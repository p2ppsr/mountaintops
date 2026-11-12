import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, bsvAmount } from '../src/paymentAmount.ts'

test('sats and BSV preserve the exact recipient amount through unit changes', () => {
  for (const sats of [1, 1000, 100000001, 2100000000000000]) {
    assert.equal(parseAmount(String(sats), 'sats'), sats)
    assert.equal(parseAmount(bsvAmount(sats), 'BSV'), sats)
  }
})

test('invalid, fractional satoshi and out-of-range values never reach review', () => {
  for (const value of ['0', '-1', '1.2', '1e3', ' 1', '9007199254740993']) assert.throws(() => parseAmount(value, 'sats'))
  for (const value of ['0', '0.000000001', '-1', '1e3', '21000000.00000001']) assert.throws(() => parseAmount(value, 'BSV'))
  assert.throws(() => bsvAmount(1.1))
  assert.throws(() => bsvAmount(Number.MAX_SAFE_INTEGER))
})
