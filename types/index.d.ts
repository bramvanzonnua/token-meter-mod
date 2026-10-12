export type Tally = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Last = {
  tally: Tally
  usd: number | null
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      session: Tally
      pending: Tally
      prompts: number
      last: Last | null
      costBefore: number
      warned: boolean
      hinted: boolean
      line: string | null
    }
  }
}
