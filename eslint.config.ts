import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default [
  { ignores: ['node_modules/**', '.phoenix/**', 'web/*.js'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.js', '**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['web/*.ts'], languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, texmath: 'readonly' } } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }], '@typescript-eslint/no-empty-object-type': 'off' } },
];
