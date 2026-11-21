// /agy config: permission mode, effort, dispatch guards, parallelism and workspace.
import { isAbsolute } from 'node:path'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { formatTokenCount } from '../../common/compaction.ts'
import { parseCompactLimitValue, resolveEffectiveCompactLimit } from '../../common/compact-threshold.ts'
import { isEffortId, REASONING_EFFORTS } from '../../common/reasoning.ts'
import { credentialSlotMutex, fastPathRunCount } from '../credential-slot.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

export function handleConfig(deps: CommandDeps, ctx: CommandContext): CommandResult {
  const { sub, arg, raw } = ctx

  if (sub === 'mode') {
    if (arg === '') {
      return ok(`Current permission mode: **${deps.cfg().permissionMode}** (usage: /agy mode <skip|auto|plan|accept-edits>)`)
    }
    if (!['skip', 'auto', 'plan', 'accept-edits'].includes(arg)) {
      return err('usage: /agy mode <skip|auto|plan|accept-edits>')
    }
    deps.setOverride('permissionMode', arg)
    return ok('Permission mode set to **' + arg + '** — effective next turn.')
  }

  if (sub === 'sandbox') {
    if (arg === '') {
      return ok(`Current terminal sandbox: **${deps.cfg().sandbox ? 'on' : 'off'}** (usage: /agy sandbox <on|off>)`)
    }
    if (arg !== 'on' && arg !== 'off') {
      return err('usage: /agy sandbox <on|off>')
    }
    const on = arg === 'on'
    deps.setOverride('sandbox', on)
    return ok(`Terminal sandbox set to **${arg}** — effective next turn.`)
  }

  if (sub === 'agent') {
    const rawAgent = (raw ?? '').trim().replace(/^(?:\/agy\s+)?agent\s*/i, '').trim()
    const target = rawAgent !== '' ? rawAgent : arg
    if (target === '') {
      const cur = deps.cfg().agent.trim()
      return ok('Current custom agent: **' + (cur !== '' ? cur : '(default)') + '** (usage: /agy agent <name|off>)')
    }
    if (target === 'off' || target === 'clear' || target === 'default') {
      deps.setOverride('agent', '')
      return ok('Custom agent cleared (back to default agy agent) — effective next turn.')
    }
    deps.setOverride('agent', target)
    return ok(`Custom agent set to **${target}** — effective next turn.`)
  }

  if (sub === 'settings') {
    const rawVal = (raw ?? '').trim().replace(/^(?:\/agy\s+)?settings\s*/i, '').trim()
    const target = rawVal !== '' ? rawVal : arg
    if (target === '' || target === 'show') {
      const cur = deps.cfg().agySettings.trim()
      return ok('Current `--settings` override: ' + (cur !== '' ? '`' + cur + '`' : '*(none)*'))
    }
    if (target === 'off' || target === 'clear') {
      deps.setOverride('agySettings', '')
      return ok('Cleared `--settings` override.')
    }
    if (target.startsWith('{')) {
      try {
        const parsed = JSON.parse(target)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return err('inline --settings JSON must be a plain object')
        }
      } catch (e) {
        return err('invalid inline JSON for --settings: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    deps.setOverride('agySettings', target)
    return ok('`--settings` override updated — effective next turn.')
  }

  if (sub === 'transport') {
    const cur = deps.cfg().transport
    if (arg === '' || arg === 'status') {
      const st = deps.acpStatus?.()
      const extra = st ? ` (ACP active processes: ${st.activeProcesses}, sessions: ${st.sessions})` : ''
      return ok(`Current transport: **${cur}**${extra} (usage: /agy transport <cli|acp>)`)
    }
    const mode = arg.toLowerCase()
    if (mode !== 'cli' && mode !== 'acp') {
      return err('usage: /agy transport <cli|acp|status>')
    }
    deps.setOverride('transport', mode)
    return ok(`Transport set to **${mode}** — effective next turn.`)
  }

  if (sub === 'effort') {
    if (arg === '') {
      const cur = deps.cfg().defaultEffort || 'model default'
      return ok(`Current default effort: **${cur}** (usage: /agy effort <${REASONING_EFFORTS.join('|')}|default>)`)
    }
    const normalized = arg.toLowerCase()
    if (normalized !== 'default' && !isEffortId(normalized)) {
      return err(`usage: /agy effort <${REASONING_EFFORTS.join('|')}|default>`)
    }
    deps.setOverride('defaultEffort', normalized === 'default' ? '' : normalized)
    deps.notifyPicker?.()
    return ok('Default effort set to **' + (normalized === 'default' ? 'model default' : normalized) + '**.')
  }

  if (sub === 'dispatch' || sub === 'dispatch-retries') {
    const cfg = deps.cfg()
    const mutex = credentialSlotMutex
    if (arg === '') {
      const cap = cfg.dispatchTimeoutMinutes > 0 ? `${cfg.dispatchTimeoutMinutes} 分钟/次` : '不限时（无限等待）'
      const lines = [
        '**Agy 派发守护（dispatch guards）**',
        `- 硬超时：**${cap}**（重试次数 ${cfg.dispatchRetries}${cfg.dispatchTimeoutMinutes > 0 ? `，总坚持 ≈ ${(1 + cfg.dispatchRetries) * cfg.dispatchTimeoutMinutes} 分钟` : ''}）`,
        '- 同账号并行：**' + (cfg.parallelSameAccount ? '开（快路径，多会话并行跑同一账号）' : '关（同一时刻仅 1 个 agy 进程）') + '**',
        `- 并发上限：**${cfg.maxConcurrent > 0 ? cfg.maxConcurrent + ' 个流' : '不限制（原生并发）'}**`,
        `- 当前凭据槽位队列：**${mutex.waiting} 个等待者 / ${mutex.pending - mutex.waiting} 个持有者**，同身份并行活跃 **${fastPathRunCount()}** 个（主账号快路径 + 次级同授权租约）`,
        `- 排队期间：Stop 随时可停；丢失唤醒 5 秒内自愈；每 2 分钟心跳日志`,
        `- 修改：/agy dispatch <分钟|off>　/agy dispatch-retries <次数>　/agy parallel <on|off>`,
      ]
      return ok(lines.join('\n'))
    }
    if (sub === 'dispatch') {
      if (arg === 'off' || arg === '0') {
        deps.setOverride('dispatchTimeoutMinutes', 0)
        return ok('派发硬超时已关闭：排队将无限等待（仍然 Stop 可停、轮询自愈、心跳可见）。')
      }
      const minutes = Number(arg)
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(minutes)) {
        return err('usage: /agy dispatch <分钟数|off>')
      }
      deps.setOverride('dispatchTimeoutMinutes', minutes)
      return ok(
        `派发硬超时设为 **${minutes} 分钟/次**（含 ${cfg.dispatchRetries} 次重试，总坚持 ≈ ${(1 + cfg.dispatchRetries) * minutes} 分钟）— 下一个回合生效。`,
      )
    }
    const retries = Number(arg)
    if (!Number.isFinite(retries) || retries < 0 || !Number.isInteger(retries) || retries > 10) {
      return err('usage: /agy dispatch-retries <0-10>')
    }
    deps.setOverride('dispatchRetries', retries)
    const cap = cfg.dispatchTimeoutMinutes > 0 ? `，总坚持 ≈ ${(1 + retries) * cfg.dispatchTimeoutMinutes} 分钟` : ''
    return ok(`派发重试次数设为 **${retries}**${cap} — 下一个回合生效。`)
  }

  if (sub === 'parallel') {
    if (arg !== 'on' && arg !== 'off') {
      return err('usage: /agy parallel <on|off>')
    }
    const on = arg === 'on'
    deps.setOverride('parallelSameAccount', on)
    return ok(
      on
        ? '同账号并行已**开启**：同一账号的多个会话立即并行跑 agy（无需独占凭据槽位），仅账号切换时串行 — 下一个回合生效。'
        : '同账号并行已**关闭**：恢复同一时刻仅 1 个 agy 进程（全串行）— 下一个回合生效。',
    )
  }

  if (sub === 'max-concurrent') {
    if (arg === 'off' || arg === '0') {
      deps.setOverride('maxConcurrent', 0)
      return ok('并发上限已移除：**不限制**（原生 agy 并发，Google 速率与账号冷却为天然调节）— 下一个回合生效。')
    }
    const n = Number(arg)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 64) {
      return err('usage: /agy max-concurrent <1-64|off>')
    }
    deps.setOverride('maxConcurrent', n)
    return ok(`并发上限设为 **${n}** 个请求流 — 下一个回合生效。`)
  }

  if (sub === 'workspace') {
    const rawPath = (raw ?? '').trim().replace(/^(?:\/agy\s+)?workspace\s*/i, '').trim()
    const target = rawPath !== '' ? rawPath : arg
    if (target === '') return ok('Current workspace: ' + (deps.cfg().workspaceRoot !== '' ? deps.cfg().workspaceRoot : '(session cwd / process cwd)'))
    if (target === 'default' || target === 'clear') {
      deps.setOverride('workspaceRoot', '')
      return ok('Workspace reset to session cwd / process cwd.')
    }
    if (!isAbsolute(target)) return err('workspace must be an absolute path (or `default` to clear)')
    deps.setOverride('workspaceRoot', target)
    return ok('Workspace set to **' + target + '** — effective next turn.')
  }

  if (sub === 'compact-limit') {
    const cfg = deps.cfg()
    if (arg === '') {
      const b = resolveEffectiveCompactLimit(cfg)
      return ok(
        `当前有效压缩阈值：**${formatTokenCount(b.effectiveLimit)}**（来源：${b.source}；模型物理窗口 ${formatTokenCount(b.physicalWindow)}；agy 默认 ${formatTokenCount(b.defaultLimit)}）\n` +
          `修改：\`/agy compact-limit <512k|900k|tokens|default>\``,
      )
    }
    if (arg === 'default' || arg === 'off' || arg === '0' || arg === 'clear') {
      deps.setOverride('autoCompactOverride', 0)
      const b = resolveEffectiveCompactLimit({ ...cfg, autoCompactOverride: 0 })
      return ok(`已恢复默认压缩阈值：**${formatTokenCount(b.effectiveLimit)}**（来源：${b.source}）— 下一轮生效。`)
    }
    const parsed = parseCompactLimitValue(arg)
    if (parsed === null) return err('usage: /agy compact-limit <tokens|256k|512k|900k|default> (10k..2m)')
    deps.setOverride('autoCompactOverride', parsed)
    return ok(`已设置 agy 自动压缩阈值为 **${formatTokenCount(parsed)}**（${parsed} tokens）— 下一轮生效。`)
  }

  if (sub === 'net') {
    const cfg = deps.cfg()
    if (arg === '') {
      return ok(
        `**网络配置**\n- 模型 API 重试（AGY_CLI_MODEL_API_MAX_RETRIES）：**${cfg.modelApiMaxRetries}**\n` +
          `- 全局代理（proxyUrl）：**${cfg.proxyUrl || '未设置'}**\n` +
          `- 禁用遥测（disableTelemetry）：**${cfg.disableTelemetry ? '开' : '关'}**\n` +
          `- 修改：\`/agy net retries <0-10>\` 或 \`/agy net proxy <url|clear>\``,
      )
    }
    const netSub = ctx.parts[1] ?? ''
    const netVal = ctx.parts.slice(2).join(' ').trim()
    if (netSub === 'retries') {
      if (netVal === '') return err('usage: /agy net retries <0-10>')
      const n = Number(netVal)
      if (!Number.isInteger(n) || n < 0 || n > 10) return err('usage: /agy net retries <0-10>')
      deps.setOverride('modelApiMaxRetries', n)
      return ok(`已设置模型 API 重试次数为 **${n}** — 下一轮生效。`)
    }
    if (netSub === 'proxy') {
      if (netVal === '' || netVal === 'clear' || netVal === 'off') {
        deps.setOverride('proxyUrl', '')
        return ok('已清除全局代理设置 — 下一轮生效。')
      }
      deps.setOverride('proxyUrl', netVal)
      return ok(`已设置全局代理为 **${netVal}** — 下一轮生效。`)
    }
    return err('usage: /agy net [retries <0-10>|proxy <url|clear>]')
  }

  if (sub === 'slim') {
    const cfg = deps.cfg()
    if (arg === '') {
      return ok(`精简执行约束（slimPromptRules）：**${cfg.slimPromptRules ? '开' : '关'}**（usage: \`/agy slim <on|off>\`）`)
    }
    if (arg !== 'on' && arg !== 'off') return err('usage: /agy slim <on|off>')
    const on = arg === 'on'
    deps.setOverride('slimPromptRules', on)
    return ok(`精简执行约束已**${on ? '开启' : '关闭'}** — 下一轮生效。`)
  }

  return err(`Unknown config command \`${sub}\`.`)
}
