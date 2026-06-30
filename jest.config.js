/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  roots: ['<rootDir>/test'],
  testRegex: '\\.(spec|test)\\.ts$',
  transform: {
    '^.+\\.ts$': '@swc/jest',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
