import type { HostServices } from '../../../host/services.ts'
import { parseCompactLimitValue } from '../../../common/compact-threshold.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

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
          'permissionMode', 'defaultModel', 'defaultEffort', 'askTool', 'workspaceRoot', 'hiddenModels', 'autoWarmup', 'warmupModels',
          'autoTranslate', 'translateModel', 'translateEffort', 'translateTargetLanguage', 'translateMaxChars', 'translateSkipSameModel', 'translateBindConversation', 'translateMinIntervalMs',
          'imageModel', 'imageEffort', 'imageTimeoutMs', 'imageMaxBytes', 'imageOutputDir', 'imageRetries',
          'showHeaderBadge', 'showTranslateAction', 'poolWideCatalog',
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
        if (key === 'hiddenModels' && (!Array.isArray(body.value) || !(body.value as unknown[]).every((x) => typeof x === 'string'))) {
          sendJson(res as RawRes, 400, { error: 'hiddenModels must be an array of model ids' })
          return
        }
        if (key === 'warmupModels' && (!Array.isArray(body.value) || !(body.value as unknown[]).every((x) => typeof x === 'string'))) {
          sendJson(res as RawRes, 400, { error: 'warmupModels must be an array of model names' })
          return
        }
        setOverride(key, nextValue)
        onConfigWritten(key, nextValue)
        // Both keys change the model set DSH's picker must display:
        // `hiddenModels` hides ids, `poolWideCatalog` switches between the
        // active account's catalog and the pool-wide union (issue #107/#108).
        // Without this event the cached picker keeps the old list until a
        // restart, so enabling the switch looked like "it did nothing".
        if (key === 'hiddenModels' || key === 'poolWideCatalog' || key === 'autoCompactOverride') notifyPicker()
        sendJson(res as RawRes, 200, { ok: true, key, value: nextValue })
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => handleConfig(services, req, res) })
}


