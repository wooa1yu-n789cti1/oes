import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readJson, writeAtomic } from './canonical.mjs'

/** Waits without retaining process-global state. */
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

/** Acquires an exact filesystem lease and returns its sealed identity plus idempotent release. */
export async function acquireExclusiveLease(lockDirectory, identity = {}, { timeoutMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true, mode: 0o700 })
  const started = Date.now()
  const owner = { leaseId: crypto.randomUUID(), pid: process.pid, ...identity, createdAt: new Date().toISOString() }
  for (;;) {
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 })
      writeAtomic(path.join(lockDirectory, 'owner.json'), owner)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const ownerPath = path.join(lockDirectory, 'owner.json')
      if (fs.existsSync(ownerPath)) {
        const owner = readJson(ownerPath)
        try { process.kill(owner.pid, 0) } catch { fs.rmSync(lockDirectory, { recursive: true, force: true }); continue }
      }
      if (Date.now() - started > timeoutMs) throw new Error(`RUNTIME_LOCK_TIMEOUT path=${lockDirectory}`)
      await sleep(25)
    }
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
  fs.rmSync(lease.lockDirectory, { recursive: true })
  return true
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
