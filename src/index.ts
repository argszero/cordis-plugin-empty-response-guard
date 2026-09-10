/**
 * Empty-response guard for the dsh harness.
 *
 * Every provider adapter refuses a *completely* empty completion: a `stop` with
 * no content maps to `EMPTY_RESPONSE_CODE` instead of a successful empty
 * message. `dsh-llm-deepseek` decides that with `order.length === 0` — the
 * number of opened blocks — but a **reasoning** block is opened through the very
 * same `open()` helper (`packages/llm/llm-deepseek/src/translate.ts:135` vs
 * `:160`). So a completion carrying only `reasoning_content` and no text and no
 * tool call is forwarded as a normal `stop`, and the turn ends with no visible
 * output, no error, and no retry.
 *
 * That is not only a missing message: `EMPTY_RESPONSE` is in
 * `DEFAULT_RETRYABLE_CODES` (`packages/llm/llm/src/retry-policy.ts:18-24`), so
 * the undetected shape also **disables the retry machinery** the guard exists
 * to trigger. It is the same shape the issue #1 reproduction of
 * `cordis-plugin-thinking-loop-guard` observed as a loop — that plugin reacts
 * across *consecutive* calls, while this one corrects the finish of *one*
 * degenerate call, before any loop can form.
 *
 * The harness already owns the correct predicate and never uses it:
 * `chunkHasVisibleText` (`packages/llm/llm/src/assistant-stream.ts:290-293`)
 * counts only non-whitespace `text-delta` / text `block-end`, and its exported
 * roll-up `assistantStreamHasVisibleText` (`:361`) excludes reasoning by
 * contract — yet nothing in the tree consumes either one. This plugin is being
 * built on the unshipped seam rather than waiting for the core fix.
 *
 * ## What it does
 *
 * Observes the public `llm/stream` waterfall (the same around-dispatch seam the
 * in-tree `guard/` family cannot reach: `guard/timeout-policy` is a per-tool
 * `tools/execute` deadline and `guard/repeat-tool-reminder` only arms on a tool
 * *call*), tallies each stream as it flows, and when the upstream finish says
 * `stop` while no visible content appeared, emits that one chunk with an
 * `error` finish instead.
 *
 * Because the finish is the last chunk a provider sends, nothing needs to be
 * buffered: every chunk is forwarded the moment it arrives, so live token
 * streaming and the durable log are untouched and only the classification of
 * the turn changes.
 *
 * `reasoning` is never removed and never rewritten: the durable log keeps the
 * model's reasoning intact. A completion with reasoning followed by a tool call
 * is genuine progress and is left alone (it has visible output).
 *
 * @module @argszero/cordis-plugin-empty-response-guard
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: loads the @deepseek-ai/dsh-llm declaration merging that adds the
// `llm/stream` event to Cordis' Context.Events, and provides the StreamChunk /
// FinishReason / LlmFailure / GenerateOptions types.
import type { FinishReason, GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
// Value imports: the harness' own degeneracy code, so a synthesized finish is
// indistinguishable from the adapter's own EMPTY_RESPONSE verdict; and the
// harness' own "is this visible?" predicate, so a plugin and the core can never
// disagree about what counts as content. Both are root exports of the package
// (`packages/llm/llm/src/index.ts:43`, `:47`).
import { EMPTY_RESPONSE_CODE, chunkHasVisibleText } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'empty-response-guard'

/** The LLM service this plugin wraps (`llm/stream`). */
export const inject = ['llm']

/** Plugin configuration. */
export interface Config {
  /**
   * What to do when a `stop` finish arrives with no visible content. One of
   * `'error'` (default), `'warn'`, or `'off'`.
   *
   * `'error'` replaces the finish with an `EMPTY_RESPONSE` error, which is what
   * every adapter already does for the *completely* empty case: the agent loop
   * routes it to `agent/request-error`
   * (`packages/core/agent-loop/src/agent.ts:443-453`) where
   * `@deepseek-ai/dsh-llm-retry` — mounted in `bundle/base` and
   * `bundle/sdk-minimal` — retries it, since `EMPTY_RESPONSE` is retryable by
   * default. `'warn'` leaves the finish untouched and only logs, which
   * demonstrates the detection without changing behaviour. `'off'` makes the
   * plugin a pure pass-through.
   */
  mode?: 'error' | 'warn' | 'off'
  /**
   * Require this many **characters** of reasoning before the correction
   * applies. Default `0`: any reasoning-only completion counts.
   *
   * A model that opens a reasoning block and is cut off after a handful of
   * tokens is a different story from one that reasoned at length and stopped
   * with nothing to show; raise this to leave the former alone. The byte
   * threshold is not a substitute for the retry policy — it only scopes which
   * degenerate completions are corrected.
   */
  minReasoningChars?: number
  /**
   * When `true` (default), a corrected stream keeps the reasoning content that
   * preceded the finish. The plugin never removes reasoning either way; this
   * flag only decides whether the count is reported in the synthesized message
   * so the user can see how much thinking preceded the empty answer.
   */
  reportReasoning?: boolean
}

/** Resolved config: every field carries its validated default. */
export type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  mode: z.union(['error', 'warn', 'off']).default('error'),
  minReasoningChars: z.number().min(0).default(0),
  reportReasoning: z.boolean().default(true),
})

/** Default mode: correct the finish, matching every adapter's own behaviour. */
export const DEFAULT_MODE = 'error'

