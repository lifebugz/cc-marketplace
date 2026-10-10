import prettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['node_modules/', '.claude-plugin/types/'] },
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      eqeqeq: 'error',
    },
  },
  {
    files: ['hooks/**'],
    rules: { 'no-console': 'error' },
  },
  {
    // Checking each argument of an `on(...)` call against the engine's
    // overload set (one signature per event) takes over 5 minutes per file.
    files: ['hooks/register.tsx', 'tests/**'],
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'script' },
    rules: {
      // osascript calls the script's top-level run(argv) by name.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^run$' },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
)
