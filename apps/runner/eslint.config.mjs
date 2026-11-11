import baseConfig from '../../eslint.config.mjs';

const files = ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'];

const noPageScripts = {
  selector:
    'MemberExpression[property.name=/^(evaluate|evaluateHandle|\\$eval|\\$\\$eval|evaluateAll|exposeFunction|exposeBinding|addInitScript)$/]',
  message: "no scripts in LinkedIn's page (spec 2026-11-11): use locators",
};

const inputMessage =
  'only the pace module (src/pace) moves the mouse, clicks, scrolls or types (spec 2026-11-11)';

export default [
  ...baseConfig,
  {
    files,
    rules: { 'no-restricted-syntax': ['error', noPageScripts] },
  },
  // A later no-restricted-syntax replaces the earlier one for the same files,
  // so this block repeats the page-script ban next to the input ban. Calls on
  // the pace object itself (`pace.click`, `pace.type`) are the allowed route.
  {
    files,
    ignores: ['src/pace/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noPageScripts,
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name=/^(click|dblclick|fill|type|press|pressSequentially|check|uncheck|selectOption|setInputFiles|hover|tap|dragTo)$/]:not([object.name='pace'])",
          message: inputMessage,
        },
        {
          selector: 'MemberExpression[property.name=/^(mouse|keyboard)$/]',
          message: inputMessage,
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^(mouse|keyboard)$/]',
          message: inputMessage,
        },
        {
          selector: 'ObjectPattern > Property[key.name=/^(mouse|keyboard)$/]',
          message: inputMessage,
        },
      ],
    },
  },
];
