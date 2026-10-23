/**
 * dsh-virtual-coding-plan — Host half.
 *
 * Meters spend in CNY from the durable `assistant/message` events, evaluates it
 * against the active plan's windows, and refuses NEW requests at `llm/stream`
 * before any adapter runs — so a refused turn costs nothing and surfaces as an
 * error instead of a normal completion. `agent/pre-step` is not used: a
 * rejected step is rendered as an ordinary finished turn by the UI.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  bjMidnightMs,
  bjWeekStartMs,
  costUnitsFor,
  evaluate,
  formatDuration,
  isPricedModel,
  limitUnitsFor,
  moneyUnits,
  percentOf,
  pruneLedger,
  unitsToYuan,
  windowBounds,
} from './pricing.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '0.1.0'
const ROUTE = '/dsh-virtual-coding-plan'
const LOG = '[virtual-coding-plan]'

const DEFAULTS = {
  preset: 'simulated',
  planFile: null,
  enforcement: 'block',
  ledgerFile: null,
}

const ENFORCEMENTS = new Set(['block', 'warn', 'off'])

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function dshHome() {
  const env = process.env.DSH_HOME
  if (env) return env
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  return path.join(home, '.dsh')
}

function defaultLedgerPath() {
  return path.join(dshHome(), '.dshvcp-ledger.json')
}

function freshLedger() {
  return {
    version: 1,
    plan: { presetId: '', appliedAt: 0 },
    settings: { enforcement: null, limitOverrides: {}, presetId: null },
    events: [],
    grants: [],
  }
}

function backupCorrupt(file, code) {
  try {
    fs.renameSync(file, file + '.corrupt-' + Date.now())
    console.warn(LOG, '账本损坏（' + code + '），已备份并重新开始')
  } catch (err) {
    console.warn(LOG, '账本损坏且无法备份:', code)
  }
}

function readLedger(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT') backupCorrupt(file, err.code || 'read-error')
    return freshLedger()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    backupCorrupt(file, 'bad-json')
    return freshLedger()
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
    backupCorrupt(file, 'bad-structure')
    return freshLedger()
  }
  const ledger = { ...freshLedger(), ...parsed }
  ledger.settings = { ...freshLedger().settings, ...(parsed.settings || {}) }
  ledger.settings.limitOverrides = ledger.settings.limitOverrides || {}
  ledger.grants = []
  return ledger
}

function writeLedger(file, ledger) {
  // Grants are excluded from the file on purpose: persisting them would let a
  // temporary top-up survive a restart, and it must not.
  const { grants, ...persisted } = ledger
  const body = JSON.stringify(persisted)
  const tmp = file + '.tmp-' + process.pid
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch (ignored) {
      /* the temp file is unreachable; nothing to clean up */
    }
    console.error(LOG, '账本保存失败:', (err && err.message) || err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const WINDOW_KINDS = new Set(['rolling', 'calendar-day', 'calendar-week'])

function normalizePlan(raw, fallbackId) {
  const windows = (Array.isArray(raw && raw.windows) ? raw.windows : [])
    .filter((w) => w && typeof w.id === 'string' && w.id)
    .map((w) => ({
      id: w.id,
      label: typeof w.label === 'string' && w.label ? w.label : w.id,
      short: typeof w.short === 'string' && w.short ? w.short : w.id,
      kind: WINDOW_KINDS.has(w.kind) ? w.kind : 'rolling',
      durationMs: Number(w.durationMs) || 5 * 3600000,
      limitYuan: Number(w.limitYuan) || 0,
    }))
  if (!windows.length) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallbackId,
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'CNY',
    note: typeof raw.note === 'string' ? raw.note : '',
    debug: raw.debug === true,
    windows,
  }
}

function fallbackPlan() {
  return normalizePlan(
    {
      id: 'simulated',
      name: '模拟 Plan',
      windows: [
        { id: 'session', label: '5 小时', short: '5h', kind: 'rolling', durationMs: 5 * 3600000, limitYuan: 5 },
        { id: 'weekly', label: '本周', short: '周', kind: 'calendar-week', limitYuan: 30 },
      ],
    },
    'simulated',
  )
}

function readPlanFile(file, fallbackId) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const plan = normalizePlan(raw, fallbackId)
    if (plan) return plan
    console.warn(LOG, '预设缺少窗口，忽略:', file)
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.warn(LOG, '预设读取失败:', file, (err && err.message) || err)
  }
  return null
}

