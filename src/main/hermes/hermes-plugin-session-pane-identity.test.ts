import { createServer } from 'node:http'
import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makePaneKey } from '../../shared/stable-pane-id'
import { getPluginInitSource } from './hermes-managed-plugin-source'

const pythonAvailable = spawnSync('python3', ['--version'], { encoding: 'utf-8' }).status === 0

const PANE_A = makePaneKey('tab-a', '11111111-1111-4111-8111-111111111111')
const PANE_B = makePaneKey('tab-b', '22222222-2222-4222-8222-222222222222')
const STALE_PANE = makePaneKey('tab-stale', '33333333-3333-4333-8333-333333333333')

// Same surface as Hermes' agent/session_client_env.py: a ContextVar the shared gateway binds per turn.
const SESSION_CLIENT_ENV_FIXTURE = `
from contextlib import contextmanager
from contextvars import ContextVar

_BOUND = ContextVar('session_client_env', default=None)


@contextmanager
def client_env_scope(env, *, local=True, rules=None):
    token = _BOUND.set(None if env is None else (env, bool(local), rules))
    try:
        yield
    finally:
        _BOUND.reset(token)


def bound_client_env():
    bound = _BOUND.get()
    return None if bound is None else bound[0]
`

// Each session fires on its own thread while the other is still bound, like concurrent gateway turns.
const DRIVER = `
import importlib.util, json, sys, threading
spec = importlib.util.spec_from_file_location("orca_status", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
hooks = {}
mod.register(type("Ctx", (), {"register_hook": lambda self, name, cb: hooks.__setitem__(name, cb)})())
sessions = json.loads(sys.argv[2])
from agent.session_client_env import client_env_scope
barrier = threading.Barrier(len(sessions))


def run(session):
    def fire():
        barrier.wait()
        hooks["pre_llm_call"](session_id=session["id"], user_message="hi", platform="cli")
        barrier.wait()
        hooks["post_llm_call"](session_id=session["id"], assistant_response="ok", platform="cli")
        if not session["bound"]:
            # Hermes 0.22 fires these from owner housekeeping, outside any session's scope.
            hooks["on_session_finalize"](session_id=session["id"], platform="cli", reason="cli_close")
            hooks["on_session_reset"](session_id=None, old_session_id=session["id"], platform="cli")
    if session["bound"]:
        with client_env_scope(session["env"]):
            fire()
    else:
        fire()


threads = [threading.Thread(target=run, args=(s,)) for s in sessions]
for t in threads:
    t.start()
for t in threads:
    t.join()
`

type Session = { id: string; bound: boolean; env?: Record<string, string> }
type Received = {
  token: string | undefined
  paneKey: string
  launchToken: string
  tabId: string
  event: string
  sessionId: string
}

function stringAt(value: unknown, ...path: string[]): string {
  let current = value
  for (const key of path) {
    current =
      typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  }
  return typeof current === 'string' ? current : ''
}

