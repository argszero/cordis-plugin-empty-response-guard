/**
 * End-to-end wiring: a real cordis `Context` and a real `llm/stream` waterfall.
 *
 * `fabricated-stop.test.js` drives `guardStream` directly; this file proves the
 * seam it mounts on — that `apply()` registers on the same event the runtime
 * dispatches, that the listener receives the `(options, next)` signature cordis
 * passes, that the guard sits in the chain around the provider call, that the
 * terminal chunk it yields is what the consumer of `ctx.waterfall` observes,
 * and that the diagnostics a host reads to self-verify are actually emitted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, name, TRANSPORT_CODE } from '../lib/index.js'

const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

/** The #6948 shape: content present, terminal `stop`, usage accounts for nothing. */
function fabricated(usage = ZERO) {
  return [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'The spawn in runner-launch has ' },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function sourceOf(chunks) {
  return (async function* () { for (const chunk of chunks) yield chunk })()
}

async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** A ctx whose logger records every line, so the diagnostics are testable. */
function recordingCtx() {
  const listeners = []
  const logs = []
  const record = (level) => (format, ...args) => logs.push({ level, format, args })
  return {
    logs,
    ctx: {
      on: (event, handler) => { listeners.push({ event, handler }) },
      logger: { info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') },
    },
    listeners,
  }
}

test('a real cordis waterfall dispatches llm/stream through the guard', async () => {
  const ctx = new Context()
  assert.equal(name, 'empty-response-guard')
  apply(ctx, {
    mode: 'error',
    minReasoningChars: 0,
    reportReasoning: true,
    detectFabricatedStop: true,
    fabricatedStopNeedsCalibration: true,
    fabricatedStopMaxPerSession: 3,
  })

  // Calibrate the route through the real seam: a healthy call with real usage.
  const healthy = ctx.waterfall(null, 'llm/stream',
    { provider: 'relay', model: 'm', messages: [] },
    () => sourceOf(fabricated({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })))
  assert.equal((await drain(healthy)).at(-1).reason.kind, 'stop')

  const options = { provider: 'relay', model: 'm', messages: [], sessionId: 's_1' }
  const before = structuredClone(options)
  const guarded = ctx.waterfall(null, 'llm/stream', options, () => sourceOf(fabricated()))
  const out = await drain(guarded)
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'error')
  assert.equal(out.at(-1).reason.failure.code, TRANSPORT_CODE)
  assert.deepEqual(options, before, 'the plugin never mutates the request it observes')
})

test('the correction and the arming of the route are both logged, once each', async () => {
  const { ctx, logs, listeners } = recordingCtx()
  apply(ctx, {
    mode: 'error',
    minReasoningChars: 0,
    reportReasoning: true,
    detectFabricatedStop: true,
    fabricatedStopNeedsCalibration: true,
    fabricatedStopMaxPerSession: 3,
  })
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'llm/stream')

  const call = (chunks, sessionId = 's_1') => drain(listeners[0].handler(
    { provider: 'relay', model: 'm', messages: [], sessionId },
    () => sourceOf(chunks),
  ))

  await call(fabricated({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }))
  const arming = logs.filter((line) => line.level === 'info')
  assert.equal(arming.length, 1)
  assert.match(arming[0].args[0], /relay::m/)
  assert.match(arming[0].format, /reports usage/)
  assert.match(arming[0].format, /#6948/)

  // Arming is announced once, not once per call.
  await call(fabricated({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }))
  assert.equal(logs.filter((line) => line.level === 'info').length, 1)

  await call(fabricated())
  const warn = logs.filter((line) => line.level === 'warn')
  assert.equal(warn.length, 1)
  assert.match(warn[0].format, /accounts for no tokens at all/)
  assert.match(warn[0].format, /#6948/)
  assert.match(warn[0].args[1], new RegExp(TRANSPORT_CODE))
  assert.match(warn[0].args[0], /31 characters of text/)

  // A suppressed correction is as visible as a made one.
  await call(fabricated())
  await call(fabricated())
  await call(fabricated())
  const capped = logs.filter((line) => line.level === 'warn').at(-1)
  assert.match(capped.args[1], /per-session bound is reached/)
  assert.match(capped.args[1], /fabricatedStopMaxPerSession=3/)
})

test('the uncalibrated wording names the instrument, not just the verdict', async () => {
  const logs = []
  const captured = []
  apply({
    on: (event, handler) => captured.push({ event, handler }),
    logger: {
      info: () => {},
      warn: (format, ...args) => logs.push({ format, args }),
      debug: () => {},
      error: () => {},
    },
  }, {
    mode: 'error',
    minReasoningChars: 0,
    reportReasoning: true,
    detectFabricatedStop: true,
    fabricatedStopNeedsCalibration: true,
    fabricatedStopMaxPerSession: 3,
  })

  const out = await drain(captured[0].handler(
    { provider: 'never-reports', model: 'm', messages: [] },
    () => sourceOf(fabricated()),
  ))
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.match(logs[0].args[1], /has not reported usage in this process/)
})

test('a caller with no sessionId is handled, and keeps its own budget', async () => {
  const ctx = new Context()
  apply(ctx, {
    mode: 'error',
    minReasoningChars: 0,
    reportReasoning: true,
    detectFabricatedStop: true,
    fabricatedStopNeedsCalibration: false,
    fabricatedStopMaxPerSession: 1,
  })
  const call = () => drain(ctx.waterfall(null, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => sourceOf(fabricated())))
  assert.equal((await call()).at(-1).reason.kind, 'error')
  assert.equal((await call()).at(-1).reason.kind, 'stop', 'the bound applies to unstamped callers too')
})

test('mode: off leaves the waterfall untouched', async () => {
  const ctx = new Context()
  apply(ctx, {
    mode: 'off',
    minReasoningChars: 0,
    reportReasoning: true,
    detectFabricatedStop: true,
    fabricatedStopNeedsCalibration: false,
    fabricatedStopMaxPerSession: 3,
  })
  const chunks = fabricated()
  const out = await drain(ctx.waterfall(null, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => sourceOf(chunks)))
  assert.deepEqual(out, chunks)
})
