import assert from 'node:assert/strict'
import test from 'node:test'
import { walletActionStatus, walletStatusMessage, unfinishedWalletActions, assertWalletActionFinal } from '../src/walletActionState.ts'

const txid = 'a'.repeat(64)
test('refresh and reconnect distinguish submitted/unproven from unknown without another financial call', async () => {
  let status = 'unproven', reads = 0
  const wallet = { listActions: async () => { reads++; return { totalActions: 1, actions: [{ txid, status, labels: ['mountaintops actions v1'] }] } } }
  for (let i = 0; i < 3; i++) {
    assert.equal((await unfinishedWalletActions(wallet, 'mainnet'))[0].data.state, 'awaiting confirmation')
    assert.equal(await walletActionStatus(wallet, { txid }), 'unproven')
    assert.match(walletStatusMessage('unproven'), /Submitted; waiting for confirmation/)
    await assert.rejects(assertWalletActionFinal(wallet, { txid }), /Do not send this payment again/)
  }
  status = 'completed'
  assert.equal(await walletActionStatus(wallet, { txid }), 'completed')
  await assertWalletActionFinal(wallet, { txid })
  assert.deepEqual(await unfinishedWalletActions(wallet, 'mainnet'), [])
  status = 'failed'
  assert.equal(await walletActionStatus(wallet, { txid }), 'failed')
  assert.match(walletStatusMessage('failed'), /reports this payment failed/)
  assert.deepEqual(await unfinishedWalletActions(wallet, 'mainnet'), [])
  assert.ok(reads > 10)
})
test('missing, conflicting, sending and unfamiliar outcomes never claim submission or completion', async () => {
  for (const actions of [[], [{ txid, status: 'sending' }], [{ txid, status: 'future-state' }], [{ txid, status: 'completed' }, { txid, status: 'unproven' }]]) {
    const wallet = { listActions: async () => ({ totalActions: actions.length, actions }) }
    assert.equal(await walletActionStatus(wallet, { txid }), 'unknown')
    await assert.rejects(assertWalletActionFinal(wallet, { txid }), /outcome is not known/)
  }
})

test('unfamiliar and conflicting terminal wallet rows keep payment admission blocked', async () => {
  for (const actions of [[{ txid, status: 'future-state' }], [{ txid, status: 'completed' }, { txid, status: 'failed' }]]) {
    const wallet = { listActions: async () => ({ totalActions: actions.length, actions }) }
    assert.equal((await unfinishedWalletActions(wallet, 'mainnet')).length, 1)
  }
})

test('dedicated refresh uses only identity/network/history reads and keeps missing or conflicting observations blocked', async () => {
  const { refreshPaymentStatus } = await import('../src/walletActionState.ts')
  const identity = 'synthetic-wallet-identity'
  let rows = [{ txid, status: 'unproven', labels: ['mountaintops actions v1'] }]
  const methods = []
  const wallet = new Proxy({
    getPublicKey: async () => { methods.push('getPublicKey'); return { publicKey: identity } },
    getNetwork: async () => { methods.push('getNetwork'); return { network: 'mainnet' } },
    listActions: async () => { methods.push('listActions'); return { totalActions: rows.length, actions: rows } }
  }, { get(target, key) { if (!(key in target)) throw Error(`Unexpected wallet method: ${String(key)}`); return target[key] } })
  let records = await unfinishedWalletActions(wallet, 'mainnet')
  let result = await refreshPaymentStatus(wallet, identity, 'mainnet', records, { txid })
  assert.equal(result.status, 'unproven'); assert.equal(result.records.length, 1)
  rows = []
  result = await refreshPaymentStatus(wallet, identity, 'mainnet', result.records, { txid })
  assert.equal(result.status, 'unknown'); assert.equal(result.records[0].data.state, 'needs wallet review')
  rows = [{ txid, status: 'completed' }, { txid, status: 'failed' }]
  result = await refreshPaymentStatus(wallet, identity, 'mainnet', result.records, { txid })
  assert.equal(result.status, 'unknown'); assert.equal(result.records.length, 1)
  rows = [{ txid, status: 'completed' }]
  result = await refreshPaymentStatus(wallet, identity, 'mainnet', result.records, { txid })
  assert.equal(result.status, 'completed'); assert.deepEqual(result.records, [])
  assert.ok(methods.every(method => ['getPublicKey', 'getNetwork', 'listActions'].includes(method)))
  await assert.rejects(refreshPaymentStatus(wallet, 'different-wallet', 'mainnet', records, { txid }), /account or network changed/)
  await assert.rejects(refreshPaymentStatus(wallet, identity, 'testnet', records, { txid }), /account or network changed/)
})

test('status reconciliation retains the existing unproven record-only exception and resolves legacy records only in memory', async () => {
  const { paymentActionRecords } = await import('../src/walletActionState.ts')
  const prior = [{ v: 1, network: 'mainnet', kind: 'action', clock: 0, data: { id: txid, txid, state: 'needs wallet review' } }]
  const recordRows = [{ txid, status: 'unproven', labels: ['mountaintops actions v1', 'mountaintops records v1'] }]
  // The exact exported record scope, rather than an extra permission label.
  const { RECORD_LABEL } = await import('../src/walletScopes.ts')
  recordRows[0].labels[1] = RECORD_LABEL
  const wallet = { listActions: async () => ({ totalActions: 1, actions: recordRows }) }
  assert.deepEqual(await paymentActionRecords(wallet, 'mainnet', prior), [])
  recordRows[0] = { txid, status: 'completed', labels: ['mountaintops actions v1'] }
  const legacy = [{ ...prior[0], clock: 1, serial: 'synthetic.0' }]
  const reconciled = await paymentActionRecords(wallet, 'mainnet', legacy)
  assert.equal(reconciled[0].data.state, 'reviewed in wallet')
  assert.equal(legacy[0].data.state, 'needs wallet review')
})

test('a failed history refresh cannot mutate or discard the previously observed guard', async () => {
  const { refreshPaymentStatus } = await import('../src/walletActionState.ts')
  const records = [{ v: 1, network: 'mainnet', kind: 'action', clock: 0, data: { id: txid, txid, state: 'awaiting confirmation' } }]
  const before = structuredClone(records)
  const wallet = { getPublicKey: async () => ({ publicKey: 'synthetic' }), getNetwork: async () => ({ network: 'mainnet' }), listActions: async () => { throw Error('Read unavailable') } }
  await assert.rejects(refreshPaymentStatus(wallet, 'synthetic', 'mainnet', records, { txid }), /Read unavailable/)
  assert.deepEqual(records, before)
})
