import assert from 'node:assert/strict'
import test from 'node:test'
import { MerklePath, P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import { availableRetainedCoins, COIN_BASKET, refreshCoins, retainedCoins } from '../src/coins.ts'
import { FixtureWallet } from './fixtureWallet.mjs'

test('tagless wallet receipts remain recoverable and are scoped to each address', async () => {
  const wallet = new FixtureWallet()
  const entries = []
  for (const keyID of ['1', '17']) {
    const pub = await wallet.getPublicKey({ protocolID: [1, 'mountaintops'], keyID, counterparty: 'anyone', forSelf: true })
    const address = PublicKey.fromString(pub.publicKey).toAddress()
    const tx = new Transaction(1, [], [{ satoshis: Number(keyID), lockingScript: new P2PKH().lock(address) }])
    const coin = { txid: tx.id('hex'), vout: 0, satoshis: Number(keyID), keyID, address, height: null }
    wallet.state.transactions.set(coin.txid, tx)
    wallet.state.outputs.set(`${coin.txid}.0`, { basket: COIN_BASKET, tags: [], satoshis: coin.satoshis, spendable: true, customInstructions: JSON.stringify({ v: 1, network: 'mainnet', ...coin }) })
    entries.push({ keyID, address, network: 'mainnet', targetStage: 0, retiredAt: null })
  }
  const original = wallet.listOutputs.bind(wallet)
  wallet.listOutputs = args => { assert.equal(args.tags, undefined); return original(args) }
  for (const entry of entries) {
    const result = await retainedCoins(wallet, entry)
    assert.equal(result.coins.length, 1)
    assert.equal(result.coins[0].keyID, entry.keyID)
    assert.ok(result.beef.findTransactionForSigning(result.coins[0].txid))
  }
  wallet.listOutputs = async args => { const page = await original(args); return { ...page, outputs: page.outputs.slice(0, 1) } }
  await assert.rejects(retainedCoins(wallet, entries[0]), /pagination is incomplete/)
})

for (const mode of ['discovery', 'restore-active', 'restore-expired', 'restore-unknown']) test(mode === 'discovery'
  ? 'active refresh reuses acknowledged evidence and checks spend status and canonical roots'
  : mode === 'restore-unknown' ? 'unknown spend state during reconnect is an error, never a zero balance'
  : `${mode} recovers wallet funds on a fresh instance without address lookups or paid records`, async () => {
  const wallet = new FixtureWallet()
  const keyID = '1'
  const pub = await wallet.getPublicKey({ protocolID: [1, 'mountaintops'], keyID, counterparty: 'anyone', forSelf: true })
  const address = PublicKey.fromString(pub.publicKey).toAddress()
  const source = new Transaction(1, [], [{ satoshis: 10000, lockingScript: new P2PKH().lock(address) }])
  const txid = source.id('hex'), height = 972000
  source.merklePath = MerklePath.fromCoinbaseTxidAndHeight(txid, height)
  wallet.state.transactions.set(txid, source)
  const coin = { txid, vout: 0, satoshis: 10000, keyID, address, height }
  wallet.state.outputs.set(`${txid}.0`, { basket: COIN_BASKET, tags: [], satoshis: 10000, spendable: true, customInstructions: JSON.stringify({ v: 1, network: 'mainnet', ...coin }) })
  wallet.internalizeAction = async () => { throw new Error('Must not reinsert acknowledged evidence') }
  wallet.createAction = async () => { throw new Error('Recovery must not create a transaction') }
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (mode === 'discovery' && String(url).includes('/unspent/all')) return Response.json({ address, result: [{ tx_hash: txid, tx_pos: 0, value: 10000, height, isSpentInMempoolTx: false }] })
    if (String(url).endsWith('/spent')) return new Response('', { status: mode === 'restore-unknown' ? 400 : 404 })
    if (String(url).endsWith(`/block/${height}/header`)) return Response.json({ merkleroot: txid })
    throw new Error('Unexpected proof download: ' + url)
  }
  try {
    const entry = { keyID, address, network: 'mainnet', targetStage: 0, retiredAt: mode === 'restore-expired' ? { height: 1000002, hash: 'f'.repeat(64), mtp: 123, lastReceiveHeight: 1000001 } : null }
    const coverage = { stage: 0, height: 972777, activations: [] }
    const fresh = new FixtureWallet(wallet.state)
    fresh.createAction = wallet.createAction; fresh.internalizeAction = wallet.internalizeAction
    if (mode === 'restore-unknown') {
      await assert.rejects(availableRetainedCoins(fresh, entry, coverage), /Spend status unknown/)
      assert.equal(calls.length, 1)
      return
    }
    const coins = mode === 'discovery' ? await refreshCoins(fresh, {}, entry, coverage, () => {}) : await availableRetainedCoins(fresh, entry, coverage)
    assert.equal(coins.length, 1)
    assert.equal(coins[0].satoshis, 10000)
    assert.equal(calls.length, mode === 'discovery' ? 3 : 2)
    if (mode !== 'discovery') assert.equal(calls.some(url => url.includes('/address/')), false)
  } finally { globalThis.fetch = previous }
})
