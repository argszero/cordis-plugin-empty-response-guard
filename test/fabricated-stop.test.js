/**
 * Shape 2 (discussion #6948): a `stop` whose usage accounts for no tokens.
 *
 * The fixture is the reported one — 1033 characters of reasoning, 1033 of text
 * (the text block duplicated the reasoning), and `usage {0, 0, 0}` on the only
 * step of a 57-step turn that reported zero — sent by a relay that had been
 * answering 502 earlier in the same turn.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardStream,
  newGuardState,
  usageWasReported,
  routeKeyOf,
  fabricatedStopFailure,
  fabricatedStopFinish,
  TRANSPORT_CODE,
  DEFAULT_FABRICATED_STOP_MAX_PER_SESSION,
  Config,
} from '../lib/index.js'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'

/** Resolved-config shape the wiring always produces. */
function cfg(over = {}) {
  return {
    mode: 'error',
    minReasoningChars: 0,
    reportReasoning: true,
    detectFabricatedStop: true,
    fabricatedStopNeedsCalibration: true,
    fabricatedStopMaxPerSession: DEFAULT_FABRICATED_STOP_MAX_PER_SESSION,
    ...over,
  }
}

/** Collect an async iterable. */
async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** Build an async iterable from a plain array. */
async function* from(chunks) {
  for (const chunk of chunks) yield chunk
}

const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const REAL = { inputTokens: 3365, outputTokens: 1574, totalTokens: 150859 }

/** A completion that produced text and reasoning and reports real usage. */
function healthyStream(usage = REAL) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'x'.repeat(1033) },
    { type: 'block-end', index: 0, block: { index: 0, type: 'reasoning', text: 'x'.repeat(1033) } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'The spawn in runner-launch has ' },
    { type: 'block-end', index: 1, block: { index: 1, type: 'text', text: 'The spawn in runner-launch has ' } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The #6948 shape: content present, terminal `stop`, usage 0/0/0. */
function fabricatedStream(usage = ZERO) {
  return healthyStream(usage)
}

/** Drive one stream through the guard with an explicit state/route/session. */
async function run(chunks, { state = newGuardState(), route = 'relay::deepseek-v4.1-flash', sessionId, config = cfg(), reports = [] } = {}) {
  const out = await drain(guardStream(from(chunks), config, {
    state,
    route,
    ...(sessionId === undefined ? {} : { sessionId }),
    onCorrection: (report) => reports.push(report),
  }))
  return { out, state, reports }
}

test('#6948: a stop whose usage is 0/0/0 is reclassified as a retryable TRANSPORT error', async () => {
  // Calibrate the route the way a real session does: a healthy call first.
  const state = newGuardState()
  await run(healthyStream(), { state })
  const chunks = fabricatedStream()
  const { out, reports } = await run(chunks, { state })

  const finish = out.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, TRANSPORT_CODE)
  assert.match(finish.reason.failure.message, /usage accounts for no tokens/)
  assert.deepEqual(out.slice(0, -1), chunks.slice(0, -1))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].kind, 'fabricated-stop')
  assert.equal(reports[0].corrected, true)
  assert.equal(reports[0].visibleChars, 'The spawn in runner-launch has '.length)
  assert.equal(reports[0].reasoningChars, 1033)
})

test('the same stream is left alone on a route that has never reported usage', async () => {
  // The control: a gateway that never reports usage returns 0/0/0 for every
  // call, so without calibration the rule would fire on healthy completions.
  const state = newGuardState()
  const first = await run(fabricatedStream(), { state })
  assert.deepEqual(first.out, fabricatedStream())
  assert.deepEqual(first.reports[0], {
    ...first.reports[0],
    corrected: false,
    suppressedBy: 'uncalibrated',
    kind: 'fabricated-stop',
    code: TRANSPORT_CODE,
  })
  // …and it stays that way however many times the route answers with zero.
  const second = await run(fabricatedStream(), { state })
  assert.equal(second.out.at(-1).reason.kind, 'stop')
  assert.equal(second.reports[0].suppressedBy, 'uncalibrated')
  assert.equal(state.calibratedRoutes.size, 0)
})

