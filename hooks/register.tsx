import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ModelUsage, SessionUsage } from 'claude-code'

import type { Last, Tally } from '../types'

const P = 'token-meter'
const ZERO: Tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const WARN_AT = 80
const HINT_AT = 60

const session = atom({ plugin: 'token-meter', key: 'session' } as const, ZERO)
const pending = atom({ plugin: 'token-meter', key: 'pending' } as const, ZERO)
const prompts = atom({ plugin: 'token-meter', key: 'prompts' } as const, 0)
const last = atom({ plugin: 'token-meter', key: 'last' } as const, null as Last | null)
const costBefore = atom({ plugin: 'token-meter', key: 'costBefore' } as const, 0)
const warned = atom({ plugin: 'token-meter', key: 'warned' } as const, false)
const hinted = atom({ plugin: 'token-meter', key: 'hinted' } as const, false)
const shown = atom({ plugin: 'token-meter', key: 'line' } as const, null as string | null)

const add = (a: Tally, u: ModelUsage): Tally => ({
  input: a.input + u.input_tokens,
  output: a.output + u.output_tokens,
  cacheRead: a.cacheRead + u.cache_read_input_tokens,
  cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
})

const sum = (a: Tally, b: Tally): Tally => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

// Cost-weighted: cache reads ~0.1x, cache writes ~2x, output ~5x a fresh input token.
export const weighted = (t: Tally): number =>
  t.input + 0.1 * t.cacheRead + 2 * t.cacheWrite + 5 * t.output

export const fmt = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

export type View = {
  last: Last | null
  total: Tally
  count: number
  usage: SessionUsage | null
  now: number
  ttlMin: number
}

export const cacheText = (lastAt: number, now: number, ttlMin: number): string => {
  const left = Math.ceil((lastAt + ttlMin * 60_000 - now) / 60_000)
  return left > 0 ? `cache warm ${left}m` : 'cache cold'
}

export const line = (v: View): string => {
  const parts: string[] = []
  if (v.last) {
    const cost = v.last.usd !== null ? ` (${usd(v.last.usd)})` : ''
    parts.push(`Last ≈ ${fmt(weighted(v.last.tally))} tok${cost}`)
  }
  const sessionUsd = v.usage?.cost?.usd
  parts.push(
    sessionUsd !== undefined
      ? `session ${usd(sessionUsd)}`
      : `session ≈ ${fmt(weighted(v.total))} tok`,
  )
  const pct = v.usage?.context.percent
  if (pct !== undefined) parts.push(`context ${pct}%${pct >= WARN_AT ? ' ⚠ /handoff' : pct >= HINT_AT ? ' · try /caveman' : ''}`)
  for (const r of v.usage?.rateLimits ?? []) {
    parts.push(`${LIMIT_NAMES[r.kind] ?? r.kind} ${Math.round(r.percentUsed)}%`)
  }
  if (v.last) parts.push(cacheText(v.last.at, v.now, v.ttlMin))
  return parts.join(' · ')
}

export const details = (v: View): string => {
  const rows = [`token-meter: ${v.count} prompt${v.count === 1 ? '' : 's'} this session`]
  if (v.last) {
    const t = v.last.tally
    rows.push(
      `Last prompt: ≈ ${fmt(weighted(t))} weighted tokens` +
        (v.last.usd !== null ? `, ${usd(v.last.usd)}` : ''),
      `  new input ${fmt(t.input)}, cache written ${fmt(t.cacheWrite)}, cache read ${fmt(t.cacheRead)}, output ${fmt(t.output)}`,
    )
  }
  const s = v.total
  rows.push(
    `Session: ≈ ${fmt(weighted(s))} weighted tokens` +
      (v.usage?.cost ? `, ${usd(v.usage.cost.usd)}` : ''),
    `  new input ${fmt(s.input)}, cache written ${fmt(s.cacheWrite)}, cache read ${fmt(s.cacheRead)}, output ${fmt(s.output)}`,
  )
  const c = v.usage?.context
  if (c?.tokens !== undefined) rows.push(`Context: ${fmt(c.tokens)} of ${fmt(c.window)} (${c.percent ?? 0}%), /caveman hint at ${HINT_AT}%, /handoff warning at ${WARN_AT}%`)
  for (const r of v.usage?.rateLimits ?? []) {
    rows.push(`Plan ${LIMIT_NAMES[r.kind] ?? r.kind}: ${r.percentUsed}% used` + (r.resetsAt ? `, resets ${r.resetsAt}` : ''))
  }
  if (v.last) rows.push(`Cache: ${cacheText(v.last.at, v.now, v.ttlMin)} (assumed lifetime ${v.ttlMin} min)`)
  rows.push('Commands: /token-meter off | on | ttl <minutes> (default 60)')
  return rows.join('\n')
}

