import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readJson, writeAtomic } from './canonical.mjs'

/** Waits without retaining process-global state. */
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

/** Publishes a complete owner file atomically so an empty lock directory is never authoritative. */
function tryPublishExclusiveOwner(lockDirectory, owner) {
  try { fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 }) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  const ownerPath = path.join(lockDirectory, 'owner.json')
  const candidate = path.join(path.dirname(lockDirectory), `.${path.basename(lockDirectory)}.owner-${owner.leaseId}.json`)
  writeAtomic(candidate, owner)
  try {
    fs.linkSync(candidate, ownerPath)
    return true
  } catch (error) {
    if (['EEXIST', 'ENOENT', 'EINVAL'].includes(error.code)) return false
    throw error
  } finally { fs.rmSync(candidate, { force: true }) }
}

/** Removes only a complete owner whose recorded process is no longer live. */
function reconcileDeadExclusiveOwner(lockDirectory) {
  const ownerPath = path.join(lockDirectory, 'owner.json')
  if (!fs.existsSync(ownerPath)) return
  try {
    const observed = readJson(ownerPath)
    process.kill(observed.pid, 0)
  } catch (error) {
    if (error.code !== 'ESRCH') return
    fs.rmSync(ownerPath, { force: true })
    try { fs.rmdirSync(lockDirectory) } catch (removeError) { if (!['ENOENT', 'ENOTEMPTY'].includes(removeError.code)) throw removeError }
  }
}

/** Acquires an exact filesystem lease and returns its sealed identity plus idempotent release. */
export async function acquireExclusiveLease(lockDirectory, identity = {}, { timeoutMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true, mode: 0o700 })
  const started = Date.now()
  const owner = { leaseId: crypto.randomUUID(), pid: process.pid, ...identity, createdAt: new Date().toISOString() }
  for (;;) {
    if (tryPublishExclusiveOwner(lockDirectory, owner)) break
    reconcileDeadExclusiveOwner(lockDirectory)
    if (Date.now() - started > timeoutMs) throw new Error(`RUNTIME_LOCK_TIMEOUT path=${lockDirectory}`)
    await sleep(25)
  }
  const lease = { lockDirectory, owner }
  let released = false
  return {
    lease,
    release: () => {
      if (released) return
      releaseExclusiveLease(lease)
      released = true
    }
  }
}

/** Releases only the exact reopened exclusive lease owner. */
export function releaseExclusiveLease(lease) {
  const ownerPath = path.join(lease.lockDirectory, 'owner.json')
  if (!fs.existsSync(ownerPath)) return false
  const observed = readJson(ownerPath)
  if (observed.leaseId !== lease.owner.leaseId || observed.pid !== lease.owner.pid) throw new Error(`RUNTIME_LOCK_OWNER_MISMATCH path=${lease.lockDirectory}`)
  fs.rmSync(ownerPath)
  try { fs.rmdirSync(lease.lockDirectory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
  return true
}

/** Acquires an exact filesystem lease synchronously without deleting a live owner-publication gap. */
export function acquireExclusiveLeaseSync(lockDirectory, identity = {}, { timeoutMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true, mode: 0o700 })
  const started = Date.now()
  const owner = { leaseId: crypto.randomUUID(), pid: process.pid, ...identity, createdAt: new Date().toISOString() }
  for (;;) {
    if (tryPublishExclusiveOwner(lockDirectory, owner)) break
    reconcileDeadExclusiveOwner(lockDirectory)
    if (Date.now() - started > timeoutMs) throw new Error(`RUNTIME_LOCK_TIMEOUT path=${lockDirectory}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  const lease = { lockDirectory, owner }
  let released = false
  return {
    lease,
    release: () => {
      if (released) return
      releaseExclusiveLease(lease)
      released = true
    }
  }
}

/** Runs one callback under an exact filesystem lock with stale-owner reconciliation. */
export async function withExclusiveLock(lockDirectory, callback, options = {}) {
  const acquired = await acquireExclusiveLease(lockDirectory, {}, options)
  try { return await callback() } finally { acquired.release() }
}

/** Acquires one cross-process FIFO slot and returns an idempotent release callback. */
export async function acquireFifoSlot(stateRoot, limit, identity, { timeoutMs = 300000 } = {}) {
  const queue = path.join(stateRoot, 'semaphores', 'queue')
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 })
  const ticket = `${Date.now().toString().padStart(16, '0')}-${crypto.randomUUID()}.json`
  const ticketPath = path.join(queue, ticket)
  writeAtomic(ticketPath, { ...identity, pid: process.pid, createdAt: new Date().toISOString() })
  const started = Date.now()
  for (;;) {
    for (const entry of fs.readdirSync(queue).filter((name) => name.endsWith('.json')).sort()) {
      const current = path.join(queue, entry)
      try {
        const value = readJson(current)
        if (value.pid !== process.pid) {
          try { process.kill(value.pid, 0) } catch {
            const durable = value.runDirectory && (fs.existsSync(path.join(value.runDirectory, 'manifest.json')) || fs.existsSync(path.join(value.runDirectory, 'transaction.json')))
            if (!durable) fs.rmSync(current, { force: true })
          }
        }
      } catch { fs.rmSync(current, { force: true }) }
    }
    const ordered = fs.readdirSync(queue).filter((name) => name.endsWith('.json')).sort()
    if (ordered.indexOf(ticket) < limit) {
      let released = false
      return () => { if (!released) { released = true; fs.rmSync(ticketPath, { force: true }) } }
    }
    if (Date.now() - started > timeoutMs) { fs.rmSync(ticketPath, { force: true }); throw new Error(`RUNTIME_SEMAPHORE_TIMEOUT taskKey=${identity.taskKey}`) }
    await sleep(50)
  }
}

/** Releases every exact FIFO ticket for one task/run identity. */
export function releaseFifoIdentity(stateRoot, taskKey, runId) {
  const queue = path.join(stateRoot, 'semaphores', 'queue')
  if (!fs.existsSync(queue)) return 0
  let removed = 0
  for (const entry of fs.readdirSync(queue).filter((name) => name.endsWith('.json'))) {
    const file = path.join(queue, entry)
    try { const value = readJson(file); if (value.taskKey === taskKey && value.runId === runId) { fs.rmSync(file, { force: true }); removed += 1 } } catch {}
  }
  return removed
}
