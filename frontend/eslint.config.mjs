import tsParser from '@typescript-eslint/parser'
import stylistic from '@stylistic/eslint-plugin'
import newlines from './eslint-rules/newlines.ts'

export default [
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@stylistic': stylistic,
      local: { rules: { 'newlines': newlines } }
    },
    rules: {
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      'local/newlines': 'error',
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['return', 'throw', 'export'] },
        { blankLine: 'always', prev: ['interface', 'type'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['if', 'switch', 'for', 'while', 'try'] },
        { blankLine: 'always', prev: 'block', next: '*' },
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
      ],
    },
  },
]