test('a route is calibrated by its own first usage-reporting call', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  assert.deepEqual([...state.calibratedRoutes], ['relay::deepseek-v4.1-flash'])
  const { out } = await run(fabricatedStream(), { state })
  assert.equal(out.at(-1).reason.kind, 'error')
})

test('calibration is per route, not per plugin', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state, route: 'a::m' })
  const other = await run(fabricatedStream(), { state, route: 'b::m' })
  assert.equal(other.out.at(-1).reason.kind, 'stop')
  assert.equal(other.reports[0].suppressedBy, 'uncalibrated')
})

test('a genuine completion with real usage passes through byte for byte', async () => {
  const state = newGuardState()
  const chunks = healthyStream()
  const { out, reports } = await run(chunks, { state })
  assert.deepEqual(out, chunks)
  assert.equal(reports.length, 0)
})

test('a stream with no usage chunk at all is never corrected', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  const chunks = healthyStream().filter((chunk) => chunk.type !== 'usage')
  const { out, reports } = await run(chunks, { state })
  assert.deepEqual(out, chunks)
  assert.equal(reports.length, 0)
})

test('the per-session bound stops the corrections and says so', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  const sessions = []
  for (let i = 0; i < 4; i++) {
    sessions.push(await run(fabricatedStream(), { state, sessionId: 's_1' }))
  }
  assert.deepEqual(sessions.map((s) => s.out.at(-1).reason.kind), ['error', 'error', 'error', 'stop'])
  assert.equal(sessions[3].reports[0].suppressedBy, 'cap')
  assert.equal(sessions[3].reports[0].corrected, false)
  assert.equal(state.corrections.get('s_1'), 3)

  // A different session has its own budget.
  const other = await run(fabricatedStream(), { state, sessionId: 's_2' })
  assert.equal(other.out.at(-1).reason.kind, 'error')
})

test('the bound counts only shape-2 corrections', async () => {
  // Shape 1 cannot feed itself, so it must not consume the budget: three
  // reasoning-only completions followed by a fabricated stop still corrects.
  const state = newGuardState()
  await run(healthyStream(), { state })
  const reasoningOnly = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { index: 0, type: 'reasoning', text: 'thinking' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  for (let i = 0; i < 3; i++) await run(reasoningOnly, { state, sessionId: 's_1' })
  assert.equal(state.corrections.get('s_1') ?? 0, 0)
  const { out } = await run(fabricatedStream(), { state, sessionId: 's_1' })
  assert.equal(out.at(-1).reason.kind, 'error')
})

test('fabricatedStopMaxPerSession: 0 removes the bound', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  const config = cfg({ fabricatedStopMaxPerSession: 0 })
  for (let i = 0; i < 5; i++) {
    const { out } = await run(fabricatedStream(), { state, sessionId: 's_1', config })
    assert.equal(out.at(-1).reason.kind, 'error')
  }
})

test('an unstamped caller is bounded, and bounded separately from sessions', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  for (let i = 0; i < 3; i++) await run(fabricatedStream(), { state })
  const fourth = await run(fabricatedStream(), { state })
  assert.equal(fourth.reports[0].suppressedBy, 'cap')
  assert.equal(state.corrections.get('*'), 3)
  const stamped = await run(fabricatedStream(), { state, sessionId: 's_1' })
  assert.equal(stamped.out.at(-1).reason.kind, 'error')
})

test('detectFabricatedStop: false restores the 0.1.0 behaviour', async () => {
  const state = newGuardState()
  const config = cfg({ detectFabricatedStop: false })
  await run(healthyStream(), { state, config })
  const chunks = fabricatedStream()
  const { out, reports } = await run(chunks, { state, config })
  assert.deepEqual(out, chunks)
  assert.equal(reports.length, 0)
})

test('fabricatedStopNeedsCalibration: false trusts the route immediately', async () => {
  const config = cfg({ fabricatedStopNeedsCalibration: false })
  const { out } = await run(fabricatedStream(), { config })
  assert.equal(out.at(-1).reason.kind, 'error')
  assert.equal(out.at(-1).reason.failure.code, TRANSPORT_CODE)
})

