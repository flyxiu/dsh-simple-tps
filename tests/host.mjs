/**
 * Offline checks for the host half: the per-turn projection fold.
 *
 * These run against the real event vocabulary, so a wrong assumption about an
 * event's payload fails here instead of in the browser.
 *
 * Run: node tests/host.mjs
 */
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const { foldEvent, projectView, finalize, turnTimingsProjection, assistantStreamFirstTokenTime } = await import(
  path.join(here, '..', 'lib', 'index.js')
)

// --- stream decoding ---------------------------------------------------------
const t = (ms) => ms
assert.equal(
  assistantStreamFirstTokenTime([{ type: 'chunk', time: t(2), chunk: { type: 'text-delta', index: 0, text: '' } }]),
  undefined,
  'an empty delta is not the first token'
)
assert.equal(
  assistantStreamFirstTokenTime([{ type: 'chunk', time: t(5), chunk: { type: 'text-delta', index: 0, text: 'hi' } }]),
  5
)
assert.equal(
  assistantStreamFirstTokenTime([{ type: 'text-chunks', time0: 10, index: 0, dt: [7, 9], texts: ['a', 'b', 'c'] }]),
  10,
  'a packed run starts at time0'
)
assert.equal(
  assistantStreamFirstTokenTime([{ type: 'text-chunks', time0: 10, index: 0, dt: [7, 9], texts: ['', 'b', 'c'] }]),
  17,
  'the gap before the first real delta is added'
)
assert.equal(
  assistantStreamFirstTokenTime([{ type: 'reasoning-chunks', time0: 3, index: 0, dt: [1], texts: ['x', 'y'] }]),
  3
)
assert.equal(
  assistantStreamFirstTokenTime([{ type: 'tool-call-chunks', time0: 4, index: 0, dt: [2], id: 'c', name: 'go', args: ['{', '}'] }]),
  4,
  'a named tool-call run starts at its first member'
)
assert.equal(assistantStreamFirstTokenTime([{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0 } }]), undefined)
assert.equal(assistantStreamFirstTokenTime([]), undefined)
assert.equal(assistantStreamFirstTokenTime(null), undefined)

// --- fold --------------------------------------------------------------------
const empty = turnTimingsProjection.init()
const stepStart = (turn, step, time) => ({ type: 'step/start', seq: 1, time, data: { turn, step } })
const message = (turn, step, time, outputTokens, stream) => ({
  type: 'assistant/message',
  seq: 2,
  time,
  data: {
    turn,
    step,
    message: { role: 'assistant', content: [], id: 'm1' },
    usage: outputTokens === undefined ? undefined : { outputTokens },
    stream
  }
})

// One clean step: 1000 start, first token 3000, message 6000, 300 tokens.
let state = foldEvent(empty, stepStart(1, 0, 1000))
state = foldEvent(state, message(1, 0, 6000, 300, [{ type: 'text-chunks', time0: 3000, index: 0, dt: [5], texts: ['a', 'b'] }]))
let view = projectView(state)
assert.equal(view.turns['1'].ttftFirst, 2000, 'TTFT is first token minus step start')
assert.equal(view.turns['1'].steps, 1)
assert.ok(Math.abs(view.turns['1'].tps - 300 / 3) < 1e-9, 'TPS is tokens over the decode window')
assert.equal(view.turns['1'].exact, true)

// A second step in the same turn pushes a second TTFT; the mean covers both.
state = foldEvent(state, stepStart(1, 1, 10000))
state = foldEvent(state, message(1, 1, 20000, 100, [{ type: 'chunk', time: 12000, chunk: { type: 'text-delta', index: 0, text: 'x' } }]))
view = projectView(state)
assert.equal(view.turns['1'].steps, 2)
assert.equal(view.turns['1'].ttftFirst, 2000, 'the first step still owns the headline TTFT')
assert.equal(view.turns['1'].ttftAvg, 2000, 'both steps waited 2000ms, so the mean matches')
assert.ok(Math.abs(view.turns['1'].tps - 400 / (3 + 8)) < 1e-9, 'TPS stays token weighted across steps')

