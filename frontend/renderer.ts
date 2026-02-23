import type { AnnotatedText } from './span'
import { countSpanChars } from './span'
import type { Round, History, RenderContext } from './round'
import {
  runCompressionPipeline, extractionPass, makeFormatPass,
  reasoningPass, truncationPass, joinPass,
} from './pipeline'
import type { TextTemplate } from './template'

// --- Age thresholds ---
// Fractions of total budget that define age zone boundaries.
// Walking newest -> oldest: age increments as accumulated chars cross these thresholds.

const AGE0_LIMIT = 0.50  // 0-50 % of budget  -> age 0 (active context)
const AGE1_LIMIT = 0.85  // 50-85 % of budget -> age 1 (mid history)
// 85-100 %           -> age 2 (deep history)
// > 100 %            -> trimmed

// --- VersionedMemory ---
// Wraps Map<string, string> with a monotonic version counter.
// The version is used by CheckpointStore to detect when memory has changed
// and a new checkpoint should be written. The renderer does NOT use the version
// for cache invalidation - extractionPass always runs fresh over compressionOut.

export class VersionedMemory {
  private readonly _map = new Map<string, string>()
  private _version = 0

  get version(): number { return this._version }

  get(key: string): string | undefined { return this._map.get(key) }
  has(key: string): boolean { return this._map.has(key) }
  keys(): IterableIterator<string> { return this._map.keys() }
  entries(): IterableIterator<[string, string]> { return this._map.entries() }

  set(key: string, value: string): void {
    this._map.set(key, value)
    this._version++
  }

  delete(key: string): boolean {
    const deleted = this._map.delete(key)
    if (deleted) this._version++

    return deleted
  }

  asReadonly(): ReadonlyMap<string, string> {
    return this._map
  }

  /** Full copy of the current state - used when writing checkpoints. */
  snapshot(): Map<string, string> {
    return new Map(this._map)
  }

  /** Restore from a plain object (used when replaying checkpoints). */
  static fromRecord(rec: Record<string, string>): VersionedMemory {
    const m = new VersionedMemory()
    for (const [k, v] of Object.entries(rec)) m.set(k, v)

    return m
  }
}

// --- RenderCache ---
// Per-round cache keyed by the Round object itself (WeakMap -> no leak risk).
// Stores the pre-joinPass pipeline output so state-forwarding can transform it
// incrementally without re-calling round.spans().

type CacheEntry = {
  age: number

  /**
   * Output of compression passes only (reasoningPass + truncationPass).
   * extractionPass is intentionally NOT applied here - caching extracted text
   * would destroy original span content, making key deletion/overwrite irrecoverable.
   * extractionPass is always applied fresh at read time over this stored output.
   */
  compressionOut: AnnotatedText

  /** Cached char count of compressionOut - used for age assignment in future renders. */
  count: number
}

export class RenderCache {
  private readonly store = new WeakMap<Round, CacheEntry>()

  get(round: Round): CacheEntry | undefined {
    return this.store.get(round)
  }

  set(round: Round, entry: CacheEntry): void {
    this.store.set(round, entry)
  }

  invalidate(round: Round): void {
    this.store.delete(round)
  }
}

// --- State forwarding ---
// Operates only on compressionOut - the pre-extraction cached output.
// extractionPass is never applied here; it runs fresh at read time.
//
// Invariants:
//   - reasoningPass is idempotent after age 0 (spans already removed)
//   - truncationPass is monotone (only compresses further)

function forwardOneStep(
  spans: AnnotatedText,
  fromAge: number,
  nextCtx: RenderContext,
): AnnotatedText {
  if (fromAge === 0) {
    // 0 -> 1: drop reasoning, apply age-1 truncation
    return truncationPass(reasoningPass(spans, nextCtx), nextCtx)
  }
  // 1 -> 2, 2 -> 3, ...: reasoning already gone; just tighten truncation
  return truncationPass(spans, nextCtx)
}

/**
 * Forward cached spans from fromAge to toAge in single steps.
 * Prefer this over a full recompute when age increased by a small delta.
 */
function stateForward(
  spans: AnnotatedText,
  fromAge: number,
  toAge: number,
  ctx: RenderContext,
): AnnotatedText {
  let out = spans
  for (let age = fromAge; age < toAge; age++) {
    out = forwardOneStep(out, age, { ...ctx, age: age + 1 })
  }

  return out
}

// --- Per-round render with cache + state forwarding ---

