#!/usr/bin/env node
import { canonicalJson, readJson } from './canonical.ts'
import { fail, runtimeErrorResult } from './errors.ts'
import { runThinVerification, type VerificationRunInput } from './verification-runner.ts'

/** Executes the single public verification command. */
function main(args: string[]): void {
  if (args[0] !== 'run' || args[1] !== '--input' || !args[2])
    fail('THIN_VERIFY_USAGE', 'oes-verify run --input INPUT.json', 'READ_VERIFICATION_RUNNER_USAGE')
  const result = runThinVerification(readJson<VerificationRunInput>(args[2]))
  process.stdout.write(`${canonicalJson(result)}\n`)
  if (result.status === 'FAILED') process.exitCode = 3
}

try {
  main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${canonicalJson(runtimeErrorResult(error))}\n`)
  process.exitCode = 2
}
