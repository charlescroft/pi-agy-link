export interface CommandInvocation {
  args?: string[]
  raw?: string
  sessionId?: string
  cwd?: string
  [key: string]: unknown
}

export interface CommandResult {
  ok?: boolean
  text?: string
  markdown?: string
  error?: string
  [key: string]: unknown
}

export interface CommandDefinition {
  name: string
  description?: string
  usage?: string
  execute: (inv: CommandInvocation) => Promise<CommandResult> | CommandResult
  [key: string]: unknown
}