// A failed attempt can still hand over the first-token boundary.
let attemptState = foldEvent(empty, stepStart(2, 0, 5000))
attemptState = foldEvent(attemptState, {
  type: 'assistant/attempt',
  seq: 3,
  time: 5900,
  data: { turn: 2, step: 0, stream: [{ type: 'chunk', time: 6500, chunk: { type: 'text-delta', index: 0, text: 'q' } }] }
})
assert.equal(attemptState.openStep.firstTokenTime, 6500, 'attempt stream supplies the first token')
attemptState = foldEvent(attemptState, message(2, 0, 9000, 40, [{ type: 'chunk', time: 7000, chunk: { type: 'text-delta', index: 0, text: 'z' } }]))
assert.equal(projectView(attemptState).turns['2'].ttftFirst, 1500, 'the attempt boundary wins over the message stream')

// No stream and no first token: the speed degrades to a lower bound.
let bare = foldEvent(empty, stepStart(3, 0, 1000))
bare = foldEvent(bare, message(3, 0, 5000, 100, []))
const bareView = projectView(bare).turns['3']
assert.equal(bareView.ttftFirst, null, 'no TTFT without a stream')
assert.equal(bareView.exact, false, 'whole-step speed is flagged approximate')
assert.ok(Math.abs(bareView.tps - 25) < 1e-9, 'whole-step span bounds the speed')

// Events from other turns and unrelated types change nothing.
assert.equal(foldEvent(state, stepStart(99, 0, 1)).turns['1'], state.turns['1'])
assert.equal(foldEvent(state, { type: 'tool/call', seq: 9, time: 1, data: { turn: 1, step: 0, callId: 'c', name: 'n', arguments: '{}' } }), state)

// Zero tokens cannot yield a speed, and a message with no open step is ignored.
const zero = projectView(foldEvent(foldEvent(empty, stepStart(4, 0, 0)), message(4, 0, 1000, 0, [{ type: 'chunk', time: 500, chunk: { type: 'text-delta', index: 0, text: 'x' } }]))).turns['4']
assert.equal(zero.tps, null, 'zero tokens cannot yield a speed')
assert.equal(foldEvent(empty, message(5, 0, 1, 10, [])), empty, 'a message without an open step is ignored')

// --- real session log --------------------------------------------------------
// Optional: the suite passes without it, so CI and other machines skip this part.
// Set DSH_SESSION_LOG to point at any session log from a DSH data directory; when
// unset, the newest log for this workspace is used if one exists.
const dshSessions = path.join(process.env.HOME ?? '', '.dsh', 'sessions', '--home-flyx-Code-VibeCoding-dsh-simple-tps--')
async function findLog() {
  if (process.env.DSH_SESSION_LOG !== undefined) return process.env.DSH_SESSION_LOG
  let dirents
  try {
    dirents = await readdir(dshSessions, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const file = path.join(dshSessions, dirent.name, 'session.v4.jsonl.zstd')
    try {
      const info = await stat(file)
      candidates.push({ file, at: info.mtimeMs })
    } catch {}
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => right.at - left.at)
  return candidates[0].file
}
const log = await findLog()
let raw = null
if (log === null) {
  console.log('ok: unit fold (no session log available, real-log check skipped)')
} else {
  try {
    raw = await readFile(log)
  } catch {
    raw = null
    console.log('ok: unit fold (session log unreadable, real-log check skipped)')
  }
}
if (raw !== null) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let at = raw.indexOf(magic); at >= 0; at = raw.indexOf(magic, at + 1)) offsets.push(at)
  const events = []
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : raw.length
    try {
      for (const line of zstdDecompressSync(raw.subarray(offsets[index], end)).toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line))
        } catch {}
      }
    } catch {}
  }
  let real = turnTimingsProjection.init()
  for (const event of events) real = foldEvent(real, event)
  const realView = projectView(real)
  const turns = Object.keys(realView.turns)
  assert.ok(turns.length > 0, 'the real log yields turns')
  const withTtft = turns.filter((key) => realView.turns[key].ttftFirst !== null)
  const exact = turns.filter((key) => realView.turns[key].exact)
  console.log(
    '   real log: ' + String(events.length) + ' events, ' + String(turns.length) + ' turns, ' +
      String(withTtft.length) + ' with TTFT, ' + String(exact.length) + ' exact speed'
  )
  assert.ok(withTtft.length / turns.length > 0.9, 'the durable stream recovers TTFT for almost every turn')
  for (const key of turns) {
    const reading = realView.turns[key]
    if (reading.ttftFirst !== null) assert.ok(reading.ttftFirst >= 0 && Number.isFinite(reading.ttftFirst))
    if (reading.tps !== null) assert.ok(reading.tps > 0 && Number.isFinite(reading.tps), 'turn ' + key + ' speed is sane')
  }
}

console.log('ok: projection fold, stream decoding, and real-log agreement')
