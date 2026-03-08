import destr from 'destr'

/**
 * Parse a raw plan value (string or object) into a plain object,
 * then recursively unwrap common LLM nesting mistakes.
 *
 * Handles:
 *   - JSON string → parsed object
 *   - { value: <plan> }  → unwrap .value
 *   - { plan:  <plan> }  → unwrap .plan
 *   - Array              → { codePlan: array }
 *   - Already correct { codePlan: [...] } → as-is
 *
 * Unwrapping is recursive so double-wrapping (e.g. { value: '{"value":{...}}' })
 * is also handled. Inner strings are parsed as JSON before unwrapping.
 *
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function parsePlan(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  // 1. Parse strings
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = destr(raw)
      if (typeof parsed === 'string') {
        return { ok: false, error: `Invalid JSON: could not parse plan string` }
      }
    }
  }

  // 2. Recursive unwrap
  return { ok: true, value: unwrap(parsed) }
}

function maybeParseString(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

function unwrap(v: unknown): unknown {
  if (Array.isArray(v)) return { codePlan: v }
  if (!v || typeof v !== 'object') return v

  const o = v as Record<string, unknown>
  if (o.codePlan) return v
  if ('plan'  in o) return unwrap(maybeParseString(o.plan))
  if ('value' in o) return unwrap(maybeParseString(o.value))
  return v
}
