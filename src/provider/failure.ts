// Pure failure classification for one agy attempt.
//
// Single place that turns process outcome + parser evidence + transport signals
// into a stable code/message; keeping it pure makes every branch testable
// without spawning agy.
import {
  Err,
  ELIGIBILITY_ERROR_HINT,
  HEADLESS_PERMISSION_ERROR_HINT,
  extractModelConfigDiagnostic,
  extractTransportDiagnostic,
  looksLikeAiCreditsLow,
  looksLikeContextWindowExceeded,
  looksLikeEligibilityFailure,
  looksLikeHardRateLimit,
  looksLikeHeadlessPermissionDenial,
  looksLikeModelConfigFetchFailure,
  looksLikePlanModelNotSpecified,
  looksLikeTosViolation,
  looksLikeValidationRequired,
} from '../common/types.ts'
import type { PluginConfig } from '../common/types.ts'

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

export interface AttemptFailure {
  kind: 'error' | 'aborted'
  code: string
  message: string
  retryAfterMs?: number
}

export interface FailureContext {
  cfg: PluginConfig
  outcome: {
    aborted: boolean
    capped: boolean
    timedOut: boolean
    idleGraceTerminated?: boolean
    code: number | null
    stderrTail: string
  }
  parser: {
    stats: {
      sawAuthFailure: boolean
      lastResultError: string | undefined
      garbage: number
    }
  }
  sawAuthFailure: boolean
  consumable: boolean
  transportFailure: boolean
  keyringJitter: boolean
  rawErrText: string
  runLogText?: string
  isRateLimit: boolean
  silentTimeout: boolean
}

function detailText(c: FailureContext, fallback = ''): string {
  return c.parser.stats.lastResultError ?? (c.outcome.stderrTail !== '' ? brief(c.outcome.stderrTail) : fallback)
}

