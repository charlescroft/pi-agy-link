export interface Context {
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void }
  effect?(fn: () => (() => void) | void, name?: string): () => void
  get?(name: string): unknown
  on?(event: string, fn: (...args: unknown[]) => unknown): () => void
  emit?(event: string, ...args: unknown[]): void
}
