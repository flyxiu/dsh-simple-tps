/**
 * Host half of dsh-simple-tps.
 *
 * Registers the `turnTimings` session projection: one entry per completed turn
 * carrying that turn's first-token latency and decode throughput. It folds the
 * committed log, so the figures are correct for history too.
 *
 * Why this lives on the host: `assistant/message` carries the durable stream with
 * per-delta timestamps, and only the complete event log has every `step/start`.
 * A browser-side fold sees just the loaded window and, after a reload, no
 * first-token time at all.
 */


/**
 * The first token's timestamp inside one compact stream.
 *
 * Mirrors the harness's own `assistantStreamFirstTokenTime`: raw chunks carry
 * their own `time`, while text, reasoning and tool-call runs are packed as a base
 * `time0` plus per-delta `dt` gaps, so the first qualifying member's time is
 * `time0` plus the gaps before it.
 * @param stream - compact records from one durable Assistant settlement.
 * @returns the first token's epoch ms, or undefined when the stream carries none.
 */
function assistantStreamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      if (isTokenChunk(record.chunk)) return record.time
      continue
    }
    const time = runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/** Whether one chunk carries a generated token (an empty delta is not one). */
function isTokenChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** First token time of one packed delta run. */
function runFirstTokenTime(run) {
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  if (!Array.isArray(fragments) || typeof run.time0 !== 'number') return undefined
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += Array.isArray(run.dt) && typeof run.dt[index - 1] === 'number' ? run.dt[index - 1] : 0
    if (fragments[index] !== '') return time
  }
  return undefined
}

/**
 * Minimal schema seat for the projection contract.
 *
 * The registry only calls `parse` on persisted cells and on the outgoing view, so
 * the unit supplies its own structural check instead of depending on a schema
 * library: this package lives outside the DSH install, and Node resolves bare
 * specifiers from the importing file, not from the host that loaded it.
 * @param validate - predicate that returns the accepted value.
 * @returns an object exposing the `parse` face the registry requires.
 */
function schema(validate) {
  return {
    parse(value) {
      return validate(value)
    }
  }
}

