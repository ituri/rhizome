'use strict';
const globals = require('globals');
const sharedClientGlobals = require('./eslint.globals.cjs');

// Correctness-focused rules only — this is a bug net, not a style police.
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-fallthrough': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'tests/node_modules/**', 'data/**', 'public/sw.js'] },

  // Node side: the server, the benchmarks (CommonJS, Node globals)
  {
    files: ['server.js', 'db.js', 'ops.js', 'opsdoc.js', 'bench/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, structuredClone: 'readonly' } },
    rules,
  },

  // Browser client: one shared global scope, no modules
  {
    files: ['public/app.js', 'public/app2.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...sharedClientGlobals } },
    rules,
  },

  // e2e tests: Node + puppeteer, with page.evaluate() callbacks that run client code
  {
    files: ['tests/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser, ...sharedClientGlobals, structuredClone: 'readonly' } },
    rules: { ...rules, 'no-unused-vars': 'off', 'no-undef': 'off' },
  },
];
