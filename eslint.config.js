// Flat ESLint config. The package-boundary rules here are load-bearing security
// controls, not style preferences — see ARCHITECTURE.md section 2 and
// SECURITY.md threat T3. They make "credentials cannot reach the browser" a
// property the build enforces rather than a convention people remember.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const CREDENTIAL_BEARING = [
  '@smm/database',
  '@smm/database/*',
  '@smm/storage',
  '@smm/storage/*',
  '@smm/publishing',
  '@smm/publishing/*',
  '@smm/ratelimit',
  '@smm/ratelimit/*',
]

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '.remember/**', // tooling scratch space, not project source
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // TypeScript resolves identifiers itself, and no-undef does not understand
    // TS-only globals or type positions — it produces false positives on
    // perfectly valid code. Disabling it for .ts/.tsx is the standard guidance
    // from typescript-eslint, not a loosening.
    files: ['**/*.{ts,tsx}'],
    rules: { 'no-undef': 'off' },
  },

  {
    // Leading-underscore names are deliberate discards — the destructure-to-omit
    // idiom (`const { secret: _omit, ...rest } = env`) is the clearest way to
    // build a fixture that is missing exactly one key.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Node scripts and config files run outside any bundler.
    files: ['scripts/**/*.{js,mjs}', '**/scripts/**/*.{js,mjs}', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },

  // --- apps/web: no credential-bearing package may be imported ---------------
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: CREDENTIAL_BEARING.filter((p) => !p.endsWith('/*')).map((name) => ({
            name,
            message:
              'apps/web must not import credential-bearing packages. Call the API instead ' +
              '(apps/web/lib/server-fetch.ts). See ARCHITECTURE.md section 2.',
          })),
          patterns: [
            {
              // The capabilities subpath is deliberately dependency-free and
              // browser-safe: it carries capability, media and text profiles so
              // the composer validates with the same code the server runs.
              // A regex, not a glob: extglob negation (`!(capabilities)**`) lets
              // `**` absorb the negated segment, and gitignore-style `!` entries
              // in `group` did not override here either. Both silently blocked
              // the one path this rule exists to permit.
              regex: '^@smm/providers(?!/capabilities(/|$))',
              message:
                'apps/web may only import @smm/providers/capabilities. The adapter modules ' +
                'load provider credentials and must never be bundled for the browser.',
            },
          ],
        },
      ],
    },
  },

  // --- apps/web: server components must forward cookies ---------------------
  {
    // Client components are EXCLUDED by the `.client.tsx` suffix. In the browser
    // a bare fetch is correct — cookies ride along automatically for same-origin
    // requests, which is the whole point of the single-origin proxy. The rule
    // targets server components, where there is no ambient cookie jar.
    //
    // The suffix exists because ESLint matches on paths, not on the 'use client'
    // directive, so the boundary has to be visible in the filename for the rule
    // to respect it.
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: ['apps/web/app/**/*.client.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // React Server Components have no ambient cookie jar, so a bare fetch
          // sends no credentials and the API sees an anonymous request. The
          // symptom is "works in the browser, logged out on refresh" — invisible
          // in review, obvious only at runtime. Hence a lint rule rather than a
          // convention.
          selector: "CallExpression[callee.name='fetch']",
          message:
            'Use serverFetch/apiGet from @/lib/server-fetch instead of bare fetch. A bare ' +
            'fetch from a server component forwards no cookies, so the request is anonymous.',
        },
      ],
    },
  },

  // --- leaves import nothing internal ---------------------------------------
  {
    files: ['packages/config/**/*.ts', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@smm/*'],
              message:
                'config and ui are leaf packages. Importing another workspace package here ' +
                'creates a cycle through almost everything.',
            },
          ],
        },
      ],
    },
  },

  // --- ratelimit is consulted by three subsystems, so it depends on none -----
  {
    files: ['packages/ratelimit/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@smm/*', '!@smm/config'],
              message:
                '@smm/ratelimit is consulted by publishing, analytics and the inbox. It must ' +
                'not depend on any of them. Only @smm/config is permitted.',
            },
          ],
        },
      ],
    },
  },

  // --- providers must not reach back into the pipeline -----------------------
  {
    files: ['packages/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@smm/publishing',
              message:
                'Adapters are leaves of the publishing pipeline. If an adapter needs pipeline ' +
                'behaviour, the abstraction has leaked — fix the interface instead.',
            },
            {
              name: '@smm/database',
              message:
                'Adapters must be persistence-free so they can be tested against fixtures. ' +
                'The caller supplies account and credential data.',
            },
          ],
        },
      ],
    },
  },

  // --- the browser-importable subpath must stay dependency-free -------------
  {
    files: ['packages/providers/src/capabilities/**/*.ts'],
    ignores: ['packages/providers/src/capabilities/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Bans BARE specifiers only — external packages and workspace
              // packages. Relative imports within the subpath are how it is
              // organised, and a rule that forbade them would force the whole
              // thing into one file to satisfy the linter rather than the intent.
              regex: '^[^.]',
              message:
                'This subpath is imported by the browser. It must have zero external ' +
                'dependencies so the composer validates with the same code the server runs. ' +
                'Relative imports within capabilities/ are fine.',
            },
          ],
        },
      ],
    },
  },
]
