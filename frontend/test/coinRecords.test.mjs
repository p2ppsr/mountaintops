import assert from 'node:assert/strict'
import test from 'node:test'
import { MerklePath, P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import { COIN_BASKET, refreshCoins, retainedCoins } from '../src/coins.ts'
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

test('active refresh reuses acknowledged evidence and still checks actual spend status and canonical roots', async () => {
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
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (String(url).includes('/unspent/all')) return Response.json({ address, result: [{ tx_hash: txid, tx_pos: 0, value: 10000, height, isSpentInMempoolTx: false }] })
    if (String(url).endsWith('/spent')) return new Response('', { status: 404 })
    if (String(url).endsWith(`/block/${height}/header`)) return Response.json({ merkleroot: txid })
    throw new Error('Unexpected proof download: ' + url)
  }
  try {
    const coins = await refreshCoins(wallet, {}, { keyID, address, network: 'mainnet', targetStage: 0, retiredAt: null }, { stage: 0, height: 972777, activations: [] }, () => {})
    assert.equal(coins.length, 1)
    assert.equal(calls.length, 3)
  } finally { globalThis.fetch = previous }
})