function loadPlan(cfg, settings) {
  const presetId = (settings && settings.presetId) || cfg.preset || 'simulated'
  if (cfg.planFile) {
    const plan = readPlanFile(path.resolve(String(cfg.planFile)), presetId)
    if (plan) return { plan, planPath: path.resolve(String(cfg.planFile)), presetId: plan.id }
  }
  const file = path.join(HERE, 'presets', String(presetId) + '.json')
  const plan = readPlanFile(file, presetId)
  if (plan) return { plan, planPath: file, presetId: plan.id }
  return { plan: fallbackPlan(), planPath: null, presetId: 'simulated' }
}

function listPresets() {
  try {
    return fs
      .readdirSync(path.join(HERE, 'presets'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
  } catch (err) {
    return ['simulated']
  }
}

/** Preset id, display name and whether it is a debug-only plan. */
function presetCatalog() {
  return listPresets().map((id) => {
    const plan = readPlanFile(path.join(HERE, 'presets', id + '.json'), id)
    return { id, name: plan ? plan.name : id, debug: !!(plan && plan.debug) }
  })
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function sumSince(events, since) {
  let units = 0
  for (const e of events) {
    if (Number(e.ts) >= since) units += Number(e.costUnits) || 0
  }
  return units
}

function tokensOf(event) {
  return (Number(event.input) || 0) + (Number(event.output) || 0) + (Number(event.cacheRead) || 0)
}

function sumTokensSince(events, since) {
  let tokens = 0
  for (const e of events) {
    if (Number(e.ts) >= since) tokens += tokensOf(e)
  }
  return tokens
}

const HISTORY_HOURS = 24

/**
 * Hourly buckets for the trend chart. Money and tokens share the same X axis
 * but each series is scaled to its own peak, which is why they are drawn as two
 * lines instead of one dual-axis chart.
 */
function buildHistory(events, now) {
  const hourMs = 3600000
  const end = Math.floor(Number(now) / hourMs) * hourMs + hourMs
  const start = end - HISTORY_HOURS * hourMs
  const buckets = []
  for (let i = 0; i < HISTORY_HOURS; i++) buckets.push({ t: start + i * hourMs, costUnits: 0, tokens: 0 })
  for (const e of events) {
    const ts = Number(e && e.ts)
    if (!Number.isFinite(ts) || ts < start || ts >= end) continue
    const bucket = buckets[Math.floor((ts - start) / hourMs)]
    if (!bucket) continue
    bucket.costUnits += Number(e.costUnits) || 0
    bucket.tokens += tokensOf(e)
  }
  return buckets
}

/** Live grants for one window, plus the soonest expiry among them. */
function grantInfo(grants, windowId, now) {
  let units = 0
  let expiresAt = null
  for (const g of grants || []) {
    if (!g || g.windowId !== windowId) continue
    const ts = Number(g.ts)
    const exp = Number(g.expiresAt)
    if (Number.isFinite(ts) && ts > now) continue
    if (Number.isFinite(exp) && exp <= now) continue
    units += Number(g.units) || 0
    if (Number.isFinite(exp) && (expiresAt == null || exp < expiresAt)) expiresAt = exp
  }
  return { units, expiresAt }
}

function windowView(w, view, ledger, now) {
  const short = w.short || w.id
  const percent = percentOf(view.ratio)
  const settings = (ledger && ledger.settings) || {}
  const baseUnits = limitUnitsFor(w, settings)
  const granted = grantInfo((ledger && ledger.grants) || [], w.id, now)
  return {
    id: w.id,
    label: w.label,
    short,
    kind: w.kind,
    spentYuan: unitsToYuan(view.spentUnits),
    limitYuan: unitsToYuan(view.limitUnits),
    baseLimitYuan: unitsToYuan(baseUnits),
    // Top-ups are temporary by construction: they expire with the window.
    tempYuan: unitsToYuan(granted.units),
    tempExpiresInMs: granted.expiresAt == null ? null : Math.max(0, granted.expiresAt - now),
    percent,
    exceeded: view.exceeded,
    resetsInMs: view.resetsInMs,
    resetsLabel: view.resetsInMs == null ? null : formatDuration(view.resetsInMs),
    durationMs: view.durationMs,
  }
}

function buildStatus(state, now) {
  const verdict = evaluate(state.plan, state.ledger, now)
  const plan = state.plan
  const windows = plan.windows.map((w, i) => windowView(w, verdict.windows[i], state.ledger, now))
  const events = state.ledger.events
  const recent = events
    .slice(-10)
    .reverse()
    .map((e) => ({
      ts: Number(e.ts) || 0,
      model: String(e.model || ''),
      yuan: unitsToYuan(Number(e.costUnits) || 0),
      priced: e.priced !== false,
    }))
  return {
    ok: true,
    version: VERSION,
    plan: { id: plan.id, name: plan.name, currency: plan.currency, note: plan.note || '', presetId: state.presetId },
    presets: presetCatalog(),
    enforcement: state.enforcement,
    exceeded: verdict.blocked,
    blocked: verdict.blocked && state.enforcement === 'block',
    windows,
    todayYuan: unitsToYuan(sumSince(events, bjMidnightMs(now))),
    weekYuan: unitsToYuan(sumSince(events, bjWeekStartMs(now))),
    tokensToday: sumTokensSince(events, bjMidnightMs(now)),
    tokensWeek: sumTokensSince(events, bjWeekStartMs(now)),
    history: buildHistory(events, now),
    recent,
    lastRejectAt: state.lastRejectAt || 0,
    debug: state.debug || null,
    updatedAt: now,
  }
}

const BAR_WIDTH = 18
const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/** Columns a string occupies when CJK glyphs are double-width. */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) width += CJK_CHAR.test(ch) ? 2 : 1
  return width
}

function padEndDisplay(text, width) {
  const pad = width - displayWidth(text)
  return pad > 0 ? String(text) + ' '.repeat(pad) : String(text)
}

function padStartDisplay(text, width) {
  const pad = width - displayWidth(text)
  return pad > 0 ? ' '.repeat(pad) + String(text) : String(text)
}

function meter(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  let filled = Math.round((value / 100) * BAR_WIDTH)
  // Any positive spend shows at least one cell, matching the host meter's
  // 2px minimum segment instead of rendering nothing.
  if (value > 0 && filled === 0) filled = 1
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

function statusText(state, now) {
  const status = buildStatus(state, now)
  const lines = []
  lines.push('Coding Plan · ' + status.plan.name)
  for (const w of status.windows) {
    const reset = w.resetsInMs == null ? '—' : formatDuration(w.resetsInMs)
    const money = '¥' + w.spentYuan.toFixed(2) + ' / ¥' + w.limitYuan.toFixed(2)
    lines.push(
      ' ' +
        padEndDisplay(w.label, 8) +
        meter(w.percent) +
        ' ' +
        padStartDisplay(w.percent + '%', 4) +
        '  ' +
        padStartDisplay(money, 16) +
        '  ' +
        reset,
    )
  }
  const mode = state.enforcement === 'block' ? '拦截开启' : state.enforcement === 'warn' ? '仅警告' : '已关闭'
  lines.push(' ' + '─'.repeat(54))
  lines.push(
    ' 今日 ¥' +
      status.todayYuan.toFixed(2) +
      ' · 本周 ¥' +
      status.weekYuan.toFixed(2) +
      ' · ' +
      mode +
      (status.exceeded ? '（已超额）' : ''),
  )
  if (!status.plan.presetId) lines.push(' （使用内置兜底预设）')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(text)) })
  res.end(text)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Append-only diagnostic trail next to the ledger; capped to keep it small. */
