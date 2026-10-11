import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import jsdoc from 'eslint-plugin-jsdoc'
import tseslint from 'typescript-eslint'

// Types the engine hands a mod: mods cannot make them readonly.
const engineTypes = [
  'EngineInterface',
  'Engine',
  'ModelCompleteResult',
  'ProcessRunResult',
]
const engineTestTypes = ['MockClock']

export default defineConfig(
  {
    ignores: ['.claude/', '.claude-types/', 'plugins/*/.claude-plugin/types/'],
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowString: false, allowNumber: false, allowNullableObject: false },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          requireDefaultForNonUnion: true,
          considerDefaultExhaustiveForUnions: false,
        },
      ],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-readonly-parameter-types': [
        'error',
        {
          treatMethodsAsReadonly: true,
          ignoreInferredTypes: true,
          allow: [
            { from: 'package', package: 'claude-code', name: engineTypes },
            {
              from: 'package',
              package: 'claude-code/testing',
              name: engineTestTypes,
            },
          ],
        },
      ],
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/strict-void-return': 'error',
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/parameter-properties': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-check': true,
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `:matches(TSTypeAliasDeclaration, TSInterfaceDeclaration, ClassDeclaration, TSEnumDeclaration)[id.name=/^(${[...engineTypes, ...engineTestTypes].join('|')})$/]:not(TSModuleDeclaration[id.value=/^claude-code(\\/testing)?$/] *)`,
          message:
            'prefer-readonly-parameter-types allows this name as an engine type, whatever declares it. Rename the type.',
        },
      ],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      'default-param-last': 'off',
      '@typescript-eslint/default-param-last': 'error',
      'no-loop-func': 'off',
      '@typescript-eslint/no-loop-func': 'error',
      'class-methods-use-this': 'off',
      '@typescript-eslint/class-methods-use-this': 'error',
      'consistent-return': 'off',
      '@typescript-eslint/consistent-return': 'error',
      eqeqeq: 'error',
      'no-console': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'no-implicit-coercion': 'error',
      'no-param-reassign': 'error',
      'no-nested-ternary': 'error',
      'no-else-return': 'error',
      'no-useless-return': 'error',
      'no-lonely-if': 'error',
      radix: 'error',
    },
  },
  {
    files: ['plugins/*/scripts/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        Application: 'readonly',
        delay: 'readonly',
        $: 'readonly',
        ObjC: 'readonly',
      },
    },
    plugins: { jsdoc },
    rules: {
      // A .js file cannot carry a `: Type` annotation; checkJs reads JSDoc instead.
      '@typescript-eslint/explicit-function-return-type': 'off',
      'jsdoc/require-jsdoc': [
        'error',
        {
          require: {
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true,
          },
          contexts: ['VariableDeclarator > ArrowFunctionExpression'],
        },
      ],
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-name': 'error',
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-returns': ['error', { forceRequireReturn: true }],
      'jsdoc/require-returns-type': 'error',
      'jsdoc/require-returns-check': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/valid-types': 'error',
      'jsdoc/no-defaults': 'error',
      'jsdoc/empty-tags': 'error',
      'jsdoc/reject-any-type': 'error',
      'jsdoc/reject-function-type': 'error',
    },
  },
  prettier,
  // eslint-config-prettier turns curly off; 'all' cannot conflict with Prettier.
  { rules: { curly: ['error', 'all'] } },
)
