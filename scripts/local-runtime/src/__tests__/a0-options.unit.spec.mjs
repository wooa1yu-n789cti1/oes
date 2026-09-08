import assert from 'node:assert/strict'
import test from 'node:test'
import { parseA0Options } from '../../a0.mjs'

test('A0 parses options after the standalone separator forwarded by pnpm', () => {
  assert.deepEqual(parseA0Options(['--', '--driver', 'simulation', '--scenario=provider-postgres']), {
    driver: 'simulation',
    scenario: 'provider-postgres'
  })
})

test('A0 rejects positional and valueless options instead of silently selecting Docker', () => {
  assert.throws(() => parseA0Options(['simulation']), /A0_ARGUMENT_INVALID/)
  assert.throws(() => parseA0Options(['--driver', '--scenario', 'provider-postgres']), /A0_OPTION_VALUE_REQUIRED/)
  assert.throws(() => parseA0Options(['--driver=']), /A0_OPTION_VALUE_REQUIRED/)
  assert.throws(() => parseA0Options(['--unknown', 'value']), /A0_OPTION_INVALID/)
})
