import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['node_modules/**', '.phoenix/**'] },
  js.configs.recommended,
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['web/*.js'], languageOptions: { globals: globals.browser } },
];
