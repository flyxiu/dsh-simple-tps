/**
 * Offline checks for the dsh-simple-tps client bundle: load it the way the DSH
 * module loader does (a script calling window.__ModuleLoader__.load) and drive
 * the pure reading logic with synthetic chat nodes.
 *
 * Run: node tests/run.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, '..', 'lib', 'client.js')

let loaded = null
let viewportWidth = 1440
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    }
  },
  matchMedia(query) {
    const bound = /max-width:\s*(\d+)px/.exec(query)
    return {
      matches: bound === null ? false : viewportWidth <= Number(bound[1]),
      addEventListener() {},
      removeEventListener() {}
    }
  }
}
const styles = new Map()
let pendingStyleKey = null
globalThis.document = {
  __styles: styles,
  querySelector: (selector) => {
    const match = /data-plugin-css="([^"]+)"/.exec(selector)
    pendingStyleKey = match === null ? null : match[1]
    return styles.has(pendingStyleKey) ? {} : null
  },
  createElement: () => ({
    dataset: {},
    set textContent(value) {
      if (pendingStyleKey !== null) styles.set(pendingStyleKey, value)
    },
    remove() {}
  }),
  head: { appendChild() {} }
}

const source = await readFile(bundle, 'utf8')
new Function('window', 'document', source)(globalThis.window, globalThis.document)

assert.ok(loaded !== null, 'bundle must register itself with the module loader')
assert.equal(loaded.id, 'dsh-simple-tps', 'bundle id must equal the package name')

const factory = loaded.factory
const captured = { locale: null, components: {} }
const ctx = {
  effect(fn) {
    fn()
  },
  locale: {
    register(ns, dicts) {
      captured.locale = { ns, dicts }
    }
  },
  slots: {
    inject(name, produce) {
      produced.push(name)
      return produce()
    },
    register(options, component) {
      registered.push({ name: options.name, id: options.id, order: options.order })
      captured.components[options.id] = component
      return () => {}
    }
  }
}
const produced = []
const registered = []
const exports = factory((id) => {
  if (id === 'react') return { createElement: () => null, Fragment: 'Fragment' }
  if (id === 'react-dom') return { createPortal: (node) => node }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { IconGaugeOutlineRegular: function Gauge() {} }
  throw new Error('unexpected require: ' + id)
})

// --- registration wiring -----------------------------------------------------
exports.apply(ctx)
assert.deepEqual(produced, ['conversation.composer.dock', 'conversation.chat.assistant-actions'], 'ambient sampler plus the per-turn pill')
assert.deepEqual(registered[0], { name: 'conversation.composer.dock', id: 'simple-tps-live', order: 900 })
assert.deepEqual(registered[1], { name: 'conversation.chat.assistant-actions', id: 'simple-tps', order: 100 })
assert.equal(captured.locale.ns, 'dsh-simple-tps')
assert.equal(captured.locale.dicts.zh['tps'], '{value} tok/s')
assert.deepEqual(exports.inject, ['slots', 'locale'])

// --- reading fold ------------------------------------------------------------
const turnReading = exports.turnReading

/** One settled assistant node. */
function step(seq, turn, messageId, start, first, done, outputTokens) {
  return {
    kind: 'assistant',
    seq,
    turn,
    messageId,
    timing: { stepStartTime: start, firstTokenTime: first, completedTime: done },
    usage: outputTokens === undefined ? {} : { outputTokens }
  }
}

// Three-step turn: TTFT 3200 / 1800 / 2100, decode 2000 / 3000 / 1000, tokens 100 / 150 / 50.
const threeSteps = [
  { kind: 'user', seq: 1, turn: 1 },
  step(10, 1, 'm-1', 1000, 4200, 6200, 100),
  step(11, 1, 'm-2', 7000, 8800, 11800, 150),
  step(12, 1, 'm-3', 13000, 15100, 16100, 50)
]
const three = turnReading(threeSteps, 1)
assert.equal(three.steps, 3)
assert.equal(three.ttftFirst, 3200)
assert.ok(Math.abs(three.ttftAvg - 7100 / 3) < 1e-9, 'mean TTFT over the three steps')
assert.ok(Math.abs(three.tps - 300 / 6) < 1e-9, 'TPS is token weighted: 300 tok over 6s')

