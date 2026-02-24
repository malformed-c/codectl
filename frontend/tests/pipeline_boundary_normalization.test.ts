import { describe, expect, test } from 'bun:test'
import { joinPass, joinWithBoundaryNormalization } from '../pipeline'
import type { Span } from '../span'

describe('boundary normalization', () => {
  test('collapses duplicate newline at join boundary only', () => {
    expect(joinWithBoundaryNormalization(['left\n', '\nright'])).toBe('left\nright')
    expect(joinWithBoundaryNormalization(['left\n\n', '\nright'])).toBe('left\n\nright')
    expect(joinWithBoundaryNormalization(['left\n', '\n\nright'])).toBe('left\n\nright')
  })

  test('preserves internal formatting while deduping boundary newlines', () => {
    const lhs = '[TOOL_JSON]\n{\n  "command": "echo hi",\n  "timeout": 10\n}\n'
    const rhs = '\n[NEXT]\nline'

    expect(joinWithBoundaryNormalization([lhs, rhs])).toBe(
      '[TOOL_JSON]\n{\n  "command": "echo hi",\n  "timeout": 10\n}\n[NEXT]\nline'
    )
  })

  test('joinPass applies boundary normalization between rendered spans', () => {
    const spans: Span[] = [
      { kind: 'system', text: '<sys>\n\n' },
      { kind: 'system', text: '\n<available_tools>...</available_tools>' },
    ]

    expect(joinPass(spans)).toBe('<sys>\n\n<available_tools>...</available_tools>')
  })
})
