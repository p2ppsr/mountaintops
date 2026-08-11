import assert from 'node:assert/strict'
import test from 'node:test'
import { fallBackOnChaintracksNotFound } from '../src/chaintracksFallback.ts'

test('converts a Chaintracks not-found response to undefined', async () => {
  const lookup = fallBackOnChaintracksNotFound(async () => {
    throw new Error(JSON.stringify({
      status: 'error',
      code: 'ERR_NOT_FOUND',
      description: 'Header not found',
    }))
  })

  assert.equal(await lookup('missing-hash'), undefined)
})

test('preserves successful Chaintracks responses', async () => {
  const header = { hash: 'known-hash' }
  const lookup = fallBackOnChaintracksNotFound(async () => header)

  assert.equal(await lookup('known-hash'), header)
})

test('does not hide other Chaintracks failures', async () => {
  const failure = new Error(JSON.stringify({ status: 'error', code: 'ERR_INTERNAL' }))
  const lookup = fallBackOnChaintracksNotFound(async () => { throw failure })

  await assert.rejects(lookup('known-hash'), error => error === failure)
})