describe('Hermes managed plugin pane identity', () => {
  let directory: string
  let endpointPath: string
  let fixturePath: string
  let initPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-hermes-session-identity-'))
    endpointPath = join(directory, 'endpoint.env')
    fixturePath = join(directory, 'hermes')
    mkdirSync(join(fixturePath, 'agent'), { recursive: true })
    writeFileSync(join(fixturePath, 'agent', '__init__.py'), '')
    writeFileSync(join(fixturePath, 'agent', 'session_client_env.py'), SESSION_CLIENT_ENV_FIXTURE)
    initPath = join(directory, 'orca_status.py')
    writeFileSync(initPath, getPluginInitSource())
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  // What Hermes' client env filter lets through: the canonical pane and launch names contain
  // KEY/TOKEN and never travel, so a session carries only their scrub-safe aliases.
  function sessionEnv(pane: string, tab: string) {
    return {
      ORCA_AGENT_PANE: pane,
      ORCA_AGENT_LAUNCH: `launch-${tab}`,
      ORCA_TAB_ID: tab,
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_AGENT_HOOK_ENDPOINT: endpointPath
    }
  }

  async function runGateway(args: {
    sessions: Session[]
    gatewayEnv: (port: number) => Record<string, string>
  }): Promise<Received[]> {
    const received: Received[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        const token = req.headers['x-orca-agent-hook-token']
        received.push({
          token: typeof token === 'string' ? token : undefined,
          paneKey: stringAt(body, 'paneKey'),
          launchToken: stringAt(body, 'launchToken'),
          tabId: stringAt(body, 'tabId'),
          event: stringAt(body, 'payload', 'hook_event_name'),
          sessionId: stringAt(body, 'payload', 'session_id')
        })
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('server did not bind to a TCP port')
      }
      writeFileSync(
        endpointPath,
        `ORCA_AGENT_HOOK_PORT=${address.port}\nORCA_AGENT_HOOK_TOKEN=token-1\n`
      )
      // The hooks call this server; synchronous execution would deadlock its responses.
      await new Promise<void>((resolve, reject) => {
        execFile(
          'python3',
          ['-c', DRIVER, initPath, JSON.stringify(args.sessions)],
          {
            env: {
              PATH: process.env.PATH ?? '',
              ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
              PYTHONPATH: fixturePath,
              ...args.gatewayEnv(address.port)
            },
            timeout: 15_000
          },
          (error) => (error ? reject(error) : resolve())
        )
      })
    } finally {
      server.close()
    }
    return received.sort((a, b) =>
      `${a.sessionId}:${a.event}`.localeCompare(`${b.sessionId}:${b.event}`)
    )
  }

  // A gateway started from another pane: valid hook coordinates, someone else's identity.
  const staleGateway = (port: number) => ({
    ORCA_PANE_KEY: STALE_PANE,
    ORCA_AGENT_LAUNCH_TOKEN: 'launch-stale',
    ORCA_TAB_ID: 'tab-stale',
    ORCA_AGENT_HOOK_PORT: String(port),
    ORCA_AGENT_HOOK_TOKEN: 'stale-token'
  })

  it.skipIf(!pythonAvailable)(
    'attributes concurrent sessions to their own panes, never the gateway pane',
    async () => {
      const received = await runGateway({
        gatewayEnv: staleGateway,
        sessions: [
          { id: 'sess-a', bound: true, env: sessionEnv(PANE_A, 'tab-a') },
          { id: 'sess-b', bound: true, env: sessionEnv(PANE_B, 'tab-b') }
        ]
      })

      const post = (paneKey: string, tab: string, sessionId: string, event: string) => ({
        token: 'token-1',
        paneKey,
        launchToken: `launch-${tab}`,
        tabId: tab,
        event,
        sessionId
      })
      expect(received).toEqual([
        post(PANE_A, 'tab-a', 'sess-a', 'post_llm_call'),
        post(PANE_A, 'tab-a', 'sess-a', 'pre_llm_call'),
        post(PANE_B, 'tab-b', 'sess-b', 'post_llm_call'),
        post(PANE_B, 'tab-b', 'sess-b', 'pre_llm_call')
      ])
    }
  )

  it.skipIf(!pythonAvailable)(
    'drops events from sessions without pane identity instead of using the gateway pane',
    async () => {
      const received = await runGateway({
        gatewayEnv: staleGateway,
        sessions: [
          { id: 'sess-identified', bound: true, env: sessionEnv(PANE_A, 'tab-a') },
          { id: 'sess-anonymous', bound: true, env: { PATH: '/usr/bin' } },
          { id: 'sess-unbound', bound: false }
        ]
      })

      expect(received.map((item) => [item.sessionId, item.paneKey])).toEqual([
        ['sess-identified', PANE_A],
        ['sess-identified', PANE_A]
      ])
    }
  )
})
