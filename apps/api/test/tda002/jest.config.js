const path = require('path');

/**
 * Standalone Jest config for the TDA-002 integration tests.
 *
 * The default apps/api Jest config has rootDir: "src", so it never discovers
 * specs under test/. This config roots discovery at test/tda002 while using
 * apps/api as rootDir so ts-jest picks up apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *   JWT_SECRET=<secret> \
 *     npx jest --config test/tda002/jest.config.js -v
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda002'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  testEnvironment: 'node',
};
