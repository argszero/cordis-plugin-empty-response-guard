import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardEmptyResponseStream,
  emptyResponseFailure,
  emptyResponseFinish,
  isVisibleChunk,
  degenerateReasoningChars,
  DEFAULT_MODE,
  Config,
} from '../lib/index.js'
import { EMPTY_RESPONSE_CODE, chunkHasVisibleText } from '@deepseek-ai/dsh-llm'

/** Resolved-config shape the wiring always produces. */
function cfg(over = {}) {
  return { mode: 'error', minReasoningChars: 0, reportReasoning: true, ...over }
}
const WARN = cfg({ mode: 'warn' })
const OFF = cfg({ mode: 'off' })

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

/**
 * The exact #6218 shape: reasoning deltas, a reasoning block-end, then a plain
 * `stop` — no text-delta and no tool-call-delta anywhere.
 */
function reasoningOnlyStream(text = 'Let me think about this carefully.') {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { index: 0, type: 'reasoning', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A normal completion: reasoning followed by visible text. */
function textStream() {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { index: 0, type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Here is the answer.' },
    { type: 'block-end', index: 1, block: { index: 1, type: 'text', text: 'Here is the answer.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('a reasoning-only completion is reclassified as EMPTY_RESPONSE', async () => {
  const chunks = reasoningOnlyStream()
  const out = await drain(guardEmptyResponseStream(from(chunks), cfg()))
  const finish = out.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, EMPTY_RESPONSE_CODE)
  // The reasoning is preserved verbatim — only the classification changes.
  assert.deepEqual(out.slice(0, -1), chunks.slice(0, -1))
})

test('the synthesized failure matches the adapters\u2019 EMPTY_RESPONSE verdict', async () => {
  const out = await drain(guardEmptyResponseStream(from(reasoningOnlyStream('abcdef')), cfg()))
  const failure = out.at(-1).reason.failure
  assert.equal(failure.code, EMPTY_RESPONSE_CODE)
  // The adapter wording plus the detail that distinguishes this shape.
  assert.match(failure.message, /no text or tool call/)
  assert.match(failure.message, /6 characters of reasoning only/)
})

test('a completion with visible text is untouched, byte for byte', async () => {
  const chunks = textStream()
  const out = await drain(guardEmptyResponseStream(from(chunks), cfg()))
  assert.deepEqual(out, chunks)
})

test('reasoning followed by a tool call is genuine progress, not empty', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'I should read the file.' },
    { type: 'block-end', index: 0, block: { index: 0, type: 'reasoning', text: 'I should read the file.' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await drain(guardEmptyResponseStream(from(chunks), cfg()))
  assert.deepEqual(out, chunks)
  // Even at `stop`, the tool call would keep it non-degenerate; assert the
  // predicate agrees with the harness’ own.
  assert.equal(degenerateReasoningChars(chunks), undefined)
})

test('non-stop finishes are never reclassified', async () => {
  for (const reason of [{ kind: 'max-tokens' }, { kind: 'tool-calls' }, { kind: 'aborted', failure: { code: 'X', message: 'm' } }]) {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'finish', reason },
    ]
    const out = await drain(guardEmptyResponseStream(from(chunks), cfg()))
    assert.deepEqual(out, chunks, `reason ${reason.kind} must pass through`)
  }
})

test('mode "warn" detects but does not touch the finish', async () => {
  const chunks = reasoningOnlyStream()
  let seen
  const out = await drain(guardEmptyResponseStream(from(chunks), WARN, n => { seen = n }))
  assert.deepEqual(out, chunks)
  assert.equal(seen, chunks[1].text.length)
})

test('mode "off" is a pure pass-through and never reports', async () => {
  const chunks = reasoningOnlyStream()
  let called = false
  const out = await drain(guardEmptyResponseStream(from(chunks), OFF, () => { called = true }))
  assert.deepEqual(out, chunks)
  assert.equal(called, false)
})

test('minReasoningChars scopes which degenerate completions are corrected', async () => {
  const short = reasoningOnlyStream('hi')
  // Below the bar: left alone.
  const kept = await drain(guardEmptyResponseStream(from(short), cfg({ minReasoningChars: 100 })))
  assert.deepEqual(kept, short)
  // At/above the bar: corrected.
  const fixed = await drain(guardEmptyResponseStream(from(short), cfg({ minReasoningChars: 2 })))
  assert.equal(fixed.at(-1).reason.kind, 'error')
})

test('an empty stream, and a stop with no blocks at all, are still corrected', async () => {
  const empty = [{ type: 'finish', reason: { kind: 'stop' } }]
  const out = await drain(guardEmptyResponseStream(from(empty), cfg()))
  assert.equal(out.at(-1).reason.kind, 'error')
  assert.equal(out.at(-1).reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('whitespace-only text is not visible (agrees with chunkHasVisibleText)', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '   \n\t  ' },
    { type: 'block-end', index: 0, block: { index: 0, type: 'text', text: '   \n\t  ' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  // The plugin’s verdict.
  assert.notEqual(degenerateReasoningChars(chunks), undefined)
  // The harness’ own predicate agrees on every chunk.
  assert.equal(chunks.some(chunkHasVisibleText), false)
  assert.equal(chunks.some(isVisibleChunk), false)
})

test('isVisibleChunk delegates to the harness predicate for every chunk type', () => {
  const cases = [
    { type: 'text-delta', index: 0, text: 'x' },
    { type: 'text-delta', index: 0, text: '  ' },
    { type: 'reasoning-delta', index: 0, text: 'x' },
    { type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { index: 0, type: 'text', text: 'x' } },
    { type: 'block-end', index: 0, block: { index: 0, type: 'text', text: ' ' } },
    { type: 'block-end', index: 0, block: { index: 0, type: 'reasoning', text: 'x' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  for (const chunk of cases) {
    assert.equal(isVisibleChunk(chunk), chunkHasVisibleText(chunk), chunk.type + ' ' + JSON.stringify(chunk.block?.type ?? ''))
  }
})

test('degenerateReasoningChars sums every reasoning delta', () => {
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: 'abcde' },
    { type: 'reasoning-delta', index: 1, text: 'fgh' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  assert.equal(degenerateReasoningChars(chunks), 8)
})

test('the config schema defaults to correcting the finish', () => {
  const resolved = new Config({})
  assert.equal(resolved.mode, DEFAULT_MODE)
  assert.equal(resolved.mode, 'error')
  assert.equal(resolved.minReasoningChars, 0)
  assert.equal(resolved.reportReasoning, true)
})

test('emptyResponseFailure / emptyResponseFinish carry the harness code', () => {
  const failure = emptyResponseFailure(12)
  assert.equal(failure.code, EMPTY_RESPONSE_CODE)
  const finish = emptyResponseFinish(12)
  assert.equal(finish.kind, 'error')
  assert.deepEqual(finish.failure, failure)
})

/**
 * Incrementality is a correctness property, not an optimisation: if the guard
 * buffered the stream, every healthy request would stop streaming tokens until
 * the model finished. This drives the generator by hand and asserts each chunk
 * is available before the next one is produced.
 */
test('chunks are yielded as they arrive, never buffered until the finish', async () => {
  let produced = 0
  const source = (async function* () {
    produced++; yield { type: 'text-delta', index: 0, text: 'a' }
    produced++; yield { type: 'text-delta', index: 0, text: 'b' }
    produced++; yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  const it = guardEmptyResponseStream(source, cfg())
  const first = await it.next()
  assert.equal(first.value.text, 'a')
  // The guard must not have pulled the rest of the stream to answer this.
  assert.equal(produced, 1, 'the first chunk must be yielded before the source is drained')

  const second = await it.next()
  assert.equal(second.value.text, 'b')
  assert.equal(produced, 2)

  const third = await it.next()
  assert.equal(third.value.type, 'finish')
  assert.equal(third.value.reason.kind, 'stop')
})

/**
 * The divergence this plugin exists to close, pinned as an executable contract.
 *
 * `translate()` opens every block through one `open()` helper that pushes into
 * `order` (llm-deepseek/src/translate.ts:120-124) and then decides degeneracy
 * with `order.length === 0` (:135). A reasoning block goes through that same
 * helper (:160), so `order.length` is already >= 1 the moment any
 * `reasoning_content` arrives and the guard can never fire.
 *
 * `openBlocks` below is that accounting exactly: one entry per block that was
 * opened, whatever its kind. The assertion is the defect itself — the shipped
 * predicate says "not degenerate" for a stream that has no visible content.
 */
function openBlocks(chunks) {
  // Mirrors translate.ts: one `open()` call per block-start, in stream order.
  return chunks.filter(chunk => chunk.type === 'block-start')
}

test('#6218 divergence: order.length disagrees with the harness predicate', async () => {
  const chunks = reasoningOnlyStream()
  const order = openBlocks(chunks)
  const visible = chunks.some(chunkHasVisibleText)

  // The shipped guard: `order.length === 0` is false, so the `stop` is kept —
  // i.e. the adapter calls this completion "successful".
  assert.equal(order.length, 1, 'the reasoning block is opened through the same helper')
  const shippedSaysSuccess = !(order.length === 0)
  assert.equal(shippedSaysSuccess, true)

  // The harness' own notion of content says there is none.
  assert.equal(visible, false)

  // So the two disagree on the same stream, which is the whole defect...
  assert.notEqual(shippedSaysSuccess, visible)

  // ...and this plugin's verdict follows the predicate, not the block count.
  const out = await drain(guardEmptyResponseStream(from(chunks), cfg()))
  assert.equal(out.at(-1).reason.kind, 'error')
})
