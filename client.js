// Client half of dsh-virtual-coding-plan.
//
// Four registrations, one shared poller:
//   conversation.composer.dock  -> the plan strip
//   conversation.input.overlay  -> the exhausted banner, anchored above the card
//   shell.overlay               -> the floating detail panel opened by the strip
//   settings.section            -> the same panel as a settings page
//   conversation.chat.commandview -> the rich /usage reply
//
// Data comes from the Host over GET /dsh-virtual-coding-plan/status.json;
// mutations go to POST /dsh-virtual-coding-plan/settings.json. No host Client
// package is imported: the ring re-draws the host's meter geometry with our own
// class names, and every colour is a theme token.
window.__ModuleLoader__.load({
  id: 'dsh-virtual-coding-plan',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const ROUTE = '/dsh-virtual-coding-plan'
    const NS = 'dsh-virtual-coding-plan'
    const POLL_MS = 15000
    const POLL_FAST_MS = 1500
    const PANEL_WIDTH = 392
    const PANEL_WIDTH_SETTINGS = 560

    // Only the tones the components actually pass around; everything else is a
    // token reference inside STYLE.
    const COLOR = {
      text: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const DICTS = {
      en: {
        title: 'Virtual Coding Plan',
        brandTitle: 'DSH Virtual Coding Plan',
        stripName: 'Coding Plan',
        distanceToReset: 'resets in',
        close: 'Close',
        plan: 'Plan',
        enforcement: 'Enforcement',
        block: 'Block',
        warn: 'Warn only',
        off: 'Off',
        limits: 'Window limits',
        save: 'Save',
        saved: 'Saved',
        topup: 'Raise limit',
        temp: 'Temp quota',
        apply: 'Apply',
        update: 'Update',
        clear: 'Zero',
        expiresIn: 'left',
        topupHint: 'One temporary quota per window: applying again edits the amount instead of adding to it.',
        today: 'today',
        week: 'week',
        totals: 'Spend',
        resetIn: 'resets in',
        paused: 'paused',
        exhausted: 'Plan limit reached',        settings: 'Settings',
        back: 'Back',
        live: 'live',
        trend: 'Usage trend',
        debugMode: 'Debug mode',
        last24h: 'last 24h',
        spend: 'Spend',
        tokens: 'Tokens',
        yuan: 'CNY',
      },
      zh: {
        title: '虚拟额度计划',
        brandTitle: 'DSH Virtual Coding Plan',
        stripName: 'Coding Plan',
        distanceToReset: '距离重置',
        close: '关闭',
        plan: '计划',
        enforcement: '拦截模式',
        block: '拦截',
        warn: '仅警告',
        off: '关闭',
        limits: '窗口上限',
        save: '保存',
        saved: '已保存',
        topup: '提额',
        temp: '临时额度',
        apply: '申请',
        update: '修改',
        clear: '清零',
        expiresIn: '后失效',
        topupHint: '每个窗口只有一笔临时额度：再次申请是修改金额，不是累加。',
        today: '今日',
        week: '本周',
        totals: '合计',
        resetIn: '后重置',
        paused: '已暂停',
        exhausted: '额度已用尽',
        settings: '设置',
        back: '返回',
        live: '实时',
        trend: '消耗趋势',
        debugMode: '调试模式',
        last24h: '最近 24 小时',
        spend: '钱数',
        tokens: 'Token',
        yuan: '元',
      },
    }

    // ---------------------------------------------------------------------
    // Shared status store — one poller for every registration.
    // ---------------------------------------------------------------------

    const store = { status: null, listeners: new Set(), timer: null, interval: 0, inflight: false }

    function emit() {
      for (const listener of store.listeners) {
        try {
          listener(store.status)
        } catch (err) {
          /* a broken subscriber must not stop the others */
        }
      }
    }

    function refresh() {
      if (store.inflight) return
      store.inflight = true
      fetch(ROUTE + '/status.json', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((next) => {
          if (next && next.ok) {
            store.status = next
            emit()
            retune()
          }
        })
        .catch(() => {
          /* host not reachable yet; keep the last value */
        })
        .then(() => {
          store.inflight = false
        })
    }

    // Poll fast while the plan is exhausted: that is the only window where a
    // rejection can happen, and a sluggish poll would make it look ignored.
    function desiredInterval() {
      return store.status && store.status.blocked ? POLL_FAST_MS : POLL_MS
    }

    function retune() {
      if (!store.timer) return
      const next = desiredInterval()
      if (next === store.interval) return
      clearInterval(store.timer)
      store.interval = next
      store.timer = setInterval(refresh, next)
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      if (store.listeners.size === 1) {
        refresh()
        store.interval = POLL_MS
        store.timer = setInterval(refresh, store.interval)
      } else if (store.status) {
        listener(store.status)
      }
      return () => {
        store.listeners.delete(listener)
        if (store.listeners.size === 0 && store.timer) {
          clearInterval(store.timer)
          store.timer = null
        }
      }
    }

    function useStatus() {
      const [snapshot, setSnapshot] = useState(store.status)
      useEffect(() => subscribe(setSnapshot), [])
      return snapshot
    }

    // Shared open/closed state for the floating panel, including the anchor
    // rect so it can sit next to the strip it was opened from, and which view
    // the card currently shows.
    const dialog = { open: false, anchor: null, view: 'status', listeners: new Set() }

    function setDialogOpen(open, anchor, view) {
      dialog.open = open
      if (open) {
        if (anchor) dialog.anchor = anchor
        if (view) dialog.view = view
      }
      const snapshot = { open: dialog.open, anchor: dialog.anchor, view: dialog.view }
      for (const listener of dialog.listeners) {
        try {
          listener(snapshot)
        } catch (err) {
          /* a broken subscriber must not stop the others */
        }
      }
    }

    function useDialog() {
      const [state, setState] = useState({ open: dialog.open, anchor: dialog.anchor, view: dialog.view })
      useEffect(() => {
        dialog.listeners.add(setState)
        return () => dialog.listeners.delete(setState)
      }, [])
      return state
    }

    async function postSettings(patch) {
      const res = await fetch(ROUTE + '/settings.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const next = await res.json()
      if (next && next.ok) {
        store.status = next
        emit()
        return next
      }
      throw new Error((next && next.error) || 'request failed')
    }

    // ---------------------------------------------------------------------
    // Presentational helpers
    // ---------------------------------------------------------------------

    /**
     * 14px progress ring. Geometry copied from the host's own meter: viewBox
     * 14x14, r=5.5, the whole circumference as the dash gap, rotated so the arc
     * starts at 12 o'clock. Stroke colour is `currentColor`, so the caller
     * passes the tone and the two circles never need their own colours.
     */
    function Ring(props) {
      const radius = 5.5
      const circumference = 2 * Math.PI * radius
      const ratio = Math.max(0, Math.min(1, Number(props.ratio) || 0))
      const dash = circumference * ratio
      return h(
        'svg',
        {
          className: 'dcp-ring',
          viewBox: '0 0 14 14',
          width: 14,
          height: 14,
          'aria-hidden': true,
          style: { color: props.tone || COLOR.tertiary },
        },
        h('circle', { className: 'dcp-ring-track', cx: 7, cy: 7, r: radius }),
        h('circle', {
          className: 'dcp-ring-fill',
          cx: 7,
          cy: 7,
          r: radius,
          strokeDasharray: dash + ' ' + circumference,
          transform: 'rotate(-90 7 7)',
        }),
      )
    }

    /** Sliders glyph — reads as "adjust settings" and stays legible at 14px. */
    function SettingsIcon() {
      return h(
        'svg',
        {
          className: 'dcp-ico',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2.5 5.5h6M11 5.5h2.5M2.5 10.5h2M7 10.5h6.5' }),
        h('circle', { cx: 9.75, cy: 5.5, r: 1.5 }),
        h('circle', { cx: 5.75, cy: 10.5, r: 1.5 }),
      )
    }

    function formatMs(ms) {
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

    function shortTime(ts) {
      const d = new Date(Number(ts) || 0)
      if (!Number.isFinite(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function shortYuan(value) {
      const n = Number(value) || 0
      if (n <= 0) return '¥0'
      return '¥' + (n >= 0.1 ? n.toFixed(2) : n.toFixed(3))
    }

    function shortTokens(value) {
      const n = Number(value) || 0
      if (n <= 0) return '0'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    /** Money field: the ¥ unit lives inside the border so both editors align. */
    function MoneyInput(props) {
      return h(
        'span',
        { className: 'dcp-money' },
        h('span', { className: 'dcp-money-unit' }, '¥'),
        h('input', {
          className: 'dcp-money-input',
          type: 'number',
          min: '0',
          step: props.step || '0.01',
          value: props.value,
          disabled: props.disabled,
          'aria-label': props.label || '',
          onChange: props.onChange,
        }),
      )
    }

    /**
     * One series in a shared X axis. `preserveAspectRatio="none"` lets the line
     * fill the row, so the stroke uses non-scaling-stroke to keep its width.
     */
    function Sparkline(props) {
      const values = props.values || []
      const max = Math.max.apply(null, values.concat([0]))
      const n = values.length
      const points = values
        .map((v, i) => {
          const x = n > 1 ? (i / (n - 1)) * 100 : 50
          const y = 24 - (max > 0 ? (Number(v) || 0) / max : 0) * 20
          return x.toFixed(2) + ',' + y.toFixed(2)
        })
        .join(' ')
      return h(
        'svg',
        {
          className: 'dcp-series-svg',
          viewBox: '0 0 100 26',
          preserveAspectRatio: 'none',
          'aria-hidden': true,
        },
        h('line', {
          x1: 0,
          y1: 24,
          x2: 100,
          y2: 24,
          stroke: 'var(--dsw-alias-border-l1)',
          strokeWidth: 1,
          vectorEffect: 'non-scaling-stroke',
        }),
        n > 0
          ? h('polyline', {
              points,
              fill: 'none',
              stroke: props.color,
              strokeWidth: 1.5,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              vectorEffect: 'non-scaling-stroke',
            })
          : null,
      )
    }

    function toneFor(percent, blocked) {
      if (blocked) return COLOR.error
      if (Number(percent) >= 80) return COLOR.warn
      return COLOR.tertiary
    }

    /** The window a countdown should describe: the most exhausted one, else the primaries. */
    function bindingWindow(windows) {
      if (!windows || !windows.length) return null
      const sorted = windows.slice().sort((a, b) => b.percent - a.percent)
      const hottest = sorted[0]
      if (hottest && hottest.percent >= 80 && hottest.resetsInMs != null) return hottest
      const primary = windows.find((w) => w.resetsInMs != null) || windows[0]
      return primary || null
    }

    const STYLE = `
/* ---- strip: mirrors the host composer trigger ---- */
.dcp-strip{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;flex:0 0 auto;
  border:0;border-radius:var(--dsw-radius-sm,8px);background:none;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));
  font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;user-select:none;pointer-events:auto}
.dcp-strip:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-secondary)}
.dcp-strip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcp-strip .dcp-sep{opacity:.6}
.dcp-strip .dcp-seg{display:inline-flex;align-items:center;gap:4px}

/* ---- ring ---- */
.dcp-ring{display:block;flex:0 0 auto}
.dcp-ring-track{fill:none;stroke:var(--dsw-alias-border-l3,var(--dsw-alias-border-l1));stroke-width:2px}
.dcp-ring-fill{fill:none;stroke:currentColor;stroke-width:2px;stroke-linecap:round}

/* ---- floating panel: host menu surface ---- */
.dcp-pop{position:fixed;z-index:1100;box-sizing:border-box;padding:12px;pointer-events:auto;
  max-height:calc(100vh - 24px);overflow:auto;
  border-radius:var(--dsw-radius-lg,12px);
  background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));
  border:1px solid var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.28));
  backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  color:var(--dsw-alias-label-secondary);
  font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));
  transition:width .2s cubic-bezier(.2,.7,.3,1),left .2s cubic-bezier(.2,.7,.3,1),height .2s cubic-bezier(.2,.7,.3,1);
  interpolate-size:allow-keywords;
  animation:dcp-pop-in .16s ease-out}
@keyframes dcp-pop-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
.dcp-pop-body{animation:dcp-body-in .18s ease-out}
@keyframes dcp-body-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dcp-pop,.dcp-pop-body{animation:none;transition:none}}
.dcp-pop-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dcp-pop-head-float{position:absolute;top:10px;right:10px;margin:0;z-index:1}
.dcp-pop-title{flex:1;color:var(--dsw-alias-label-primary);font-weight:500}
.dcp-back{border:0;background:none;padding:0 6px;height:22px;border-radius:var(--dsw-radius-sm,6px);
  font-family:inherit;font-size:12px;line-height:22px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dcp-back:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-secondary)}
.dcp-settings-btn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;margin-right:-4px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent);
  border-radius:var(--dsw-radius-sm,6px);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  font-family:inherit;font-size:12px;font-weight:500;line-height:20px;
  color:var(--dsw-alias-brand-primary);cursor:pointer}
.dcp-settings-btn:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
  border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent)}
.dcp-settings-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcp-ico{flex:0 0 auto;display:block}

/* ---- page body ---- */
.dcp-page{display:flex;flex-direction:column;gap:8px;max-width:640px;padding-top:14px}
.dcp-page-compact{padding-top:0;gap:5px}
.dcp-page-compact .dcp-head{margin-bottom:2px}
.dcp-page-compact .dcp-head-title{font-size:13px;line-height:18px}
.dcp-head{display:flex;flex-direction:column;align-items:center;gap:4px;margin-bottom:6px}
.dcp-head-title{font-size:15px;font-weight:600;line-height:22px;letter-spacing:.2px;
  color:var(--dsw-alias-label-primary);text-align:center}
.dcp-head-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dcp-rule{height:1px;margin:4px 0;background:var(--dsw-alias-border-l1)}
.dcp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:20px}
.dcp-k{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dcp-v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcp-muted{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcp-money{display:inline-flex;align-items:center;height:22px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-base);overflow:hidden}
.dcp-money:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dcp-money-unit{padding:0 2px 0 7px;font-size:11px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dcp-money-input{width:62px;height:20px;box-sizing:border-box;padding:0 6px 0 2px;border:0;
  background:none;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums}
.dcp-money-input:focus{outline:none}
.dcp-wlabel{margin-top:4px}
.dcp-bar{display:flex;height:4px;margin:4px 0 2px;border-radius:999px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-border-l1))}
.dcp-bar > i{display:block;height:100%;min-width:2px;border-radius:999px}
.dcp-wfoot{display:flex;align-items:center;justify-content:space-between;gap:12px;
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcp-field{display:inline-flex;align-items:center;gap:6px}
.dcp-tools{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dcp-chart{display:flex;flex-direction:column;gap:4px;margin-top:2px}
.dcp-series{display:flex;align-items:center;gap:8px;height:26px}
.dcp-series-label{flex:0 0 40px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dcp-series-svg{flex:1;height:26px;display:block;overflow:visible}
.dcp-series-peak{flex:0 0 auto;min-width:46px;text-align:right;font-size:11px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcp-axis{display:flex;justify-content:space-between;margin-top:2px;font-size:11px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* ---- /usage command row ---- */
.dcp-cmd{display:flex;flex-direction:column;gap:6px;margin:4px 0;padding:10px 12px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);
  background:var(--dsw-alias-bg-layer-1);font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dcp-cmd-head{display:flex;align-items:center;gap:8px}
.dcp-cmd-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-weight:500;color:var(--dsw-alias-label-primary)}
.dcp-badge{flex:0 0 auto;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dcp-foot{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dcp-sign{margin-top:10px;font-size:11px;line-height:16px;text-align:center;letter-spacing:2px;
  color:var(--dsw-alias-label-tertiary)}

/* ---- controls ---- */
.dcp-select{height:22px;box-sizing:border-box;padding:0 4px;font-family:inherit;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.dcp-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dcp-btn{height:22px;padding:0 10px;font-family:inherit;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dcp-btn:hover{border-color:var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dcp-btn:disabled{opacity:.5;cursor:default}
.dcp-btn-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}

/* ---- exhausted banner ---- */
.dcp-temp{color:var(--dsw-alias-brand-primary);font-size:11px;margin-left:2px}
.dcp-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);
  color:var(--dsw-alias-brand-primary);font-size:11px;line-height:20px;
  font-variant-numeric:tabular-nums;white-space:nowrap}

/* ---- exhausted banner ---- */
/* The overlay slot renders inside the composer card, so anchoring to its box
   makes the banner exactly as wide as the card — no pixel matching. */
.dcp-banner{position:absolute;left:0;right:0;bottom:100%;margin:0 0 6px;
  display:flex;align-items:center;gap:10px;padding:8px 12px;box-sizing:border-box;
  border-radius:var(--dsw-radius-sm,8px);pointer-events:auto;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,var(--dsw-alias-bg-layer-1))}
.dcp-banner-dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;
  background:var(--dsw-alias-state-error-primary)}
.dcp-banner-main{flex:1;min-width:0}
.dcp-banner-title{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.dcp-banner-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcp-banner-btn{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);
  border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base);
  font-family:inherit;font-size:12px;line-height:22px;color:var(--dsw-alias-state-error-primary);cursor:pointer}
.dcp-banner-btn:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
@keyframes dcp-banner-pulse{
  0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);transform:scale(1.014)}
  40%{box-shadow:0 0 0 7px color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}
  100%{box-shadow:0 0 0 14px transparent;transform:scale(1)}}
.dcp-banner-pulse{animation:dcp-banner-pulse 1s ease-out}
@media (prefers-reduced-motion:reduce){.dcp-banner-pulse{animation:none}}

`

    // ---------------------------------------------------------------------
    // A. Strip — conversation.composer.dock
    // ---------------------------------------------------------------------

    function Strip(props) {
      const status = useStatus()
      const panel = useDialog()
      const t = props.t || ((key) => DICTS.en[key] || key)
      if (!status || !status.windows || !status.windows.length) return null

      const windows = status.windows
      const primary = windows[0]
      const secondary = windows[1] || null
      const blocked = !!status.blocked
      const tone = toneFor(Math.max.apply(null, windows.map((w) => w.percent)), blocked)
      const binding = bindingWindow(windows)

      const title = windows
        .map((w) => {
          const reset = w.resetsInMs == null ? '' : '（重置于 ' + formatMs(w.resetsInMs) + ' 后）'
          return w.label + ' ¥' + w.spentYuan.toFixed(2) + '/¥' + w.limitYuan.toFixed(2) + reset
        })
        .join(' · ')

      const toggle = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setDialogOpen(!dialog.open, rect, 'status')
      }

      const segments = []
      segments.push(h('span', { key: 'name' }, t('stripName')))
      const push = (key, node) => {
        segments.push(h('span', { key: key + '-sep', className: 'dcp-sep' }, '·'))
        segments.push(node)
      }
      const pushWindow = (key, w) =>
        push(
          key,
          h(
            'span',
            { className: 'dcp-seg' },
            (w.tempYuan || 0) > 0 ? t('temp') : w.short,
            h(Ring, { ratio: w.percent / 100, tone: toneFor(w.percent, w.exceeded) }),
            String(w.percent) + '%',
          ),
        )

      pushWindow('primary', primary)
      if (secondary) pushWindow('secondary', secondary)

      if (binding && binding.resetsInMs != null) {
        // The number is time left; the ring shows how much of the window has
        // already been consumed, so it fills up instead of draining.
        const elapsedRatio =
          binding.durationMs > 0 ? 1 - binding.resetsInMs / binding.durationMs : 0
        push(
          'reset',
          h(
            'span',
            { className: 'dcp-seg' },
            blocked ? t('paused') : t('distanceToReset'),
            h(Ring, { ratio: elapsedRatio, tone: blocked ? COLOR.error : tone }),
            formatMs(binding.resetsInMs),
          ),
        )
      }

      return h(
        'div',
        {
          className: 'dcp-strip',
          title,
          role: 'button',
          tabIndex: 0,
          'aria-expanded': panel.open ? 'true' : 'false',
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggle(event)
            }
          },
        },
        h('style', null, STYLE),
        segments,
      )
    }

    // ---------------------------------------------------------------------
    // B. Shared pieces
    // ---------------------------------------------------------------------

    /** One window: label + money, a 4px meter, then percent and reset. */
    function WindowBlock(props) {
      const w = props.w
      const t = props.t
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dcp-row dcp-wlabel' },
          h('span', { className: 'dcp-k' }, w.label),
          h(
            'span',
            { className: 'dcp-v' },
            '¥' +
              w.spentYuan.toFixed(2) +
              ' / ¥' +
              (w.baseLimitYuan != null ? w.baseLimitYuan : w.limitYuan).toFixed(2),
            (w.tempYuan || 0) > 0
              ? h(
                  'span',
                  {
                    className: 'dcp-temp',
                    title:
                      w.tempExpiresInMs != null ? '临时额度 · ' + formatMs(w.tempExpiresInMs) + ' ' + t('resetIn') : '临时额度',
                  },
                  ' +¥' + w.tempYuan.toFixed(2),
                )
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dcp-bar' },
          h('i', { style: { width: Math.min(100, w.percent) + '%', background: toneFor(w.percent, w.exceeded) } }),
        ),
        h(
          'div',
          { className: 'dcp-wfoot' },
          h('span', null, w.percent + '%'),
          h('span', null, w.resetsInMs == null ? '' : formatMs(w.resetsInMs) + ' ' + t('resetIn')),
        ),
      )
    }

    /** Read-only view: what the plan is and how much is spent. */
    function Overview(props) {
      const status = useStatus()
      const t = props.t || ((key) => DICTS.en[key] || key)
      if (!status) return null
      const windows = status.windows || []
      const mode = status.enforcement === 'block' ? 'block' : status.enforcement === 'warn' ? 'warn' : 'off'
      return h(
        'div',
        { className: 'dcp-page dcp-page-compact' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'dcp-head' },
          h('div', { className: 'dcp-head-title' }, t('brandTitle')),
          h('div', { className: 'dcp-head-sub' }, status.plan.name),
        ),
        h(
          'div',
          { className: 'dcp-row' },
          h('span', { className: 'dcp-k' }, t('enforcement')),
          h('span', { className: 'dcp-v' }, t(mode)),
        ),
        h('div', { className: 'dcp-rule' }),
        windows.map((w) => h(WindowBlock, { key: w.id, w, t })),
        h(
          'div',
          { className: 'dcp-row' },
          h('span', { className: 'dcp-k' }, t('totals')),
          h(
            'span',
            { className: 'dcp-v' },
            t('today') + ' ¥' + status.todayYuan.toFixed(2) + ' · ' + t('week') + ' ¥' + status.weekYuan.toFixed(2),
          ),
        ),
      )
    }

    /**
     * Rich replacement for the `/usage` command row. Reads live status instead
     * of the captured text (the text stays as the non-Web fallback), so the
     * badge says "live" rather than pretending to be a frozen snapshot.
     */
    function CommandCard(props) {
      const status = useStatus()
      const t = props.t || ((key) => DICTS.en[key] || key)
      if (!status) return null
      const windows = status.windows || []
      const hottest = windows.reduce((worst, w) => (w.percent > worst.percent ? w : worst), windows[0] || { percent: 0 })
      const mode = status.enforcement === 'block' ? t('block') : status.enforcement === 'warn' ? t('warn') : t('off')
      return h(
        'div',
        { className: 'dcp-cmd' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'dcp-cmd-head' },
          h(Ring, { ratio: (hottest.percent || 0) / 100, tone: toneFor(hottest.percent, status.blocked) }),
          h('span', { className: 'dcp-cmd-title' }, t('stripName') + ' · ' + status.plan.name),
          h('span', { className: 'dcp-badge' }, t('live')),
        ),
        windows.map((w) => h(WindowBlock, { key: w.id, w, t })),
        h('div', { className: 'dcp-rule' }),
        h(
          'div',
          { className: 'dcp-row' },
          h('span', { className: 'dcp-k' }, t('totals')),
          h(
            'span',
            { className: 'dcp-v' },
            t('today') + ' ¥' + status.todayYuan.toFixed(2) + ' · ' + t('week') + ' ¥' + status.weekYuan.toFixed(2),
          ),
        ),
        h(
          'div',
          { className: 'dcp-row' },
          h('span', { className: 'dcp-k' }, t('tokens')),
          h(
            'span',
            { className: 'dcp-v' },
            shortTokens(status.tokensToday || 0) + ' · ' + t('week') + ' ' + shortTokens(status.tokensWeek || 0),
          ),
        ),
        h('div', { className: 'dcp-wfoot' }, h('span', null, t('enforcement') + ' · ' + mode)),
      )
    }

    // ---------------------------------------------------------------------
    // C. Page — the editable view (panel and settings section)
    // ---------------------------------------------------------------------
    function Page(props) {
      const status = useStatus()
      const t = props.t || ((key) => DICTS.en[key] || key)
      const [draft, setDraft] = useState({})
      const [topup, setTopup] = useState('5')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      useEffect(() => {
        if (!status || !status.windows) return
        const next = {}
        for (const w of status.windows) {
          next[w.id] = String(w.baseLimitYuan != null ? w.baseLimitYuan : w.limitYuan)
        }
        setDraft(next)
      }, [status && status.plan && status.plan.presetId, status && status.windows && status.windows.length])

      const run = useCallback(
        async (patch) => {
          setBusy(true)
          setNote('')
          try {
            await postSettings(patch)
            setNote(t('saved'))
          } catch (err) {
            setNote(String((err && err.message) || err))
          } finally {
            setBusy(false)
          }
        },
        [t],
      )

      if (!status) return h('div', { className: 'dcp-page' }, h('style', null, STYLE), h('div', { className: 'dcp-muted' }, '…'))
      const windows = status.windows || []
      const presets = status.presets || []

      // Older hosts return bare ids; normalise so the page works before the
      // Host half is restarted with the debug flag.
      const catalog = presets.map((p) => (typeof p === 'string' ? { id: p, name: p, debug: false } : p))
      const normalPresets = catalog.filter((p) => p && !p.debug)
      const debugPresets = catalog.filter((p) => p && p.debug)

      // Centred brand line replaces the old "Plan: name" row; the preset
      // selector stays underneath it because switching plans is still useful.
      const header = h(
        'div',
        { className: 'dcp-head' },
        h('div', { className: 'dcp-head-title' }, t('brandTitle')),
        normalPresets.length > 1
          ? h(
              'select',
              {
                className: 'dcp-select',
                value: status.plan.presetId || '',
                disabled: busy,
                onChange: (event) => run({ presetId: event.target.value }),
              },
              normalPresets.map((p) => h('option', { key: p.id, value: p.id }, p.name)),
            )
          : null,
      )

      const enforcementRow = h(
        'div',
        { className: 'dcp-row' },
        h('span', { className: 'dcp-k' }, t('enforcement')),
        h(
          'span',
          { className: 'dcp-tools' },
          note ? h('span', { className: 'dcp-muted' }, note) : null,
          h(
            'select',
            {
              className: 'dcp-select',
              value: status.enforcement,
              disabled: busy,
              onChange: (event) => run({ enforcement: event.target.value }),
            },
            h('option', { value: 'block' }, t('block')),
            h('option', { value: 'warn' }, t('warn')),
            h('option', { value: 'off' }, t('off')),
          ),
        ),
      )

      const windowBlocks = windows.map((w) => h(WindowBlock, { key: w.id, w, t }))

      const totalsRow = h(
        'div',
        { className: 'dcp-row' },
        h('span', { className: 'dcp-k' }, t('totals')),
        h('span', { className: 'dcp-v' }, t('today') + ' ¥' + status.todayYuan.toFixed(2) + ' · ' + t('week') + ' ¥' + status.weekYuan.toFixed(2)),
      )

      const limitsRow = h(
        'div',
        { className: 'dcp-row' },
        h('span', { className: 'dcp-k' }, t('limits')),
        h(
          'span',
          { className: 'dcp-tools' },
          windows.map((w) =>
            h(
              'label',
              { key: w.id, className: 'dcp-field' },
              h('span', { className: 'dcp-muted' }, w.short),
              h(MoneyInput, {
                value: draft[w.id] != null ? draft[w.id] : '',
                disabled: busy,
                label: w.label,
                onChange: (event) => setDraft({ ...draft, [w.id]: event.target.value }),
              }),
            ),
          ),
          h(
            'button',
            {
              className: 'dcp-btn dcp-btn-primary',
              disabled: busy,
              onClick: () => {
                const limits = {}
                for (const w of windows) {
                  const value = Number(draft[w.id])
                  if (Number.isFinite(value) && value >= 0) limits[w.id] = value
                }
                run({ limits })
              },
            },
            t('save'),
          ),
        ),
      )

      const tempWindow = windows[0] || {}
      const tempActive = (tempWindow.tempYuan || 0) > 0
      const tempNote = tempActive
        ? '¥' +
          tempWindow.tempYuan.toFixed(2) +
          (tempWindow.tempExpiresInMs != null ? ' · ' + formatMs(tempWindow.tempExpiresInMs) + ' ' + t('expiresIn') : '')
        : ''

      const topupRow = h(
        'div',
        { className: 'dcp-row' },
        h('span', { className: 'dcp-k' }, t('temp')),
        h(
          'span',
          { className: 'dcp-tools' },
          h(MoneyInput, {
            value: topup,
            step: '1',
            disabled: busy,
            label: t('temp'),
            onChange: (event) => setTopup(event.target.value),
          }),
          h(
            'button',
            {
              className: 'dcp-btn' + (tempActive ? '' : ' dcp-btn-primary'),
              disabled: busy,
              onClick: () => {
                const value = Number(topup)
                if (!Number.isFinite(value) || value <= 0) return
                run({ topup: { windowId: tempWindow.id, yuan: value } })
              },
            },
            tempActive ? t('update') : t('apply'),
          ),
          tempActive
            ? h(
                'button',
                {
                  className: 'dcp-btn',
                  disabled: busy,
                  onClick: () => run({ topup: { windowId: tempWindow.id, yuan: 0 } }),
                },
                t('clear'),
              )
            : null,
          tempNote ? h('span', { className: 'dcp-chip' }, tempNote) : null,
        ),
      )

      const history = status.history || []
      const moneySeries = history.map((b) => b.costUnits / 1e8)
      const tokenSeries = history.map((b) => b.tokens)
      const peak = (values) => values.reduce((m, v) => (v > m ? v : m), 0)

      const chart = h(
        'div',
        { className: 'dcp-chart' },
        h(
          'div',
          { className: 'dcp-series' },
          h('span', { className: 'dcp-series-label' }, t('spend')),
          h(Sparkline, { values: moneySeries, color: COLOR.text }),
          h('span', { className: 'dcp-series-peak' }, shortYuan(peak(moneySeries))),
        ),
        h(
          'div',
          { className: 'dcp-series' },
          h('span', { className: 'dcp-series-label' }, t('tokens')),
          h(Sparkline, { values: tokenSeries, color: COLOR.tertiary }),
          h('span', { className: 'dcp-series-peak' }, shortTokens(peak(tokenSeries))),
        ),
        h(
          'div',
          { className: 'dcp-axis' },
          h('span', null, history.length ? shortTime(history[0].t) : ''),
          h('span', null, history.length ? shortTime(history[history.length - 1].t) : ''),
        ),
      )

      return h(
        'div',
        { className: 'dcp-page' + (props.compact ? ' dcp-page-compact' : '') },
        h('style', null, STYLE),
        header,
        enforcementRow,
        h('div', { className: 'dcp-rule' }),
        windowBlocks,
        totalsRow,
        h('div', { className: 'dcp-rule' }),
        limitsRow,
        topupRow,
        h('div', { className: 'dcp-foot' }, t('topupHint')),
        h('div', { className: 'dcp-rule' }),
        history.length
          ? h(
              'div',
              { className: 'dcp-row' },
              h('span', { className: 'dcp-k' }, t('trend')),
              h('span', { className: 'dcp-muted' }, t('last24h')),
            )
          : null,
        history.length ? chart : null,
        debugPresets.length && normalPresets.length
          ? h(
              'div',
              { className: 'dcp-row' },
              h('span', { className: 'dcp-k' }, t('debugMode')),
              h(
                'span',
                { className: 'dcp-tools' },
                h(
                  'select',
                  {
                    className: 'dcp-select',
                    value: debugPresets.some((p) => p.id === status.plan.presetId)
                      ? status.plan.presetId
                      : normalPresets[0].id,
                    disabled: busy,
                    onChange: (event) => run({ presetId: event.target.value }),
                  },
                  h('option', { value: normalPresets[0].id }, t('off')),
                  debugPresets.map((p) => h('option', { key: p.id, value: p.id }, p.name)),
                ),
              ),
            )
          : null,
        h('div', { className: 'dcp-foot' }, '本插件只在本机记账与拦截，不连接任何第三方订阅。'),
        h('div', { className: 'dcp-sign' }, '赤石科技巨献'),
      )
    }

    // ---------------------------------------------------------------------
    // D. Exhausted banner — conversation.input.overlay
    // ---------------------------------------------------------------------

    function Banner(props) {
      const status = useStatus()
      const t = props.t || ((key) => DICTS.en[key] || key)
      const [pulse, setPulse] = useState(false)
      const seenReject = useRef(0)

      // The Host stamps lastRejectAt on every refused step, so a send that was
      // silently dropped still produces a visible reaction here.
      useEffect(() => {
        const at = status && status.lastRejectAt
        if (!at || at === seenReject.current) return undefined
        seenReject.current = at
        setPulse(true)
        const id = setTimeout(() => setPulse(false), 1000)
        return () => clearTimeout(id)
      }, [status && status.lastRejectAt])

      if (!status || !status.blocked) return null
      const windows = status.windows || []
      const over = windows.find((w) => w.exceeded) || bindingWindow(windows)
      const detail = over
        ? over.label +
          ' ¥' +
          over.spentYuan.toFixed(2) +
          ' / ¥' +
          over.limitYuan.toFixed(2) +
          (over.resetsInMs != null ? ' · ' + formatMs(over.resetsInMs) + ' ' + t('resetIn') : '')
        : ''
      return h(
        'div',
        {
          className: 'dcp-banner' + (pulse ? ' dcp-banner-pulse' : ''),
          role: 'status',
          'aria-live': 'polite',
        },
        h('style', null, STYLE),
        h('span', { className: 'dcp-banner-dot' }),
        h(
          'div',
          { className: 'dcp-banner-main' },
          h('div', { className: 'dcp-banner-title' }, t('exhausted')),
          detail ? h('div', { className: 'dcp-banner-sub' }, detail) : null,
        ),
        h(
          'button',
          { className: 'dcp-banner-btn', onClick: () => setDialogOpen(true, null, 'settings') },
          h(SettingsIcon),
          t('topup'),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // E. Floating panel — shell.overlay (opened by clicking the strip)
    // ---------------------------------------------------------------------

    function panelPosition(anchor, preferred) {
      const width = Math.min(preferred || PANEL_WIDTH, Math.max(280, window.innerWidth - 24))
      if (!anchor) return { right: '16px', bottom: '96px', width: width + 'px' }
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))
      const bottom = Math.max(12, window.innerHeight - anchor.top + 8)
      return { left: left + 'px', bottom: bottom + 'px', width: width + 'px' }
    }

    function Popover(props) {
      const state = useDialog()
      const t = props.t || ((key) => DICTS.en[key] || key)
      const panelRef = useRef(null)

      useEffect(() => {
        if (!state.open) return undefined
        const onDown = (event) => {
          const target = event.target
          if (panelRef.current && panelRef.current.contains(target)) return
          // A pointer-down on the strip is the toggle itself; let its click win.
          if (target && target.closest && target.closest('.dcp-strip')) return
          setDialogOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setDialogOpen(false)
        }
        const onResize = () => setDialogOpen(false)
        document.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onResize)
        }
      }, [state.open])

      if (!state.open) return null
      const inSettings = state.view === 'settings'
      return h(
        'div',
        {
          className: 'dcp-pop',
          ref: panelRef,
          style: panelPosition(state.anchor, inSettings ? PANEL_WIDTH_SETTINGS : PANEL_WIDTH),
          role: 'dialog',
          'aria-modal': 'false',
          'aria-label': inSettings ? t('settings') : t('title'),
        },
        h('style', null, STYLE),
        h(
          'div',
          { className: inSettings ? 'dcp-pop-head' : 'dcp-pop-head dcp-pop-head-float' },
          inSettings
            ? h('button', { className: 'dcp-back', onClick: () => setDialogOpen(true, null, 'status') }, '‹ ' + t('back'))
            : null,
          inSettings ? h('span', { className: 'dcp-pop-title' }, t('settings')) : null,
          inSettings
            ? null
            : h(
                'button',
                { className: 'dcp-settings-btn', onClick: () => setDialogOpen(true, null, 'settings') },
                h(SettingsIcon),
                t('settings'),
              ),
        ),
        h(
          'div',
          { className: 'dcp-pop-body', key: inSettings ? 'settings' : 'status' },
          inSettings ? h(Page, { t, compact: true }) : h(Overview, { t }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        // The locale service keys dictionaries by its active locale id, which
        // can be zh, zh-CN, zh-Hans, ... — register every common spelling so a
        // lookup cannot miss and fall back to English.
        const ZH_LOCALE_IDS = ['zh', 'zh-CN', 'zh-cn', 'zh-Hans', 'zh-hans', 'zh-Hant', 'zh-TW']
        let preferred = DICTS.en
        try {
          if (/^zh/i.test(navigator.language || '')) preferred = DICTS.zh
        } catch (err) {
          /* navigator unavailable; every key has an English fallback anyway */
        }
        let t = (key) => preferred[key] || DICTS.en[key] || key

        try {
          const locale = ctx.get('locale')
          if (locale) {
            for (const id of ZH_LOCALE_IDS) {
              try {
                locale.register(NS, id, DICTS.zh)
              } catch (err) {
                /* an id this build does not know */
              }
            }
            try {
              locale.register(NS, 'en', DICTS.en)
            } catch (err) {
              /* ignore */
            }
            const bound = locale.bind(NS)
            if (typeof bound === 'function') {
              t = (key) => {
                try {
                  const value = bound(key)
                  return typeof value === 'string' && value ? value : preferred[key] || DICTS.en[key] || key
                } catch (err) {
                  return preferred[key] || DICTS.en[key] || key
                }
              }
            }
          }
        } catch (err) {
          /* fall back to the inline dictionary chosen above */
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-virtual-coding-plan', order: 2 },
            (props) => h(Strip, { ...props, t }),
          ),
        )

        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'dsh-virtual-coding-plan-block', order: 0 },
            (props) => h(Banner, { ...props, t }),
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-virtual-coding-plan', order: 50, label: () => t('title') },
            (props) => h(Page, { ...props, t }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-virtual-coding-plan-dialog', order: 20 },
            (props) => h(Popover, { ...props, t }),
          ),
        )

        ctx.slots.inject('conversation.chat.commandview', () =>
          ctx.slots.register(
            { name: 'conversation.chat.commandview', key: 'usage' },
            (props) => h(CommandCard, { ...props, t }),
          ),
        )
      },
    }
  },
})
