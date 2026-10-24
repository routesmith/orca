import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'

import { HERMES_CLIENT_ENV_PASSTHROUGH, HERMES_PLUGIN_NAME } from './hermes-managed-plugin-source'
import { updateHermesPluginDocument } from './hermes-config-document'

export type HermesConfig = Record<string, unknown>

export type ConfigParseResult = { ok: true; config: HermesConfig } | { ok: false; detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null
  }
  return value
}

export function parseHermesConfig(content: string | null): ConfigParseResult {
  if (!content || content.trim().length === 0) {
    return { ok: true, config: {} }
  }
  try {
    const parsed = parse(content) as unknown
    if (parsed === null || parsed === undefined) {
      return { ok: true, config: {} }
    }
    if (!isRecord(parsed)) {
      return { ok: false, detail: 'Hermes config.yaml root must be a mapping' }
    }
    return { ok: true, config: { ...parsed } }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function enablePlugin(config: HermesConfig): HermesConfig {
  const next: HermesConfig = { ...config }
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {}
  const enabled = asStringArray(plugins.enabled) ?? []
  const disabled = asStringArray(plugins.disabled)
  plugins.enabled = enabled.includes(HERMES_PLUGIN_NAME)
    ? enabled
    : [...enabled, HERMES_PLUGIN_NAME]
  if (disabled === null) {
    // Match Hermes' loader: malformed disabled lists behave as empty.
    plugins.disabled = []
  } else if (disabled.includes(HERMES_PLUGIN_NAME)) {
    const filtered = disabled.filter((name) => name !== HERMES_PLUGIN_NAME)
    plugins.disabled = filtered
  }
  next.plugins = plugins
  return next
}

export function disablePlugin(config: HermesConfig): HermesConfig {
  const next: HermesConfig = { ...config }
  if (!isRecord(next.plugins)) {
    return next
  }
  const plugins = { ...next.plugins }
  const enabled = asStringArray(plugins.enabled)
  if (enabled !== null && plugins.enabled !== undefined) {
    plugins.enabled = enabled.filter((name) => name !== HERMES_PLUGIN_NAME)
  }
  next.plugins = plugins
  return next
}

const PASSTHROUGH_KEY = 'client_env_passthrough'
const ORCA_PASSTHROUGH: readonly string[] = HERMES_CLIENT_ENV_PASSTHROUGH

function passthroughNames(config: HermesConfig): string[] | null {
  if (config.terminal === undefined) {
    return []
  }
  return isRecord(config.terminal) ? asStringArray(config.terminal[PASSTHROUGH_KEY]) : null
}

export function addClientEnvPassthrough(config: HermesConfig): HermesConfig {
  const names = passthroughNames(config)
  // Hermes ignores a malformed list; leaving it alone keeps the user's value for them to fix.
  if (names === null) {
    return config
  }
  const missing = ORCA_PASSTHROUGH.filter((name) => !names.includes(name))
  if (missing.length === 0) {
    return config
  }
  const terminal = isRecord(config.terminal) ? config.terminal : {}
  return { ...config, terminal: { ...terminal, [PASSTHROUGH_KEY]: [...names, ...missing] } }
}

export function removeClientEnvPassthrough(config: HermesConfig): HermesConfig {
  const names = passthroughNames(config)
  if (
    names === null ||
    !isRecord(config.terminal) ||
    !names.some((name) => ORCA_PASSTHROUGH.includes(name))
  ) {
    return config
  }
  const kept = names.filter((name) => !ORCA_PASSTHROUGH.includes(name))
  return { ...config, terminal: { ...config.terminal, [PASSTHROUGH_KEY]: kept } }
}

export function updateConfigContent(
  content: string | null,
  updater: (config: HermesConfig) => HermesConfig
): { content: string | null; detail?: string } {
  const parsed = parseHermesConfig(content)
  if (!parsed.ok) {
    return { content: null, detail: parsed.detail }
  }
  const next = updater(parsed.config)
  if (isDeepStrictEqual(parsed.config, next)) {
    return { content: content ?? '' }
  }
  return updateHermesPluginDocument(content ?? '', next)
}

export function getClientEnvPassthroughState(config: HermesConfig): {
  present: boolean
  detail: string | null
} {
  const names = passthroughNames(config)
  if (names === null) {
    return { present: false, detail: `terminal.${PASSTHROUGH_KEY} is not a string list` }
  }
  const present = ORCA_PASSTHROUGH.every((name) => names.includes(name))
  return {
    present,
    detail: present ? null : `terminal.${PASSTHROUGH_KEY} is missing Orca's pane identity names`
  }
}

export function getConfigEnablement(config: HermesConfig): {
  enabled: boolean
  disabled: boolean
  detail: string | null
} {
  if (!isRecord(config.plugins)) {
    return { enabled: false, disabled: false, detail: 'plugins.enabled is missing' }
  }
  const enabled = asStringArray(config.plugins.enabled)
  const disabled = asStringArray(config.plugins.disabled)
  if (enabled === null) {
    return { enabled: false, disabled: false, detail: 'plugins.enabled is not a string list' }
  }
  if (disabled === null) {
    return { enabled: false, disabled: false, detail: 'plugins.disabled is not a string list' }
  }
  return {
    enabled: enabled.includes(HERMES_PLUGIN_NAME),
    disabled: disabled.includes(HERMES_PLUGIN_NAME),
    detail: null
  }
}
