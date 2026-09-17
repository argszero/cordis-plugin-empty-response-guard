/**
 * Empty-response guard for the dsh harness.
 *
 * Two shapes of "a provider reported a clean completion that was not one",
 * corrected at the same public seam (`llm/stream`).
 *
 * ## 1. The reasoning-only completion (discussion #6218)
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
 * ## 2. The fabricated stop (discussion #6948)
 *
 * The neighbouring shape has content *and* is still a lie. `mapStopReason`
 * (`packages/llm/llm-pi-ai/src/stream.ts:80`) keys its degeneracy branch on
 * `message.content.length === 0` (`:99`), so a relay that truncates a response
 * mid-sentence and still terminates the stream with `stop` is accepted as a
 * clean completion: the half-finished text is committed as an answer, the turn
 * is recorded `completed`, and the retry policy never engages. Observed in the
 * wild as 1033 characters of text (a duplicate of the reasoning) plus
 * `usage {inputTokens: 0, outputTokens: 0, totalTokens: 0}` — the only step of
 * that 57-step turn reporting zero usage.
 *
 * The discriminator is therefore the accounting, not the text: a genuine
 * completion *emits tokens*, so a terminal `stop` whose usage reports nothing
 * at all is evidence the provider never ran the generation it claims to have
 * finished. Text cannot be used — nothing machine-checkable separates "cut
 * mid-clause" from "answered briefly".
 *
 * Zero usage is evidence only against a control, so the rule self-calibrates:
 * a route is trusted only once it has reported non-zero usage at least once in
 * this process. A gateway that never reports usage keeps zero for every call —
 * treating those as failures would turn each clean stop into up to
 * `maxRetries` extra requests. A per-session cap bounds the worst case
 * regardless, since a flaky relay can truncate many steps.
 *
 * ## What it does
 *
 * Observes the public `llm/stream` waterfall (the same around-dispatch seam the
 * in-tree `guard/` family cannot reach: `guard/timeout-policy` is a per-tool
 * `tools/execute` deadline and `guard/repeat-tool-reminder` only arms on a tool
 * *call*), tallies each stream as it flows, and rewrites only the terminal
 * chunk when the completion turns out to be degenerate.
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
 * Neither correction is guessed at: both are legal at this seam because
 * `packages/llm/llm/src/invariant.ts:75` permits an `error` finish to leave
 * blocks open, while a non-error finish requires every block closed.
 *
 * @module @argszero/cordis-plugin-empty-response-guard
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: loads the @deepseek-ai/dsh-llm declaration merging that adds the
// `llm/stream` event to Cordis' Context.Events, and provides the StreamChunk /
// FinishReason / LlmFailure / GenerateOptions types.
import type {
  FinishReason,
  GenerateOptions,
  LlmFailure,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
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

/**
 * The harness code for a stream that ended without the provider finishing its
 * response; retryable under the default policy
 * (`packages/llm/llm/src/retry-policy.ts:18-24`).
 *
 * The harness mints this code for exactly this situation in the pi-ai adapter —
 * `/stream ended (?:before|without)\b/i` → `TRANSPORT`
 * (`packages/llm/llm-pi-ai/src/stream.ts:58`), plus the flattened socket-drop
 * wordings at `:63-66` — but publishes no constant for it, so the string is
 * repeated here with the citation rather than imported. It is deliberately not
 * `EMPTY_RESPONSE`: the caller did receive content, so naming the failure after
 * an absent answer would misreport it; what failed is the transport's claim to
 * have delivered a whole one.
 */
export const TRANSPORT_CODE = 'TRANSPORT'

