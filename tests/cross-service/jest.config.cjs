/** Executes TypeScript Journey specifications against production modules from the repository root. */
module.exports = {
  rootDir: '../..',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  setupFiles: ['reflect-metadata'],
  testMatch: ['<rootDir>/tests/cross-service/**/*.journey.spec.ts'],
  // Keep repository-local scratch and ignored reference projects out of Jest's Haste map.
  modulePathIgnorePatterns: ['<rootDir>/(?:\\.tmp[^/]*|app/demo)(?:/|$)'],
  testTimeout: 300_000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tests/cross-service/tsconfig.json',
        diagnostics: false
      }
    ]
  }
}
