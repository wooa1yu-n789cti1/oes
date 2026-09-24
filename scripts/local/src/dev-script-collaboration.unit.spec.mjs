import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('development aliases keep scoped compatibility while full backend uses the prepared session', () => {
  const scripts = JSON.parse(
    fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
  ).scripts
  assert.deepEqual(
    Object.fromEntries(
      [
        'backend:system',
        'backend:business',
        'backend:prepare:raw',
        'backend:prepare',
        'backend:raw',
        'backend',
        'dev:system',
        'dev:business',
        'dev:all',
        'dev'
      ].map((name) => [name, scripts[name]])
    ),
    {
      'backend:system': 'node scripts/local-runtime/launcher.mjs dev --scope system',
      'backend:business': 'node scripts/local-runtime/launcher.mjs dev --scope business',
      'backend:prepare:raw': 'node scripts/local-runtime/dev-backend-session.mjs prepare',
      'backend:prepare': 'node scripts/local/logged-dev-command.mjs backend-prepare',
      'backend:raw': 'node scripts/local-runtime/dev-backend-session.mjs start',
      backend: 'node scripts/local/logged-dev-command.mjs backend',
      'dev:system': 'node scripts/local-runtime/launcher.mjs dev --scope system',
      'dev:business': 'node scripts/local-runtime/launcher.mjs dev --scope business',
      'dev:all': 'node scripts/local-runtime/launcher.mjs dev --scope full',
      dev: 'node scripts/local-runtime/launcher.mjs dev --scope full'
    }
  )
})

test('local startup exposes separate logged infrastructure, preparation, backend, and web commands', () => {
  const scripts = JSON.parse(
    fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
  ).scripts
  assert.deepEqual(
    Object.fromEntries(
      ['infra:raw', 'infra', 'backend:prepare:raw', 'backend:prepare', 'backend', 'web'].map(
        (name) => [name, scripts[name]]
      )
    ),
    {
      'infra:raw': 'node scripts/local-runtime/ensure-dev-infrastructure.mjs',
      infra: 'node scripts/local/logged-dev-command.mjs infra',
      'backend:prepare:raw': 'node scripts/local-runtime/dev-backend-session.mjs prepare',
      'backend:prepare': 'node scripts/local/logged-dev-command.mjs backend-prepare',
      backend: 'node scripts/local/logged-dev-command.mjs backend',
      web: 'node scripts/local/logged-dev-command.mjs web'
    }
  )
})