function logDebug(ledgerFile, line) {
  try {
    const file = path.join(path.dirname(ledgerFile), '.dshvcp-debug.log')
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n')
    const stat = fs.statSync(file)
    if (stat.size > 128 * 1024) {
      const text = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, text.slice(text.length - 64 * 1024))
    }
  } catch (err) {
    /* diagnostics must never break the meter */
  }
}

/**
 * Fail the request before it reaches an adapter. Yielding nothing and throwing
 * on first pull is what turns this into a turn error rather than a completion.
 */
async function* refuseStream() {
  const error = new Error('额度已用尽：本轮请求已被拦截。提额或等待窗口重置后再试。')
  error.code = 'plan_quota_exhausted'
  error.status = 429
  throw error
}

export const inject = ['webServer', 'commands']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const ledgerFile = cfg.ledgerFile ? path.resolve(String(cfg.ledgerFile)) : defaultLedgerPath()
  const ledger = readLedger(ledgerFile)
  const loaded = loadPlan(cfg, ledger.settings)
  const state = {
    plan: loaded.plan,
    presetId: loaded.presetId,
    planPath: loaded.planPath,
    ledger,
    enforcement: ENFORCEMENTS.has(ledger.settings.enforcement) ? ledger.settings.enforcement : (ENFORCEMENTS.has(cfg.enforcement) ? cfg.enforcement : 'block'),
    lastRejectAt: 0,
    debug: null,
  }

  // Rebuild the in-memory dedupe index from whatever the ledger already holds.
  const seen = new Set()
  for (const e of ledger.events) seen.add(String(e.sid) + ':' + String(e.turn) + ':' + String(e.step))

  let persistTimer = null
  let lastEventTs = ledger.events.length ? Number(ledger.events[ledger.events.length - 1].ts) || 0 : 0

  function persistNow() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    pruneLedger(ledger, Date.now())
    writeLedger(ledgerFile, ledger)
  }

  function schedulePersist() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      pruneLedger(ledger, Date.now())
      writeLedger(ledgerFile, ledger)
    }, 1000)
    if (persistTimer.unref) persistTimer.unref()
  }

  // --- metering ---------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'assistant/message') return
    const data = event.data || {}
    const usage = data.usage
    if (!usage) return
    const sid = String((session && session.id) || '')
    const turn = Number(data.turn)
    const step = Number(data.step)
    if (!Number.isFinite(turn) || !Number.isFinite(step)) return
    const key = sid + ':' + turn + ':' + step
    if (seen.has(key)) return

    const ts = Number(event.time) || Date.now()
    if (ts < lastEventTs) return // clock went backwards; ignore rather than reorder
    let costUnits
    try {
      costUnits = costUnitsFor(data.message && data.message.source ? data.message.source.model : '', usage, ts)
    } catch (err) {
      console.warn(LOG, '计价失败:', (err && err.message) || err)
      return
    }
    const model = (data.message && data.message.source && data.message.source.model) || ''
    ledger.events.push({
      ts,
      sid,
      turn,
      step,
      model: String(model),
      input: Number(usage.inputTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      costUnits,
      priced: isPricedModel(model),
    })
    seen.add(key)
    lastEventTs = ts
    schedulePersist()
  })

  // --- gate -------------------------------------------------------------
  // Decided at the request layer, from the live ledger — no session mapping was
  // reliable (agent-loop requests do not consistently carry a sessionId), and a
  // rejected step is rendered as an ordinary completed turn, which is why the
  // UI kept showing "已完成". Refusing before `next()` bills nothing.
  ctx.on('llm/stream', (options, next) => {
    if (!options) {
      logDebug(ledgerFile, 'stream no-options')
      return next()
    }
    const verdict = evaluate(state.plan, state.ledger, Date.now())
    logDebug(
      ledgerFile,
      'stream sid=' +
        JSON.stringify(options.sessionId || null) +
        ' purpose=' +
        JSON.stringify(options.purpose || null) +
        ' model=' +
        JSON.stringify(String(options.model || '')) +
        ' enforcement=' +
        state.enforcement +
        ' blocked=' +
        verdict.blocked,
    )
    if (options.purpose) return next()
    if (state.enforcement !== 'block') return next()
    state.debug = {
      at: Date.now(),
      sid: String(options.sessionId || ''),
      blocked: verdict.blocked,
      model: String(options.model || ''),
    }
    if (!verdict.blocked) return next()
    state.lastRejectAt = Date.now()
    logDebug(ledgerFile, 'REFUSE')
    return refuseStream()
  })

  // --- routes -----------------------------------------------------------
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE + '/status.json',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, buildStatus(state, Date.now()))
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE + '/settings.json',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        let patch
        try {
          patch = JSON.parse(await readBody(req))
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          return
        }
        const error = applySettings(state, patch, Date.now())
        if (error) {
          sendJson(res, 400, { ok: false, error })
          return
        }
        persistNow()
        sendJson(res, 200, buildStatus(state, Date.now()))
      },
    }),
  )

  // --- command ----------------------------------------------------------
  const commands = ctx.commands
  if (commands) {
    ctx.effect(() =>
      commands.register({
        name: 'usage',
        // CommandDefinition has no icon field, so the only lever the slash menu
        // renders is this line. The ring glyph doubles as the icon.
        description: '◔ 额度计划：查看用量、调整上限、提额',
        input: { hint: 'status | on | off | topup <元> | preset <id>' },
        handler: (invocation) => {
          const now = Date.now()
          const arg = String((invocation && invocation.rawInput) || '').trim()
          if (!arg) return { kind: 'success', text: statusText(state, now) }
          const parts = arg.split(/\s+/)
          const head = parts[0].toLowerCase()
          if (head === 'on' || head === 'off') {
            state.enforcement = head === 'on' ? 'block' : 'off'
            state.ledger.settings.enforcement = state.enforcement
            persistNow()
            return { kind: 'success', text: head === 'on' ? '额度拦截已开启' : '额度拦截已关闭（仍继续记账）' }
          }
          if (head === 'topup') {
            const yuan = Number(parts[1])
            if (!Number.isFinite(yuan) || yuan <= 0 || yuan > 1000000) {
              return { kind: 'error', text: '用法：/usage topup <金额，元>' }
            }
            const target = pickWindow(state, parts[2])
            if (!target) return { kind: 'error', text: '找不到窗口：' + String(parts[2] || '') }
            grant(state, target, yuan, now)
            persistNow()
            return { kind: 'success', text: '已为「' + target.label + '」提额 ¥' + yuan.toFixed(2) + '\n' + statusText(state, now) }
          }
          if (head === 'preset') {
            const id = parts[1]
            if (!id) return { kind: 'error', text: '可用预设：' + listPresets().join(', ') }
            const plan = readPlanFile(path.join(HERE, 'presets', String(id) + '.json'), String(id))
            if (!plan) return { kind: 'error', text: '预设不存在：' + id }
            state.plan = plan
            state.presetId = plan.id
            state.ledger.settings.presetId = plan.id
            state.ledger.settings.limitOverrides = {}
            persistNow()
            return { kind: 'success', text: '已切换到「' + plan.name + '」\n' + statusText(state, now) }
          }
          return { kind: 'success', text: statusText(state, now) }
        },
      }),
    )
  }

  // Flush whatever coalesced when the plugin unloads.
  ctx.effect(() => () => persistNow())

  console.info(LOG, '已启用 · 预设', state.presetId, '· 模式', state.enforcement, '· 账本', ledgerFile)
}

