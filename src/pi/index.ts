import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createHostServices } from '../host/services.ts'
import { runBootHygiene } from '../host/boot-hygiene.ts'
import { MIN_AGY_VERSION, compareVersions, parseVersion, probeProcess } from '../host/runner.ts'
import { defineAgyMirrorTool } from '../provider/mirror/definition.ts'
import type { Context as CordisContext } from './dsh-shims/cordis.ts'
import type { Message, StreamChunk, TokenUsage } from './dsh-shims/dsh-llm.ts'
import type { ManagedAccount, ModelFamily } from '../common/pool-types.ts'

export const AGY_PROVIDER_ID = 'agy-link'
export const AGY_PROVIDER_NAME = 'Antigravity (agy CLI)'

interface AgyWidgetModelQuota {
  name: string
  percentage: number
  resetTime?: string
}

interface AgyWidgetAccount {
  id: string
  alias: string
  email?: string
  tier: string
  priority: number
  disabled: boolean
  active: boolean
  systemHome: boolean
  proxyUrl?: string
  authRequired: boolean
  authError?: string
  cooldownUntil?: number
  cooldownReason?: string
  fiveHourPct?: number
  fiveHourReset?: string
  weeklyPct?: number
  weeklyReset?: string
  argonPct?: number
  argonReset?: string
  models: AgyWidgetModelQuota[]
}

interface AgyWidgetState {
  version?: string | null
  dormantReason?: string | null
  activeAccountId?: string | null
  pendingAuthUrl?: string
  accounts: AgyWidgetAccount[]
  availableModels: string[]
  settings: Record<string, unknown>
  updatedAt: number
}

function pctFromFraction(frac?: number): number | undefined {
  if (typeof frac !== 'number' || !Number.isFinite(frac)) return undefined
  return Math.max(0, Math.min(100, Math.round(frac * 100)))
}