/** Plugin configuration. */
export interface Config {
  /**
   * What to do when a degenerate completion is detected. One of `'error'`
   * (default), `'warn'`, or `'off'`.
   *
   * `'error'` replaces the finish with an error, which is what every adapter
   * already does for the *completely* empty case: the agent loop routes it to
   * `agent/request-error` (`packages/core/agent-loop/src/agent.ts:443-453`)
   * where `@deepseek-ai/dsh-llm-retry` — mounted in `bundle/base` and
   * `bundle/sdk-minimal` — retries it, since both codes used here are retryable
   * by default. `'warn'` leaves the finish untouched and only logs, which
   * demonstrates the detection without changing behaviour. `'off'` makes the
   * plugin a pure pass-through.
   */
  mode?: 'error' | 'warn' | 'off'
  /**
   * Require this many **characters** of reasoning before the reasoning-only
   * correction (shape 1) applies. Default `0`: any reasoning-only completion
   * counts.
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
  /**
   * Detect shape 2 — a terminal `stop` whose usage reports no tokens at all
   * (discussion #6948). Default `true`.
   *
   * Turn this off to leave every `stop` with visible content untouched, which
   * is the behaviour of 0.1.0. The detection needs the usage chunk the adapter
   * emits before the finish; a stream that reports no usage chunk at all is
   * never corrected.
   */
  detectFabricatedStop?: boolean
  /**
   * Require calibration before shape 2 applies (default `true`): the route must
   * have reported non-zero usage at least once in this process.
   *
   * Without this control, a gateway that never reports usage would have every
   * clean stop read as fabricated — one silent truncation traded for up to
   * `maxRetries` extra requests per step. Set to `false` only when the routes
   * in play are known to report usage on every call.
   */
  fabricatedStopNeedsCalibration?: boolean
  /**
   * Upper bound on shape-2 corrections per session (default `3`; `0` disables
   * the bound). A relay that degrades keeps truncating, and each correction
   * costs a retry cycle; past the bound the guard reports the evidence it sees
   * and leaves the `stop` alone — the pre-0.2.0 behaviour, chosen deliberately
   * over an unbounded loop.
   *
   * Correlations are counted per `sessionId` (shape-1 corrections are not
   * counted: they are deterministic and cannot feed themselves).
   */
  fabricatedStopMaxPerSession?: number
}

/** Resolved config: every field carries its validated default. */
export type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  mode: z.union(['error', 'warn', 'off']).default('error'),
  minReasoningChars: z.number().min(0).default(0),
  reportReasoning: z.boolean().default(true),
  detectFabricatedStop: z.boolean().default(true),
  fabricatedStopNeedsCalibration: z.boolean().default(true),
  fabricatedStopMaxPerSession: z.number().min(0).default(3),
})

/** Default mode: correct the finish, matching every adapter's own behaviour. */
export const DEFAULT_MODE = 'error'

/** Default bound on shape-2 corrections per session. */
export const DEFAULT_FABRICATED_STOP_MAX_PER_SESSION = 3

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
 * Whether a usage report carries any token count at all.
 *
 * Every counter the harness models is included, not just input/output: what the
 * rule needs to know is whether the provider reported *anything*, and a gateway
 * that answers from a cache with `cacheReadTokens > 0` has plainly reported.
 * Absent optional counters count as zero.
 *
 * @param usage - the usage the adapter mapped for this call.
 * @returns `true` when at least one counter is non-zero.
 */
export function usageWasReported(usage: TokenUsage): boolean {
  return usage.inputTokens !== 0
    || usage.outputTokens !== 0
    || (usage.totalTokens ?? 0) !== 0
    || (usage.cacheReadTokens ?? 0) !== 0
    || (usage.cacheWriteTokens ?? 0) !== 0
    || (usage.reasoningTokens ?? 0) !== 0
}

/**
 * The `TRANSPORT` failure for a `stop` that claims a completion the accounting
 * says never happened (discussion #6948).
 *
 * @param detail - what was observed: the route, the content the stream did
 *   carry, and the zero usage that contradicts the `stop`.
 * @returns the failure the agent loop routes to `agent/request-error`.
 */
export function fabricatedStopFailure(detail: string): LlmFailure {
  return {
    code: TRANSPORT_CODE,
    message: `model reported a completed response whose usage accounts for no tokens at all (${detail})`,
  }
}

/**
 * The terminal `error` finish that replaces a fabricated `stop`.
 *
 * @param detail - what was observed; see {@link fabricatedStopFailure}.
 * @returns a finish whose `failure.code` is `TRANSPORT`, so the default policy
 *   retries the call instead of committing a truncated answer.
 */
export function fabricatedStopFinish(detail: string): FinishReason {
  return { kind: 'error', failure: fabricatedStopFailure(detail) }
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
    (total, chunk) => total + (chunk.type === 'reasoning-delta' ? chunk.text.length : 0),
    0,
  )
}

/**
 * The route key a usage calibration is remembered under.
 *
 * `provider::model` rather than either alone: one gateway can serve several
 * models and one model can be reachable through several routes, and it is the
 * *route* — the thing that produces the accounting — whose honesty is being
 * learned.
 *
 * @param options - the request being generated.
 * @returns the calibration key.
 */
