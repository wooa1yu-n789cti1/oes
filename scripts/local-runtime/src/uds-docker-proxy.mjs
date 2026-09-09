#!/usr/bin/env node
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_MESSAGE_BYTES = 1024 * 1024
const RESPONSE_TIMEOUT_MS = 10_000

/** Reads one path entry without following symbolic links and distinguishes absence from identity drift. */
function lstatIfPresent(target) {
  try { return fs.lstatSync(target) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Compares the stable filesystem identity of two observed path entries. */
function samePathIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

/** Starts one persistent exact-container bridge and serializes local JSON-RPC clients across it. */
export function startUdsDockerProxy(environment = process.env, dependencies = {}) {
  const socketPath = environment.OES_PROXY_SOCKET_PATH?.trim()
  const container = environment.OES_PROXY_CONTAINER_NAME?.trim()
  if (!socketPath?.startsWith('/') || !/^oes-v2-[a-z0-9-]+-execution-signer$/u.test(container || '')) throw new Error('UDS_DOCKER_PROXY_CONFIGURATION_INVALID')
  const socketParent = lstatIfPresent(path.dirname(socketPath))
  const expectedUid = process.getuid?.()
  if (!socketParent?.isDirectory() || socketParent.isSymbolicLink() || (expectedUid !== undefined && socketParent.uid !== expectedUid) || (socketParent.mode & 0o777) !== 0o700) throw new Error('UDS_DOCKER_PROXY_SOCKET_PARENT_INVALID')
  if (lstatIfPresent(socketPath)) throw new Error('UDS_DOCKER_PROXY_SOCKET_EXISTS')
  const spawnBridge = dependencies.spawnBridge || spawn
  const exit = dependencies.exit || ((status) => process.exit(status))
  const logFailure = dependencies.logFailure || ((code) => process.stderr.write(`${code}\n`))
  const clients = new Set()
  const queue = []
  let active = null
  let bridgeOutput = ''
  let stopping = false
  let terminated = false
  let bridge
  let socketIdentity = null

  const stop = () => terminate(0)
  const finish = (status) => {
    if (terminated) return
    terminated = true
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    exit(status)
  }
  const preserveForeignSocketAndClose = (observed) => {
    let preservedPath
    try {
      for (let suffix = 0; suffix < 100; suffix += 1) {
        const candidate = `${socketPath}.foreign-preserved-${process.pid}-${suffix}`
        if (!lstatIfPresent(candidate)) { preservedPath = candidate; break }
      }
      if (!preservedPath) throw new Error('UDS_DOCKER_PROXY_PRESERVE_PATH_EXHAUSTED')
      fs.renameSync(socketPath, preservedPath)
      if (!samePathIdentity(lstatIfPresent(preservedPath), observed)) throw new Error('UDS_DOCKER_PROXY_PRESERVED_IDENTITY_MISMATCH')
    } catch {
      logFailure('UDS_DOCKER_PROXY_SOCKET_PRESERVATION_FAILED')
      server.unref()
      finish(1)
      return
    }
    server.close((closeError) => {
      let restoreFailed = Boolean(closeError)
      try {
        const preserved = lstatIfPresent(preservedPath)
        if (!preserved || !samePathIdentity(preserved, observed) || lstatIfPresent(socketPath)) restoreFailed = true
        else fs.renameSync(preservedPath, socketPath)
      } catch { restoreFailed = true }
      if (restoreFailed) logFailure('UDS_DOCKER_PROXY_SOCKET_RESTORE_FAILED')
      finish(1)
    })
  }
  const closeListener = (status) => {
    if (!server.listening) return finish(status)
    let observed
    try { observed = lstatIfPresent(socketPath) } catch {
      logFailure('UDS_DOCKER_PROXY_SOCKET_INSPECTION_FAILED')
      server.unref()
      return finish(1)
    }
    if (observed && socketIdentity && observed.isSocket() && samePathIdentity(observed, socketIdentity)) {
      server.close((error) => finish(error ? 1 : status))
      return
    }
    if (observed) {
      logFailure('UDS_DOCKER_PROXY_SOCKET_IDENTITY_MISMATCH')
      preserveForeignSocketAndClose(observed)
      return
    }
    server.close((error) => finish(error ? 1 : status))
  }
  const terminate = (status, failureCode = null) => {
    if (stopping) return
    stopping = true
    if (failureCode) logFailure(failureCode)
    for (const client of clients) client.destroy()
    if (active?.timer) clearTimeout(active.timer)
    if (bridge?.exitCode === null) bridge.kill('SIGTERM')
    closeListener(status)
  }
  const pump = () => {
    if (stopping || active || !queue.length) return
    active = queue.shift()
    active.timer = setTimeout(() => terminate(1, 'UDS_DOCKER_PROXY_RESPONSE_TIMEOUT'), RESPONSE_TIMEOUT_MS)
    bridge.stdin.write(`${active.line}\n`)
  }
  const server = net.createServer((client) => {
    clients.add(client)
    let input = ''
    let accepted = false
    client.setTimeout(RESPONSE_TIMEOUT_MS, () => client.destroy())
    client.on('data', (chunk) => {
      if (accepted) return
      input += chunk.toString('utf8')
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) return client.destroy()
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const line = input.slice(0, newline)
      if (!line || input.slice(newline + 1).trim()) return client.destroy()
      accepted = true
      client.pause()
      queue.push({ client, line, timer: null })
      pump()
    })
    client.once('close', () => {
      clients.delete(client)
      const index = queue.findIndex((item) => item.client === client)
      if (index !== -1) queue.splice(index, 1)
    })
    client.once('error', () => client.destroy())
  })
  server.once('error', () => terminate(1, 'UDS_DOCKER_PROXY_LISTENER_FAILED'))

  bridge = spawnBridge('docker', ['exec', '-i', container, 'socat', 'STDIO', 'UNIX-CONNECT:/execution-signer/container.sock'], { stdio: ['pipe', 'pipe', 'ignore'] })
  bridge.stdin.once('error', () => terminate(1, 'UDS_DOCKER_PROXY_BRIDGE_FAILED'))
  bridge.stdout.once('error', () => terminate(1, 'UDS_DOCKER_PROXY_BRIDGE_FAILED'))
  bridge.stdout.on('data', (chunk) => {
    bridgeOutput += chunk.toString('utf8')
    if (Buffer.byteLength(bridgeOutput) > MAX_MESSAGE_BYTES) return terminate(1, 'UDS_DOCKER_PROXY_RESPONSE_INVALID')
    let newline = bridgeOutput.indexOf('\n')
    while (newline !== -1) {
      const line = bridgeOutput.slice(0, newline)
      bridgeOutput = bridgeOutput.slice(newline + 1)
      if (!active || !line) return terminate(1, 'UDS_DOCKER_PROXY_RESPONSE_INVALID')
      clearTimeout(active.timer)
      if (!active.client.destroyed) active.client.end(`${line}\n`)
      active = null
      pump()
      newline = bridgeOutput.indexOf('\n')
    }
  })
  bridge.once('error', () => terminate(1, 'UDS_DOCKER_PROXY_BRIDGE_FAILED'))
  bridge.once('exit', () => {
    if (!stopping) terminate(1, 'UDS_DOCKER_PROXY_BRIDGE_EXITED')
  })
  bridge.once('spawn', () => server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600)
      const observed = lstatIfPresent(socketPath)
      if (!observed?.isSocket()) throw new Error('UDS_DOCKER_PROXY_SOCKET_IDENTITY_INVALID')
      socketIdentity = observed
    } catch { terminate(1, 'UDS_DOCKER_PROXY_SOCKET_IDENTITY_FAILED') }
  }))

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return { server, bridge, stop }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) startUdsDockerProxy()
