// eslint-rules/newlines-inside-blocks.js
export default {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: []
  },
  create(context) {
    const source = context.sourceCode

    function ensureBlankLineInsideBlock(blockNode) {
      if (!blockNode || !blockNode.body || blockNode.body.length === 0) return
      const lastStatement = blockNode.body[blockNode.body.length - 1]
      const lastToken = source.getLastToken(lastStatement)
      const closingBrace = source.getLastToken(blockNode) // should be '}'

      if (!lastToken || !closingBrace) return

      const linesBetween = closingBrace.loc.start.line - lastToken.loc.end.line - 1

      if (linesBetween === 1) return // already exactly one blank line

      context.report({
        node: closingBrace,
        message: 'Expected one blank line before closing brace',
        fix(fixer) {
          return fixer.replaceTextRange([lastToken.range[1], closingBrace.range[0]], '\n')
        }
      })
    }

    return {
      BlockStatement(node) {
        ensureBlankLineInsideBlock(node)
      },
      CatchClause(node) {
        ensureBlankLineInsideBlock(node.body)
      }
    }
  }
}
