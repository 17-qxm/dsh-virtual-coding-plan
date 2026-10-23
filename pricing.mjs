// Cost accounting and quota-window math for dsh-virtual-coding-plan.
//
// The pricing table, the peak/valley rule and the money-unit helpers are ported
// from dsh-whale-widget v0.4.2 (MIT) — see THIRD_PARTY_NOTICES.md. They are kept
// semantically identical on purpose: a plan's spend must reconcile with the
// balance widget's number, otherwise the same turn shows two different prices.
//
// This module is pure: no IO, no clock reads. Callers pass `nowMs` in.

// ---------------------------------------------------------------------------
// Money units: 1 unit = 1e-8 CNY, so sums never drift through IEEE-754 float.
// ---------------------------------------------------------------------------

export const SCALE = 100000000

export function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}

export function unitsToYuan(units) {
  return Number(units) / SCALE
}

export function sumUnits(values) {
  let units = 0
  for (const value of values) units += Number(value) || 0
  if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围')
  return units
}

// ---------------------------------------------------------------------------
// Beijing calendar helpers (UTC+8, no DST).
// ---------------------------------------------------------------------------

export const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const DAY_MS = 86400000

export function beijingDay(timeMs = Date.now()) {
  const d = new Date(Number(timeMs) + BEIJING_OFFSET_MS)
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间')
  return d.toISOString().slice(0, 10)
}

/** Beijing 00:00 of the calendar day containing `timeMs`. */
export function bjMidnightMs(timeMs) {
  const n = Number(timeMs)
  const dayIndex = Math.floor((n + BEIJING_OFFSET_MS) / DAY_MS)
  return dayIndex * DAY_MS - BEIJING_OFFSET_MS
}

/** Beijing Monday 00:00 of the calendar week containing `timeMs`. */
export function bjWeekStartMs(timeMs) {
  const midnight = bjMidnightMs(timeMs)
  // 1970-01-01 was a Thursday; `dow` is 0=Sunday..6=Saturday.
  const dayIndex = Math.round((midnight + BEIJING_OFFSET_MS) / DAY_MS)
  const dow = ((dayIndex % 7) + 7 + 4) % 7
  const sinceMonday = (dow + 6) % 7
  return midnight - sinceMonday * DAY_MS
}

// ---------------------------------------------------------------------------
// Pricing (CNY per million tokens), ported from dsh-whale-widget.
// ---------------------------------------------------------------------------

export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

// Flash (official model name deepseek-flash = DeepSeek-V4.1-Flash).
export const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro is 3x Flash for every tier.
export const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

export const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}

const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)

/**
 * Legal-holiday valley days. Only *holidays* need listing: make-up working
 * weekends are already valley by the weekend rule. Upstream maintains this
 * list — add the next year's dates every November.
 */
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}

export const HOLIDAY_VALLEY_LIST = Object.keys(HOLIDAY_VALLEY).sort()

function isHolidayValley(bjDate) {
  try {
    return !!HOLIDAY_VALLEY[bjDate.toISOString().slice(0, 10)]
  } catch (err) {
    return false
  }
}

export function isPeakTime(timeSec) {
  if (!Number.isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + BEIJING_OFFSET_MS)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/** Next peak/valley switch as epoch seconds, or null if none within 12 days. */
export function nextPeakChangeAt(timeSec) {
  const n = Number(timeSec)
  if (!Number.isFinite(n)) return null
  const cur = isPeakTime(n)
  const day0 = Math.floor((n + 8 * 3600) / DAY_MS) * DAY_MS
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * DAY_MS + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeakTime(cand) !== cur) return cand
    }
  }
  return null
}

/** Longest key wins, so a short keyword such as "pro" cannot shadow a longer one. */
export function priceFor(model, table = PRICING) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (key === '_default') continue
    if (key && m.indexOf(key) !== -1) return table[key]
  }
  return table._default || PRICING._default
}

export function isPricedModel(model, table = PRICING) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(table)) {
    if (key === '_default') continue
    if (key && m.indexOf(key) !== -1) return true
  }
  return false
}

/**
 * Price one assistant message. `usage` uses the DSH TokenUsage field names.
 *
 * `reasoningTokens` is deliberately NOT added: DSH's outputTokens already
 * includes it, and adding both doubles the output side (upstream hit the same
 * bug).
 */
