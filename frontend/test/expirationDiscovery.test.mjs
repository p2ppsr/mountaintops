import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshCoins, coinIsUnspent } from '../src/coins.ts'

const retired = { keyID: '1', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', network: 'mainnet', targetStage: 0, retiredAt: { height: 1000002, hash: 'a'.repeat(64), mtp: 123, lastReceiveHeight: 1000001 } }
const coverage = { stage: 1, height: 1000005 }
test('expired addresses have one bounded historical bootstrap and no live deposit polling', async () => {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async url => { calls.push(String(url)); return Response.json({ address: retired.address, result: [], error: '' }) }
  const records = []
  const store = { load: async () => records, append: async (kind, data) => { records.push({ kind, data }); return records } }
  const wallet = { listOutputs: async () => ({ outputs: [], totalOutputs: 0 }) }
  try {
    assert.deepEqual(await refreshCoins(wallet, store, retired, coverage, () => {}), [])
    assert.deepEqual(await refreshCoins(wallet, store, retired, coverage, () => {}), [])
    assert.equal(calls.length, 1)
    assert.match(calls[0], /confirmed\/history\?order=asc/)
    assert.equal(calls.some(x => x.includes('/unspent')), false)
    assert.equal(records[0].kind, 'history')
  } finally { globalThis.fetch = previous }
})
test('unknown spend state is an error, never an empty balance', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response('unknown outpoint', { status: 400 })
  try { await assert.rejects(coinIsUnspent(retired, { txid: 'b'.repeat(64), vout: 0 }), /unknown/) }
  finally { globalThis.fetch = previous }
})
test('an expired destination cannot be routed through the active discovery branch', async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not be called') }
  try {
    await assert.rejects(refreshCoins({}, {}, { ...retired, retiredAt: null }, { stage: 27 }, () => {}), /Expired/)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = previous }
})

test('failed retirement persistence blocks receiving without blocking the historical view', async () => {
  const { applyExpirations } = await import('../src/addressBook.ts')
  const book = [{ ...retired, address: '1HjSupRYgLt7Q8csnHXz5kXurMRiJHQGEP', retiredAt: null }]
  const warning = await applyExpirations(book, { stage: 2, activations: [{ stage: 2, height: 1000002, hash: 'a'.repeat(64), mtp: 123 }] }, { append: async () => { throw new Error('unfunded wallet') } })
  assert.match(warning, /Receiving is blocked/)
  assert.equal(book[0].retiredAt.lastReceiveHeight, 1000001)
})

test('funding coverage uses the confirmation event and exact version without changing ownership', async () => {
  const { fundingCoverage } = await import('../src/coins.ts')
  const entry = { ...retired, address: '1Chickencoinxxxxxxxxxxxxxxxxxxxxxxx' }
  const state = { activations: [{ height: 1000010, stage: 13 }] }
  assert.equal(fundingCoverage(entry, { height: 1000009, txid: '0'.repeat(64) }, { version: 2 }, state), 'covered')
  assert.equal(fundingCoverage(entry, { height: 1000011, txid: '9'.repeat(64) }, { version: 2 }, state), 'outside coverage')
  assert.equal(fundingCoverage(entry, { height: null, txid: '9'.repeat(64) }, { version: 1 }, state), 'unconfirmed')
})

test('retained pre-sunset coins recover using wallet BEEF and known-output checks only', async () => {
  const { Beef, MerklePath, P2PKH, PrivateKey, Transaction } = await import('@bsv/sdk')
  const { publicDeriver } = await import('../src/derivation.ts')
  const address = publicDeriver(new PrivateKey(42).toPublicKey().toString())('1', 'mainnet')
  const entry = { ...retired, address }
  const tx = new Transaction(1, [], [{ satoshis: 1234, lockingScript: new P2PKH().lock(address) }])
  const txid = tx.id('hex')
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(txid, 1000001)
  const beef = new Beef(); beef.mergeTransaction(tx)
  const coin = { v: 1, network: 'mainnet', txid, vout: 0, satoshis: 1234, keyID: '1', address, height: 1000001 }
  const wallet = { listOutputs: async () => ({ totalOutputs: 1, outputs: [{ outpoint: `${txid}.0`, satoshis: 1234, customInstructions: JSON.stringify(coin) }], BEEF: beef.toBinary() }) }
  const store = { load: async () => [{ kind: 'history', data: { keyID: '1', cutoffHash: entry.retiredAt.hash } }] }
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (String(url).endsWith('/spent')) return new Response('', { status: 404 })
    if (String(url).includes('/block/1000001/header')) return Response.json({ merkleroot: txid })
    throw new Error('Forbidden address discovery or unexpected dependency: ' + url)
  }
  try {
    const coins = await refreshCoins(wallet, store, entry, { ...coverage, activations: [] }, () => {})
    assert.equal(coins.length, 1); assert.equal(coins[0].satoshis, 1234)
    assert.equal(calls.some(url => url.includes('/address/')), false)
    assert.equal(coins[0].fundingCoverage, 'covered')
  } finally { globalThis.fetch = previous }
})