// Numeric outputTokens of 0 are real data, not absence.
const zeroTokens = [step(1, 9, 'z', 0, 1000, 3000, 0)]
assert.equal(turnReading(zeroTokens, 9).tps, null, 'zero tokens cannot yield a speed')

// Missing timing: no TTFT and no decode window, but a message id still resolves.
const noTiming = [{ kind: 'assistant', seq: 1, turn: 2, messageId: 'm-x', usage: { outputTokens: 10 } }]
assert.equal(turnReading(noTiming, 2), null, 'nothing readable must render nothing')

// Partial timing: step start missing (history window opened mid-step) keeps TPS.
const partial = [
  {
    kind: 'assistant',
    seq: 1,
    turn: 3,
    messageId: 'm-p',
    timing: { stepStartTime: null, firstTokenTime: 1000, completedTime: 3000 },
    usage: { outputTokens: 40 }
  }
]
const partialReading = turnReading(partial, 3)
assert.equal(partialReading.ttftFirst, null)
assert.equal(partialReading.tps, 20)

// Other turns never leak into the fold.
const mixed = [step(1, 4, 'a', 0, 1000, 2000, 10), step(2, 5, 'b', 0, 1000, 3000, 90)]
assert.equal(turnReading(mixed, 5).steps, 1, 'only the closing turn is folded')
assert.ok(Math.abs(turnReading(mixed, 5).tps - 45) < 1e-9)

// Unknown turn: nothing to render.
assert.equal(turnReading(mixed, 99), null)
assert.equal(turnReading(null, 1), null)
assert.equal(turnReading(mixed, null), null)

// Turn resolution bridges the action row's message id to the owning turn.
const resolveTurn = exports.resolveTurn
const viewMap = (turn, messageId) => new Map([['turn-tail@7', { kind: 'turn-tail', data: { turn, closing: { finalNode: { messageId } } } }]])
assert.equal(resolveTurn({ nodes: viewMap(7, 'msg-7') }, 'msg-7'), 7)
assert.equal(resolveTurn({ nodes: viewMap(7, 'msg-7') }, 'other'), null, 'unrelated message resolves no turn')
assert.equal(resolveTurn({ nodes: new Map([['x', { kind: 'assistant' }]]) }, 'msg-7'), null, 'no turn-tail in window')
assert.equal(resolveTurn(null, 'msg-7'), null)
assert.equal(resolveTurn({ nodes: new Map() }, 'msg-7'), null)

// --- formatting --------------------------------------------------------------
assert.equal(exports.formatMs(3200), '3.2s')
assert.equal(exports.formatMs(12300), '12s')
assert.equal(exports.formatMs(59600), '1m')
assert.equal(exports.formatMs(72000), '1m12s')
assert.equal(exports.formatMs(0), '0.0s')
assert.equal(exports.formatTps(42.64), '42.6')
assert.equal(exports.formatTps(7.25), '7.3')
assert.equal(exports.formatTps(123.4), '123')

console.log('ok: registration wiring, reading fold, and formatting')

