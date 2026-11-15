export interface ToolExecution {
  toolCallId?: string
  name: string
  args?: unknown
  [key: string]: unknown
}

export type PreToolDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'modify'; args?: unknown }

export function defineTool<T>(def: T): T {
  return def
}