export function routeKeyOf(options: Pick<GenerateOptions, 'provider' | 'model'>): string {
  return `${options.provider}::${options.model}`
}

/**
 * Per-plugin-instance memory the guard needs across calls.
 *
 * Held by {@link apply} for the plugin lifetime and passed in by tests, so the
 * guard functions themselves stay pure and free of module-level state (two
 * mounts must not share a calibration).
 */
export interface GuardState {
  /** Routes observed to report usage (shape 2 is only credible against these). */
  calibratedRoutes: Set<string>
  /** Shape-2 corrections already made, keyed by session (or `'*'` when absent). */
  corrections: Map<string, number>
}

/**
 * Create empty guard state.
 *
 * @returns a fresh state object; one per plugin instance.
 */
export function newGuardState(): GuardState {
  return { calibratedRoutes: new Set<string>(), corrections: new Map<string, number>() }
}

/** Why a detected shape was not corrected. */
export type SuppressionReason =
  /** The per-session bound for shape-2 corrections is exhausted. */
  | 'cap'
  /** The route has never reported usage, so zero usage is not evidence. */
  | 'uncalibrated'
  /** `mode: 'warn'` — detected and reported, finish left alone. */
  | 'warn-mode'

/**
 * What the guard decided about one terminal finish.
 *
 * The log is built from this, so a suppressed correction is as visible as a
 * made one: the host can tell "the guard never suspected this stop" apart from
 * "the guard suspected it and declined".
 */
export interface CorrectionReport {
  /** Which shape was detected. */
  kind: 'empty-response' | 'fabricated-stop'
  /** The failure code the correction uses (also the code it would have used). */
  code: string
  /** Whether the finish was actually replaced. */
  corrected: boolean
  /** Present exactly when `corrected` is false. */
  suppressedBy?: SuppressionReason
  /** Characters of reasoning the stream carried. */
  reasoningChars: number
  /** Characters of visible text the stream carried. */
  visibleChars: number
  /** The caller's session, when the loop stamped one. */
  sessionId?: string
  /** The calibration key (`provider::model`), when known. */
  route?: string
}

/** Per-call wiring for {@link guardStream}. */
export interface GuardContext {
  /** Cross-call memory; omitted means a throwaway state (pure single-call use). */
  state?: GuardState
  /** Calibration key for this call; see {@link routeKeyOf}. */
  route?: string
  /** Session identity for the per-session bound, when the loop stamped one. */
  sessionId?: string
  /** Called once per terminal finish the guard has an opinion about. */
  onCorrection?: (report: CorrectionReport) => void
  /** Called once per route, the first time that route reports usage. */
  onCalibrated?: (route: string) => void
}

/** Build the observed-evidence clause shared by the failure message and the log. */
function evidenceClause(reasoningChars: number, visibleChars: number): string {
  return `${visibleChars} characters of text, ${reasoningChars} characters of reasoning, usage 0 tokens`
}

/**
 * The guard: forward every chunk the moment it arrives, and correct the finish
 * when the completion turned out to be degenerate.
 *
 * **Streaming-preserving by construction.** The verdict needs the finish, and
 * the finish is the last chunk a provider sends — so nothing has to be held.
 * The generator carries a running "has anything visible appeared?" flag, the
 * two character counts, and the usage report, forwards each chunk immediately
 * (live token streaming and the durable log are untouched), and rewrites only
 * the terminal chunk. A buffer-then-decide implementation would also be correct
 * but would stall every healthy request's output until the model finished,
 * which is why it is not what this does.
 *
 * Shape 1 (no visible content) is corrected unconditionally: a `stop` with
 * nothing to show is degenerate however the provider accounts for it, and the
 * correction cannot feed itself. Shape 2 (visible content, zero usage) is
 * gated by calibration and the per-session bound — see {@link Config}.
 *
 * @param source - the upstream chunk stream.
 * @param config - resolved plugin config.
 * @param context - cross-call memory, the calibration/session keys, and the
 *   report sink. Kept as a parameter so the generator stays pure and log-free
 *   for tests; the plugin passes `ctx.logger` delegates.
 * @returns the stream, with a degenerate `stop` finish replaced by an error.
 */