// --- render ------------------------------------------------------------------
/** Minimal React surface: enough to drive the component as a render function. */
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) })
let openSeat = false
const fakeReact = {
  createElement: h,
  Fragment: 'Fragment',
  useMemo: (produce) => produce(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  useLayoutEffect: () => {},
  useState: (initial) => [openSeat, (next) => { openSeat = typeof next === 'function' ? next(openSeat) : next }],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
}
const ui = factory((id) => {
  if (id === 'react') return fakeReact
  if (id === 'react-dom') return { createPortal: (node) => node }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { IconGaugeOutlineRegular: function Gauge() {} }
  throw new Error('unexpected require: ' + id)
})
// Re-run registration with the render-capable React stub so the captured
// component closure sees the same fake hooks.
ui.apply({ ...ctx, locale: { register() {} }, slots: ctx.slots })

/** Flatten rendered text. */
function textOf(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string') return tree
  if (typeof tree.type === 'function') return textOf(tree.type(tree.props))
  if (tree.type === 'Fragment') return tree.children.map(textOf).join('')
  return tree.children.map(textOf).join('')
}

/** The trigger button inside the rendered root. */
function triggerOf(tree) {
  const button = tree.children.find((child) => child && child.type === 'button')
  if (!button) throw new Error('rendered root has no trigger button')
  return button
}

const t = (key, params) => {
  const dict = {
    tps: '{value} tok/s',
    'tps.gross': '≈{value} tok/s',
    'tps.grossHint': '没记录到首字时刻，此处为整步平均速度（下界）',
    'dialog.title': '本轮速度',
    'dialog.first': '首字（TTFT）',
    'dialog.avg': '首字均值',
    'dialog.speed': '输出速度（TPS）',
    'dialog.steps': '步骤',
    'dialog.exact': '精确窗口',
    'dialog.gross': '整步窗口（下界）',
    'dialog.hint.exact': '输出 tokens ÷ 首字到结束的时长',
    'dialog.hint.gross': '缺少首字时刻，用整步时长；数值偏低'
  }
  return dict[key].replace(/\{(\w+)\}/g, (_match, name) => String(params[name]))
}
/** The registered component comes from the ctx captured above. */
const snapshotFor = (nodes, turn, messageId) => {
  const view = new Map()
  if (turn !== null) {
    view.set('turn-tail', { kind: 'turn-tail', data: { turn, closing: { finalNode: { messageId } } } })
    nodes.filter((node) => node.kind === 'assistant').forEach((finalNode, index) => {
      view.set('assistant-' + index, { kind: 'assistant-step', data: { turn, finalNode } })
    })
  }
  return { legacy: { nodes }, nodes: view }
}
const renderWith = (nodes, messageId, turn = 1) => {
  const snapshot = snapshotFor(nodes, turn, messageId)
  return captured.components['simple-tps']({ messageId, t, useChat: (selector) => selector(snapshot) })
}

// The diagnostic build only substitutes a probe when the lookup fails; a
// successful read always renders the real figures.
viewportWidth = 1440
ui.setDebug(true)
assert.equal(textOf(triggerOf(renderWith(threeSteps, 'm-3', 1))), '50.0 tok/s')
assert.match(
  textOf(renderWith(threeSteps, 'unknown', null)),
  /^DBG no-reading/,
  'a failed lookup renders a probe'
)
ui.setDebug(false)

viewportWidth = 1440
assert.equal(textOf(triggerOf(renderWith(threeSteps, 'm-3'))), '50.0 tok/s', 'default view is the speed only')

// A single step repeats the same figure twice, so only the first reading shows.
const oneStep = [step(10, 6, 'm-s', 1000, 2200, 10200, 400)]
assert.equal(textOf(triggerOf(renderWith(oneStep, 'm-s', 6))), '50.0 tok/s')

// Narrow windows keep the pill but drop its label, like the usage control does.
viewportWidth = 800
assert.equal(textOf(triggerOf(renderWith(threeSteps, 'm-3'))), '50.0 tok/s')
viewportWidth = 560
assert.equal(textOf(triggerOf(renderWith(threeSteps, 'm-3'))), '', 'label hidden, icon only')
viewportWidth = 400
assert.equal(renderWith(threeSteps, 'm-3'), null, 'tiny windows render nothing')

// Unreadable turns render nothing at all.
viewportWidth = 1440
ui.setDebug(false)
assert.equal(renderWith(noTiming, 'm-x', 2), null, 'release build renders nothing without data')
assert.equal(renderWith(threeSteps, 'unknown', null), null, 'turn not resolved renders nothing')

// The pill carries the text as its hover title and a stable data attribute.
const pill = triggerOf(renderWith(threeSteps, 'm-3', 1))
assert.equal(pill.props['data-simple-tps'], 'exact')
assert.equal(textOf(pill), '50.0 tok/s')

// The view nodes are the primary source: a window whose legacy entries are
// empty still yields a reading, because the durable final nodes live there.
const viewOnly = {
  legacy: { nodes: [] },
  nodes: new Map([
    ['turn-tail', { kind: 'turn-tail', data: { turn: 1, closing: { finalNode: { messageId: 'm-3' } } } }],
    ...threeSteps.filter((node) => node.kind === 'assistant').map((finalNode, index) => ['assistant-' + index, { kind: 'assistant-step', data: { turn: 1, finalNode } }])
  ])
}
assert.equal(textOf(triggerOf(captured.components['simple-tps']({ messageId: 'm-3', t, useChat: (selector) => selector(viewOnly) }))), '50.0 tok/s')

// --- historical turns --------------------------------------------------------
// The durable log stores no live chunks, so a replayed turn has no first-token
// time. The readout then falls back to the whole-step speed, marked approximate.
const historical = [
  {
    kind: 'assistant',
    seq: 1,
    turn: 11,
    messageId: 'm-h',
    timing: { stepStartTime: 1000, firstTokenTime: null, completedTime: 6000 },
    usage: { outputTokens: 200 }
  }
]
// No first-token time means no TTFT: only the approximate speed renders.
const historicalTree = captured.components['simple-tps']({ messageId: 'm-h', t, useChat: (selector) => selector(snapshotFor(historical, 11, 'm-h')) })
assert.equal(textOf(triggerOf(historicalTree)), '≈40.0 tok/s')
assert.equal(triggerOf(historicalTree).props['data-simple-tps'], 'gross')
assert.match(triggerOf(historicalTree).props.title, /下界/)

// Ordering rides the stylesheet: the descendant selector reaches the pill even
// though a display:contents slot wrapper sits between it and the action row.
const cssText = globalThis.document.__styles.get('dsh-simple-tps/readout.css')
assert.ok(cssText.includes('.dsh-simple-tps-trigger{'), 'trigger styled')
assert.ok(cssText.includes('.dsh-simple-tps-panel{'), 'dialog styled')
assert.ok(cssText.includes('[data-clock=end] .dsh-simple-tps-root{margin-right:-8px;order:5}'), 'readout ordered after the branch button and cancels the usage group margin')
assert.ok(cssText.includes('.dsh-simple-tps-live{'), 'live chip styled')
// The chip is floated out of flow, so it cannot reflow the running row at all.
assert.ok(cssText.includes('position:fixed'), 'chip is out of flow')
assert.ok(cssText.includes('pointer-events:none'), 'chip never swallows clicks')
assert.ok(cssText.includes('[data-clock=end]>:last-child{order:10}'), 'usage pill and clock ordered after the readout')
// The dialog mirrors the shipped stat-dialog recipe rather than inventing one.
assert.ok(cssText.includes('var(--dsw-specific-menu)'), 'dialog uses the menu surface token')
assert.ok(cssText.includes('z-index:1100'), 'dialog sits on the stat-dialog layer')

// --- host projection ---------------------------------------------------------
// When the host projects the turn, its figures win: they cover the whole log.
const projection = {
  turns: {
    1: { ttftFirst: 1111, ttftAvg: 1222, tps: 77.7, steps: 3, exact: true }
  }
}
const projectedTree = captured.components['simple-tps']({
  messageId: 'm-3',
  t,
  useChat: (selector) => selector(snapshotFor(threeSteps, 1, 'm-3')),
  useProjection: (key, selector) => (key === 'turnTimings' ? selector(projection) : undefined)
})
assert.equal(textOf(triggerOf(projectedTree)), '77.7 tok/s', 'projection figures override the window fold')

// An absent projection falls back to folding the loaded window.
const fallbackTree = captured.components['simple-tps']({
  messageId: 'm-3',
  t,
  useChat: (selector) => selector(snapshotFor(threeSteps, 1, 'm-3')),
  useProjection: (key, selector) => selector(undefined)
})
assert.equal(textOf(triggerOf(fallbackTree)), '50.0 tok/s', 'window fold remains the fallback')

// --- dialog ----------------------------------------------------------------
// Closed by default: the trigger only carries the speed.
const closed = renderWith(threeSteps, 'm-3', 1)
assert.equal(closed.children.length, 1, 'closed state renders the trigger alone')

// Opening renders the details panel with the same figures plus the breakdown.
openSeat = true
const openTree = captured.components['simple-tps']({
  messageId: 'm-3',
  t,
  useChat: (selector) => selector(snapshotFor(threeSteps, 1, 'm-3'))
})
// The panel is a component element; render it to inspect the portaled markup.
const panelElement = openTree.children.find((child) => child && typeof child.type === 'function')
assert.ok(panelElement !== undefined, 'open state renders a dialog component')
const panel = panelElement.type(panelElement.props)
assert.equal(panel.props['data-simple-tps-dialog'], '')
const panelText = textOf(panel)
assert.match(panelText, /本轮速度/)
assert.match(panelText, /3\.2s/, 'dialog shows the first-token latency')
assert.match(panelText, /2\.4s/, 'dialog shows the mean')
assert.match(panelText, /50\.0 tok\/s/, 'dialog shows the speed')
assert.match(panelText, /精确窗口/)
openSeat = false

// --- live sampler ------------------------------------------------------------
// Streaming speed is sampled from the partial assistant's character count over a
// short sliding window, so a slow stretch in a long turn still reads slow.
const liveChars = exports.liveChars
assert.equal(liveChars(null), null)
assert.equal(liveChars({ turn: 1, step: 0, blocks: [] }), null, 'no text yet')
assert.deepEqual(
  liveChars({ turn: 3, step: 1, blocks: [{ kind: 'reasoning', text: 'abc' }, { kind: 'text', text: 'defgh' }] }),
  { chars: 8, turn: 3, step: 1 },
  'reasoning and text both count'
)
assert.equal(
  liveChars({ turn: 1, step: 0, blocks: [{ kind: 'tool-call', callId: 'c', name: 'n', argsRaw: '{}' }] }),
  null,
  'tool calls are not output'
)

const createLiveSampler = exports.createLiveSampler
const sampler = createLiveSampler()
sampler.observe({ chars: 100, turn: 1, step: 0 }, 1000)
assert.equal(sampler.read(), null, 'one sample cannot imply a rate')
sampler.observe({ chars: 200, turn: 1, step: 0 }, 1500)
assert.equal(sampler.read(), '200 字/s', '100 chars in 0.5s, whole numbers above 100')
// A stalled sample must hold the reading, not clear or decay it.
sampler.observe({ chars: 200, turn: 1, step: 0 }, 1700)
assert.equal(sampler.read(), '200 字/s', 'a stalled sample holds the last reading')
sampler.observe({ chars: 300, turn: 1, step: 0 }, 2000)
assert.equal(sampler.read(), '200 字/s', 'steady rate holds')
// A new step resets the window but keeps the last figure on screen: blanking it
// between steps is what made the chip blink at every tool boundary.
sampler.observe({ chars: 10, turn: 2, step: 0 }, 2500)
assert.equal(sampler.read(), '200 字/s', 'step change holds the last reading')
sampler.observe({ chars: 60, turn: 2, step: 0 }, 3000)
assert.equal(sampler.read(), '100 字/s', 'the new step measures from its own baseline')
// A missing measurement must NOT clear it: that caused the blink.
sampler.observe(null, 3000)
assert.equal(sampler.read(), '100 字/s', 'a gap holds whatever was last shown instead of blanking')
// Only an explicit forget clears it, which the turn-end path calls.
sampler.forget()
assert.equal(sampler.read(), null, 'forget clears the readout')

console.log('ok: render output across breakpoints')
