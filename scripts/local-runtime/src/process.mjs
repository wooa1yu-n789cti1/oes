import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'

/** Executes a command and returns literal output without printing secret-bearing arguments. */
export function runChecked(command, args, { cwd, env = process.env, input, timeout = 120000, stdio = 'pipe' } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024, stdio })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const status = result.status ?? (result.signal ? 128 + (os.constants.signals[result.signal] || 1) : 1)
    const error = new Error(`COMMAND_FAILED command=${command} exit=${status}${result.signal ? ` signal=${result.signal}` : ''}`)
    error.stdout = result.stdout ?? ''
    error.stderr = result.stderr ?? ''
    error.status = status
    error.signal = result.signal
    throw error
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

/** Executes an operator-visible command with stdout and stderr inherited by the launcher. */
export function runCheckedVisible(command, args, options = {}) {
  return runChecked(command, args, { ...options, stdio: 'inherit' })
}

/** Spawns one host process with an explicit environment and no inherited launcher bindings. */
export function spawnHost(command, args, { cwd, environment, stdio = 'inherit' } = {}) {
  return spawn(command, args, { cwd, env: environment, stdio })
}