test('warn mode reports the shape without touching the finish', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  const chunks = fabricatedStream()
  const { out, reports } = await run(chunks, { state, config: cfg({ mode: 'warn' }) })
  assert.deepEqual(out, chunks)
  assert.equal(reports[0].corrected, false)
  assert.equal(reports[0].suppressedBy, 'warn-mode')
})

test('mode: off is a pure pass-through and does not even calibrate', async () => {
  const state = newGuardState()
  const { out } = await run(healthyStream(), { state, config: cfg({ mode: 'off' }) })
  assert.deepEqual(out, healthyStream())
  assert.equal(state.calibratedRoutes.size, 0)
})

test('a stop with nothing visible is shape 1 even when the usage is also zero', async () => {
  // Both rules could claim this stream; EMPTY_RESPONSE names it more precisely,
  // and both codes are retryable, so the retry policy cannot tell the difference.
  const state = newGuardState()
  await run(healthyStream(), { state })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'usage', usage: ZERO },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { out, reports } = await run(chunks, { state })
  assert.equal(out.at(-1).reason.failure.code, EMPTY_RESPONSE_CODE)
  assert.equal(reports[0].kind, 'empty-response')
})

test('a tool-calls finish and an aborted finish are never shape 2', async () => {
  const state = newGuardState()
  await run(healthyStream(), { state })
  for (const reason of [{ kind: 'tool-calls' }, { kind: 'aborted' }, { kind: 'max-tokens' }]) {
    const chunks = healthyStream().slice(0, -1).concat([{ type: 'finish', reason }])
    const { out, reports } = await run(chunks, { state })
    assert.deepEqual(out, chunks)
    assert.equal(reports.length, 0)
  }
})

test('the calibration hook fires once per route', async () => {
  const state = newGuardState()
  const seen = []
  for (let i = 0; i < 3; i++) {
    await drain(guardStream(from(healthyStream()), cfg(), {
      state,
      route: 'relay::m',
      onCalibrated: (route) => seen.push(route),
    }))
  }
  assert.deepEqual(seen, ['relay::m'])
})

test('usageWasReported counts every counter the harness models', async () => {
  assert.equal(usageWasReported(ZERO), false)
  assert.equal(usageWasReported({ inputTokens: 1, outputTokens: 0 }), true)
  assert.equal(usageWasReported({ inputTokens: 0, outputTokens: 1 }), true)
  assert.equal(usageWasReported({ inputTokens: 0, outputTokens: 0, totalTokens: 7 }), true)
  assert.equal(usageWasReported({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 5 }), true)
  assert.equal(usageWasReported({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 5 }), true)
  assert.equal(usageWasReported({ inputTokens: 0, outputTokens: 0, reasoningTokens: 5 }), true)
  // An absent optional counter is zero, not "reported".
  assert.equal(usageWasReported({ inputTokens: 0, outputTokens: 0 }), false)
})

test('the synthesized failure names the evidence, and routeKeyOf is provider::model', async () => {
  assert.equal(fabricatedStopFailure('route "r", 1 characters of text').code, TRANSPORT_CODE)
  assert.deepEqual(fabricatedStopFinish('r 5 characters of text').failure, fabricatedStopFailure('r 5 characters of text'))
  assert.match(fabricatedStopFailure('r 5 characters of text').message, /5 characters of text/)
  assert.equal(routeKeyOf({ provider: 'p', model: 'm' }), 'p::m')
})

test('the config schema ships the 0.2.0 defaults', async () => {
  const resolved = new Config({})
  assert.equal(resolved.detectFabricatedStop, true)
  assert.equal(resolved.fabricatedStopNeedsCalibration, true)
  assert.equal(resolved.fabricatedStopMaxPerSession, DEFAULT_FABRICATED_STOP_MAX_PER_SESSION)
  assert.equal(DEFAULT_FABRICATED_STOP_MAX_PER_SESSION, 3)
})