export async function* guardStream(
  source: AsyncIterable<StreamChunk>,
  config: ResolvedConfig,
  context: GuardContext = {},
): AsyncIterable<StreamChunk> {
  if (config.mode === 'off') {
    for await (const chunk of source) yield chunk
    return
  }

  let sawVisible = false
  let reasoningChars = 0
  let visibleChars = 0
  let usage: TokenUsage | undefined

  for await (const chunk of source) {
    if (chunk.type === 'finish') {
      // Only a plain `stop` is degenerate: `tool-calls`, `max-tokens` and
      // `aborted` each describe a different situation and pass through.
      if (chunk.reason.kind === 'stop') {
        const decision = decide(chunk, { sawVisible, reasoningChars, visibleChars, usage }, config, context)
        if (decision !== undefined) {
          context.onCorrection?.(decision.report)
          if (decision.corrected) {
            yield { ...chunk, reason: decision.finish }
            continue
          }
        }
      }
      yield chunk
      continue
    }
    if (chunk.type === 'usage') {
      usage = chunk.usage
      // Calibrate on the way past: the adapter emits usage before the finish,
      // so a route is trusted for its own stream as soon as its own accounting
      // arrives, and no separate bookkeeping pass is needed.
      if (context.route !== undefined && usageWasReported(chunk.usage)) {
        const first = context.state?.calibratedRoutes.has(context.route) === false
        context.state?.calibratedRoutes.add(context.route)
        if (first) context.onCalibrated?.(context.route)
      }
    } else if (chunk.type === 'reasoning-delta') {
      reasoningChars += chunk.text.length
    } else if (chunk.type === 'text-delta') {
      visibleChars += chunk.text.length
    }
    if (!sawVisible && isVisibleChunk(chunk)) sawVisible = true
    yield chunk
  }
}

/** The observations one stream accumulated, as the decision sees them. */
interface Observations {
  sawVisible: boolean
  reasoningChars: number
  visibleChars: number
  usage: TokenUsage | undefined
}

/** A made correction, or a detected shape the guard declined to correct. */
type Decision =
  | { corrected: true; finish: FinishReason; report: CorrectionReport }
  | { corrected: false; report: CorrectionReport }

/**
 * Decide what to do with one terminal `stop`.
 *
 * Shape 1 is checked first and wins when both could apply: a stream with no
 * visible content *and* no usage is described more precisely by
 * `EMPTY_RESPONSE`, and both codes are retryable, so the choice cannot change
 * what the retry policy does.
 *
 * @param chunk - the terminal finish chunk.
 * @param seen - what the stream carried.
 * @param config - resolved plugin config.
 * @param context - calibration key, session key and report sink.
 * @returns the decision, or `undefined` when the finish is none of our business.
 */
function decide(
  chunk: Extract<StreamChunk, { type: 'finish' }>,
  seen: Observations,
  config: ResolvedConfig,
  context: GuardContext,
): Decision | undefined {
  const base = {
    reasoningChars: seen.reasoningChars,
    visibleChars: seen.visibleChars,
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    ...(context.route === undefined ? {} : { route: context.route }),
  }

  // Shape 1 (discussion #6218): a stop with nothing visible to show.
  if (!seen.sawVisible && seen.reasoningChars >= config.minReasoningChars) {
    const report: CorrectionReport = {
      ...base,
      kind: 'empty-response',
      code: EMPTY_RESPONSE_CODE,
      corrected: config.mode === 'error',
      ...(config.mode === 'error' ? {} : { suppressedBy: 'warn-mode' as const }),
    }
    return config.mode === 'error'
      ? { corrected: true, finish: emptyResponseFinish(seen.reasoningChars), report }
      : { corrected: false, report }
  }

  // Shape 2 (discussion #6948): a stop whose usage accounts for nothing.
  if (!config.detectFabricatedStop) return undefined
  if (seen.usage === undefined || usageWasReported(seen.usage)) return undefined

  const detail = evidenceClause(seen.reasoningChars, seen.visibleChars)
  const report: CorrectionReport = {
    ...base,
    kind: 'fabricated-stop',
    code: TRANSPORT_CODE,
    corrected: false,
  }
  if (config.mode === 'warn') return { corrected: false, report: { ...report, suppressedBy: 'warn-mode' } }

  const calibrated = !config.fabricatedStopNeedsCalibration
    || context.route === undefined
    || context.state?.calibratedRoutes.has(context.route) === true
  if (!calibrated) return { corrected: false, report: { ...report, suppressedBy: 'uncalibrated' } }

  const sessionKey = context.sessionId ?? '*'
  const already = context.state?.corrections.get(sessionKey) ?? 0
  if (config.fabricatedStopMaxPerSession > 0 && already >= config.fabricatedStopMaxPerSession) {
    return { corrected: false, report: { ...report, suppressedBy: 'cap' } }
  }
  context.state?.corrections.set(sessionKey, already + 1)
  return {
    corrected: true,
    finish: fabricatedStopFinish(detail),
    report: { ...report, corrected: true },
  }
}