function formatResetShort(iso?: string): string | undefined {
  if (!iso) return undefined
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso
  const diffMs = ts - Date.now()
  if (diffMs <= 0) return 'now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

function mapCatalogToPiModels(services: ReturnType<typeof createHostServices>) {
  const poolData = services.pool.getPoolData()
  const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId ?? undefined
  const catalog = services.catalog.get(activeId)
  const cfg = services.getConfig()
  const hidden = new Set(
    (Array.isArray(cfg.hiddenModels) ? cfg.hiddenModels : [])
      .map((s) => s.trim())
      .filter(Boolean)
  )
  const rawModels = catalog.models.filter((m) => !hidden.has(m.id))
  return rawModels.map((m) => {
    const efforts = Array.isArray(m.efforts) ? m.efforts : []
    const supportsReasoning = efforts.length > 0
    const thinkingLevelMap: Record<string, string | null> = {}
    if (supportsReasoning) {
      for (const lvl of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        thinkingLevelMap[lvl] = efforts.includes(lvl) ? lvl : null
      }
    }
    return {
      id: m.id,
      name: m.name || m.id,
      api: AGY_PROVIDER_ID,
      provider: AGY_PROVIDER_ID,
      baseUrl: 'agy-cli://local',
      reasoning: supportsReasoning,
      thinkingLevelMap,
      input: ['text'] as Array<'text' | 'image'>,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    }
  })
}

function buildWidgetState(services: ReturnType<typeof createHostServices>): AgyWidgetState {
  const poolData = services.pool.getPoolData()
  const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId ?? null
  const accounts = services.pool.getAccounts()
  const now = Date.now()

  const mappedAccounts: AgyWidgetAccount[] = accounts.map((acc: ManagedAccount, idx: number) => {
    const g = acc.quotas?.google
    const c = acc.quotas?.anthropic
    const arg = acc.quotas?.argon
    const gCooldown = acc.cooldowns?.google
    const activeCooldown = gCooldown && gCooldown.cooldownUntil > now ? gCooldown : undefined

    const modelsMap = new Map<string, AgyWidgetModelQuota>()
    for (const fam of [g, c, arg]) {
      for (const mq of fam?.models ?? []) {
        const pct = pctFromFraction(mq.remainingFraction) ?? 0
        modelsMap.set(mq.modelId, {
          name: mq.displayName || mq.modelId,
          percentage: pct,
          resetTime: formatResetShort(mq.resetTime),
        })
      }
    }

    const tier =
      acc.subscriptionTier ||
      (acc.dedicatedGroups?.includes('argon') || arg !== undefined ? 'PRO/ULTRA' : 'STANDARD')

    return {
      id: acc.id,
      alias: acc.alias || acc.email || acc.id,
      email: acc.email,
      tier,
      priority: idx + 1,
      disabled: !acc.enabled,
      active: acc.id === activeId,
      systemHome: Boolean(acc.systemHome),
      proxyUrl: acc.proxyUrl,
      authRequired: Boolean(acc.authRequired),
      authError: acc.authError,
      cooldownUntil: activeCooldown?.cooldownUntil,
      cooldownReason: activeCooldown?.reason,
      fiveHourPct: pctFromFraction(g?.remainingFraction),
      fiveHourReset: formatResetShort(g?.resetTime),
      weeklyPct: pctFromFraction(g?.weeklyFraction),
      weeklyReset: formatResetShort(g?.weeklyResetTime),
      argonPct: pctFromFraction(arg?.weeklyFraction ?? arg?.remainingFraction),
      argonReset: formatResetShort(arg?.weeklyResetTime ?? arg?.resetTime),
      models: Array.from(modelsMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }
  })

  const cfg = services.getConfig()
  const availableModels = services.catalog
    .get(activeId ?? undefined)
    .models.map((m) => m.id)

  const authSt = services.poolAuth.status()
  const pendingAuthUrl = authSt.phase === 'waiting' ? authSt.url : undefined

  return {
    version: services.status.version,
    dormantReason: services.status.dormantReason,
    activeAccountId: activeId,
    pendingAuthUrl,
    accounts: mappedAccounts,
    availableModels,
    settings: {
      mode: poolData.mode,
      proxyUrl: cfg.proxyUrl || '',
      permissionMode: cfg.permissionMode || 'skip',
      defaultEffort: cfg.defaultEffort || '',
      parallelSameAccount: Boolean(cfg.parallelSameAccount),
      maxConcurrent: Number(cfg.maxConcurrent ?? 0),
      dispatchTimeoutMinutes: Number(cfg.dispatchTimeoutMinutes ?? 0),
      dispatchRetries: Number(cfg.dispatchRetries ?? 0),
      suppressAgyAutoUpdate: Boolean(cfg.suppressAgyAutoUpdate),
      poolWideCatalog: Boolean(cfg.poolWideCatalog),
      autoFallbackModel: Boolean(cfg.autoFallbackModel),
      hiddenModels: Array.isArray(cfg.hiddenModels) ? [...cfg.hiddenModels] : [],
      autoWarmup: Boolean(cfg.autoWarmup),
      imageModel: cfg.imageModel || '',
      imageEffort: cfg.imageEffort || 'low',
      imageTimeoutMs: Number(cfg.imageTimeoutMs ?? 240000),
      imageRetries: Number(cfg.imageRetries ?? 1),
      imageOutputDir: cfg.imageOutputDir || '',
    },
    updatedAt: now,
  }
}

function publishAgyUi(ctx: ExtensionContext | undefined, services: ReturnType<typeof createHostServices>): void {
  if (!ctx) return
  try {
    if (!ctx.hasUI) return
    const state = buildWidgetState(services)
    const active = state.accounts.find((a) => a.active) ?? state.accounts[0]
    let statusText = 'AGY'
    if (state.dormantReason) {
      statusText = `AGY: dormant`
    } else if (active) {
      const name = active.email || active.alias
      const pct = active.fiveHourPct !== undefined ? ` (${active.fiveHourPct}%)` : ''
      statusText = `AGY: ${name}${pct}`
    } else {
      statusText = 'AGY: no account'
    }
    ctx.ui.setStatus('agy-link', statusText)
    if ((ctx as unknown as { mode?: string }).mode === 'rpc') {
      ctx.ui.setWidget('agy-link-state', [JSON.stringify(state)])
    }
  } catch {
    // Ignore stale ExtensionContext after session replacement or shutdown
  }
}

function convertPiMessagesToDsh(context: { systemPrompt?: string; messages?: Array<{ role: string; content: unknown; sections?: Record<string, string | null>; toolCallId?: string; toolName?: string; isError?: boolean }> }): Message[] {
  const out: Message[] = []
  if (typeof context.systemPrompt === 'string' && context.systemPrompt.trim() !== '') {
    const hasLeadingSystem = (context.messages?.[0]?.role ?? '') === 'system'
    if (!hasLeadingSystem) {
      out.push({ role: 'system', content: context.systemPrompt })
    }
  }
  for (const m of context.messages ?? []) {
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
      if (typeof m.content === 'string') {
        let text = m.content
        if (m.role === 'system' && m.sections && typeof m.sections === 'object') {
          const extra = Object.entries(m.sections)
            .filter(([, v]) => typeof v === 'string' && v.length > 0)
            .map(([k, v]) => `[${k}]\n${v}`)
            .join('\n\n')
          if (extra) text = text ? `${text}\n\n${extra}` : extra
        }
        out.push({ role: m.role, content: text })
      } else if (Array.isArray(m.content)) {
        const parts: Array<Record<string, unknown>> = []
        for (const p of m.content as any[]) {
          if (!p || typeof p !== 'object') continue
          if (p.type === 'text' && typeof p.text === 'string') {
            parts.push({ type: 'text', text: p.text })
          } else if (p.type === 'thinking' && typeof p.thinking === 'string') {
            parts.push({ type: 'reasoning', text: p.thinking })
          } else if (p.type === 'toolCall') {
            parts.push({
              type: 'tool-call',
              id: String(p.id || ''),
              name: String(p.name || ''),
              arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}),
            })
          }
        }
        if (parts.length > 0) {
          out.push({ role: m.role, content: parts as any })
        }
      }
    } else if (m.role === 'toolResult') {
      const text = Array.isArray(m.content)
        ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
        : String(m.content ?? '')
      out.push({
        role: 'tool',
        content: text,
        toolCallId: m.toolCallId as any,
        toolName: m.toolName,
        isError: m.isError,
      })
    }
  }
  return out
}

function emitOutput(ctx: ExtensionCommandContext, text: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type)
  } else if (type === 'error' || type === 'warning') {
    console.error(text)
  } else {
    console.log(text)
  }
}

