import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
)
const scripts = packageJson.scripts
const loggedDevCommand = readFileSync(
  new URL('../../logged-dev-command.mjs', import.meta.url),
  'utf8'
)

test('all local development and database compatibility entries delegate to a managed runtime entry', () => {
  for (const name of [
    'backend:system',
    'backend:business',
    'backend:prepare:raw',
    'backend:raw',
    'infra:raw',
    'dev:system',
    'dev:business',
    'dev',
    'db:migrate',
    'db:seed',
    'db:rollback',
    'env:bootstrap',
    'local:trusted-runtime:prepare'
  ])
    assert.match(
      scripts[name],
      /(?:runtime:|scripts\/local-runtime\/(?:launcher|ensure-dev-infrastructure|dev-backend-session)\.mjs)/u,
      name
    )
})

test('operator-facing startup entries use the fixed-log wrapper', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['infra', 'backend:prepare', 'backend', 'web'].map((name) => [name, scripts[name]])
    ),
    {
      infra: 'node scripts/local/logged-dev-command.mjs infra',
      'backend:prepare': 'node scripts/local/logged-dev-command.mjs backend-prepare',
      backend: 'node scripts/local/logged-dev-command.mjs backend',
      web: 'node scripts/local/logged-dev-command.mjs web'
    }
  )
})

test('web resolves the gateway endpoint itself instead of a gateway downstream endpoint', () => {
  assert.match(loggedDevCommand, /reopenBackendSession\(runtimeStateRoot\)/u)
  assert.match(loggedDevCommand, /item\.host === 'api-gateway\.localhost'/u)
  assert.doesNotMatch(loggedDevCommand, /item\.owners\?\.includes\('api-gateway'\)/u)
})

test('fixed logs remove terminal control sequences without changing terminal output', () => {
  assert.match(loggedDevCommand, /stripVTControlCharacters/u)
  assert.match(loggedDevCommand, /process\.stdout\.write\(chunk\)/u)
  assert.match(
    loggedDevCommand,
    /log\.write\(stripVTControlCharacters\(chunk\.toString\('utf8'\)\)\)/u
  )
})

test('operator-facing launchers bypass nested pnpm lifecycle wrappers and normalize intentional stops', () => {
  assert.match(loggedDevCommand, /executable: process\.execPath/u)
  assert.match(loggedDevCommand, /app\/web\/node_modules\/\.bin\/vite/u)
  assert.doesNotMatch(loggedDevCommand, /spawn\('pnpm'/u)
  assert.match(loggedDevCommand, /operatorInterrupted[\s\S]*\? 0/u)
  assert.match(loggedDevCommand, /reason=operator-interrupt/u)
})

test('managed root entries contain no direct Prisma push or legacy lifecycle executable', () => {
  for (const [name, command] of Object.entries(scripts))
    assert.doesNotMatch(
      command,
      /prisma(?::|\s+)push|prisma\s+db\s+push|database-lifecycle|worktree-env/u,
      name
    )
})