export function costUnitsFor(model, usage, timeMs, table = PRICING) {
  const p = priceFor(model, table)
  const off = isPeakTime(Math.floor(Number(timeMs) / 1000)) ? 1 : 0
  const input = Number(usage && usage.inputTokens) || 0
  const cacheRead = Number(usage && usage.cacheReadTokens) || 0
  const output = Number(usage && usage.outputTokens) || 0
  const yuan = (cacheRead / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
  return moneyUnits(yuan)
}

// ---------------------------------------------------------------------------
// Quota windows.
// ---------------------------------------------------------------------------

const DAY = DAY_MS

/** Absolute [start, end) bounds of a window at `nowMs`. Rolling windows end at now. */
export function windowBounds(w, nowMs) {
  const now = Number(nowMs)
  if (w.kind === 'rolling') {
    const durationMs = Number(w.durationMs) || DAY
    return { start: now - durationMs, end: now, durationMs }
  }
  if (w.kind === 'calendar-day') {
    const start = bjMidnightMs(now)
    return { start, end: start + DAY, durationMs: DAY }
  }
  if (w.kind === 'calendar-week') {
    const start = bjWeekStartMs(now)
    return { start, end: start + 7 * DAY, durationMs: 7 * DAY }
  }
  throw new Error('未知的窗口类型: ' + String(w.kind))
}

function spentBetween(events, start, end) {
  let units = 0
  for (const e of events || []) {
    const ts = Number(e && e.ts)
    if (!Number.isFinite(ts)) continue
    if (ts < start || ts >= end) continue
    units += Number(e.costUnits) || 0
  }
  return units
}

/** Base limit: the plan's value, unless the user overrode it in the page. */
export function limitUnitsFor(w, settings) {
  const override = settings && settings.limitOverrides ? settings.limitOverrides[w.id] : undefined
  const yuan = typeof override === 'number' && Number.isFinite(override) ? override : w.limitYuan
  return moneyUnits(Number(yuan) || 0)
}

/** Grants live inside their own `[ts, expiresAt)` interval. */
function grantsAt(grants, windowId, at) {
  let units = 0
  for (const g of grants || []) {
    if (!g || g.windowId !== windowId) continue
    const ts = Number(g.ts)
    const exp = Number(g.expiresAt)
    if (Number.isFinite(ts) && ts > at) continue
    if (Number.isFinite(exp) && exp <= at) continue
    units += Number(g.units) || 0
  }
  return units
}

/** Limit in force at `at`, including the grants live at that moment. */
export function limitAt(w, ledger, at) {
  const settings = (ledger && ledger.settings) || {}
  const grants = (ledger && ledger.grants) || []
  return limitUnitsFor(w, settings) + grantsAt(grants, w.id, at)
}

export function windowSpentUnits(w, events, nowMs) {
  const { start, end } = windowBounds(w, nowMs)
  return spentBetween(events, start, end)
}

/**
 * Earliest moment after `now` at which this window is no longer exhausted, or
 * null when it is not exhausted now.
 *
 * Grants raise the limit only while alive, so their expiry can make things
 * worse rather than better; every candidate time is therefore re-tested against
 * the limit in force at that moment instead of being assumed to help.
 */
export function windowResetsAt(w, ledger, nowMs) {
  const now = Number(nowMs)
  const events = (ledger && ledger.events) || []
  const grants = (ledger && ledger.grants) || []
  const spent = windowSpentUnits(w, events, now)
  if (spent < limitAt(w, ledger, now)) return null

  const candidates = []
  if (w.kind === 'rolling') {
    const durationMs = Number(w.durationMs) || DAY
    for (const e of events) {
      const ts = Number(e && e.ts)
      if (!Number.isFinite(ts) || ts <= now - durationMs || ts > now) continue
      // +1 because the window start is inclusive: the event drops once t > ts+duration.
      candidates.push(ts + durationMs + 1)
    }
  } else {
    candidates.push(windowBounds(w, now).end)
  }
  for (const g of grants) {
    if (!g || g.windowId !== w.id) continue
    const at = Number(g.expiresAt)
    if (Number.isFinite(at) && at > now) candidates.push(at)
  }

  candidates.sort((a, b) => a - b)
  for (const t of candidates) {
    if (!(t > now)) continue
    if (windowSpentUnits(w, events, t) < limitAt(w, ledger, t)) return t
  }
  return null
}

/**
 * Evaluate every window. `blocked` is true when any window's spend has reached
 * its limit (>=, so a limit of 0 blocks immediately).
 */
/**
 * When this window's oldest spend drops out — the display "resets in" value
 * even while the window still has room. A rolling window with no spend has
 * nothing to release, so it reports null; calendar windows always report their
 * boundary.
 */
export function windowReleaseAt(w, ledger, nowMs) {
  const now = Number(nowMs)
  if (w.kind !== 'rolling') return windowBounds(w, now).end
  const durationMs = Number(w.durationMs) || DAY
  const events = (ledger && ledger.events) || []
  let oldest = Infinity
  for (const e of events) {
    const ts = Number(e && e.ts)
    if (!Number.isFinite(ts)) continue
    if (ts <= now - durationMs || ts > now) continue
    if (ts < oldest) oldest = ts
  }
  if (!Number.isFinite(oldest)) return null
  return oldest + durationMs + 1
}

export function evaluate(plan, ledger, nowMs) {
  const now = Number(nowMs)
  const events = (ledger && ledger.events) || []
  const windows = (plan && plan.windows ? plan.windows : []).map((w) => {
    const { start, end, durationMs } = windowBounds(w, now)
    const limitUnits = limitAt(w, ledger, now)
    const spentUnits = windowSpentUnits(w, events, now)
    // A zero limit means "no allowance left", so it blocks too; its ratio reads 100%.
    const ratio = limitUnits > 0 ? spentUnits / limitUnits : 1
    const exceeded = spentUnits >= limitUnits
    const resetsAt = exceeded ? windowResetsAt(w, ledger, now) : windowReleaseAt(w, ledger, now)
    return {
      id: w.id,
      label: w.label || w.id,
      short: w.short || w.id,
      kind: w.kind,
      unit: 'CNY',
      spentUnits,
      limitUnits,
      ratio,
      exceeded,
      durationMs,
      windowStartMs: start,
      windowEndMs: end,
      resetsAt,
      resetsInMs: resetsAt == null ? null : Math.max(0, resetsAt - now),
    }
  })
  return { blocked: windows.some((w) => w.exceeded), windows }
}

// ---------------------------------------------------------------------------
// Ledger maintenance.
// ---------------------------------------------------------------------------

export const LEDGER_RETENTION_MS = 14 * DAY
export const LEDGER_MAX_EVENTS = 20000

/** Drops aged-out events in place; returns true when anything was removed. */
export function pruneLedger(ledger, nowMs) {
  const now = Number(nowMs)
  const cut = now - LEDGER_RETENTION_MS
  const events = Array.isArray(ledger.events) ? ledger.events : []
  const kept = events.filter((e) => Number(e && e.ts) >= cut)
  let changed = kept.length !== events.length
  if (kept.length > LEDGER_MAX_EVENTS) {
    kept.splice(0, kept.length - LEDGER_MAX_EVENTS)
    changed = true
  }
  ledger.events = kept
  const grants = Array.isArray(ledger.grants) ? ledger.grants : []
  const keptGrants = grants.filter((g) => Number(g && g.expiresAt) > now - 7 * DAY)
  if (keptGrants.length !== grants.length) changed = true
  ledger.grants = keptGrants
  return changed
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by the strip, the page and the command).
// ---------------------------------------------------------------------------

export function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 60000) return '<1m'
  const totalMin = Math.floor(n / 60000)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  if (days > 0) {
    if (hours > 0) return days + 'd' + hours + 'h'
    return minutes > 0 ? days + 'd' + minutes + 'm' : days + 'd'
  }
  if (hours > 0) return minutes > 0 ? hours + 'h' + minutes + 'm' : hours + 'h'
  return minutes + 'm'
}

export function percentOf(ratio) {
  const r = Number(ratio)
  if (!Number.isFinite(r) || r <= 0) return 0
  return Math.min(100, Math.round(r * 100))
}
