// Live subagent registry.
//
// `SubagentTracker` instances are created per attempt inside the provider/ACP
// layers and were previously invisible to anything outside that attempt: the
// only trace of a running agy-internal subagent was a scrolling reasoning line.
// The header badge needs an aggregate view ("how many are running, and what is
// each one doing"), so each tracker registers itself here for the life of its
// run and the status route reads a snapshot.
//
// Keyed by DSH session id so a session's header only reports its OWN subagents.
/**
 * How long a tracked subagent may go without observed activity before the panel
 * stops calling it "running". agy never flips a finished descriptor off
 * SUBAGENT_STATE_ALIVE, so descriptor state cannot prove life; recent transcript
 * activity can, and the round ending (tracker.stop) settles the rest.
 */
export interface BackgroundTaskSnapshot {
  id: string
  command?: string
  status?: string
  logPath?: string
  outputTail: string
  startedAt?: number
  [key: string]: unknown
}

export const SUBAGENT_LIVE_WINDOW_MS = 10 * 60_000

export interface SubagentSnapshotItem {
  conversationId: string
  role: string
  typeName: string
  state?: string
  running: boolean
  lastAction: string
  startedAt: number
  lastAt: number
}

export interface SubagentSnapshot {
  total: number
  running: number
  items: SubagentSnapshotItem[]
}

export interface SessionSubagentSnapshot extends SubagentSnapshot {
  session: string
}

export interface SubagentTrackable {
  snapshot(): SubagentSnapshot
  backgroundTasks?(): BackgroundTaskSnapshot[]
}

const live = new Map<string, SubagentTrackable[]>()
const bgTaskSinks = new Set<(tasks: BackgroundTaskSnapshot[]) => void>()

export function registerBackgroundTaskWidgetSink(sink: (tasks: BackgroundTaskSnapshot[]) => void): () => void {
  bgTaskSinks.add(sink)
  return () => {
    bgTaskSinks.delete(sink)
  }
}

export function hasBackgroundTaskWidgetSink(): boolean {
  return bgTaskSinks.size > 0
}

export function snapshotBackgroundTasks(sessionKey?: string): BackgroundTaskSnapshot[] {
  const byId = new Map<string, BackgroundTaskSnapshot>()
  const entries = sessionKey ? [[sessionKey, live.get(sessionKey) ?? []] as const] : Array.from(live.entries())
  for (const [, trackers] of entries) {
    for (const tr of trackers) {
      const list = tr.backgroundTasks?.() ?? []
      for (const item of list) {
        byId.set(item.id, item)
      }
    }
  }
  return Array.from(byId.values())
}

export function notifyBackgroundTasksChanged(): void {
  if (bgTaskSinks.size === 0) return
  const tasks = snapshotBackgroundTasks()
  for (const sink of bgTaskSinks) {
    try {
      sink(tasks)
    } catch {
      // ignore sink errors
    }
  }
}

export function attachSubagentTracker(sessionKey: string, tracker: SubagentTrackable): void {
  if (sessionKey === '') return
  const list = live.get(sessionKey) ?? []
  if (!list.includes(tracker)) list.push(tracker)
  live.set(sessionKey, list)
  notifyBackgroundTasksChanged()
}

export function detachSubagentTracker(sessionKey: string, tracker: SubagentTrackable): void {
  if (sessionKey === '') return
  const list = live.get(sessionKey)
  if (list === undefined) return
  const next = list.filter((t) => t !== tracker)
  if (next.length === 0) live.delete(sessionKey)
  else live.set(sessionKey, next)
  notifyBackgroundTasksChanged()
}

/** Every session that currently has at least one tracked subagent. */
export function snapshotSubagents(): SessionSubagentSnapshot[] {
  const out: SessionSubagentSnapshot[] = []
  for (const [session, trackers] of live) {
    const items: SubagentSnapshotItem[] = []
    for (const tr of trackers) items.push(...tr.snapshot().items)
    if (items.length === 0) continue
    out.push({
      session,
      total: items.length,
      running: items.filter((i) => i.running).length,
      items,
    })
  }
  return out
}
