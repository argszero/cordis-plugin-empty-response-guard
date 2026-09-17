# @argszero/cordis-plugin-empty-response-guard

**A silent successful turn, reported as a failure so the retry policy can act.**

A dsh turn can end as a **success** while nothing was actually delivered to the
user. This plugin watches the `llm/stream` waterfall and reclassifies exactly
two such shapes — both of them finishes the harness currently records as
`reason.kind = "stop"` — as retryable errors:

| shape | what the provider sent | what the user saw | source |
| --- | --- | --- | --- |
| **1** | `reasoning_content` only, then `stop` | "it thought halfway and stopped" | discussion [#6218](https://github.com/deepseek-ai/deepseek-harness/discussions/6218) |
| **2** | text, then `stop`, with **usage accounting for zero tokens** | "the answer just stops mid-sentence" | discussion [#6948](https://github.com/deepseek-ai/deepseek-harness/discussions/6948) |

Both are **seam** fixes: they make the failure visible and retryable at the
stream boundary, without waiting for upstream to change every adapter.

## Shape 1 — a `stop` with nothing visible (discussion #6218)

Every adapter refuses a *completely* empty completion. The DeepSeek adapter
decides that with the number of opened blocks:

```js
// packages/llm/llm-deepseek/src/translate.ts
// (0.1.6+ moved it, unchanged, to src/protocols/chat-completions/translate.ts)
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
— **nothing in the tree consumes either one**. This plugin imports the first
one, so a plugin and the core can never disagree about what counts as content.

## Shape 2 — a `stop` whose usage accounts for nothing (discussion #6948)

A relay can truncate a response mid-stream and still report a **successful
completion**: the chunks arrive, the finish says `stop`, and the usage chunk
says `0 / 0 / 0`. `mapStopReason` decides on `message.content.length === 0`
alone (`packages/llm/llm-pi-ai/src/stream.ts:80`, `:99`), so content that
exists — even content that stops mid-sentence — makes the turn a success, and
nothing downstream retries it.

**The retry machinery is not the problem.** The correction upstream needs is
already there and is *not* gated on partial content:
`packages/core/agent-loop/src/agent.ts:443` settles `assistant/attempt` and
dispatches `agent/request-error` for any error finish, and
`llm-retry` decides purely on the failure code
(`packages/llm/llm-retry/src/index.ts:215`, `retry-policy.ts:18`). What is
missing is only the **detection**.

### Why the detector is built the way it is

Text-level heuristics ("does it look like it stopped mid-sentence?") are not
decidable, and guessing wrong costs real requests. Usage is the only handle the
provider gives us — which creates the trap this plugin is mostly about: **a
route that never reports usage must not be read as a route that reported zero.**

Zero usage is evidence only **with a control**, so:

- **Self-calibration.** A route's zero usage is trusted only after that route
  has reported non-zero usage at least once in this process. In practice the
  adapter emits `usage` before `finish` on every call, so a healthy call arms
  its own route; a route that has never reported usage is never corrected.
  Arming is announced once in the log, so "the guard declined because the route
  never reported usage" is distinguishable from "the guard saw nothing".
- **A per-session bound** (`fabricatedStopMaxPerSession`, default `3`). A relay
  that has degraded keeps truncating, and each correction buys a retry cycle;
  past the bound the guard reports the evidence and leaves the `stop` alone.
  Shape-1 corrections are not counted — they are deterministic and cannot feed
  themselves.
- **A distinct failure code.** Shape 2 is reported as `TRANSPORT`, not
  `EMPTY_RESPONSE`: the caller *did* receive content, so naming it after an
  absent answer would misreport it. What failed is the transport's claim to have
  delivered a whole one.

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

Observes the `llm/stream` waterfall, tallies each stream as it flows, and
rewrites only the terminal chunk when a degenerate completion is detected:

- **Streaming is preserved.** The verdict needs the finish, and the finish is
  the last chunk a provider sends — so nothing is buffered. Every chunk is
  forwarded the moment it arrives; live token streaming and the durable log are
  untouched. (A buffer-then-decide implementation would also be correct but
  would stall every healthy request. A test fails if this ever changes.)
- **Reasoning is never removed or rewritten.** Only the classification of the
  turn changes.
- **Reasoning followed by a tool call is progress**, not degeneracy, and passes
  through untouched.
- **Non-`stop` finishes are never touched** (`tool-calls`, `max-tokens`,
  `aborted`, and a provider's own `error` each mean something else).
- **Shape 1 wins when both apply**: a stream with no visible content *and* no
  usage is described more precisely by `EMPTY_RESPONSE`, and both codes are
  retryable, so the choice cannot change what the retry policy does.
- A stream that carries **no usage chunk at all** is never shape 2.
- The resulting finish routes to `agent/request-error`
  (`packages/core/agent-loop/src/agent.ts:443-453`) and is retried by
  `@deepseek-ai/dsh-llm-retry` — mounted in `bundle/base` and
  `bundle/sdk-minimal` — exactly like the adapter's own verdict.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `mode` | `'error'` | `'error'` = reclassify (as `EMPTY_RESPONSE` / `TRANSPORT`); `'warn'` = detect and log only; `'off'` = pure pass-through |
| `minReasoningChars` | `0` | require N characters of reasoning before the shape-1 correction applies |
| `reportReasoning` | `true` | include the reasoning character count in the synthesized message |
| `detectFabricatedStop` | `true` | enable shape 2; `false` restores exactly the 0.1.0 behaviour |
| `fabricatedStopNeedsCalibration` | `true` | only trust zero usage on a route that has previously reported usage |
| `fabricatedStopMaxPerSession` | `3` | bound on shape-2 corrections per session; `0` removes the bound |

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

These are **seam** fixes, not the core fix. The real repair belongs in
`translate.ts` / `mapStopReason` (and in any adapter sharing the shape): test
for the absence of *visible* content rather than the absence of *any* block —
the predicate already exists in the same package — and refuse to call a
completion complete when its own accounting says nothing was produced. Until
upstream decides, this keeps the failure visible and retryable.

## Compatibility

Peer-compatible with `@deepseek-ai/dsh-llm` on the **0.1.3**, **0.1.5** and
**0.1.6** lines — each one has had the full suite run against it. The seam the
plugin needs (`llm/stream`, `EMPTY_RESPONSE_CODE`, `chunkHasVisibleText`) is
complete from `0.1.3-alpha.2` onward.

Two corrections came out of running that check rather than trusting the range:

- **0.1.6 was excluded until 0.2.1.** A comparator admits a prerelease only when
  it shares that prerelease's `major.minor.patch`, so `>=0.1.5-alpha.1 <0.2.0`
  is not "0.1.5 and later" — it silently drops every `0.1.6-*` release one
  `npm install` after `0.1.6-alpha.2` became the `alpha` dist-tag.
- **0.1.2-rc.1 was claimed and is not supportable.** That release has no
  `assistant-stream` module, so `chunkHasVisibleText` does not exist there and
  `tsc` fails before a single test runs. The range admitted the version; nobody
  had run the code against it. It is now excluded, so an unsupported line fails
  loudly at install time instead of at load time.

`test/peer-range.test.js` computes admission over the published version list
with `semver` and asserts the admitted set exactly, so neither an accidental
extra line nor a missing one can pass a regex-shaped test again.

## Tests

```sh
npm test
```

45 tests:

- `test/empty-response-guard.test.js` — shape 1, including a divergence test
  that pins the contract break itself (`order.length` says success while the
  harness' own predicate says there is no content) and an incrementality test
  that fails if the guard ever starts buffering;
- `test/fabricated-stop.test.js` — shape 2, its control (calibration), the
  bound, and every config switch;
- `test/cordis.test.js` — the wiring, on a **real cordis `Context`**: a real
  `llm/stream` waterfall dispatches through the guard, the correction reaches
  the consumer of the waterfall, the request is not mutated, and the
  diagnostics a host reads to self-verify are actually emitted;
- `test/peer-range.test.js` — the peer range admits both supported lines.

## License

MIT
