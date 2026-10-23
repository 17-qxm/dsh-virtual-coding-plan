import test from 'node:test'
import assert from 'node:assert/strict'

import {
  moneyUnits,
  unitsToYuan,
  sumUnits,
  beijingDay,
  bjMidnightMs,
  bjWeekStartMs,
  isPeakTime,
  priceFor,
  isPricedModel,
  BASE_PRICE,
  PRO_PRICE,
  costUnitsFor,
  windowBounds,
  windowSpentUnits,
  limitAt,
  windowResetsAt,
  evaluate,
  pruneLedger,
  formatDuration,
  percentOf,
  LEDGER_RETENTION_MS,
  LEDGER_MAX_EVENTS,
} from '../pricing.mjs'

const H = 3600000
const YUAN = 100000000
const yuan = (n) => Math.round(n * YUAN)

// 2026-10-23 is a Friday. All fixtures are built from Beijing wall-clock times.
const FRI_10 = Date.UTC(2026, 9, 23, 2, 0, 0) // Fri 10:00 CST  -> peak
const FRI_13 = Date.UTC(2026, 9, 23, 5, 0, 0) // Fri 13:00 CST  -> valley
const SAT_10 = Date.UTC(2026, 9, 24, 2, 0, 0) // Sat 10:00 CST  -> valley
const MON_00 = Date.UTC(2026, 9, 25, 16, 0, 0) // Mon 2026-10-26 00:00 CST
const HOLIDAY = Date.UTC(2026, 9, 1, 2, 0, 0) // Thu 2026-10-01 10:00 CST, national holiday

const plan = {
  id: 't',
  windows: [
    { id: 'session', label: '5 小时', short: '5h', kind: 'rolling', durationMs: 5 * H, limitYuan: 0.1 },
    { id: 'weekly', label: '本周', short: '周', kind: 'calendar-week', limitYuan: 1 },
  ],
}

const emptyLedger = (events = [], grants = []) => ({
  version: 1,
  settings: { limitOverrides: {} },
  events,
  grants,
})

test('money units stay integral', () => {
  assert.equal(moneyUnits(1), YUAN)
  assert.equal(unitsToYuan(moneyUnits(0.123)), 0.123)
  assert.equal(sumUnits([1, 2, 3]), 6)
  // 0.1 + 0.2 must not drift
  assert.equal(unitsToYuan(moneyUnits(0.1) + moneyUnits(0.2)), 0.3)
  assert.throws(() => moneyUnits(NaN))
})

test('beijing calendar boundaries', () => {
  assert.equal(beijingDay(FRI_10), '2026-10-23')
  assert.equal(bjMidnightMs(FRI_10), Date.UTC(2026, 9, 22, 16, 0, 0))
  // Monday 00:00 is its own week start
  assert.equal(bjWeekStartMs(MON_00), MON_00)
  // The Sunday before belongs to the week starting Monday 2026-10-19
  assert.equal(bjWeekStartMs(Date.UTC(2026, 9, 25, 4, 0, 0)), Date.UTC(2026, 9, 18, 16, 0, 0))
})

test('peak / valley follows weekday hours, weekends and holidays', () => {
  assert.equal(isPeakTime(FRI_10 / 1000), true)
  assert.equal(isPeakTime(FRI_13 / 1000), false)
  assert.equal(isPeakTime(SAT_10 / 1000), false)
  assert.equal(isPeakTime(HOLIDAY / 1000), false)
  assert.equal(isPeakTime(NaN), false)
})

test('price table matching prefers the longest key and falls back', () => {
  assert.equal(priceFor('deepseek-v4-pro'), PRO_PRICE)
  assert.equal(priceFor('deepseek-flash'), BASE_PRICE)
  assert.equal(priceFor('some-unknown-model'), BASE_PRICE)
  assert.equal(isPricedModel('deepseek-v4-pro'), true)
  assert.equal(isPricedModel('some-unknown-model'), false)
})

test('cost bills cache, miss and output separately, and never double-counts reasoning', () => {
  const plain = { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 }
  assert.equal(costUnitsFor('deepseek-flash', plain, FRI_13), yuan(5.02))
  assert.equal(costUnitsFor('deepseek-flash', plain, FRI_10), yuan(10.04))
  // reasoningTokens is already inside outputTokens
  const withReasoning = { ...plain, reasoningTokens: 1000000 }
  assert.equal(costUnitsFor('deepseek-flash', withReasoning, FRI_13), yuan(5.02))
  // Pro is 3x Flash on miss and output; its cache-hit price is 0.15, not 3x0.02.
  assert.equal(costUnitsFor('deepseek-v4-pro', plain, FRI_13), yuan(18.15))
})

