/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.core.json',
        diagnostics: { warnOnly: false },
      },
    ],
  },
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/core/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
  },
  collectCoverageFrom: [
    'core/**/*.ts',
    '!core/**/*.d.ts',
    '!core/**/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 90,
      lines: 90,
    },
  },
  verbose: true,
};