/** Whether a value is a usable non-negative finite number. */
function isMeasure(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validate one wire reading, falling back to a readable default on bad input. */
function readReading(value) {
  const record = typeof value === 'object' && value !== null ? value : {}
  return {
    ttftFirst: isMeasure(record.ttftFirst) ? record.ttftFirst : null,
    ttftAvg: isMeasure(record.ttftAvg) ? record.ttftAvg : null,
    tps: isMeasure(record.tps) ? record.tps : null,
    steps: isMeasure(record.steps) ? Math.floor(record.steps) : 0,
    exact: record.exact === true
  }
}

/** Validate the outgoing per-turn view. */
function readView(value) {
  const record = typeof value === 'object' && value !== null ? value : {}
  const source = typeof record.turns === 'object' && record.turns !== null ? record.turns : {}
  const turns = {}
  for (const key of Object.keys(source)) turns[key] = readReading(source[key])
  return { turns }
}

/** Validate a persisted accumulator cell before it seeds the fold. */
function readState(value) {
  const record = typeof value === 'object' && value !== null ? value : {}
  const source = typeof record.turns === 'object' && record.turns !== null ? record.turns : {}
  const turns = {}
  for (const key of Object.keys(source)) {
    const cell = typeof source[key] === 'object' && source[key] !== null ? source[key] : {}
    turns[key] = {
      ttft: Array.isArray(cell.ttft) ? cell.ttft.filter(isMeasure) : [],
      decodeMs: isMeasure(cell.decodeMs) ? cell.decodeMs : 0,
      tokens: isMeasure(cell.tokens) ? cell.tokens : 0,
      spanMs: isMeasure(cell.spanMs) ? cell.spanMs : 0,
      spanTokens: isMeasure(cell.spanTokens) ? cell.spanTokens : 0,
      steps: isMeasure(cell.steps) ? Math.floor(cell.steps) : 0
    }
  }
  const open = typeof record.openStep === 'object' && record.openStep !== null ? record.openStep : null
  return {
    turns,
    openStep:
      open === null
        ? null
        : {
            turn: isMeasure(open.turn) ? Math.floor(open.turn) : 0,
            startTime: isMeasure(open.startTime) ? open.startTime : 0,
            firstTokenTime: isMeasure(open.firstTokenTime) ? open.firstTokenTime : null
          }
  }
}

export const name = 'simple-tps'

/** The projection registry is required; without it the fiber stays pending. */
export const inject = ['sessionProjections']

const StateSchema = schema(readState)
const ViewSchema = schema(readView)

/** Provider-reported completion tokens, guarded the way Chat guards node usage. */
function outputTokensOf(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** The empty accumulator set for one turn. */
function emptyAccumulators() {
  return { ttft: [], decodeMs: 0, tokens: 0, spanMs: 0, spanTokens: 0, steps: 0 }
}

/**
 * Finalize one turn's accumulators into the wire reading.
 *
 * `tps` prefers the exact decode window (first token → message). When no step
 * recorded a first token — the durable stream can be missing after an aborted
 * attempt — the whole-step span still bounds the speed from below, and `exact`
 * says which of the two was used.
 * @param accumulators - per-turn accumulators.
 * @returns the display reading.
 */
function finalize(accumulators) {
  const ttft = accumulators.ttft
  let sum = 0
  for (let index = 0; index < ttft.length; index += 1) sum += ttft[index]
  let tps = null
  let exact = false
  if (accumulators.decodeMs > 0 && accumulators.tokens > 0) {
    tps = accumulators.tokens / (accumulators.decodeMs / 1000)
    exact = true
  } else if (accumulators.spanMs > 0 && accumulators.spanTokens > 0) {
    tps = accumulators.spanTokens / (accumulators.spanMs / 1000)
  }
  return {
    ttftFirst: ttft.length > 0 ? ttft[0] : null,
    ttftAvg: ttft.length > 0 ? sum / ttft.length : null,
    tps,
    steps: accumulators.steps,
    exact
  }
}

/**
 * Fold one committed session event into the per-turn accumulators.
 * @param state - state covering every prior event.
 * @param event - the next committed event.
 * @returns the next state; the same reference when the event is not ours.
 */
function foldEvent(state, event) {
  switch (event.type) {
    case 'step/start':
      return {
        ...state,
        openStep: { turn: event.data.turn, startTime: event.time, firstTokenTime: null }
      }
    case 'assistant/attempt': {
      // A failed or retried attempt can still carry the first delta boundary.
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn) return state
      const first = assistantStreamFirstTokenTime(event.data.stream)
      if (first === undefined || open.firstTokenTime !== null) return state
      return { ...state, openStep: { ...open, firstTokenTime: first } }
    }
    case 'assistant/message': {
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn) return state
      const firstToken = open.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream) ?? null
      const key = String(event.data.turn)
      const previous = state.turns[key] ?? emptyAccumulators()
      const next = {
        ttft: previous.ttft.slice(),
        decodeMs: previous.decodeMs,
        tokens: previous.tokens,
        spanMs: previous.spanMs + Math.max(0, event.time - open.startTime),
        spanTokens: previous.spanTokens,
        steps: previous.steps + 1
      }
      const tokens = outputTokensOf(event.data.usage)
      if (firstToken !== null) {
        next.ttft.push(Math.max(0, firstToken - open.startTime))
        if (tokens !== null) {
          next.decodeMs += Math.max(0, event.time - firstToken)
          next.tokens += tokens
        }
      }
      if (tokens !== null) next.spanTokens += tokens
      return { ...state, openStep: null, turns: { ...state.turns, [key]: next } }
    }
    default:
      return state
  }
}

/** Read-side view: the accumulators become the plain per-turn readings. */
function projectView(state) {
  const turns = {}
  for (const key of Object.keys(state.turns)) turns[key] = finalize(state.turns[key])
  return { turns }
}

const turnTimingsProjection = {
  key: 'turnTimings',
  stateVersion: 1,
  stateSchema: StateSchema,
  init: () => ({ turns: {}, openStep: null }),
  apply: foldEvent,
  wire: {
    viewSchema: ViewSchema,
    view: projectView
  }
}

/**
 * Register the per-turn timing unit.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(turnTimingsProjection)
}

export { turnTimingsProjection, finalize, projectView, foldEvent, assistantStreamFirstTokenTime }
