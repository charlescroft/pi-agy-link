export type ToolCallId = string & { readonly __brand?: 'ToolCallId' }

export const ToolCallId = (id: string): ToolCallId => id as ToolCallId
export const CallId = ToolCallId

export function asToolCallId(id: string): ToolCallId {
  return id as ToolCallId
}

export function asMessageId(id: string): string {
  return id
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  [key: string]: unknown
}

export type LlmFailure = {
  code?: string
  message: string
  retryable?: boolean
  [key: string]: unknown
}

export interface LlmModelInfo {
  id: string
  name?: string
  provider?: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEfforts?: string[]
  supportsReasoning?: boolean
  supportsImages?: boolean
  [key: string]: unknown
}

export interface LlmProviderInfo {
  id: string
  name: string
  models?: LlmModelInfo[]
  [key: string]: unknown
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  provider: string
  [key: string]: unknown
}

export interface MessagePart {
  type: string
  text?: string
  [key: string]: unknown
}

export interface Message {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | MessagePart[]
  source?: { kind?: string; [key: string]: unknown }
  toolCallId?: ToolCallId
  toolName?: string
  isError?: boolean
  [key: string]: unknown
}

export interface GenerateOptions {
  model: string
  messages: Message[]
  systemPrompt?: string
  sessionId?: string
  signal?: AbortSignal
  reasoningEffort?: string
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
      type: 'block-end'
      index: number
      block:
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId?: ToolCallId; name: string; args?: unknown }
    }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: { kind: string; error?: LlmFailure; [key: string]: unknown } }
  | { type: 'notice'; message: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

export class LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('Not implemented')
  }
}

export class LlmError extends Error {
  readonly code: string
  readonly retryable?: boolean
  readonly details?: unknown

  constructor(message: string, code = 'LLM_ERROR', details?: unknown) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.details = details
  }
}

export function createUserMessage(init: {
  content: string | MessagePart[]
  source?: { kind?: string; [key: string]: unknown }
}): Message {
  return {
    role: 'user',
    content: init.content,
    source: init.source ?? { kind: 'user' },
  }
}