/**
 * The `EMPTY_RESPONSE` failure for a reasoning-only completion.
 *
 * Wording follows the adapters' own message ("model returned a completed
 * response with no content" — `translate.ts:138`, and the pi-ai variant at
 * `llm-pi-ai/src/stream.ts:104`) and appends what distinguishes this case: the
 * response *did* carry reasoning, which is exactly what hid it from the
 * original guard.
 *
 * @param reasoningChars - characters of reasoning the response carried.
 * @returns the failure the agent loop routes to `agent/request-error`.
 */
export function emptyResponseFailure(reasoningChars: number): LlmFailure {
  return {
    code: EMPTY_RESPONSE_CODE,
    message: `model returned a completed response with no text or tool call (${reasoningChars} characters of reasoning only)`,
  }
}

/**
 * The terminal `error` finish that replaces the upstream `stop`.
 *
 * @param reasoningChars - characters of reasoning the response carried.
 * @returns a finish whose `failure.code` is `EMPTY_RESPONSE`, so it is retryable
 *   under the default policy just like the adapters' own degenerate verdict.
 */
export function emptyResponseFinish(reasoningChars: number): FinishReason {
  return { kind: 'error', failure: emptyResponseFailure(reasoningChars) }
}

/**
 * Whether a chunk contributes *visible* content, via the harness' own predicate.
 *
 * `chunkHasVisibleText` is deliberately narrow — non-whitespace `text-delta`,
 * or a text `block-end` carrying non-whitespace — so a block-end for a
 * tool-call or reasoning block does not count. Reusing it (rather than testing
 * chunk types here) keeps this plugin's definition of "content" identical to
 * the core's, including the whitespace-only edge case.
 *
 * @param chunk - one stream chunk.
 * @returns `true` when the chunk is visible output.
 */
export function isVisibleChunk(chunk: StreamChunk): boolean {
  return chunkHasVisibleText(chunk)
}

/**
 * Classify one complete chunk sequence.
 *
 * @param chunks - the whole stream, in order, as the adapter emitted it.
 * @returns `undefined` when the stream is fine (or is not a `stop`), otherwise
 *   the number of reasoning characters that accompanied the empty completion.
 */
export function degenerateReasoningChars(chunks: readonly StreamChunk[]): number | undefined {
  const finish = chunks.at(-1)
  // Only a plain `stop` is degenerate. `tool-calls`, `max-tokens`, `aborted`
  // and a provider's own `error` all describe a different situation and must be
  // forwarded untouched.
  if (finish?.type !== 'finish' || finish.reason.kind !== 'stop') return undefined
  if (chunks.some(isVisibleChunk)) return undefined
  return chunks.reduce(
    (total, chunk) => chunk.type === 'reasoning-delta' ? total + chunk.text.length : total,
    0,
  )
}

/**
 * The guard: forward every chunk the moment it arrives, and correct the finish
 * when the completion turned out to be reasoning-only.
 *
 * **Streaming-preserving by construction.** The verdict needs the finish, and
 * the finish is the last chunk a provider sends — so nothing has to be held.
 * The generator carries a running "has anything visible appeared?" flag and a
 * reasoning counter, forwards each chunk immediately (live token streaming and
 * the durable log are untouched), and rewrites only the terminal chunk. A
 * buffer-then-decide implementation would also be correct but would stall every
 * healthy request's output until the model finished, which is why it is not
 * what this does.
 *
 * @param source - the upstream chunk stream.
 * @param config - resolved plugin config.
 * @param onDegenerate - called once when a reasoning-only completion is
 *   corrected or observed, with the reasoning character count. Kept as a
 *   parameter so the generator stays pure and log-free for tests; the plugin
 *   passes a `ctx.logger.warn` delegate.
 * @returns the stream, with a `stop` finish replaced by `EMPTY_RESPONSE` when
 *   the completion carried only reasoning.
 */
export async function* guardEmptyResponseStream(
  source: AsyncIterable<StreamChunk>,
  config: ResolvedConfig,
  onDegenerate?: (reasoningChars: number) => void,
): AsyncIterable<StreamChunk> {
  if (config.mode === 'off') {
    for await (const chunk of source) yield chunk
    return
  }

  let sawVisible = false
  let reasoningChars = 0

  for await (const chunk of source) {
    if (chunk.type === 'finish') {
      // Only a plain `stop` is degenerate: `tool-calls`, `max-tokens` and
      // `aborted` each describe a different situation and pass through.
      if (chunk.reason.kind === 'stop' && !sawVisible && reasoningChars >= config.minReasoningChars) {
        onDegenerate?.(reasoningChars)
        if (config.mode === 'error') {
          yield { ...chunk, reason: emptyResponseFinish(reasoningChars) }
          continue
        }
      }
      yield chunk
      continue
    }
    if (!sawVisible && isVisibleChunk(chunk)) sawVisible = true
    if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
    yield chunk
  }
}

/**
 * Register the guard.
 *
 * @param ctx - the Cordis context.
 * @param config - plugin config (defaults applied here so a caller that builds
 *   its own config object — a custom profile layer, a test — gets the same
 *   behaviour as one that went through schemastery).
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const resolved: ResolvedConfig = {
    ...config,
    mode: config.mode ?? DEFAULT_MODE,
    minReasoningChars: config.minReasoningChars ?? 0,
    reportReasoning: config.reportReasoning ?? true,
  }
  ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const upstream = next()
    if (resolved.mode === 'off') return upstream
    return guardEmptyResponseStream(upstream, resolved, (reasoningChars) => {
      ctx.logger.warn(
        'empty-response-guard: model returned a completed response with no text or tool call '
        + '(%d characters of reasoning only); %s (discussion #6218)',
        reasoningChars,
        resolved.mode === 'error'
          ? `reported as ${EMPTY_RESPONSE_CODE} so the retry policy can act`
          : 'left as a successful stop (warn mode)',
      )
    })
  })
}
