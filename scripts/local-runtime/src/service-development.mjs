#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../../..')
const stopOperations = new WeakMap()

/** Resolves one declared service package without accepting an ambiguous workspace match. */
export function resolveServicePackage(rootDirectory, owner) {
  const matches = ['src/services/system', 'src/services/business', 'src/services']
    .map((base) => path.join(rootDirectory, base, owner, 'package.json'))
    .filter((candidate) => fs.existsSync(candidate))
  const unique = [...new Set(matches)]
  if (unique.length !== 1) throw new Error(`DEVELOPMENT_SERVICE_PACKAGE_AMBIGUOUS owner=${owner}`)
  return unique[0]
}

/** Converts one child outcome into a conventional process exit status. */
export function childExitStatus(code, signal) {
  return code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1)
}

/** Prefixes live service output while suppressing package-manager teardown noise after an intentional stop. */
function forwardOutput(stream, owner, role, destination, isStopping) {
  let buffered = ''
  const flush = (complete) => {
    const parts = buffered.split('\n')
    buffered = parts.pop() ?? ''
    for (const line of parts) if (!isStopping()) destination.write(`[${owner}] [${role}] ${line}\n`)
    if (complete && buffered && !isStopping()) destination.write(`[${owner}] [${role}] ${buffered}\n`)
    if (complete) buffered = ''
  }
  stream.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    flush(false)
  })
  stream.once('end', () => flush(true))
}

/** Terminates one detached command tree and waits for its output streams to close. */
function stopCommand(child, signal = 'SIGTERM', timeoutMs = 5000) {
  if (stopOperations.has(child)) return stopOperations.get(child)
  const operation = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch (error) {
          if (error?.code !== 'ESRCH') process.stderr.write(`${error.message || error}\n`)
        }
        resolve()
      }, timeoutMs)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  })()
  stopOperations.set(child, operation)
  return operation
}

/** Runs one service's watch compiler and nodemon command without nested pnpm lifecycle reporting. */
export async function runServiceDevelopment({ owner, packageFile, spawnCommand = spawn } = {}) {
  const resolvedPackage = packageFile || resolveServicePackage(root, owner)
  const packageJson = JSON.parse(fs.readFileSync(resolvedPackage, 'utf8'))
  const scripts = packageJson.scripts || {}
  if (!scripts['dev:build'] || !scripts['dev:start'])
    throw new Error(`DEVELOPMENT_SERVICE_SCRIPTS_REQUIRED owner=${owner || packageJson.name}`)
  const packageDirectory = path.dirname(resolvedPackage)
  const environment = {
    ...process.env,
    PATH: [
      path.join(packageDirectory, 'node_modules/.bin'),
      path.join(root, 'node_modules/.bin'),
      process.env.PATH || ''
    ].join(path.delimiter)
  }
  let stoppingSignal = null
  const children = [
    ['build', scripts['dev:build']],
    ['run', scripts['dev:start']]
  ].map(([role, command]) => {
    const child = spawnCommand(command, [], {
      cwd: packageDirectory,
      env: environment,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    forwardOutput(child.stdout, owner || packageJson.name, role, process.stdout, () => !!stoppingSignal)
    forwardOutput(child.stderr, owner || packageJson.name, role, process.stderr, () => !!stoppingSignal)
    return { role, child }
  })

  const interrupt = (signal) => {
    if (stoppingSignal) return
    stoppingSignal = signal
    for (const { child } of children) void stopCommand(child, signal)
  }
  const signalHandlers = new Map(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
      const handler = () => interrupt(signal)
      process.on(signal, handler)
      return [signal, handler]
    })
  )
  const outcome = await Promise.race(
    children.map(
      ({ role, child }) =>
        new Promise((resolve) => {
          child.once('error', (error) => resolve({ role, error }))
          child.once('close', (code, signal) => resolve({ role, code, signal }))
        })
    )
  )
  const intentionalStop = !!stoppingSignal
  if (!stoppingSignal) stoppingSignal = 'SIGTERM'
  await Promise.all(children.map(({ child }) => stopCommand(child, stoppingSignal)))
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  if (intentionalStop) return { exitCode: 0, reason: 'operator-interrupt' }
  if (outcome.error) throw outcome.error
  const exitCode = childExitStatus(outcome.code, outcome.signal)
  process.stderr.write(
    `[${owner || packageJson.name}] [supervisor] unexpected-exit role=${outcome.role} exit=${exitCode}${outcome.signal ? ` signal=${outcome.signal}` : ''}\n`
  )
  return { exitCode: exitCode === 0 ? 1 : exitCode, reason: 'child-exit' }
}

/** Dispatches the runtime-owned service supervisor for one exact owner. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0]) throw new Error('SERVICE_DEVELOPMENT_USAGE expected=<owner>')
  const result = await runServiceDevelopment({ owner: argv[0] })
  process.exitCode = result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || error}\n`)
    process.exitCode = 1
  }
}
