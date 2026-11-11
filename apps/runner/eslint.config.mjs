import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(evaluate|evaluateHandle|\\$eval|\\$\\$eval|evaluateAll|exposeFunction|exposeBinding|addInitScript)$/]',
          message:
            "no scripts in LinkedIn's page (spec 2026-11-11): use locators",
        },
      ],
    },
  },
];
