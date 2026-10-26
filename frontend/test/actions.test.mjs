import test from 'node:test'
import assert from 'node:assert/strict'
import { P2PKH, PrivateKey, Transaction, Spend } from '@bsv/sdk'
import { assertSameTemplate, sendCoins } from '../src/actions.ts'
import Importer from '../src/Importer.ts'
import { FixtureWallet } from './fixtureWallet.mjs'

test('import signer uses the right key ID and refuses a wrong source script', async () => {
  const wallet = new FixtureWallet()
  const keyID = '17'
  const pub = (await wallet.getPublicKey({ protocolID: [1, 'mountaintops'], keyID, counterparty: 'anyone', forSelf: true })).publicKey
  const { PublicKey } = await import('@bsv/sdk')
  const source = new Transaction(1, [], [{ satoshis: 1000, lockingScript: new P2PKH().lock(PublicKey.fromString(pub).toAddress()) }])
  const tx = new Transaction(1, [{ sourceTransaction: source, sourceTXID: source.id('hex'), sourceOutputIndex: 0, sequence: 0xffffffff }], [{ satoshis: 990, lockingScript: new P2PKH().lock(new PrivateKey(43).toPublicKey().toAddress()) }])
  const unlockingScript = await new Importer().unlock(wallet, keyID).sign(tx, 0)
  const spend = new Spend({ sourceTXID: source.id('hex'), sourceOutputIndex: 0, sourceSatoshis: 1000, lockingScript: source.outputs[0].lockingScript, transactionVersion: 1, otherInputs: [], inputIndex: 0, inputSequence: 0xffffffff, unlockingScript, outputs: tx.outputs, lockTime: 0 })
  assert.equal(spend.validate(), true)
  await assert.rejects(new Importer().unlock(wallet, '1').sign(tx, 0), /does not match/)
})
test('signed outputs and input ordering cannot change after authorization', () => {
  const output = { satoshis: 1, lockingScript: new P2PKH().lock(new PrivateKey(43).toPublicKey().toAddress()) }
  const before = new Transaction(1, [], [output])
  const after = new Transaction(1, [], [{ ...output, satoshis: 2 }])
  assert.throws(() => assertSameTemplate(before, after), /changed/)
})
test('stage-zero payment uses noSend inspection then one explicit sendWith', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => Response.json({ blocks: 972777, bestblockhash: 'a'.repeat(64) })
  const records = []
  const store = { network: 'mainnet', load: async () => records, append: async (kind, data) => { records.push({ kind, data }); return records } }
  const wallet = new FixtureWallet()
  const sent = []
  const original = wallet.createAction.bind(wallet)
  wallet.createAction = async args => { if (args.options?.sendWith) sent.push(...args.options.sendWith); return original(args) }
  try {
    const txid = await sendCoins(wallet, store, new PrivateKey(43).toPublicKey().toAddress(), '0.00001000', { stage: 0, state: null }, () => {})
    assert.deepEqual(sent, [txid])
    assert.equal(records.at(-1).data.state, 'submitted')
  } finally { globalThis.fetch = previous }
})
