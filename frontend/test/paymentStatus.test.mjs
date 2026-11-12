import assert from 'node:assert/strict'
import test from 'node:test'
import { walletActionStatus, walletStatusMessage, unfinishedWalletActions, assertWalletActionResolved, refreshPaymentStatus, paymentActionRecords } from '../src/walletActionState.ts'

const txid = 'a'.repeat(64)
const row = status => ({ txid, status, labels: ['mountaintops actions v1'] })
const guard = () => ({ v: 1, network: 'mainnet', kind: 'action', clock: 0, data: { id: txid, txid, state: 'needs wallet review' } })

test('wallet acceptance releases the app without waiting for mining, including after reconnect', async () => {
  for (const status of ['sending', 'unproven', 'completed']) {
    const wallet = { listActions: async () => ({ totalActions: 1, actions: [row(status)] }) }
    assert.equal(await walletActionStatus(wallet, { txid }), 'accepted')
    await assertWalletActionResolved(wallet, { txid })
    assert.deepEqual(await unfinishedWalletActions(wallet, 'mainnet'), [])
    assert.deepEqual(await paymentActionRecords(wallet, 'mainnet', [guard()]), [])
  }
  assert.equal(walletStatusMessage('accepted'), 'Your wallet accepted this payment.')
})

test('compatible accepted lifecycle observations are not conflicting payment outcomes', async () => {
  const actions = ['sending', 'unproven', 'completed'].map(row)
  const wallet = { listActions: async () => ({ totalActions: actions.length, actions }) }
  assert.equal(await walletActionStatus(wallet, { txid }), 'accepted')
  assert.deepEqual(await unfinishedWalletActions(wallet, 'mainnet'), [])
})

test('missing, unfamiliar and contradictory outcomes stay guarded', async () => {
  for (const actions of [[], [row('future-state')], [row('unsigned')], [row('completed'), row('failed')], [row('unproven'), row('nosend')]]) {
    const wallet = { listActions: async () => ({ totalActions: actions.length, actions }) }
    assert.equal(await walletActionStatus(wallet, { txid }), 'unknown')
    await assert.rejects(assertWalletActionResolved(wallet, { txid }), /outcome is not known/)
    const records = await paymentActionRecords(wallet, 'mainnet', [guard()])
    assert.equal(records.length, 1)
    assert.equal(records[0].data.state, 'needs wallet review')
  }
})

test('failed is a known wallet outcome, never a success receipt or automatic retry', async () => {
  const wallet = { listActions: async () => ({ totalActions: 1, actions: [row('failed')] }) }
  assert.equal(await walletActionStatus(wallet, { txid }), 'failed')
  assert.match(walletStatusMessage('failed'), /reports this payment failed/)
  assert.deepEqual(await unfinishedWalletActions(wallet, 'mainnet'), [])
})

test('checking an unresolved attempt uses only identity/network/history reads', async () => {
  const identity = 'synthetic-wallet-identity', methods = []
  let rows = [row('unprocessed')]
  const wallet = new Proxy({
    getPublicKey: async () => { methods.push('getPublicKey'); return { publicKey: identity } },
    getNetwork: async () => { methods.push('getNetwork'); return { network: 'mainnet' } },
    listActions: async () => { methods.push('listActions'); return { totalActions: rows.length, actions: rows } }
  }, { get(target, key) { if (!(key in target)) throw Error(`Unexpected wallet method: ${String(key)}`); return target[key] } })
  let result = await refreshPaymentStatus(wallet, identity, 'mainnet', [guard()], { txid })
  assert.equal(result.status, 'unknown'); assert.equal(result.records.length, 1)
  rows = []
  result = await refreshPaymentStatus(wallet, identity, 'mainnet', result.records, { txid })
  assert.equal(result.status, 'unknown'); assert.equal(result.records.length, 1)
  rows = [row('unproven')]
  result = await refreshPaymentStatus(wallet, identity, 'mainnet', result.records, { txid })
  assert.equal(result.status, 'accepted'); assert.deepEqual(result.records, [])
  assert.ok(methods.every(method => ['getPublicKey', 'getNetwork', 'listActions'].includes(method)))
  await assert.rejects(refreshPaymentStatus(wallet, 'different-wallet', 'mainnet', [guard()], { txid }), /account or network changed/)
  await assert.rejects(refreshPaymentStatus(wallet, identity, 'testnet', [guard()], { txid }), /account or network changed/)
})

test('legacy action records resolve in memory after wallet acceptance without a paid record', async () => {
  const original = { ...guard(), clock: 1, serial: 'synthetic.0' }
  const wallet = { listActions: async () => ({ totalActions: 1, actions: [row('unproven')] }) }
  const result = await paymentActionRecords(wallet, 'mainnet', [original])
  assert.equal(result[0].data.state, 'reviewed in wallet')
  assert.equal(original.data.state, 'needs wallet review')
})

test('a failed history read preserves the unresolved attempt', async () => {
  const records = [guard()], before = structuredClone(records)
  const wallet = { getPublicKey: async () => ({ publicKey: 'synthetic' }), getNetwork: async () => ({ network: 'mainnet' }), listActions: async () => { throw Error('Read unavailable') } }
  await assert.rejects(refreshPaymentStatus(wallet, 'synthetic', 'mainnet', records, { txid }), /Read unavailable/)
  assert.deepEqual(records, before)
})
