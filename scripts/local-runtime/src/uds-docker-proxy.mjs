#!/usr/bin/env node
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_MESSAGE_BYTES = 1024 * 1024
const RESPONSE_TIMEOUT_MS = 10_000

/** Starts one persistent exact-container bridge and serializes local JSON-RPC clients across it. */
export function startUdsDockerProxy(environment = process.env, dependencies = {}) {
  const socketPath = environment.OES_PROXY_SOCKET_PATH?.trim()
  const container = environment.OES_PROXY_CONTAINER_NAME?.trim()
  if (!socketPath?.startsWith('/') || !/^oes-v2-[a-z0-9-]+-execution-signer$/u.test(container || '')) throw new Error('UDS_DOCKER_PROXY_CONFIGURATION_INVALID')
  if (fs.existsSync(socketPath)) throw new Error('UDS_DOCKER_PROXY_SOCKET_EXISTS')
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

  const removeSocket = () => fs.rmSync(socketPath, { force: true })
  const stop = () => terminate(0)
  const finish = (status) => {
    if (terminated) return
    terminated = true
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    removeSocket()
    exit(status)
  }
  const terminate = (status, failureCode = null) => {
    if (stopping) return
    stopping = true
    if (failureCode) logFailure(failureCode)
    for (const client of clients) client.destroy()
    if (active?.timer) clearTimeout(active.timer)
    if (bridge?.exitCode === null) bridge.kill('SIGTERM')
    if (server.listening) server.close(() => finish(status))
    else finish(status)
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
  bridge.once('spawn', () => server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600)))

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return { server, bridge, stop }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) startUdsDockerProxy()