function classifyPolicyOrQuota(c: FailureContext): AttemptFailure | null {
  if (c.sawAuthFailure) {
    return c.transportFailure
      ? {
          kind: 'error',
          code: Err.NETWORK,
          message: 'agy could not validate its Google login over the network (transport failure'
            + (c.keyringJitter ? '; its own log shows keyring auth timing out on the network, not a sign-out' : '')
            + ', not a sign-out) — retrying on another account. '
            + (c.rawErrText !== '' ? brief(c.rawErrText) : ''),
        }
      : { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login' }
  }
  if (c.isRateLimit) {
    const bestMsg = detailText(c, 'Rate limit or quota reached')
    const aiCreditsLow = looksLikeAiCreditsLow(c.rawErrText) || looksLikeAiCreditsLow(bestMsg)
    const hard = looksLikeHardRateLimit(c.rawErrText) || aiCreditsLow
    return {
      kind: 'error',
      code: hard ? Err.RATE_LIMIT : Err.OVERLOADED,
      message: aiCreditsLow
        ? 'Google Antigravity AI credits balance is too low: ' + bestMsg
        : hard
          ? 'Google Antigravity quota / rate limit reached: ' + bestMsg
          : 'Google Antigravity quota / rate limit reached (server capacity overloaded): ' + bestMsg,
    }
  }
  const resultErr = c.parser.stats.lastResultError ?? ''
  if (looksLikeContextWindowExceeded(c.rawErrText) || looksLikeContextWindowExceeded(resultErr)) {
    return {
      kind: 'error',
      code: Err.CONTEXT_WINDOW_EXCEEDED,
      message: 'Google Antigravity context window exceeded: ' + detailText(c, 'Prompt exceeds context window limit'),
    }
  }
  if (!c.transportFailure && (looksLikeEligibilityFailure(c.rawErrText) || looksLikeEligibilityFailure(resultErr))) {
    const detail = detailText(c)
    return {
      kind: 'error',
      code: Err.ELIGIBILITY,
      message: ELIGIBILITY_ERROR_HINT + (detail !== '' ? ' (' + detail + ')' : ''),
    }
  }
  if (!c.transportFailure && (looksLikeTosViolation(c.rawErrText) || looksLikeTosViolation(resultErr))) {
    // Terminal Google suspension (TOS_VIOLATION): non-rotatable AGY_ERROR stops
    // DSH immediately (preventing an IP-correlated ban sweep across sibling
    // accounts) while finalizeAttempt quarantines ONLY this account.
    return {
      kind: 'error',
      code: Err.AGY_ERROR,
      message: 'Google Antigravity account suspended (TOS_VIOLATION): ' + detailText(c, brief(c.rawErrText)),
    }
  }
  if (!c.transportFailure && (looksLikeValidationRequired(c.rawErrText) || looksLikeValidationRequired(resultErr))) {
    return {
      kind: 'error',
      code: Err.AGY_ERROR,
      message: 'Google Antigravity account requires verification (VALIDATION_REQUIRED): ' + detailText(c, brief(c.rawErrText)),
    }
  }
  if (looksLikeHeadlessPermissionDenial(c.rawErrText) || looksLikeHeadlessPermissionDenial(resultErr)) {
    const detail = detailText(c)
    return {
      kind: 'error',
      code: Err.AGY_ERROR,
      message: HEADLESS_PERMISSION_ERROR_HINT + (detail !== '' ? ' (' + detail + ')' : ''),
    }
  }
  const combinedErr = [c.rawErrText, resultErr, c.runLogText ?? ''].filter(Boolean).join('\n')
  const planModelMissing = looksLikePlanModelNotSpecified(c.rawErrText) || looksLikePlanModelNotSpecified(resultErr)
  const modelConfigFetchFailed = looksLikeModelConfigFetchFailure(combinedErr)
  if (planModelMissing || modelConfigFetchFailed) {
    if (c.transportFailure) {
      const netDetail = extractTransportDiagnostic(c.runLogText)
        ?? extractTransportDiagnostic(c.rawErrText)
        ?? detailText(c, brief(c.rawErrText))
      return {
        kind: 'error',
        code: Err.NETWORK,
        message: 'Network/proxy error prevented agy from fetching model config — check proxy or network connectivity (网络/代理异常导致 agy 无法拉取模型配置，并非所选模型无效，请检查代理或网络): '
          + (netDetail !== '' ? netDetail : brief(c.rawErrText)),
      }
    }
    if (modelConfigFetchFailed) {
      const cfgDetail = extractModelConfigDiagnostic(c.runLogText)
        ?? extractModelConfigDiagnostic(c.rawErrText)
        ?? detailText(c, brief(c.rawErrText))
      return {
        kind: 'error',
        code: Err.AGY_ERROR,
        message: 'agy failed to fetch available model config from server — not a network disconnect; try /agy refresh or switch account (无法拉取可用模型配置，非网络断连，请尝试 /agy refresh 或切换账号): '
          + (cfgDetail !== '' ? cfgDetail : brief(c.rawErrText)),
      }
    }
    return {
      kind: 'error',
      code: Err.UNKNOWN_MODEL,
      message: 'agy could not apply the selected model (未指定或当前账号不支持所选模型，请重新选择模型或刷新模型列表): '
        + detailText(c, brief(c.rawErrText)),
    }
  }
  return null
}

function classifyExitOrFallback(c: FailureContext): AttemptFailure {
  const netDetail = c.transportFailure
    ? (extractTransportDiagnostic(c.runLogText) ?? extractTransportDiagnostic(c.rawErrText))
    : undefined
  if (c.outcome.code !== 0) {
    // `detailText` only looks at the parsed result / stderr. The ACP path's own
    // exception (e.g. "ACP prompt returned an empty turn: ...") lives in
    // rawErrText, and dropping it turned every such failure into the useless
    // "agy exited with code 1". Fall back to it when nothing else is present.
    const detail = detailText(c, brief(c.rawErrText))
    return c.transportFailure
      ? {
          kind: 'error',
          code: Err.NETWORK,
          message: 'agy hit a network error while talking to Google — the automatic retry usually succeeds (网络连接异常，通常会自动重试成功): '
            + (netDetail ?? (detail !== '' ? detail : brief(c.rawErrText))),
        }
      : { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + c.outcome.code + (detail !== '' ? ': ' + detail : '') }
  }
  if (c.transportFailure) {
    return {
      kind: 'error',
      code: Err.NETWORK,
      message: 'agy hit a network error while talking to Google — the automatic retry usually succeeds (网络连接异常，通常会自动重试成功): '
        + (netDetail ?? brief(c.rawErrText)),
    }
  }
  if (c.parser.stats.lastResultError) {
    return { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + c.parser.stats.lastResultError }
  }
  return { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + c.parser.stats.garbage + ' unparseable lines)' }
}

export function classifyFailure(c: FailureContext): AttemptFailure | null {
  if (c.outcome.aborted) {
    return { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
  }
  if (c.outcome.capped) {
    return {
      kind: 'error',
      code: Err.TIMEOUT,
      message: 'agy turn exceeded maxTurnMinutes (' + c.cfg.maxTurnMinutes + ' min) — the agy process tree was terminated. Re-send to continue. 本轮超过 maxTurnMinutes 上限，已终止 agy 进程树',
    }
  }
  if (c.outcome.timedOut) {
    return {
      kind: 'error',
      code: Err.TIMEOUT,
      message: 'agy run was idle for ' + c.cfg.timeoutMs + 'ms without output'
        + (c.silentTimeout
          ? ' — agy never emitted a single event; it is likely unable to reach Google (check proxy/network). 无法连接 Google，请检查代理或网络配置'
          : ''),
    }
  }
  if (c.outcome.idleGraceTerminated || c.consumable) {
    return null
  }
  return classifyPolicyOrQuota(c) ?? classifyExitOrFallback(c)
}
