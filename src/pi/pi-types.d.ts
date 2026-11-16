declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionUI {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
    select(prompt: string, items: string[]): Promise<string | undefined>
    setStatus(key: string, text: string): void
    setWidget(key: string, lines: string[]): void
  }

  export interface ExtensionContext {
    hasUI: boolean
    ui: ExtensionUI
    cwd?: string
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface ExtensionToolDef<TParams = any> {
    name: string
    label?: string
    description: string
    parameters: TParams
    execute: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<{
      content: Array<{ type: 'text'; text: string }>
      details?: unknown
    }>
  }

  export interface ExtensionCommandDef {
    description?: string
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
  }

  export interface ExtensionAPI {
    registerProvider(id: string, config: Record<string, unknown>): void
    registerTool(tool: ExtensionToolDef): void
    registerCommand(name: string, command: ExtensionCommandDef): void
    on(event: 'session_start' | 'turn_end' | 'session_shutdown', handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void
    on(event: string, handler: (...args: any[]) => Promise<void> | void): void
  }
}

declare module '@earendil-works/pi-ai' {
  export interface AssistantMessageEventStream {
    push(event: Record<string, unknown>): void
  }
  export function createAssistantMessageEventStream(): AssistantMessageEventStream
}
