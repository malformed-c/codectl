import consola from 'consola'

export type RetryOptions = {
  /** Maximum number of attempts (default: 4). */
  maxAttempts?: number
  /** Base delay in ms before exponential backoff (default: 1000). */
  baseDelayMs?: number
  /** Label used in log messages (e.g. adapter name). */
  label?: string
}

/** HTTP status codes / Google API status strings that are safe to retry. */
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504])
const RETRYABLE_STATUSES = new Set(['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'ABORTED'])

/**
 * Extract a numeric HTTP code or a Google API status string from an unknown
 * thrown value so we can decide whether to retry.
 */
function classifyError(err: unknown): { code?: number; status?: string; message: string } {
  if (err instanceof Error) {
    // Google GenAI SDK wraps errors as { error: { code, message, status } }
    const inner = (err as any).error ?? (err as any).errorDetails?.[0]

    if (inner?.code !== undefined) {
      return { code: inner.code, status: inner.status, message: inner.message ?? err.message }
    }

    // OpenAI-style: err.status
    if ((err as any).status !== undefined) {
      return { code: (err as any).status, message: err.message }
    }

    return { message: err.message }
  }

  if (typeof err === 'object' && err !== null) {
    const e = err as any

    return {
      code: e.error?.code ?? e.code,
      status: e.error?.status ?? e.status,
      message: e.error?.message ?? e.message ?? JSON.stringify(err),
    }
  }

  return { message: String(err) }
}

function isRetryable(err: unknown): boolean {
  const { code, status } = classifyError(err)

  if (code !== undefined && RETRYABLE_CODES.has(code)) return true

  if (status !== undefined && RETRYABLE_STATUSES.has(status)) return true

  return false
}

async function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

/**
 * Retry `fn` on transient upstream errors using exponential backoff.
 *
 * Non-retryable errors (4xx except 429) are re-thrown immediately.
 * After `maxAttempts` the last error is re-thrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4
  const baseDelayMs = opts.baseDelayMs ?? 1000
  const label = opts.label ?? 'upstream'

  let lastErr: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const { code, status, message } = classifyError(err)

      if (!isRetryable(err)) {
        consola.error(`[retry:${label}] non-retryable error (code=${code ?? '?'} status=${status ?? '?'}): ${message}`)

        throw err
      }

      if (attempt === maxAttempts) {
        consola.error(`[retry:${label}] giving up after ${maxAttempts} attempts (code=${code ?? '?'} status=${status ?? '?'}): ${message}`)
        break
      }

      const backoff = baseDelayMs * Math.pow(2, attempt - 1)
      consola.warn(`[retry:${label}] attempt ${attempt}/${maxAttempts} failed (code=${code ?? '?'} status=${status ?? '?'}): ${message} — retrying in ${backoff}ms`)
      await delay(backoff)
    }
  }

  throw lastErr
}