export default function (pi: ExtensionAPI): void {
  let onAdaptersUpdated = () => {}
  const mockCtx: CordisContext = {
    logger: {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    },
    get: () => undefined,
    effect: () => () => {},
    on: () => () => {},
    emit: (event?: string) => {
      if (event === 'llm/adapters-updated') {
        onAdaptersUpdated()
      }
    },
  }

  const services = createHostServices(mockCtx as unknown as Parameters<typeof createHostServices>[0], {})
  runBootHygiene(services)

  const warnTimestamps = new Map<string, number>()
  const warnThrottled = (key: string, msg: string, err?: unknown): void => {
    const now = Date.now()
    const last = warnTimestamps.get(key) ?? 0
    if (now - last < 60_000) return
    warnTimestamps.set(key, now)
    const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : ''
    console.warn(`[agy-link] ${msg}${detail ? `: ${detail}` : ''}`)
  }

  let lastUiCtx: ExtensionContext | undefined
  let lastQuotaRefreshAt = 0
  let bgQuotaRefreshing = false
  let bgQuotaTimer: ReturnType<typeof setInterval> | null = null

  const maybeRefreshActiveQuotaInBackground = async (force = false) => {
    if (bgQuotaRefreshing) return
    const now = Date.now()
    if (!force && now - lastQuotaRefreshAt < 20_000) return
    const poolData = services.pool.getPoolData()
    const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
    const activeAcc = activeId ? services.pool.getAccounts().find((a) => a.id === activeId) : undefined
    if (!activeAcc) return
    bgQuotaRefreshing = true
    try {
      await services.quota.refreshAccountQuota(activeAcc, force).catch((err) => {
        warnThrottled('bg-quota', 'background quota refresh failed', err)
      })
      lastQuotaRefreshAt = Date.now()
      publishAgyUi(lastUiCtx, services)
    } finally {
      bgQuotaRefreshing = false
    }
  }

  const startBgQuotaTimer = () => {
    if (bgQuotaTimer) return
    bgQuotaTimer = setInterval(() => {
      if (!lastUiCtx) return
      void maybeRefreshActiveQuotaInBackground(false)
    }, 45_000)
    bgQuotaTimer.unref?.()
  }
  startBgQuotaTimer()

  const refreshBootState = async () => {
    publishAgyUi(lastUiCtx, services)
    const currentBin = services.bin()
    if (!currentBin) {
      services.status.dormantReason = 'agy binary not found'
      publishAgyUi(lastUiCtx, services)
      return
    }
    try {
      const v = await probeProcess(currentBin, ['--version'], 10_000, undefined, undefined, services.getConfig().suppressAgyAutoUpdate)
      services.status.version = parseVersion(v.stdout)
      if (services.status.version && compareVersions(services.status.version, MIN_AGY_VERSION) < 0) {
        services.status.dormantReason = `agy ${services.status.version} < ${MIN_AGY_VERSION}`
      } else {
        services.status.dormantReason = null
      }
    } catch {
      // ignore version probe failure
    }
    const poolData = services.pool.getPoolData()
    const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
    await services.catalog.refreshIfNeeded(activeId).catch(() => undefined)
    await services.quota.refreshAllQuotas(false).catch(() => undefined)
    lastQuotaRefreshAt = Date.now()
    registerAgyProvider()
    publishAgyUi(lastUiCtx, services)
  }

  const streamSimpleImpl = (model: any, context: any, options?: any) => {
      const stream = createAssistantMessageEventStream()
      const partial: any = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }

      void (async () => {
        try {
          stream.push({ type: 'start', partial })
          const dshMessages = convertPiMessagesToDsh(context)
          const reasoning = typeof options?.reasoning === 'string' && options.reasoning !== 'off' ? options.reasoning : undefined
          const iter = services.adapter.stream({
            provider: AGY_PROVIDER_ID,
            model: model.id,
            messages: dshMessages as any,
            sessionId: (options?.sessionId ?? 'pi-session') as any,
            signal: options?.signal,
            reasoningEffort: reasoning,
          })

          let textIndex: number | null = null
          let thinkingIndex: number | null = null
          let textAcc = ''
          let thinkingAcc = ''
          const toolCallIndices = new Map<number, number>()
          let finishReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' = 'stop'

          for await (const chunk of iter as AsyncIterable<StreamChunk>) {
            const rawChunk = chunk as any
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              let idx: number
              if (textIndex === null) {
                idx = partial.content.length
                textIndex = idx
                partial.content.push({ type: 'text', text: '' })
                stream.push({ type: 'text_start', contentIndex: idx, partial })
              } else {
                idx = textIndex
              }
              textAcc += chunk.text
              partial.content[idx].text = textAcc
              stream.push({ type: 'text_delta', contentIndex: idx, delta: chunk.text, partial })
            } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              let idx: number
              if (thinkingIndex === null) {
                idx = partial.content.length
                thinkingIndex = idx
                partial.content.push({ type: 'thinking', thinking: '' })
                stream.push({ type: 'thinking_start', contentIndex: idx, partial })
              } else {
                idx = thinkingIndex
              }
              thinkingAcc += chunk.text
              partial.content[idx].thinking = thinkingAcc
              stream.push({ type: 'thinking_delta', contentIndex: idx, delta: chunk.text, partial })
            } else if (rawChunk.type === 'block-start' && rawChunk.blockType === 'tool-call') {
              const blockIdx = typeof rawChunk.index === 'number' ? rawChunk.index : partial.content.length
              if (!toolCallIndices.has(blockIdx)) {
                const tcIdx = partial.content.length
                partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
                toolCallIndices.set(blockIdx, tcIdx)
                stream.push({ type: 'toolcall_start', contentIndex: tcIdx, partial })
              }
            } else if (rawChunk.type === 'block-end' && rawChunk.block && typeof rawChunk.block === 'object') {
              if (rawChunk.block.type === 'tool-call') {
                const blockIdx = typeof rawChunk.index === 'number' ? rawChunk.index : -1
                const existingIdx = blockIdx >= 0 ? toolCallIndices.get(blockIdx) : undefined
                let tcIdx: number
                if (existingIdx === undefined) {
                  tcIdx = partial.content.length
                  partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
                  if (blockIdx >= 0) toolCallIndices.set(blockIdx, tcIdx)
                  stream.push({ type: 'toolcall_start', contentIndex: tcIdx, partial })
                } else {
                  tcIdx = existingIdx
                }
                const rawArgs = typeof rawChunk.block.arguments === 'string'
                  ? rawChunk.block.arguments
                  : JSON.stringify(rawChunk.block.arguments ?? {})
                let parsedArgs: Record<string, unknown> = {}
                try {
                  const candidate = typeof rawChunk.block.arguments === 'string'
                    ? JSON.parse(rawChunk.block.arguments)
                    : rawChunk.block.arguments
                  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsedArgs = candidate as Record<string, unknown>
                  }
                } catch {
                  // Keep empty fallback object when raw arguments fail JSON parse
                }
                const toolCall = {
                  type: 'toolCall' as const,
                  id: String(rawChunk.block.id || `call_${Date.now()}`),
                  name: String(rawChunk.block.name || 'agy_tool'),
                  arguments: parsedArgs,
                }
                partial.content[tcIdx] = toolCall
                stream.push({ type: 'toolcall_delta', contentIndex: tcIdx, delta: rawArgs, partial })
                stream.push({ type: 'toolcall_end', contentIndex: tcIdx, toolCall: toolCall as any, partial })
              } else if (rawChunk.block.type === 'reasoning' && thinkingIndex !== null) {
                stream.push({ type: 'thinking_end', contentIndex: thinkingIndex, content: thinkingAcc, partial })
                thinkingIndex = null
                thinkingAcc = ''
              } else if (rawChunk.block.type === 'text' && textIndex !== null) {
                stream.push({ type: 'text_end', contentIndex: textIndex, content: textAcc, partial })
                textIndex = null
                textAcc = ''
              }
            } else if (chunk.type === 'usage' && chunk.usage) {
              const u = chunk.usage as TokenUsage
              partial.usage.input = u.inputTokens ?? partial.usage.input
              partial.usage.output = u.outputTokens ?? partial.usage.output
              partial.usage.cacheRead = u.cacheReadTokens ?? partial.usage.cacheRead
              partial.usage.cacheWrite = u.cacheWriteTokens ?? partial.usage.cacheWrite
              partial.usage.totalTokens = u.totalTokens ?? partial.usage.input + partial.usage.output + partial.usage.cacheRead
            } else if (chunk.type === 'finish' && chunk.reason) {
              const reasonAny = chunk.reason as any
              if (reasonAny.kind === 'error') {
                finishReason = 'error'
                partial.errorMessage = reasonAny.failure?.message || reasonAny.error?.message || 'agy stream error'
              } else if (reasonAny.kind === 'aborted') {
                finishReason = 'aborted'
                partial.errorMessage = reasonAny.failure?.message || reasonAny.error?.message || 'agy stream aborted'
              } else if (reasonAny.kind === 'length') {
                finishReason = 'length'
              } else if (reasonAny.kind === 'tool-calls') {
                finishReason = 'toolUse'
              } else {
                finishReason = 'stop'
              }
            }
          }

          if (thinkingIndex !== null) {
            stream.push({ type: 'thinking_end', contentIndex: thinkingIndex, content: thinkingAcc, partial })
          }
          if (textIndex !== null) {
            stream.push({ type: 'text_end', contentIndex: textIndex, content: textAcc, partial })
          }

          partial.stopReason = finishReason
          if (finishReason === 'error' || finishReason === 'aborted') {
            stream.push({ type: 'error', reason: finishReason, error: partial })
          } else {
            stream.push({ type: 'done', reason: finishReason, message: partial })
          }
          publishAgyUi(lastUiCtx, services)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          partial.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
          partial.errorMessage = msg
          stream.push({ type: 'error', reason: partial.stopReason, error: partial })
          publishAgyUi(lastUiCtx, services)
        }
      })()

      return stream
    }

  const registerAgyProvider = () => {
    pi.registerProvider(AGY_PROVIDER_ID, {
      name: AGY_PROVIDER_NAME,
      baseUrl: 'agy-cli://local',
      api: AGY_PROVIDER_ID,
      apiKey: 'agy-cli-local',
      models: mapCatalogToPiModels(services),
      refreshModels: async () => {
        const poolData = services.pool.getPoolData()
        const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
        await services.catalog.refreshIfNeeded(activeId).catch(() => undefined)
        return mapCatalogToPiModels(services)
      },
      streamSimple: streamSimpleImpl,
    } as any)
  }

  onAdaptersUpdated = () => {
    registerAgyProvider()
    publishAgyUi(lastUiCtx, services)
  }

  registerAgyProvider()
  void refreshBootState()

  pi.on('session_start', async (_event, ctx) => {
    lastUiCtx = ctx
    startBgQuotaTimer()
    publishAgyUi(ctx, services)
  })

  pi.on('turn_end', async (_event, ctx) => {
    lastUiCtx = ctx
    publishAgyUi(ctx, services)
    void maybeRefreshActiveQuotaInBackground(false)
  })

  pi.on('session_shutdown', async () => {
    lastUiCtx = undefined
    if (bgQuotaTimer) {
      clearInterval(bgQuotaTimer)
      bgQuotaTimer = null
    }
    if (authWatchTimer) {
      clearInterval(authWatchTimer)
      authWatchTimer = null
    }
  })

  const mirrorTool = defineAgyMirrorTool({ runs: services.runs })
  pi.registerTool({
    name: mirrorTool.name,
    label: 'Antigravity Tool Mirror',
    description: mirrorTool.description,
    parameters: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'Recording run id.' },
        step: { type: 'number', description: 'Recorded event index of the tool step.' },
        tool: { type: 'string', description: 'agy tool name that ran (optional).' },
        server: { type: 'string', description: 'MCP server name (optional).' },
        input: { description: 'agy tool arguments as recorded (optional).' },
      },
      required: ['run', 'step'],
    } as any,
    execute: async (_toolCallId, params: Record<string, unknown>, signal) => {
      const text = await mirrorTool.execute(params as any, { signal } as any)
      return {
        content: [{ type: 'text' as const, text: typeof text === 'string' ? text : String(text ?? '') }],
        details: {},
      }
    },
  })

  pi.registerTool({
    name: 'agy_ask',
    label: 'Ask Antigravity (agy)',
    description: 'Delegate a one-shot question or task to an Antigravity model via agy CLI.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to send to agy' },
        model: { type: 'string', description: 'Optional model alias or slug (e.g. flash, pro, gemini-3.6-flash)' },
      },
      required: ['prompt'],
    } as any,
    execute: async (_toolCallId, params: { prompt: string; model?: string }) => {
      const poolData = services.pool.getPoolData()
      const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
      const acc = activeId ? services.pool.getAccount(activeId) : undefined
      let out = ''
      for await (const chunk of services.adapter.stream({
        provider: AGY_PROVIDER_ID,
        model: params.model || 'gemini-3.6-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: params.prompt }] }] as any,
        sessionId: `agy_ask_${Date.now()}` as any,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text
        }
      }
      return {
        content: [{ type: 'text' as const, text: out || `(no output; account=${acc?.email ?? 'primary'})` }],
      }
    },
  })

  pi.registerCommand('agy', {
    description: 'Manage Antigravity (agy-link) accounts, quotas, and proxies',
    handler: async (args, ctx) => {
      lastUiCtx = ctx
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = (parts[0] || '').toLowerCase()
      const rest = parts.slice(1)

      if (!sub && ctx.hasUI) {
        const accounts = services.pool.getAccounts()
        const choice = await ctx.ui.select('Antigravity (agy-link) Actions', [
          'Refresh all quotas',
          'Add new Google account (OAuth)',
          'Login primary account (OAuth)',
          ...(accounts.length > 0 ? ['Switch active account'] : []),
          'Show account status',
        ])
        if (!choice) return
        if (choice.startsWith('Refresh')) return await runRefresh(ctx)
        if (choice.startsWith('Add new')) return await runAddAccount(ctx)
        if (choice.startsWith('Login primary')) return await runPrimaryAuth(ctx)
        if (choice.startsWith('Switch')) {
          const picked = await ctx.ui.select(
            'Select active Antigravity account',
            accounts.map((a, i) => `${i + 1}. ${a.email || a.alias} (${a.id})`),
          )
          if (!picked) return
          const idx = parseInt(picked.split('.')[0] || '0', 10) - 1
          if (accounts[idx]) {
            services.pool.setActiveAccount(accounts[idx].id, 'google')
            publishAgyUi(ctx, services)
            emitOutput(ctx, `Switched active AGY account to ${accounts[idx].email || accounts[idx].alias}`)
          }
          return
        }
        return showStatus(ctx)
      }

      if (sub === 'refresh' || sub === 'quota') return await runRefresh(ctx)
      if (sub === 'add') return await runAddAccount(ctx)
      if (sub === 'auth-url') {
        const st = services.poolAuth.status()
        if (st.phase === 'waiting' && st.url && st.stagingId !== 'acc_primary') {
          publishAgyUi(ctx, services)
          emitOutput(ctx, st.url)
          return
        }
        return await runAddAccount(ctx)
      }
      if (sub === 'primary') return await runPrimaryAuth(ctx)
      if (sub === 'primary-url') {
        const st = services.poolAuth.status()
        if (st.phase === 'waiting' && st.url && st.stagingId === 'acc_primary') {
          publishAgyUi(ctx, services)
          emitOutput(ctx, st.url)
          return
        }
        return await runPrimaryAuth(ctx)
      }
      if ((sub === 'reauth' || sub === 'reauth-url') && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        if (sub === 'reauth-url') {
          const st = services.poolAuth.status()
          if (st.phase === 'waiting' && st.url && (st.stagingId === target.id || st.alias === target.alias)) {
            publishAgyUi(ctx, services)
            emitOutput(ctx, st.url)
            return
          }
        }
        if (target.systemHome || !target.dir) {
          return await runPrimaryAuth(ctx)
        }
        const res = await services.poolAuth.beginAccount(target.id)
        if (res.ok) {
          emitOutput(ctx, res.url ? `Opened Google OAuth for ${target.email || target.alias} (${res.url}).` : 'Google OAuth started.')
          watchPoolAuthCompletion()
        } else {
          emitOutput(ctx, `Failed to start OAuth: ${res.code || 'unknown'}`, 'error')
        }
        publishAgyUi(ctx, services)
        return
      }
      if (sub === 'details' || sub === 'models') return showDetails(ctx, rest[0])
      if (sub === 'switch' && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        services.pool.setActiveAccount(target.id, 'google')
        registerAgyProvider()
        publishAgyUi(ctx, services)
        void services.catalog.forceRefreshAndNotify(target.id).catch((err) => {
          warnThrottled('catalog-refresh', 'catalog refresh after switch failed', err)
        }).finally(() => {
          registerAgyProvider()
          publishAgyUi(lastUiCtx ?? ctx, services)
        })
        void maybeRefreshActiveQuotaInBackground(true)
        emitOutput(ctx, `Switched active AGY account to ${target.email || target.alias}`)
        return
      }
      if (sub === 'remove' && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        const deleted = services.pool.deleteAccount(target.id)
        if (!deleted) {
          emitOutput(ctx, `Cannot remove account ${target.email || target.alias} (${target.id}).`, 'error')
          return
        }
        registerAgyProvider()
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Removed AGY account ${target.email || target.alias}`)
        return
      }
      if (sub === 'proxy' && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        const proxy = rest[1] && rest[1] !== 'clear' ? rest[1] : ''
        services.pool.setAccountProxy(target.id, proxy)
        publishAgyUi(ctx, services)
        emitOutput(ctx, proxy ? `Proxy set for ${target.email || target.alias}: ${proxy}` : `Cleared proxy for ${target.email || target.alias}`)
        return
      }
      if ((sub === 'enable' || sub === 'disable') && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        const enabled = sub === 'enable'
        services.pool.setAccountEnabled(target.id, enabled)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `${enabled ? 'Enabled' : 'Disabled'} AGY account ${target.email || target.alias}`)
        return
      }
      if (sub === 'mode' && rest[0]) {
        const mode = rest[0].toLowerCase()
        if (mode !== 'sequential' && mode !== 'round-robin') {
          emitOutput(ctx, 'Usage: /agy mode <sequential|round-robin>', 'error')
          return
        }
        services.pool.setMode(mode)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Pool rotation mode set to ${mode}`)
        return
      }
      if (sub === 'proxy-global') {
        const raw = (rest[0] || '').trim()
        const nextProxy = !raw || raw === 'clear' || raw === 'none' ? '' : raw
        services.setOverride('proxyUrl', nextProxy)
        publishAgyUi(ctx, services)
        emitOutput(ctx, nextProxy ? `Global upstream proxy set to ${nextProxy}` : 'Global upstream proxy cleared')
        return
      }
      if (sub === 'permission' && rest[0]) {
        const p = rest[0].toLowerCase()
        if (p !== 'skip' && p !== 'plan' && p !== 'accept-edits') {
          emitOutput(ctx, 'Usage: /agy permission <skip|plan|accept-edits>', 'error')
          return
        }
        services.setOverride('permissionMode', p)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Permission mode set to ${p}`)
        return
      }
      if (sub === 'effort' && rest[0]) {
        const eff = rest[0].toLowerCase()
        if (!['default', 'low', 'medium', 'high'].includes(eff)) {
          emitOutput(ctx, 'Usage: /agy effort <default|low|medium|high>', 'error')
          return
        }
        services.setOverride('defaultEffort', eff === 'default' ? '' : eff)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Default effort set to ${eff}`)
        return
      }
      if (sub === 'parallel' && rest[0]) {
        const on = rest[0].toLowerCase() === 'on' || rest[0].toLowerCase() === 'true'
        services.setOverride('parallelSameAccount', on)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Same-account parallelism ${on ? 'enabled' : 'disabled'}`)
        return
      }
      if (sub === 'max-concurrent' && rest[0]) {
        const n = Number(rest[0])
        if (!Number.isFinite(n) || n < 0 || n > 64) {
          emitOutput(ctx, 'Usage: /agy max-concurrent <0-64>', 'error')
          return
        }
        services.setOverride('maxConcurrent', Math.floor(n))
        publishAgyUi(ctx, services)
        emitOutput(ctx, n === 0 ? 'Max concurrent streams: unlimited' : `Max concurrent streams set to ${Math.floor(n)}`)
        return
      }
      if (sub === 'suppress-update' && rest[0]) {
        const on = rest[0].toLowerCase() === 'on' || rest[0].toLowerCase() === 'true'
        services.setOverride('suppressAgyAutoUpdate', on)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Suppress agy CLI auto-update: ${on ? 'enabled' : 'disabled'}`)
        return
      }
      if (sub === 'clear-cooldown') {
        services.pool.clearCooldown(rest[0] || undefined, undefined, true)
        publishAgyUi(ctx, services)
        emitOutput(ctx, 'Cleared all Antigravity cooldowns and low-quota benches')
        return
      }
      if (sub === 'pool-wide' && rest[0]) {
        const on = rest[0].toLowerCase() === 'on' || rest[0].toLowerCase() === 'true'
        services.setOverride('poolWideCatalog', on)
        registerAgyProvider()
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Pool-wide model catalog ${on ? 'enabled' : 'disabled'}`)
        return
      }
      if (sub === 'auto-fallback' && rest[0]) {
        const on = rest[0].toLowerCase() === 'on' || rest[0].toLowerCase() === 'true'
        services.setOverride('autoFallbackModel', on)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Auto fallback model ${on ? 'enabled' : 'disabled'}`)
        return
      }
      if (sub === 'warmup' && rest[0]) {
        const on = rest[0].toLowerCase() === 'on' || rest[0].toLowerCase() === 'true'
        services.setOverride('autoWarmup', on)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Auto 7-day warmup ${on ? 'enabled' : 'disabled'}`)
        return
      }
      if (sub === 'hidden-models') {
        const raw = rest.join(' ').trim()
        const list =
          !raw || raw === 'clear' || raw === 'none'
            ? []
            : raw
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean)
        services.setOverride('hiddenModels', list)
        registerAgyProvider()
        publishAgyUi(ctx, services)
        emitOutput(ctx, list.length > 0 ? `Hidden models: ${list.join(', ')}` : 'Cleared hidden models')
        return
      }
      if (sub === 'image-model') {
        const val = (rest[0] || '').trim()
        const nextModel = !val || val === 'default' || val === 'clear' ? '' : val
        services.setOverride('imageModel', nextModel)
        publishAgyUi(ctx, services)
        emitOutput(ctx, nextModel ? `Image generation model set to ${nextModel}` : 'Image generation model reset to default')
        return
      }
      if (sub === 'image-effort' && rest[0]) {
        const eff = rest[0].toLowerCase()
        if (!['low', 'medium', 'high'].includes(eff)) {
          emitOutput(ctx, 'Usage: /agy image-effort <low|medium|high>', 'error')
          return
        }
        services.setOverride('imageEffort', eff)
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Image generation effort set to ${eff}`)
        return
      }
      if (sub === 'image-timeout' && rest[0]) {
        const sec = Number(rest[0])
        if (!Number.isFinite(sec) || sec < 10 || sec > 1800) {
          emitOutput(ctx, 'Usage: /agy image-timeout <10-1800 seconds>', 'error')
          return
        }
        services.setOverride('imageTimeoutMs', Math.floor(sec * 1000))
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Image generation timeout set to ${Math.floor(sec)}s`)
        return
      }
      if (sub === 'image-retries' && rest[0]) {
        const n = Number(rest[0])
        if (!Number.isFinite(n) || n < 0 || n > 5) {
          emitOutput(ctx, 'Usage: /agy image-retries <0-5>', 'error')
          return
        }
        services.setOverride('imageRetries', Math.floor(n))
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Image generation retries set to ${Math.floor(n)}`)
        return
      }
      if (sub === 'image-dir') {
        const raw = rest.join(' ').trim()
        const nextDir = !raw || raw === 'clear' || raw === 'default' ? '' : raw
        services.setOverride('imageOutputDir', nextDir)
        publishAgyUi(ctx, services)
        emitOutput(ctx, nextDir ? `Image output directory set to ${nextDir}` : 'Image output directory reset to default')
        return
      }
      showStatus(ctx)
    },
  })

  function findAccount(query: string): ManagedAccount | undefined {
    const accounts = services.pool.getAccounts()
    const num = Number(query)
    if (Number.isInteger(num) && num >= 1 && num <= accounts.length) {
      return accounts[num - 1]
    }
    const q = query.toLowerCase()
    return accounts.find((a) => a.id.toLowerCase() === q || a.email?.toLowerCase() === q || a.alias.toLowerCase() === q)
  }

  async function runRefresh(ctx: ExtensionCommandContext): Promise<void> {
    emitOutput(ctx, 'Refreshing Antigravity quotas…')
    await services.quota.refreshAllQuotas(true).catch(() => undefined)
    lastQuotaRefreshAt = Date.now()
    await services.catalog.refreshIfNeeded().catch(() => undefined)
    publishAgyUi(ctx, services)
    emitOutput(ctx, 'Antigravity quotas refreshed.')
  }

  let authWatchTimer: ReturnType<typeof setInterval> | null = null

  function watchPoolAuthCompletion(): void {
    if (authWatchTimer) {
      clearInterval(authWatchTimer)
      authWatchTimer = null
    }
    let checks = 0
    authWatchTimer = setInterval(() => {
      checks += 1
      const st = services.poolAuth.status()
      if (st.phase === 'done') {
        if (authWatchTimer) {
          clearInterval(authWatchTimer)
          authWatchTimer = null
        }
        registerAgyProvider()
        publishAgyUi(lastUiCtx, services)
        if (lastUiCtx) {
          if (st.code === 'account_duplicate_updated') {
            emitOutput(
              lastUiCtx,
              `Account${st.alias ? ` ${st.alias}` : ''} already exists in the pool — updated its credentials instead of adding a duplicate.`,
              'warning',
            )
          } else {
            emitOutput(lastUiCtx, `Google OAuth completed${st.alias ? ` for ${st.alias}` : ''}.`)
          }
        }
        const activeId = services.pool.getActiveAccountId('google')
        void Promise.allSettled([
          activeId
            ? services.catalog.forceRefreshAndNotify(activeId).catch((err) => {
                warnThrottled('oauth-catalog', 'catalog refresh after OAuth failed', err)
              })
            : Promise.resolve(),
          services.quota.refreshAllQuotas(true).catch((err) => {
            warnThrottled('oauth-quota', 'quota refresh after OAuth failed', err)
          }),
        ]).finally(() => {
          lastQuotaRefreshAt = Date.now()
          registerAgyProvider()
          publishAgyUi(lastUiCtx, services)
        })
      } else if (st.phase === 'failed' || st.phase === 'idle' || checks >= 180) {
        if (authWatchTimer) {
          clearInterval(authWatchTimer)
          authWatchTimer = null
        }
        publishAgyUi(lastUiCtx, services)
        if (st.phase === 'failed' && lastUiCtx) {
          emitOutput(lastUiCtx, `Google OAuth failed (${st.code || 'unknown'}).`, 'error')
        }
      }
    }, 1000)
    authWatchTimer.unref?.()
  }

  async function runAddAccount(ctx: ExtensionCommandContext): Promise<void> {
    const res = await services.poolAuth.begin()
    if (res.ok) {
      emitOutput(ctx, res.url ? `Opened Google OAuth in browser (${res.url}). Complete sign-in to add account.` : 'Google OAuth started.')
      watchPoolAuthCompletion()
    } else {
      emitOutput(ctx, `Failed to start OAuth: ${res.code || 'unknown'}`, 'error')
    }
    publishAgyUi(ctx, services)
  }

  async function runPrimaryAuth(ctx: ExtensionCommandContext): Promise<void> {
    const res = await services.poolAuth.beginPrimary()
    if (res.ok) {
      emitOutput(ctx, 'Opened Google OAuth for primary account in browser.')
      watchPoolAuthCompletion()
    } else {
      emitOutput(ctx, `Failed to start primary OAuth: ${res.code || 'unknown'}`, 'error')
    }
    publishAgyUi(ctx, services)
  }

  function showDetails(ctx: ExtensionCommandContext, query?: string): void {
    const state = buildWidgetState(services)
    publishAgyUi(ctx, services)
    const target = query ? findAccount(query) : undefined
    const acc = target
      ? state.accounts.find((a) => a.id === target.id)
      : state.accounts.find((a) => a.active) ?? state.accounts[0]
    if (!acc) {
      emitOutput(ctx, query ? `Account not found: ${query}` : 'No accounts in pool.', 'warning')
      return
    }
    const header = `${acc.email || acc.alias} [${acc.tier}] | Priority: ${acc.priority} | Proxy: ${acc.proxyUrl || 'system/direct'}`
    const modelLines = acc.models.length > 0
      ? acc.models.map((m) => `  - ${m.name}: ${m.percentage}%${m.resetTime ? ` (reset ${m.resetTime})` : ''}`)
      : ['  (no sub-model quota data yet — run /agy refresh)']
    emitOutput(ctx, `${header}\nOfficial Sub-models & Quotas (${acc.models.length}):\n${modelLines.join('\n')}`)
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    const state = buildWidgetState(services)
    publishAgyUi(ctx, services)
    if (state.accounts.length === 0) {
      emitOutput(ctx, `AGY v${state.version ?? 'unknown'} | No accounts in pool. Run /agy add to sign in.`, 'warning')
      return
    }
    const lines = state.accounts.map((a) => {
      const mark = a.active ? '*' : ' '
      const q5 = a.fiveHourPct !== undefined ? `5h:${a.fiveHourPct}%${a.fiveHourReset ? `(${a.fiveHourReset})` : ''}` : '5h:?'
      const q7 = a.weeklyPct !== undefined ? `7d:${a.weeklyPct}%${a.weeklyReset ? `(${a.weeklyReset})` : ''}` : '7d:?'
      const qa = a.argonPct !== undefined ? ` argon:${a.argonPct}%${a.argonReset ? `(${a.argonReset})` : ''}` : ''
      const flags = [
        a.authRequired ? 'REAUTH' : '',
        a.cooldownUntil ? 'COOLDOWN' : '',
        a.proxyUrl ? `proxy=${a.proxyUrl}` : '',
      ].filter(Boolean).join(' ')
      return `${mark} ${a.priority}. ${a.email || a.alias} [${a.tier}] (${q5}, ${q7}${qa})${flags ? ` [${flags}]` : ''}`
    })
    emitOutput(ctx, `AGY v${state.version ?? 'unknown'}${state.dormantReason ? ` (DORMANT: ${state.dormantReason})` : ''}\n${lines.join('\n')}`)
  }
}
