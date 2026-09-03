// S17 — typed linting per the TS standards cache: strict-type-checked is a
// SUPERSET of recommended(+TypeChecked)+strict; stylistic adds zero
// formatting rules. Tests may use `!` freely (the cache's documented
// team-practice); in src every `!` carries a comment instead.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // plain-JS build/dev scripts, the built single-file planners, and the
      // planner v2 sources (tools/planner-v2/**: browser IIFEs, no TS project)
      'tools/**',
      // bin/sfpw.mjs: the ESM launcher that registers tsx. Plain JS outside
      // the TS project, like tools/** — everything it runs (src/cli/**) IS
      // linted.
      'bin/**',
      'L2/**',
      'recordings/**',
      'src/journeys/generated/**', // pipeline output — regenerate, never lint
      '**/*.mjs',
      '**/*.js',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Cast-style guards intentionally check "impossible" states (defence in
      // depth around indexed access); for(;;) is the logout-to-comply loop.
      '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: true }],
      // Log/error text interpolates numbers and booleans by design.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // House rule instead (per the standards cache): every `!` in src MUST
      // carry a comment naming the invariant that makes it safe. The rule
      // can't read comments, so the discipline lives in review, not lint.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Underscore = declared-unused (matches the tsconfig discipline).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Validators defend against MALFORMED runtime JSON (user graphs,
    // personas.json). Their parameter types under-state that, so checks the
    // rule calls "unnecessary" are exactly the job. Scope: validators only —
    // upgrade.ts is one: it referees v1 documents off the disk.
    files: ['src/graph/schema.ts', 'src/graph/upgrade.ts', 'src/personas/schema.ts', 'src/journeys/schema.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    // Tests exercise untyped boundaries on purpose: window globals in the
    // planner harness, fixture JSON via require, empty step stubs, async
    // catalog contract fns, defensive optional chains on unknown shapes.
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'no-console': 'off',
    },
  },
);
