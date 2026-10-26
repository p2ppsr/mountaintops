import assert from 'node:assert/strict'
import test from 'node:test'
import { PushDrop, Utils } from '@bsv/sdk'
import { WalletRecords, RECORD_BASKET } from '../src/walletRecords.ts'
import { FixtureWallet, walletState } from './fixtureWallet.mjs'

test('encrypted PushDrop records restore on a new wallet instance with no browser data', async () => {
  const state = walletState()
  const first = new FixtureWallet(state)
  const identity = (await first.getPublicKey({ identityKey: true })).publicKey
  const records = new WalletRecords(first, identity, 'mainnet')
  assert.deepEqual(await records.load(), [])
  const saved = await records.append('address', { keyID: '17', address: 'fixture address', targetStage: 8 })
  assert.equal(saved.length, 1)
  const tokens = [...state.outputs.entries()].filter(([, x]) => x.basket === RECORD_BASKET)
  assert.equal(tokens.length, 1)
  const [txid, vout] = tokens[0][0].split('.')
  const script = state.transactions.get(txid).outputs[Number(vout)].lockingScript
  const fields = PushDrop.decode(script).fields
  assert.equal(Utils.toUTF8(fields[0]).includes('fixture address'), false)
  const restoredWallet = new FixtureWallet(state)
  const restored = new WalletRecords(restoredWallet, identity, 'mainnet')
  assert.deepEqual((await restored.load()).map(x => x.data), [{ keyID: '17', address: 'fixture address', targetStage: 8 }])
  await restored.append('retirement', { keyID: '17', boundary: { height: 1000002 } })
  assert.equal((await records.load()).length, 2)
  assert.equal((await new WalletRecords(restoredWallet, identity, 'testnet').load()).length, 0)
})
test('recovery refuses incomplete pagination and unauthenticated basket entries', async () => {
  const wallet = new FixtureWallet()
  const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const records = new WalletRecords(wallet, identity, 'mainnet')
  wallet.listOutputs = async () => ({ totalOutputs: 2, outputs: [] })
  await assert.rejects(records.load(), /incomplete/)
  wallet.listOutputs = async () => ({ totalOutputs: 1, outputs: [{ outpoint: `${'a'.repeat(64)}.0`, tags: ['foreign'] }] })
  await assert.rejects(records.load(), /Ambiguous/)
})
