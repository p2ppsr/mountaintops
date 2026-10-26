import test from 'node:test'
import assert from 'node:assert/strict'
import { P2PKH, PrivateKey, Transaction, Spend } from '@bsv/sdk'
import { assertSameTemplate, importCoins, sendCoins, unfinishedWalletActions } from '../src/actions.ts'
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
    assert.equal(wallet.state.actions.at(-1).status, 'unproven')
    assert.equal(records.length, 0)
  } finally { globalThis.fetch = previous }
})


test('first import funds an empty wallet without a prerequisite PushDrop fee', async () => {
  const wallet = new FixtureWallet()
  const pub = (await wallet.getPublicKey({ protocolID: [1, 'mountaintops'], keyID: '17', counterparty: 'anyone', forSelf: true })).publicKey
  const { PublicKey, MerklePath } = await import('@bsv/sdk')
  const address = PublicKey.fromString(pub).toAddress()
  const source = new Transaction(1, [], [{ satoshis: 10000, lockingScript: new P2PKH().lock(address) }])
  wallet.state.outputs.clear(); wallet.state.transactions.clear(); wallet.state.transactions.set(source.id('hex'), source)
  const coin = { keyID: '17', address, txid: source.id('hex'), vout: 0, satoshis: 10000, height: null }
  source.merklePath = MerklePath.fromCoinbaseTxidAndHeight(coin.txid, 972000)
  coin.height = 972000
  wallet.state.outputs.set(`${coin.txid}.0`, { basket: 'mountaintops receipts v1', tags: [`address ${address}`], satoshis: 10000, spendable: true, customInstructions: JSON.stringify({ v: 1, network: 'mainnet', ...coin }) })
  const store = { network: 'mainnet', load: async () => [], append: async () => { throw new Error('Cannot pay for a record yet') } }
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).endsWith('/spent')) return new Response('', { status: 404 })
    if (String(url).endsWith('/header')) return Response.json({ merkleroot: coin.txid })
    return Response.json({ blocks: 972777, bestblockhash: 'a'.repeat(64) })
  }
  try {
    const txid = await importCoins(wallet, store, { keyID: '17', address, network: 'mainnet', targetStage: 0, retiredAt: { height: 1000002, hash: 'f'.repeat(64), mtp: 123, lastReceiveHeight: 1000001 } }, [coin], { stage: 0, state: null }, () => {})
    assert.equal(wallet.state.actions.at(-1).txid, txid)
    assert.ok([...wallet.state.outputs.values()].some(x => x.basket === 'default' && x.satoshis > 0))
  } finally { globalThis.fetch = previous }
})

test('a fresh wallet instance finds a signed unsubmitted action without browser records', async () => {
  const wallet = new FixtureWallet()
  wallet.state.actions.push({ txid: 'a'.repeat(64), status: 'nosend', labels: ['mountaintops actions v1', 'mountaintops request synthetic-id'], description: 'Interrupted import' })
  const restored = new FixtureWallet(wallet.state)
  const records = await unfinishedWalletActions(restored, 'mainnet')
  assert.equal(records[0].data.id, 'synthetic-id')
  assert.equal(records[0].data.reference, 'a'.repeat(64))
  assert.equal(records[0].data.state, 'prepared')
})


test('fresh-device recovery blocks another payment while a submission is sending or unproven', async () => {
  for (const status of ['sending', 'unproven']) {
    const wallet = new FixtureWallet()
    wallet.state.actions.push({ txid: 'a'.repeat(64), status, labels: ['mountaintops actions v1', 'mountaintops request uncertain'], description: 'Awaiting wallet outcome' })
    const pending = await unfinishedWalletActions(new FixtureWallet(wallet.state), 'mainnet')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].data.state, 'needs wallet review')
    await assert.rejects(sendCoins(wallet, { network: 'mainnet' }, new PrivateKey(43).toPublicKey().toAddress(), '0.00000001', { stage: 0 }, () => {}), /unfinished wallet action/)
  }
})
