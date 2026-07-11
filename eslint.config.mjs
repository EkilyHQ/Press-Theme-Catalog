import eslint from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module'
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error'
    }
  }
];
