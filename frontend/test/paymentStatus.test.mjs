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
