import { test, expect, mock } from 'claude-code/testing'

const usage = (input: number, out: number, read: number, write: number) => ({
  input_tokens: input,
  output_tokens: out,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  model: 'claude-test',
})

const base = { answer: 'ok', durationMs: 10, isAborted: false, reason: 'answer' as const }

test('tokens only when the host has no usage figures; subagents folded in', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const lines: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => {
    throw new Error('no usage here')
  })
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))

  await $.turn.complete({ ...base, turnId: 's1', agentId: 'a1', usage: usage(1000, 100, 0, 0) })
  expect(lines.length).toBe(0)

  // 1000 + 0.1*10000 + 2*500 + 5*200 = 4000, plus subagent 1500 → 5.5k
  await $.turn.complete({ ...base, turnId: 't1', usage: usage(1000, 200, 10000, 500) })
  expect(lines[0]).toContain('Last ≈ 5.5k tok')
  expect(lines[0]).toContain('session ≈ 5.5k tok')
  expect(lines[0]).toContain('cache warm 60m')
})

test('cost, context, plan limits, 80% warning and the command', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const lines: (string | undefined)[] = []
  const toasts: string[] = []
  let cost = 1.0
  let percent = 41
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined } as never
  })
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { tokens: percent * 2000, window: 200000, percent },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 22.4 },
      { kind: 'seven_day', percentUsed: 9 },
    ],
    cost: { usd: cost },
  } }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))

  await $.turn.complete({ ...base, turnId: 't1', usage: usage(100, 10, 1000, 0) })
  expect(lines.at(-1)).toContain('session $1.00')
  expect(lines.at(-1)).toContain('context 41%')
  expect(lines.at(-1)).toContain('5h 22%')
  expect(lines.at(-1)).toContain('week 9%')

  percent = 65
  await $.turn.complete({ ...base, turnId: 't1b', usage: usage(100, 10, 1000, 0) })
  expect(lines.at(-1)).toContain('try /caveman')
  expect(toasts.length).toBe(1)

  cost = 1.31
  percent = 82
  await $.turn.complete({ ...base, turnId: 't2', usage: usage(100, 10, 1000, 0) })
  expect(lines.at(-1)).toContain('($0.31)')
  expect(lines.at(-1)).toContain('context 82% ⚠ /handoff')
  expect(toasts.length).toBe(2)

  await $.turn.complete({ ...base, turnId: 't3', usage: usage(100, 10, 1000, 0) })
  expect(toasts.length).toBe(2)

  const off = await $.command.run({ command: 'token-meter', args: 'off' } as never)
  expect((off as { text?: string }).text).toContain('hidden')
  expect(lines.at(-1)).toBeUndefined()

  const info = await $.command.run({ command: 'token-meter', args: '' } as never)
  expect((info as { text?: string }).text).toContain('Plan 5h: 22.4% used')
})
