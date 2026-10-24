import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem.test-fixture'
import { HERMES_CLIENT_ENV_PASSTHROUGH } from './hermes-managed-plugin-source'
import { HermesHookService } from './hook-service'

const ORCA_NAMES = [...HERMES_CLIENT_ENV_PASSTHROUGH]

describe.each(['\n', '\r\n'])('Hermes client env passthrough (%j)', (eol) => {
  let root: string
  let configPath: string
  const service = new HermesHookService()

  const userConfig = [
    '# operator notes',
    'model: "001"',
    'terminal:',
    '  backend: local # keep',
    '  client_env_passthrough:',
    '    - GEM_HOME # user toolchain',
    '    - ORCA_TAB_ID',
    'plugins:',
    '  enabled: [other]',
    ''
  ].join(eol)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-hermes-passthrough-'))
    mkdirSync(join(root, '.hermes'))
    configPath = join(root, '.hermes', 'config.yaml')
    vi.stubEnv('HERMES_HOME', join(root, '.hermes'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  const installs = {
    local: async () => service.install(),
    remote: async () => service.installRemote(createManagedHookLocalFilesystem(), root)
  }

  it.each(['local', 'remote'] as const)(
    'merges Orca names after user entries and preserves bytes (%s install)',
    async (kind) => {
      writeFileSync(configPath, userConfig)
      expect((await installs[kind]()).state).toBe('installed')
      const installed = readFileSync(configPath, 'utf8')
      expect(parse(installed)).toEqual({
        ...parse(userConfig),
        terminal: {
          backend: 'local',
          client_env_passthrough: [
            'GEM_HOME',
            'ORCA_TAB_ID',
            ...ORCA_NAMES.filter((name) => name !== 'ORCA_TAB_ID')
          ]
        },
        plugins: { enabled: ['other', 'orca-status'] }
      })
      for (const line of [
        '# operator notes',
        '  backend: local # keep',
        'GEM_HOME # user toolchain'
      ]) {
        expect(installed.split(line)).toHaveLength(2)
      }
      if (eol === '\r\n') {
        expect(installed.replaceAll(eol, '')).not.toContain('\n')
      }

      const before = statSync(configPath)
      expect((await installs[kind]()).state).toBe('installed')
      expect(readFileSync(configPath, 'utf8')).toBe(installed)
      expect(statSync(configPath).ino).toBe(before.ino)
    }
  )

  it('removes only Orca names on uninstall', () => {
    writeFileSync(configPath, userConfig)
    service.install()
    expect(service.remove().state).toBe('not_installed')
    const removed = readFileSync(configPath, 'utf8')
    expect(parse(removed)).toEqual({
      ...parse(userConfig),
      terminal: { backend: 'local', client_env_passthrough: ['GEM_HOME'] },
      plugins: { enabled: ['other'] }
    })
    expect(removed.split('GEM_HOME # user toolchain')).toHaveLength(2)
  })

  it('adds a terminal section to a config without one', () => {
    writeFileSync(configPath, ['# notes', 'model: "001"', ''].join(eol))
    expect(service.install().state).toBe('installed')
    const installed = readFileSync(configPath, 'utf8')
    expect(installed.startsWith(['# notes', 'model: "001"', ''].join(eol))).toBe(true)
    expect(parse(installed).terminal).toEqual({ client_env_passthrough: ORCA_NAMES })
  })

  it('leaves a malformed passthrough value alone and reports the integration partial', () => {
    const input = ['terminal:', '  client_env_passthrough: GEM_HOME', ''].join(eol)
    writeFileSync(configPath, input)
    const status = service.install()
    expect(status.state).toBe('partial')
    expect(status.detail).toContain('terminal.client_env_passthrough is not a string list')
    const installed = parse(readFileSync(configPath, 'utf8'))
    expect(installed.terminal).toEqual({ client_env_passthrough: 'GEM_HOME' })
    expect(installed.plugins.enabled).toEqual(['orca-status'])
  })
})