test('rolling window sums only the last duration and reports when it clears', () => {
  const now = FRI_13
  const ledger = emptyLedger([
    { ts: now - 4 * H, costUnits: yuan(0.06) },
    { ts: now - 3 * H, costUnits: yuan(0.05) },
    { ts: now - 9 * H, costUnits: yuan(0.5) }, // aged out of the 5h window
  ])
  const w = plan.windows[0]
  assert.equal(windowSpentUnits(w, ledger.events, now), yuan(0.11))

  const verdict = evaluate(plan, ledger, now)
  const session = verdict.windows[0]
  assert.equal(session.exceeded, true)
  // Dropping the oldest in-window event clears the window: (now-4h) + 5h
  assert.equal(session.resetsInMs, H + 1)
})

test('a grant raises the limit while it lives, then stops helping', () => {
  const now = FRI_13
  const events = [{ ts: now - H, costUnits: yuan(0.15) }]
  const bare = emptyLedger(events)
  assert.equal(evaluate(plan, bare, now).windows[0].exceeded, true)

  const granted = emptyLedger(events, [{ windowId: 'session', units: yuan(0.1), ts: now - H, expiresAt: now + H }])
  const session = evaluate(plan, granted, now).windows[0]
  assert.equal(session.limitUnits, yuan(0.2))
  assert.equal(session.exceeded, false)
  // Once the grant expires the same spend is over the base limit again
  assert.equal(limitAt(plan.windows[0], granted, now + 2 * H), yuan(0.1))
})

test('calendar week resets at the next Beijing Monday', () => {
  const now = FRI_13
  const ledger = emptyLedger([{ ts: now - H, costUnits: yuan(2) }])
  const week = evaluate(plan, ledger, now).windows[1]
  assert.equal(week.exceeded, true)
  assert.equal(week.resetsAt, bjWeekStartMs(now) + 7 * 86400000)
  assert.equal(week.resetsAt, MON_00)
})

test('limit overrides replace the preset value', () => {
  const now = FRI_13
  const ledger = emptyLedger([{ ts: now - H, costUnits: yuan(0.05) }])
  ledger.settings.limitOverrides = { session: 0.04 }
  const session = evaluate(plan, ledger, now).windows[0]
  assert.equal(session.limitUnits, yuan(0.04))
  assert.equal(session.exceeded, true)
})

test('a zero limit blocks immediately', () => {
  const ledger = emptyLedger([])
  ledger.settings.limitOverrides = { session: 0 }
  assert.equal(evaluate(plan, ledger, FRI_13).windows[0].exceeded, true)
})

test('not exhausted windows still report when their spend frees up', () => {
  const ledger = emptyLedger([{ ts: FRI_13 - H, costUnits: yuan(0.01) }])
  const session = evaluate(plan, ledger, FRI_13).windows[0]
  assert.equal(session.exceeded, false)
  // The oldest in-window event ages out one window-length after it happened.
  assert.equal(session.resetsInMs, 4 * H + 1)
  // A calendar window always reports its boundary.
  assert.equal(evaluate(plan, ledger, FRI_13).windows[1].resetsAt, MON_00)
})

test('a rolling window with no spend has nothing to release', () => {
  const ledger = emptyLedger([])
  assert.equal(evaluate(plan, ledger, FRI_13).windows[0].resetsAt, null)
  assert.equal(windowResetsAt(plan.windows[0], ledger, FRI_13), null)
})

test('window bounds are absolute and half-open', () => {
  const w = plan.windows[0]
  const { start, end } = windowBounds(w, FRI_13)
  assert.equal(end, FRI_13)
  assert.equal(start, FRI_13 - 5 * H)
  // An event exactly at `end` belongs to the next window
  const ledger = emptyLedger([{ ts: FRI_13, costUnits: yuan(9) }])
  assert.equal(windowSpentUnits(w, ledger.events, FRI_13), 0)
})

test('pruning drops aged events and caps the ledger', () => {
  const now = FRI_13
  const ledger = emptyLedger([
    { ts: now - LEDGER_RETENTION_MS - 1, costUnits: 1 },
    { ts: now - H, costUnits: 2 },
  ])
  assert.equal(pruneLedger(ledger, now), true)
  assert.equal(ledger.events.length, 1)

  const big = emptyLedger(Array.from({ length: LEDGER_MAX_EVENTS + 5 }, (_, i) => ({ ts: now - i, costUnits: 1 })))
  pruneLedger(big, now)
  assert.equal(big.events.length, LEDGER_MAX_EVENTS)

  const empty = emptyLedger()
  assert.equal(pruneLedger(empty, now), false)
})

test('formatting helpers', () => {
  assert.equal(formatDuration(2 * H + 13 * 60000), '2h13m')
  assert.equal(formatDuration(H), '1h')
  assert.equal(formatDuration(13 * 60000), '13m')
  assert.equal(formatDuration(30000), '<1m')
  assert.equal(formatDuration(-5), '<1m')
  // Long windows read in days rather than a 50+ hour count
  assert.equal(formatDuration(53 * H + 52 * 60000), '2d5h')
  assert.equal(formatDuration(48 * H), '2d')
  assert.equal(formatDuration(24 * H + 30 * 60000), '1d30m')
  assert.equal(percentOf(0.104), 10)
  assert.equal(percentOf(0.999), 100)
  assert.equal(percentOf(1.5), 100)
  assert.equal(percentOf(0), 0)
})
