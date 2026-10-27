import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { PushDrop, Utils } from '@bsv/sdk'
import { WalletRecords, RECORD_BASKET } from '../src/walletRecords.ts'
import { FixtureWallet, walletState } from './fixtureWallet.mjs'

const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async url => { if (String(url).endsWith('/spent')) return new Response('', { status: 404 }); throw new Error('Unexpected fixture request: ' + url) } })
after(() => { globalThis.fetch = originalFetch })

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

test('one encrypted publication restores both a new address and its selection', async () => {
  const { publicDeriver } = await import('../src/derivation.ts')
  const { bookFromRecords, primaryFromRecords } = await import('../src/addressBook.ts')
  const state = walletState(), wallet = new FixtureWallet(state)
  const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const address = publicDeriver(identity)('17', 'mainnet')
  await new WalletRecords(wallet, identity, 'mainnet').append('address', { keyID: '17', address, targetStage: 0, useForReceiving: true })
  const restored = await new WalletRecords(new FixtureWallet(state), identity, 'mainnet').load()
  const book = bookFromRecords(identity, 'mainnet', restored)
  assert.deepEqual(book.map(x => x.keyID), ['1', '17'])
  assert.equal(primaryFromRecords(book, restored, 0), '17')
  assert.equal(restored.length, 1)
  assert.equal([...state.outputs.values()].filter(x => x.basket === RECORD_BASKET).length, 1)
  assert.equal(state.actions.length, 1)
})

test('combined publication and legacy selections follow the same order and never reactivate retirement', async () => {
  const { publicDeriver } = await import('../src/derivation.ts')
  const { bookFromRecords, primaryFromRecords } = await import('../src/addressBook.ts')
  const wallet = new FixtureWallet(), identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const derive = publicDeriver(identity)
  const records = [
    { kind: 'address', data: { keyID: '17', address: derive('17', 'mainnet'), targetStage: 0 } },
    { kind: 'primary', data: { keyID: '17' } },
    { kind: 'address', data: { keyID: '18', address: derive('18', 'mainnet'), targetStage: 0, useForReceiving: true } }
  ]
  const book = bookFromRecords(identity, 'mainnet', records)
  assert.equal(primaryFromRecords(book, records.slice(0, 2), 0), '17')
  assert.equal(primaryFromRecords(book, records, 0), '18')
  assert.equal(primaryFromRecords(book, [...records, { kind: 'primary', data: { keyID: '1' } }], 0), '1')
  book.find(x => x.keyID === '18').retiredAt = { height: 1000002, lastReceiveHeight: 1000001, hash: 'f'.repeat(64), mtp: 123 }
  assert.equal(primaryFromRecords(book, records, 0), null)
})


for (const afterSigning of [false, true]) test(`recovery record rejects spent wallet inputs ${afterSigning ? 'after signing' : 'before signing'} without publication`, async () => {
  const { P2PKH, PrivateKey, Transaction, UnlockingScript } = await import('@bsv/sdk')
  const wallet = new FixtureWallet(), identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const [point] = [...wallet.state.outputs.keys()], [sourceTXID, index] = point.split('.')
  const conflict = new Transaction(1, [{ sourceTXID, sourceOutputIndex: Number(index), sequence: 0xffffffff, unlockingScript: new UnlockingScript() }], [{ satoshis: 9999990, lockingScript: new P2PKH().lock(new PrivateKey(44).toPublicKey().toAddress()) }])
  let signed = false, aborts = 0, submissions = 0
  const create = wallet.createAction.bind(wallet), sign = wallet.signAction.bind(wallet)
  wallet.createAction = async args => { if (args.options?.sendWith) submissions++; else assert.equal(args.options.noSend, true); return create(args) }
  wallet.signAction = async args => { signed = true; assert.equal(args.options.noSend, true); return sign(args) }
  wallet.abortAction = async () => { aborts++; return { aborted: true } }
  const previous = globalThis.fetch
  globalThis.fetch = async url => String(url).endsWith('/spent') ? (!afterSigning || signed ? Response.json({ txid: conflict.id('hex'), vin: 0, status: 'confirmed' }) : new Response('', { status: 404 })) : new Response(conflict.toHex())
  try {
    await assert.rejects(new WalletRecords(wallet, identity, 'mainnet').append('address', { keyID: '17', address: 'fixture', targetStage: 0 }), /wallet chose coins that have already been spent/)
    assert.equal(signed, afterSigning); assert.equal(aborts, 1); assert.equal(submissions, 0)
  } finally { globalThis.fetch = previous }
})

// A fresh app must see abandoned record preparations without treating an
// acknowledged broadcast as a second payment or persisting UI history.
test('native unfinished record actions survive a new app session and block another save', async () => {
  const { unfinishedWalletActions } = await import('../src/walletActionState.ts')
  const wallet = new FixtureWallet(), identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const labels = ['mountaintops actions v1', 'mountaintops record v1', 'mountaintops request fixture']
  let status = 'nosend', creates = 0
  wallet.listActions = async () => ({ totalActions: 1, actions: [{ txid: 'a'.repeat(64), labels, status }] })
  wallet.createAction = async () => { creates++; throw new Error('Unexpected action') }
  const pending = await unfinishedWalletActions(wallet, 'mainnet')
  assert.equal(pending[0].data.reference, 'a'.repeat(64))
  await assert.rejects(new WalletRecords(wallet, identity, 'mainnet').append('primary', { keyID: '17' }), /unfinished wallet action/)
  assert.equal(creates, 0)
  status = 'unproven'
  assert.deepEqual(await unfinishedWalletActions(wallet, 'mainnet'), [])
})
