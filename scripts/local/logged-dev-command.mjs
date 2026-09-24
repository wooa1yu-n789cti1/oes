import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { reopenBackendSession } from '../local-runtime/src/development-session.mjs'

const target = process.argv[2]
const definitions = Object.freeze({
  backend: {
    rawScript: 'backend:raw',
    logName: 'backend.log',
    executable: process.execPath,
    args: ['scripts/local-runtime/dev-backend-session.mjs', 'start']
  },
  'backend-prepare': {
    commandName: 'backend:prepare',
    rawScript: 'backend:prepare:raw',
    logName: 'backend-prepare.log',
    executable: process.execPath,
    args: ['scripts/local-runtime/dev-backend-session.mjs', 'prepare']
  },
  infra: {
    rawScript: 'infra:raw',
    logName: 'infra.log',
    executable: process.execPath,
    args: ['scripts/local-runtime/ensure-dev-infrastructure.mjs']
  },
  web: {
    rawScript: 'web:raw',
    logName: 'web.log',
    executable: 'app/web/node_modules/.bin/vite',
    args: ['--mode', 'development'],
    cwd: 'app/web/apps/tenant-web'
  }
})

if (!definitions[target])
  throw new Error(`LOGGED_DEV_COMMAND_INVALID target=${target || '<missing>'}`)

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stateRoot = path.join(os.homedir(), '.local', 'state', 'oes')
const runtimeStateRoot = path.join(stateRoot, 'runtime-v2')
const logsRoot = path.join(stateRoot, 'logs')
const logPath = path.join(logsRoot, definitions[target].logName)
const pidPath = path.join(stateRoot, `${target}.pid`)
const exitPath = path.join(stateRoot, `${target}.exit`)

fs.mkdirSync(logsRoot, { recursive: true, mode: 0o700 })
fs.rmSync(exitPath, { force: true })
fs.writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 })
const log = fs.createWriteStream(logPath, { flags: 'w', mode: 0o600 })

/** Writes one launcher message to both the terminal and the fixed log. */
function writeMessage(message, stream = process.stdout) {
  stream.write(message)
  log.write(stripVTControlCharacters(String(message)))
}

/** Reports whether one recorded process still exists. */
function isLivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Returns every currently published run manifest, newest first. */
function listRunManifests() {
  const stacksRoot = path.join(stateRoot, 'runtime-v2', 'stacks')
  if (!fs.existsSync(stacksRoot)) return []
  const manifests = []
  for (const stackName of fs.readdirSync(stacksRoot)) {
    const runsRoot = path.join(stacksRoot, stackName, 'runs')
    if (!fs.existsSync(runsRoot)) continue
    for (const taskName of fs.readdirSync(runsRoot)) {
      const taskRoot = path.join(runsRoot, taskName)
      for (const runName of fs.readdirSync(taskRoot)) {
        const manifestPath = path.join(taskRoot, runName, 'manifest.json')
        if (fs.existsSync(manifestPath))
          manifests.push({ path: manifestPath, modifiedAt: fs.statSync(manifestPath).mtimeMs })
      }
    }
  }
  return manifests.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

/** Reports whether the manifest endpoint still belongs to a live host process. */
function isLiveEndpoint(endpoint) {
  const match = String(endpoint.authority || '').match(/pid:(\d+)/u)
  if (!match) return false
  try {
    process.kill(Number(match[1]), 0)
    return true
  } catch {
    return false
  }
}

/** Resolves the currently healthy backend gateway from runtime manifest truth. */
async function resolveGatewayBaseUrl({ timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const session = reopenBackendSession(runtimeStateRoot)
      if (session && isLivePid(session.record.pid)) {
        const endpoint = session.record.endpoints?.find(
          (item) => item.host === 'api-gateway.localhost' && isLiveEndpoint(item)
        )
        if (endpoint && Number.isInteger(endpoint.port)) {
          const root = `http://127.0.0.1:${endpoint.port}`
          const response = await fetch(`${root}/health`, { signal: AbortSignal.timeout(1_000) })
          if (response.status === 200) return `${root}/api/v1`
        }
      }
    } catch {}
    for (const candidate of listRunManifests()) {
      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(candidate.path, 'utf8'))
      } catch {
        continue
      }
      const endpoint = manifest.endpoints?.find(
        (item) =>
          item.provider === 'host-process' &&
          item.host === 'api-gateway.localhost' &&
          isLiveEndpoint(item)
      )
      if (!endpoint || !Number.isInteger(endpoint.port)) continue
      const root = `http://127.0.0.1:${endpoint.port}`
      try {
        const response = await fetch(`${root}/health`, { signal: AbortSignal.timeout(1_000) })
        if (response.status === 200) return `${root}/api/v1`
      } catch {}
    }
    writeMessage('[logged-dev-command] waiting for a healthy backend gateway...\n', process.stderr)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error('LOGGED_DEV_COMMAND_GATEWAY_TIMEOUT timeoutMs=300000')
}

/** Removes only this launcher's current PID record. */
function removePidRecord() {
  try {
    if (fs.readFileSync(pidPath, 'utf8').trim() === String(process.pid))
      fs.rmSync(pidPath, { force: true })
  } catch {}
}

/** Runs the selected raw package script while duplicating output into its fixed log. */
async function main() {
  const commandName = definitions[target].commandName || target
  writeMessage(
    [
      `OES ${commandName}`,
      `repository: ${repositoryRoot}`,
      `command: pnpm ${commandName}`,
      `raw-command: pnpm ${definitions[target].rawScript}`,
      `log: ${logPath}`,
      '---',
      ''
    ].join('\n')
  )

  const environment = { ...process.env }
  if (target === 'web' && !environment.OES_GATEWAY_HTTP_BASE_URL?.trim())
    environment.OES_GATEWAY_HTTP_BASE_URL = await resolveGatewayBaseUrl()
  if (target === 'web') writeMessage(`gateway: ${environment.OES_GATEWAY_HTTP_BASE_URL}\n---\n`)

  const definition = definitions[target]
  const child = spawn(path.resolve(repositoryRoot, definition.executable), definition.args, {
    cwd: definition.cwd ? path.resolve(repositoryRoot, definition.cwd) : repositoryRoot,
    env: environment,
    stdio: ['inherit', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    log.write(stripVTControlCharacters(chunk.toString('utf8')))
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    log.write(stripVTControlCharacters(chunk.toString('utf8')))
  })

  let forwardedSignal = null
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (forwardedSignal) return
      forwardedSignal = signal
      child.kill(signal)
    })
  }

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const operatorInterrupted = forwardedSignal !== null
  const exitCode = operatorInterrupted
    ? 0
    : (result.code ?? (result.signal ? 128 + (os.constants.signals[result.signal] || 1) : 1))
  writeMessage(
    `\n[logged-dev-command] exit=${exitCode}${operatorInterrupted ? ` reason=operator-interrupt signal=${forwardedSignal}` : result.signal ? ` signal=${result.signal}` : ''}\n`
  )
  fs.writeFileSync(exitPath, `${exitCode}\n`, { mode: 0o600 })
  await new Promise((resolve) => log.end(resolve))
  removePidRecord()
  process.exitCode = exitCode
}

try {
  await main()
} catch (error) {
  writeMessage(`\n[logged-dev-command] ${error.stack || error.message}\n`, process.stderr)
  fs.writeFileSync(exitPath, '1\n', { mode: 0o600 })
  await new Promise((resolve) => log.end(resolve))
  removePidRecord()
  process.exitCode = 1
}
