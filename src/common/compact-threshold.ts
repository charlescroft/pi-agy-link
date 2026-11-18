// Effective agy auto-compaction threshold resolution (256K default vs overrides).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_AGY_COMPACT_LIMIT = 256_000
export const MIN_COMPACT_LIMIT = 10_000
export const MAX_COMPACT_LIMIT = 2_000_000

export type CompactLimitSource = 'config' | 'env' | 'settings' | 'default'

export interface EffectiveCompactBudget {
  effectiveLimit: number
  source: CompactLimitSource
  defaultLimit: number
  physicalWindow: number
}

/** Parse numeric tokens or shorthand like "256k", "512k", "900k", "1m". */
export function parseCompactLimitValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    const n = Math.floor(raw)
    return n >= MIN_COMPACT_LIMIT && n <= MAX_COMPACT_LIMIT ? n : null
  }
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s === '') return null
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(s)
  if (!match) return null
  const num = Number(match[1])
  if (!Number.isFinite(num)) return null
  const mult = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  const tokens = Math.floor(num * mult)
  return tokens >= MIN_COMPACT_LIMIT && tokens <= MAX_COMPACT_LIMIT ? tokens : null
}

/** Read `contextWindow` from `~/.gemini/antigravity-cli/settings.json` if present. */
export function readSettingsContextWindow(homeDir: string = homedir()): number | null {
  const settingsPath = join(homeDir, '.gemini', 'antigravity-cli', 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    return parseCompactLimitValue(parsed?.contextWindow)
  } catch {
    return null
  }
}

/**
 * Resolve the effective agy auto-compaction threshold.
 * Precedence matches agy CLI: plugin config override -> AGY_CLI_AUTO_COMPACT_OVERRIDE
 * env -> `~/.gemini/antigravity-cli/settings.json` contextWindow -> 256K default.
 */
export function resolveEffectiveCompactLimit(
  cfg: { autoCompactOverride?: number; contextWindowDefault?: number },
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): EffectiveCompactBudget {
  const physicalWindow =
    typeof cfg.contextWindowDefault === 'number' && cfg.contextWindowDefault > 0
      ? cfg.contextWindowDefault
      : 1_048_576

  const fromCfg = parseCompactLimitValue(cfg.autoCompactOverride)
  if (fromCfg !== null) {
    return { effectiveLimit: fromCfg, source: 'config', defaultLimit: DEFAULT_AGY_COMPACT_LIMIT, physicalWindow }
  }
  const fromEnv = parseCompactLimitValue(env.AGY_CLI_AUTO_COMPACT_OVERRIDE)
  if (fromEnv !== null) {
    return { effectiveLimit: fromEnv, source: 'env', defaultLimit: DEFAULT_AGY_COMPACT_LIMIT, physicalWindow }
  }
  const fromSettings = readSettingsContextWindow(homeDir)
  if (fromSettings !== null) {
    return { effectiveLimit: fromSettings, source: 'settings', defaultLimit: DEFAULT_AGY_COMPACT_LIMIT, physicalWindow }
  }
  return {
    effectiveLimit: DEFAULT_AGY_COMPACT_LIMIT,
    source: 'default',
    defaultLimit: DEFAULT_AGY_COMPACT_LIMIT,
    physicalWindow,
  }
}
