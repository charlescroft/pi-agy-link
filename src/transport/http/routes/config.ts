import type { HostServices } from '../../../host/services.ts'
import { parseCompactLimitValue } from '../../../common/compact-threshold.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

const PERMISSION_MODES = new Set(['skip', 'auto', 'plan', 'accept-edits'])
const TRANSPORTS = new Set(['cli', 'acp'])

function validateConfigValue(key: string, value: unknown): string | null {
  if (key === 'hiddenModels') {
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'hiddenModels must be an array of model ids'
  }
  if (key === 'selectedModels') {
    // Allow-list of model ids; an empty array means "no restriction".
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'selectedModels must be an array of model ids'
  }
  if (key === 'warmupModels') {
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'warmupModels must be an array of model names'
  }
  if (key === 'permissionMode') {
    return typeof value === 'string' && PERMISSION_MODES.has(value)
      ? null
      : 'permissionMode must be skip, auto, plan, or accept-edits'
  }
  if (key === 'transport') {
    return typeof value === 'string' && TRANSPORTS.has(value)
      ? null
      : 'transport must be cli or acp'
  }
  if (key === 'sandbox' || key === 'imageTool' || key === 'syncAccountCustomizations') {
    return typeof value === 'boolean' ? null : `${key} must be a boolean`
  }
  if (key === 'agent') {
    return typeof value === 'string' ? null : 'agent must be a string'
  }
  if (key === 'agySettings') {
    if (typeof value !== 'string') return 'agySettings must be a string'
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return 'agySettings JSON must be a plain object'
        }
      } catch {
        return 'agySettings inline JSON is invalid'
      }
    }
    return null
  }
  return null
}

function handleConfig(services: HostServices, req: unknown, res: unknown): void {
  const { setOverride, notifyPicker, onConfigWritten } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        const allowed = [
          'enabled', 'permissionMode', 'sandbox', 'agent', 'agySettings', 'transport', 'imageTool', 'syncAccountCustomizations',
          'defaultModel', 'defaultEffort', 'askTool', 'workspaceRoot', 'hiddenModels', 'autoWarmup', 'warmupModels',
          'autoTranslate', 'translateModel', 'translateEffort', 'translateTargetLanguage', 'translateMaxChars', 'translateSkipSameModel', 'translateBindConversation', 'translateMinIntervalMs',
          'imageModel', 'imageEffort', 'imageTimeoutMs', 'imageMaxBytes', 'imageOutputDir', 'imageRetries',
          'showHeaderBadge', 'showTranslateAction', 'poolWideCatalog', 'selectedModels',
          'autoCompactOverride', 'modelApiMaxRetries', 'slimPromptRules', 'proxyUrl', 'disableTelemetry',
        ]
        if (!allowed.includes(key)) {
          sendJson(res as RawRes, 400, { error: 'key not settable' })
          return
        }
        let nextValue: unknown = body.value
        if (key === 'autoCompactOverride') {
          if (body.value === 0 || body.value === '0' || body.value === 'default' || body.value === 'off' || body.value === '') {
            nextValue = 0
          } else {
            const parsed = parseCompactLimitValue(body.value)
            if (parsed === null) {
              sendJson(res as RawRes, 400, { error: 'autoCompactOverride must be 0 or 10000..2000000 (e.g. 512k, 900k)' })
              return
            }
            nextValue = parsed
          }
        }
        if (key === 'modelApiMaxRetries') {
          const n = Number(body.value)
          if (!Number.isInteger(n) || n < 0 || n > 10) {
            sendJson(res as RawRes, 400, { error: 'modelApiMaxRetries must be an integer 0..10' })
            return
          }
          nextValue = n
        }
        const validationError = validateConfigValue(key, nextValue)
        if (validationError !== null) {
          sendJson(res as RawRes, 400, { error: validationError })
          return
        }
        setOverride(key, nextValue)
        onConfigWritten(key, nextValue)
        // Both keys change the model set DSH's picker must display:
        // `hiddenModels`/`selectedModels` change visibility, `poolWideCatalog`
        // switches between the active account's catalog and the pool-wide union
        // (issue #107/#108). Without this event the cached picker keeps the old
        // list until a restart, so ticking a checkbox looked like "it did
        // nothing".
        if (key === 'hiddenModels' || key === 'selectedModels' || key === 'poolWideCatalog' || key === 'enabled' || key === 'autoCompactOverride') {
          notifyPicker()
        }
        sendJson(res as RawRes, 200, { ok: true, key, value: nextValue })
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => handleConfig(services, req, res) })
}


