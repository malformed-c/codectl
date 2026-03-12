/**
 * Entropy-based agent ejection tracker.
 *
 * Tracks an entropy score that rises on failure or repeated tool calls and
 * falls on successful unique tool calls. When it crosses the eject threshold
 * the agent should be ejected to chat mode.
 *
 * Weights:
 *   Successful unique call   → −1.5  (progress, drives entropy down)
 *   Successful repeated call → +0.5  (no new information even though it worked)
 *   Failed call              → +2.0  (error costs more)
 *
 * Eject threshold: 10.0  (floor: 0.0)
 *
 * Rationale: ~7 clean unique successes absorb ~3 failures before ejecting.
 * A pure spinner hits 10 in ~20 repeated successful calls.
 */

const WEIGHT_SUCCESS_UNIQUE = -1.5
const WEIGHT_SUCCESS_REPEATED = 0.5
const WEIGHT_FAILURE = 2.0
const EJECT_THRESHOLD = 10.0
const ENTROPY_FLOOR = 0.0

/** Stable string key for a tool call — used for repetition detection. */
function callSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`
}

export class AgentEntropyTracker {
  private score = 0
  /** Set of call signatures seen in this agent run. */
  private seen = new Set<string>()

  get currentScore(): number { return this.score }

  /**
   * Record the outcome of a single tool call.
   * Returns true if the eject threshold has been crossed.
   */
  record(name: string, args: Record<string, unknown>, success: boolean): boolean {
    const sig = callSignature(name, args)

    if (!success) {
      this.score += WEIGHT_FAILURE

    } else if (this.seen.has(sig)) {
      this.score += WEIGHT_SUCCESS_REPEATED

    } else {
      this.seen.add(sig)
      this.score += WEIGHT_SUCCESS_UNIQUE
    }

    this.score = Math.max(ENTROPY_FLOOR, this.score)

    return this.score >= EJECT_THRESHOLD
  }

  reset(): void {
    this.score = 0
    this.seen.clear()
  }
}