/**
 * The guard, with a throwaway calibration state.
 *
 * Kept at its 0.1.0 signature for callers that imported the generator directly
 * (tests, embedders). Shape 1 behaves exactly as in 0.1.0; shape 2 is inert
 * here because a throwaway state is never calibrated — mount the plugin (or
 * pass a shared state to {@link guardStream}) for the #6948 half.
 *
 * @param source - the upstream chunk stream.
 * @param config - resolved plugin config.
 * @param onDegenerate - called once when a degenerate completion is found.
 * @returns the guarded stream.
 */
export async function* guardEmptyResponseStream(
  source: AsyncIterable<StreamChunk>,
  config: ResolvedConfig,
  onDegenerate?: (reasoningChars: number) => void,
): AsyncIterable<StreamChunk> {
  yield* guardStream(source, config, {
    state: newGuardState(),
    ...(onDegenerate === undefined
      ? {}
      : { onCorrection: (report: CorrectionReport) => onDegenerate(report.reasoningChars) }),
  })
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
    detectFabricatedStop: config.detectFabricatedStop ?? true,
    fabricatedStopNeedsCalibration: config.fabricatedStopNeedsCalibration ?? true,
    fabricatedStopMaxPerSession: config.fabricatedStopMaxPerSession
      ?? DEFAULT_FABRICATED_STOP_MAX_PER_SESSION,
  }
  // One calibration per mounted plugin, shared by every stream it wraps.
  const state = newGuardState()

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const upstream = next()
    if (resolved.mode === 'off') return upstream
    const route = routeKeyOf(options)
    return guardStream(upstream, resolved, {
      state,
      route,
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      onCalibrated: (calibratedRoute) => {
        // Announce the arming of a route once, so "the guard declined because
        // the route never reported usage" is distinguishable from "the guard
        // saw nothing" without reading the source (a reading that reports
        // absence must name its instrument, not just its result).
        ctx.logger.info(
          'empty-response-guard: route "%s" reports usage; a stop whose usage accounts for '
          + 'no tokens will now be treated as a fabricated completion (discussion #6948)',
          calibratedRoute,
        )
      },
      onCorrection: (report) => log(ctx, resolved, report),
    })
  })
}

/**
 * Emit one log line per detected shape, corrected or not.
 *
 * @param ctx - the Cordis context (for its logger).
 * @param config - resolved plugin config, for the bound in the suppressed wording.
 * @param report - what the guard decided.
 */
function log(ctx: Context, config: ResolvedConfig, report: CorrectionReport): void {
  if (report.kind === 'empty-response') {
    ctx.logger.warn(
      'empty-response-guard: model returned a completed response with no text or tool call '
      + '(%d characters of reasoning only); %s (discussion #6218)',
      report.reasoningChars,
      report.corrected
        ? `reported as ${report.code} so the retry policy can act`
        : 'left as a successful stop (warn mode)',
    )
    return
  }
  const observed = `route "${report.route ?? 'unknown'}" ${report.visibleChars} characters of text, `
    + `${report.reasoningChars} characters of reasoning`
  const outcome = report.corrected
    ? `reported as ${report.code} so the retry policy can act`
    : report.suppressedBy === 'cap'
      ? `left as a successful stop, the per-session bound is reached `
        + `(fabricatedStopMaxPerSession=${config.fabricatedStopMaxPerSession})`
      : report.suppressedBy === 'uncalibrated'
        ? 'left as a successful stop, this route has not reported usage in this process '
          + '(no calibration)'
        : 'left as a successful stop (warn mode)'
  ctx.logger.warn(
    'empty-response-guard: a model response on %s ended with a `stop` whose usage accounts for '
    + 'no tokens at all; %s (discussion #6948)',
    observed,
    outcome,
  )
}
