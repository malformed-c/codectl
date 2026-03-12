import { consola } from 'consola'

/**
 * Transient HTTP status codes that warrant an automatic retry.
 * 429  — rate limited
 * 500  — internal server error (sometimes transient)
 * 502  — bad gateway
 * 503  — service unavailable / overloaded
 * 504  — gateway timeout
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export type UpstreamError = {
  /** HTTP status code if available */
  status?: number
  /** Human-readable message from the provider */
  message: string
  /** Raw error object */
  raw: unknown
}

/**
 * Extract a structured UpstreamError from anything thrown by an LLM adapter.
 *
 * Handles:
 *   - OpenAIError (has .status and .message)
 *   - Gemini SDK errors  (body shape: { error: { code, message, status } })
 *   - Plain Error objects
 *   - Thrown strings / unknown shapes
 */
export function parseUpstreamError(err: unknown): UpstreamError {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>

    // OpenAIError or any error with numeric .status
    if (typeof obj['status'] === 'number') {
      return {
        status: obj['status'] as number,
        message: String(obj['message'] ?? err),
        raw: err,
      }
    }

    // Gemini SDK may throw an object with a nested .error.code (already parsed)
    if (obj['error'] && typeof obj['error'] === 'object') {
      const inner = obj['error'] as Record<string, unknown>

      if (typeof inner['code'] === 'number') {
        return {
          status: inner['code'],
          message: String(inner['message'] ?? err),
          raw: err,
        }
      }
    }

    // Gemini SDK wraps the API body: err.message may be a JSON string like
    // '{"error":{"code":503,"message":"...","status":"UNAVAILABLE"}}'
    // or the SDK may have already parsed it into err.errorDetails / err.status.
    if (typeof obj['message'] === 'string') {
      const msg = obj['message'] as string

      try {
        const parsed = JSON.parse(msg) as { error?: { code?: number; message?: string } }

        if (parsed?.error?.code) {
          return {
            status: parsed.error.code,
            message: parsed.error.message ?? msg,
            raw: err,
          }
        }

      } catch { /* not JSON */ }

      // Try to parse the raw JSON that appears in the log output directly
      // e.g. the whole err was JSON-serialised: {"error":{"code":503,...}}
      try {
        const strErr = JSON.stringify(err)
        const parsed = JSON.parse(strErr) as { error?: { code?: number; message?: string } }

        if (parsed?.error?.code) {
          return {
            status: parsed.error.code,
            message: parsed.error.message ?? msg,
            raw: err,
          }
        }

      } catch { /* ignore */ }

      return { message: msg, raw: err }
    }
  }

  if (typeof err === 'string') {
    return { message: err, raw: err }
  }

  return { message: String(err), raw: err }
}

export function isTransientError(err: unknown): boolean {
  const { status } = parseUpstreamError(err)

  return status != null && RETRYABLE_STATUS.has(status)
}

export type RetryOptions = {
  /** Maximum number of attempts (default: 4) */
  maxAttempts?: number
  /** Initial delay in ms before first retry (default: 2000) */
  initialDelay?: number
  /** Backoff multiplier (default: 2) */
  backoff?: number
  /** Max delay cap in ms (default: 30_000) */
  maxDelay?: number
  /** Label shown in log messages */
  label?: string
}

/**
 * Call `fn` and retry on transient upstream errors with exponential backoff.
 * Non-transient errors are rethrown immediately without retrying.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts  = 4,
    initialDelay = 2000,
    backoff      = 2,
    maxDelay     = 30_000,
    label        = 'upstream call',
  } = opts

  let delay = initialDelay

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()

    } catch (err) {
      const parsed = parseUpstreamError(err)

      if (!isTransientError(err) || attempt === maxAttempts) {
        // Non-transient or exhausted — rethrow
        throw err
      }

      consola.warn(
        `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}) ` +
        `with status=${parsed.status ?? '?'}: ${parsed.message}. ` +
        `Retrying in ${delay}ms…`
      )

      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * backoff, maxDelay)
    }
  }

  // Unreachable but satisfies TypeScript
  throw new Error(`${label}: max retries exceeded`)
}
