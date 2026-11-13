import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          // Only src/testing imports it so far; the extractor (a later task) will too.
          ignoredDependencies: ['@xapply/answerer'],
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@xapply/fact-bank',
              message: 'libs/disqualify never imports the fact bank.',
            },
          ],
          patterns: [
            {
              group: ['@xapply/fact-bank/*'],
              message: 'libs/disqualify never imports the fact bank.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