async function isOff($: EngineInterface): Promise<boolean> {
  return (await $.store.get('off')) === true
}

async function ttl($: EngineInterface): Promise<number> {
  const v = await $.store.get('ttlMin')
  return typeof v === 'number' && v > 0 ? v : 60
}

async function safeUsage($: EngineInterface): Promise<SessionUsage | null> {
  try {
    return await $.session.usage()
  } catch {
    return null
  }
}

async function view($: EngineInterface, usage?: SessionUsage | null): Promise<View> {
  return {
    last: await read($, last),
    total: await read($, session),
    count: await read($, prompts),
    usage: usage === undefined ? await safeUsage($) : usage,
    now: await $.clock.now(),
    ttlMin: await ttl($),
  }
}

async function show($: EngineInterface, text: string | undefined): Promise<void> {
  $.ui.status(text)
  await update($, shown, () => text ?? null)
}

async function refresh($: EngineInterface): Promise<void> {
  if (await isOff($)) return show($, undefined)
  if ((await read($, last)) === null) return
  await show($, line(await view($)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-meter',
      description: 'Token, cost, context and plan usage; off | on | ttl <minutes>',
    })
    // Keep the cache countdown current while idle.
    $.clock.every(60_000, () => void refresh($))
    await refresh($)
    return next(e)
  })

  on('command.run', { command: 'token-meter' }, async ($, e) => {
    const [word = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'off') {
      await $.store.set('off', true)
      await show($, undefined)
      return { text: 'token-meter hidden. /token-meter on brings it back.' }
    }
    if (word === 'on') {
      await $.store.set('off', false)
      await refresh($)
      return { text: 'token-meter shown.' }
    }
    if (word === 'ttl') {
      const min = Number(arg)
      if (!(min > 0)) return { text: 'Usage: /token-meter ttl <minutes>, e.g. 5 or 60' }
      await $.store.set('ttlMin', min)
      await refresh($)
      return { text: `Cache lifetime set to ${min} min.` }
    }
    return { text: details(await view($)) }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage ?? result.usage

    if (e.agentId !== undefined) {
      // A subagent's run: hold it until the main prompt it belongs to finishes.
      if (usage) await update($, pending, p => add(p, usage))
      return result
    }

    const sub = await read($, pending)
    const tally = usage ? add(sub, usage) : sub
    await update($, pending, () => ZERO)
    await update($, session, s => sum(s, tally))
    await update($, prompts, n => n + 1)

    const live = await safeUsage($)
    const costNow = live?.cost?.usd
    const before = await read($, costBefore)
    if (costNow !== undefined) await update($, costBefore, () => costNow)
    const now = await $.clock.now()
    await update($, last, () => ({
      tally,
      usd: costNow !== undefined ? Math.max(0, costNow - before) : null,
      at: now,
    }))

    const pct = live?.context.percent
    if (pct !== undefined) {
      if (pct >= WARN_AT && !(await read($, warned))) {
        await update($, warned, () => true)
        $.ui.toast(`Context is ${pct}% full. Run /handoff and continue in a new chat to keep costs down.`)
      } else if (pct >= HINT_AT && pct < WARN_AT && !(await read($, hinted))) {
        await update($, hinted, () => true)
        $.ui.toast(`Context is ${pct}% full. /caveman makes replies shorter so it fills up slower.`)
      } else if (pct < HINT_AT - 20) {
        await update($, warned, () => false)
        await update($, hinted, () => false)
      }
    }

    if (!(await isOff($))) await show($, line(await view($, live)))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, shown)
    if (e.surface === 'terminal' || text === null || (await isOff($))) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{text}</Text>
  })
}
