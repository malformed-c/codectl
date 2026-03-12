/**
 * ESLint rule: enforce a blank line before `else`, `catch`, and `finally`.
 *
 * Desired style:
 *
 *   try {
 *     doSomething()
 *
 *   } catch (e) {       ← blank line before closing brace of try block
 *     handleError(e)
 *
 *   } finally {         ← blank line before closing brace of catch block
 *     cleanup()
 *   }
 *
 *   if (cond) {
 *     doThing()
 *
 *   } else {            ← blank line before closing brace of if block
 *     doOther()
 *   }
 */
export default {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
  },
  create(context: any) {
    const source = context.sourceCode

    /**
     * Ensure there is exactly one blank line between the last token of
     * `block` and the closing brace of `block`.
     */
    function ensureBlankLineBeforeClose(block: any): void {
      if (!block || block.body.length === 0) return

      const lastStmt   = block.body[block.body.length - 1]
      const lastToken  = source.getLastToken(lastStmt)
      const closeBrace = source.getLastToken(block) // '}'

      if (!lastToken || !closeBrace) return

      if (lastToken === closeBrace) return

      const blankLines = closeBrace.loc.start.line - lastToken.loc.end.line - 1

      if (blankLines >= 1) return // already has a blank line — good

      context.report({
        node: closeBrace,
        message: 'Expected a blank line before closing brace (before else/catch/finally)',
        fix(fixer: any) {
          // Insert a blank line between the end of the last statement and '}'
          return fixer.replaceTextRange(
            [lastToken.range[1], closeBrace.range[0]],
            '\n\n' + ' '.repeat(closeBrace.loc.start.column),
          )
        },
      })
    }

    return {
      // if (...) { ... } else
      IfStatement(node: any) {
        if (!node.alternate) return

        if (node.consequent.type !== 'BlockStatement') return
        ensureBlankLineBeforeClose(node.consequent)
      },

      // try { ... } catch / finally
      TryStatement(node: any) {
        if (node.handler || node.finalizer) {
          ensureBlankLineBeforeClose(node.block)
        }

        if (node.handler && node.finalizer) {
          ensureBlankLineBeforeClose(node.handler.body)
        }
      },
    }
  },
}
