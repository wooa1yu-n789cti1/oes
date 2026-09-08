import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireExclusiveLease, acquireExclusiveLeaseSync } from '../locks.mjs'

test('exclusive lease acquires through an ownerless directory left by a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-lock-ownerless-'))
  const asyncLock = path.join(root, 'async.lock')
  const syncLock = path.join(root, 'sync.lock')
  fs.mkdirSync(asyncLock)
  fs.mkdirSync(syncLock)
  const asynchronous = await acquireExclusiveLease(asyncLock, { kind: 'FIXTURE' }, { timeoutMs: 100 })
  assert.equal(fs.existsSync(path.join(asyncLock, 'owner.json')), true)
  asynchronous.release()
  const synchronous = acquireExclusiveLeaseSync(syncLock, { kind: 'FIXTURE' }, { timeoutMs: 100 })
  assert.equal(fs.existsSync(path.join(syncLock, 'owner.json')), true)
  synchronous.release()
})

test('releasing one lease does not recursively delete a later owner publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-lock-release-'))
  const lock = path.join(root, 'fixture.lock')
  const acquired = acquireExclusiveLeaseSync(lock, { kind: 'FIXTURE' })
  assert.throws(() => acquireExclusiveLeaseSync(lock, { kind: 'OTHER' }, { timeoutMs: 20 }), /RUNTIME_LOCK_TIMEOUT/)
  acquired.release()
  assert.equal(fs.existsSync(lock), false)
})
