const path = require('path');

/**
 * Standalone Jest config for the TDA-003 tenant-isolation / RBAC tests.
 *
 * Mirrors test/tda002/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda003 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   npx jest --config test/tda003/jest.config.js -v
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda003'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
