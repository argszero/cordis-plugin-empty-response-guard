# @argszero/cordis-plugin-empty-response-guard

**A silent successful turn, reported as a failure so the retry policy can act.**

A provider completion that carries only `reasoning_content` and stops is
currently reported as a **successful** turn in dsh. No text, no tool call, no
error, no retry — the session log records `turn/end` with `reason.kind =
"completed"`. From the user's side the model "thought halfway and then stopped".

## The defect (discussion #6218)

Every adapter refuses a *completely* empty completion. The DeepSeek adapter
decides that with the number of opened blocks:

```js
// packages/llm/llm-deepseek/src/translate.ts
function open(kind) { const block = { index: nextIndex++, kind, text: '' }; order.push(block); return block }  // :120-124
// :135
reason: reason.kind === 'stop' && order.length === 0 ? { kind: 'error', failure: { …, code: EMPTY_RESPONSE_CODE } } : reason
// :160 — a reasoning block is opened through the very same helper
reasoningBlock = open('reasoning')
```

So as soon as **any** `reasoning_content` arrives, `order.length >= 1` for the
rest of the stream and the `EMPTY_RESPONSE` branch can never be taken. The
intent and the implementation disagree about whether a reasoning block is
content.

**It is worse than a wrong flag.** `EMPTY_RESPONSE` is in
`DEFAULT_RETRYABLE_CODES` (`packages/llm/llm/src/retry-policy.ts:18-24`), so
the undetected shape also **disables the retry machinery the guard exists to
trigger** — a turn that should have been retried is silently accepted.

The harness already owns the right predicate and never uses it:
`chunkHasVisibleText` (`packages/llm/llm/src/assistant-stream.ts:290-293`)
counts only non-whitespace `text-delta` / text `block-end`, and its exported
roll-up `assistantStreamHasVisibleText` (`:361`) excludes reasoning by contract
— **nothing in the tree consumes either one**.

## Install and mount

```sh
npm install @argszero/cordis-plugin-empty-response-guard
```

The bundle patch mounts it; the plugin needs no configuration:

```yaml
- insert:
    - id: empty-response-guard
      name: '@argszero/cordis-plugin-empty-response-guard'
```

## What it does

Observes the `llm/stream` waterfall, tallies each stream as it flows, and when
the upstream finish says `stop` while no visible content appeared, emits that
one chunk with an `error` finish instead:

- **Streaming is preserved.** The verdict needs the finish, and the finish is
  the last chunk a provider sends — so nothing is buffered. Every chunk is
  forwarded the moment it arrives; live token streaming and the durable log are
  untouched. (A buffer-then-decide implementation would also be correct but
  would stall every healthy request.)
- **Reasoning is never removed or rewritten.** Only the classification of the
  turn changes.
- **Reasoning followed by a tool call is progress**, not degeneracy, and passes
  through untouched.
- **Non-`stop` finishes are never touched** (`tool-calls`, `max-tokens`,
  `aborted`, and a provider's own `error` each mean something else).
- The resulting finish routes to `agent/request-error`
  (`packages/core/agent-loop/src/agent.ts:443-453`) and is retried by
  `@deepseek-ai/dsh-llm-retry` — mounted in `bundle/base` and
  `bundle/sdk-minimal` — exactly like the adapter's own verdict.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `mode` | `'error'` | `'error'` = reclassify as `EMPTY_RESPONSE`; `'warn'` = detect and log only; `'off'` = pure pass-through |
| `minReasoningChars` | `0` | require N characters of reasoning before correcting; a model cut off after a few tokens is a different story |
| `reportReasoning` | `true` | include the reasoning character count in the synthesized message |

```yaml
- set:
    - id: empty-response-guard
      config:
        mode: warn
```

## Relationship to other guards

- `cordis-plugin-thinking-loop-guard` reacts across **consecutive** calls to
  break a loop. This one corrects the **single** degenerate call, before a loop
  can form — the issue #1 reproduction is the same model shape.
- The in-tree `guard/timeout-policy` (per-tool deadline) and
  `guard/repeat-tool-reminder` (tool-call chain) cannot see a stream that
  contains no tool call at all.

## Scope, honestly

This is a **seam** fix, not the core fix. The real repair belongs in
`translate.ts` (and in any adapter sharing the shape): test for the absence of
*visible* content rather than the absence of *any* block — the predicate already
exists in the same package. Until upstream decides, this keeps the failure
visible and retryable.

## Compatibility

Peer-compatible with `@deepseek-ai/dsh-llm` on the **0.1.2-rc** and **0.1.5**
lines (see `test/peer-range.test.js` for why a bare `>=0.1.2` range would match
nothing).

## Tests

```sh
npm test
```

20 tests, including a divergence test that pins the contract break itself
(`order.length` says success while the harness' own predicate says there is no
content) and an incrementality test that fails if the guard ever starts
buffering.

## License

MIT