// ---------------------------------------------------------------------------
// Settings mutation (shared by POST and the command)
// ---------------------------------------------------------------------------

function applySettings(state, patch, now) {
  if (!patch || typeof patch !== 'object') return '无效的请求体'
  if (patch.enforcement != null) {
    if (!ENFORCEMENTS.has(patch.enforcement)) return '未知的强制模式'
    state.enforcement = patch.enforcement
    state.ledger.settings.enforcement = patch.enforcement
  }
  if (patch.limits != null) {
    if (typeof patch.limits !== 'object') return 'limits 必须是对象'
    for (const [id, value] of Object.entries(patch.limits)) {
      const w = state.plan.windows.find((x) => x.id === id)
      if (!w) return '未知的窗口：' + id
      const yuan = Number(value)
      if (!Number.isFinite(yuan) || yuan < 0 || yuan > 1000000) return '窗口 ' + id + ' 的上限无效'
      state.ledger.settings.limitOverrides[id] = Math.round(yuan * 100) / 100
    }
  }
  if (patch.topup != null) {
    const target = pickWindow(state, patch.topup.windowId)
    if (!target) return '未知的窗口：' + String(patch.topup.windowId)
    const yuan = Number(patch.topup.yuan)
    if (!Number.isFinite(yuan) || yuan < 0 || yuan > 1000000) return '提额金额无效'
    grant(state, target, yuan, now)
  }
  if (patch.presetId != null) {
    const id = String(patch.presetId)
    const plan = readPlanFile(path.join(HERE, 'presets', id + '.json'), id)
    if (!plan) return '预设不存在：' + id
    state.plan = plan
    state.presetId = plan.id
    state.ledger.settings.presetId = plan.id
    state.ledger.settings.limitOverrides = {}
  }
  return null
}

function pickWindow(state, id) {
  const windows = state.plan.windows
  if (!id) return windows[0]
  return windows.find((w) => w.id === id || w.short === id) || null
}

/**
 * A grant lives until the window it belongs to would have rolled over.
 * The amount is SET, never added: a second request edits the existing grant so
 * repeated clicks cannot walk the cap upward. Asking for 0 removes it.
 */
function grant(state, w, yuan, now) {
  const grants = state.ledger.grants
  const index = grants.findIndex(
    (g) => g && g.windowId === w.id && Number(g.expiresAt) > now && (Number(g.ts) || 0) <= now,
  )
  if (!(Number(yuan) > 0)) {
    // "Zero" keeps the grant record and sets its amount to 0, rather than
    // deleting it — the window then simply falls back to its base limit.
    if (index >= 0) grants[index].units = 0
    return
  }
  const units = moneyUnits(yuan)
  if (index >= 0) {
    grants[index].units = units
    return
  }
  const { end, durationMs } = windowBounds(w, now)
  const expiresAt = w.kind === 'rolling' ? now + durationMs : end
  grants.push({ windowId: w.id, units, ts: now, expiresAt })
}