/** Maximum age delta for which state-forwarding is used. Beyond this, full recompute. */
const MAX_FORWARD_DELTA = 4

/**
 * Render one round to formatted AnnotatedText.
 *
 * Cache stores compressionOut (age-keyed, memory-agnostic).
 * extractionPass and formatPass are always applied fresh at read time.
 *
 * Cache branches:
 *   Hit (same age)        -> use cached compressionOut directly
 *   Age increased (small) -> state-forward compressionOut, update cache
 *   Miss / large delta    -> full recompute from round.spans()
 *
 * Memory changes never invalidate the cache - extractionPass always runs
 * fresh over compressionOut, so key deletions/overwrites are always reflected.
 */
function renderRound(
  round: Round,
  template: TextTemplate,
  ctx: RenderContext,
  cache: RenderCache,
): AnnotatedText {
  const cached = cache.get(round)

  let compressionOut: AnnotatedText

  if (cached && cached.age === ctx.age) {
    // Cache hit: same age - use stored compressionOut as-is
    compressionOut = cached.compressionOut

  } else if (
    cached &&
    ctx.age > cached.age &&
    ctx.age <= cached.age + MAX_FORWARD_DELTA
  ) {
    // Age increased by a small delta: state-forward the compressionOut
    compressionOut = stateForward(cached.compressionOut, cached.age, ctx.age, ctx)
    cache.set(round, { age: ctx.age, compressionOut, count: countSpanChars(compressionOut) })

  } else {
    // Full recompute: call round.spans() and run compression passes
    const rawSpans = round.spans(ctx)
    compressionOut = runCompressionPipeline(rawSpans, ctx)
    cache.set(round, { age: ctx.age, compressionOut, count: countSpanChars(compressionOut) })
  }

  // extractionPass and formatPass always run fresh - never cached
  const extracted = extractionPass(compressionOut, ctx)
  return makeFormatPass(template)(extracted, ctx)
}

// --- Pass 2: budget-aware render ---

export type RenderOptions = {
  budget: number
  cache?: RenderCache
}

export type RenderResult = {
  /** Fully joined prompt text - all rounds concatenated in order. */
  text: string

  /** How many rounds were beyond budget and trimmed. */
  trimmedRounds: number

  /** Age assigned to each round (indexed by History position, -1 = trimmed). */
  ageMap: number[]
}

/**
 * Render the full history into a prompt string.
 *
 * Algorithm:
 *   1. Walk newest -> oldest, accumulating chars to assign ages.
 *   2. Render oldest -> newest using per-round cache + state forwarding.
 *   3. Join with joinPass.
 */
export function renderHistory(
  history: History,
  memory: VersionedMemory,
  template: TextTemplate,
  opts: RenderOptions,
): RenderResult {
  const { budget } = opts
  const cache = opts.cache ?? new RenderCache()
  const readMem = memory.asReadonly()

  // -- Step 1: Assign ages (newest -> oldest) ---

  const ageMap = new Array<number>(history.length).fill(0)
  let accumulated = 0
  let trimmedRounds = 0

  for (let i = history.length - 1; i >= 0; i--) {
    const round = history[i]!

    // Use cached count if available (reflects compressed size), else Pass 1 value
    // Use cached compression size if available (smaller than raw), else Pass 1 raw count
    const roundChars = cache.get(round)?.count ?? round.count

    if (accumulated >= budget) {
      ageMap[i] = -1  // beyond budget: trim
      trimmedRounds++
      // Still accumulate to report accurate trimmedRounds
      accumulated += roundChars

      continue
    }

    const fraction = accumulated / budget
    ageMap[i] =
      fraction < AGE0_LIMIT ? 0 :
        fraction < AGE1_LIMIT ? 1 : 2

    accumulated += roundChars
  }

  // -- Step 2: Render (oldest -> newest) ---

  const parts: string[] = []

  for (let i = 0; i < history.length; i++) {
    const age = ageMap[i]!
    if (age === -1) continue  // trimmed

    const round = history[i]!
    const ctx: RenderContext = { age, memory: readMem, budget }

    const pipelineOut = renderRound(round, template, ctx, cache)
    const text = joinPass(pipelineOut)
    if (text) parts.push(text)
  }

  // Open the next model turn - model completes from here
  parts.push(template.modelTurn[0])

  return {
    text: parts.join(''),
    trimmedRounds,
    ageMap,
  }
}
