import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createHostServices } from '../host/services.ts'
import { runBootHygiene } from '../host/boot-hygiene.ts'
import { MIN_AGY_VERSION, compareVersions, parseVersion, probeProcess } from '../host/runner.ts'
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
  accounts: AgyWidgetAccount[]
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
  const catalog = services.catalog.get()
  const rawModels = catalog.models
  return rawModels.map((m) => {
    const efforts = Array.isArray(m.efforts) ? m.efforts : []
    const supportsReasoning = efforts.length > 0
    const thinkingLevelMap: Record<string, string | null> = {}
    if (supportsReasoning) {
      for (const lvl of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        if (efforts.includes(lvl)) thinkingLevelMap[lvl] = lvl
        else if (lvl === 'xhigh' && efforts.includes('high')) thinkingLevelMap[lvl] = 'high'
        else if (lvl === 'max' && efforts.includes('xhigh')) thinkingLevelMap[lvl] = 'xhigh'
        else if (lvl === 'max' && efforts.includes('high')) thinkingLevelMap[lvl] = 'high'
        else if (lvl === 'minimal' && efforts.includes('low')) thinkingLevelMap[lvl] = 'low'
        else thinkingLevelMap[lvl] = null
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

    const tier = acc.dedicatedGroups?.includes('argon') || arg !== undefined ? 'PRO/ULTRA' : 'STANDARD'

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

  return {
    version: services.status.version,
    dormantReason: services.status.dormantReason,
    activeAccountId: activeId,
    accounts: mappedAccounts,
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

function convertPiMessagesToDsh(context: { systemPrompt?: string; messages?: Array<{ role: string; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean }> }): Message[] {
  const out: Message[] = []
  for (const m of context.messages ?? []) {
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content })
      } else if (Array.isArray(m.content)) {
        const parts = m.content
          .map((p: any) => {
            if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
              return { type: 'text', text: p.text }
            }
            return null
          })
          .filter((x): x is { type: string; text: string } => x !== null)
        if (parts.length > 0) {
          out.push({ role: m.role, content: parts })
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
  const mockCtx: CordisContext = {
    logger: {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    },
    get: () => undefined,
    effect: () => () => {},
    on: () => () => {},
    emit: () => {},
  }

  const services = createHostServices(mockCtx, {})
  runBootHygiene(services)

  let lastUiCtx: ExtensionContext | undefined

  const refreshBootState = async () => {
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
    publishAgyUi(lastUiCtx, services)
  }

  void refreshBootState()

  const initialModels = mapCatalogToPiModels(services)

  pi.registerProvider(AGY_PROVIDER_ID, {
    name: AGY_PROVIDER_NAME,
    baseUrl: 'agy-cli://local',
    api: AGY_PROVIDER_ID,
    apiKey: 'agy-cli-local',
    models: initialModels,
    refreshModels: async () => {
      const poolData = services.pool.getPoolData()
      const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
      await services.catalog.refreshIfNeeded(activeId).catch(() => undefined)
      return mapCatalogToPiModels(services)
    },
    streamSimple: (model: any, context: any, options?: any) => {
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
            model: model.id,
            messages: dshMessages,
            systemPrompt: context.systemPrompt,
            sessionId: options?.sessionId ?? 'pi-session',
            signal: options?.signal,
            reasoningEffort: reasoning,
          })

          let textIndex: number | null = null
          let thinkingIndex: number | null = null
          let textAcc = ''
          let thinkingAcc = ''
          let finishReason: 'stop' | 'length' | 'error' | 'aborted' = 'stop'

          for await (const chunk of iter as AsyncIterable<StreamChunk>) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              if (textIndex === null) {
                textIndex = partial.content.length
                partial.content.push({ type: 'text', text: '' })
                stream.push({ type: 'text_start', contentIndex: textIndex, partial })
              }
              textAcc += chunk.text
              partial.content[textIndex].text = textAcc
              stream.push({ type: 'text_delta', contentIndex: textIndex, delta: chunk.text, partial })
            } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
              if (thinkingIndex === null) {
                thinkingIndex = partial.content.length
                partial.content.push({ type: 'thinking', thinking: '' })
                stream.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial })
              }
              thinkingAcc += chunk.text
              partial.content[thinkingIndex].thinking = thinkingAcc
              stream.push({ type: 'thinking_delta', contentIndex: thinkingIndex, delta: chunk.text, partial })
            } else if (chunk.type === 'usage' && chunk.usage) {
              const u = chunk.usage as TokenUsage
              partial.usage.input = u.inputTokens ?? partial.usage.input
              partial.usage.output = u.outputTokens ?? partial.usage.output
              partial.usage.cacheRead = u.cacheReadTokens ?? partial.usage.cacheRead
              partial.usage.cacheWrite = u.cacheWriteTokens ?? partial.usage.cacheWrite
              partial.usage.totalTokens = u.totalTokens ?? partial.usage.input + partial.usage.output + partial.usage.cacheRead
            } else if (chunk.type === 'finish' && chunk.reason) {
              if (chunk.reason.kind === 'error') {
                finishReason = 'error'
                partial.errorMessage = chunk.reason.error?.message || 'agy stream error'
              } else if (chunk.reason.kind === 'length') {
                finishReason = 'length'
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
          if (finishReason === 'error') {
            stream.push({ type: 'error', reason: 'error', error: partial })
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
    },
  } as any)

  pi.on('session_start', async (_event, ctx) => {
    lastUiCtx = ctx
    publishAgyUi(ctx, services)
  })

  pi.on('turn_end', async (_event, ctx) => {
    lastUiCtx = ctx
    publishAgyUi(ctx, services)
  })

  pi.on('session_shutdown', async () => {
    lastUiCtx = undefined
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
        model: params.model || 'gemini-3.6-flash',
        messages: [{ role: 'user', content: params.prompt }],
        sessionId: `agy_ask_${Date.now()}`,
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
      if (sub === 'primary') return await runPrimaryAuth(ctx)
      if (sub === 'details' || sub === 'models') return showDetails(ctx, rest[0])
      if (sub === 'switch' && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        services.pool.setActiveAccount(target.id, 'google')
        publishAgyUi(ctx, services)
        emitOutput(ctx, `Switched active AGY account to ${target.email || target.alias}`)
        return
      }
      if (sub === 'remove' && rest[0]) {
        const target = findAccount(rest[0])
        if (!target) {
          emitOutput(ctx, `Account not found: ${rest[0]}`, 'error')
          return
        }
        services.pool.removeAccount(target.id)
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
    await services.catalog.refreshIfNeeded().catch(() => undefined)
    publishAgyUi(ctx, services)
    emitOutput(ctx, 'Antigravity quotas refreshed.')
  }

  async function runAddAccount(ctx: ExtensionCommandContext): Promise<void> {
    const res = await services.poolAuth.begin()
    if (res.ok) {
      emitOutput(ctx, res.url ? `Opened Google OAuth in browser (${res.url}). Complete sign-in to add account.` : 'Google OAuth started.')
    } else {
      emitOutput(ctx, `Failed to start OAuth: ${res.error || res.code || 'unknown'}`, 'error')
    }
    publishAgyUi(ctx, services)
  }

  async function runPrimaryAuth(ctx: ExtensionCommandContext): Promise<void> {
    const res = await services.poolAuth.beginPrimary()
    if (res.ok) {
      emitOutput(ctx, 'Opened Google OAuth for primary account in browser.')
    } else {
      emitOutput(ctx, `Failed to start primary OAuth: ${res.error || res.code || 'unknown'}`, 'error')
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
