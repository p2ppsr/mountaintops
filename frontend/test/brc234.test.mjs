import test from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { addressMatches, transactionMatches, scriptHashMatches, addCalendarMonths, eligibilityTime, anchorState, advanceChain, assertReceivable, coverageLabel, canonicalKeyID, suggestedStage } from '../../shared/brc234.ts'
import { publicDeriver, firstMatch } from '../src/derivation.ts'
import { validateAddress, bookFromRecords, primaryFromRecords } from '../src/addressBook.ts'
import { parseSatoshis } from '../src/actions.ts'

test('normative address sets distinguish Base58 characters and case', () => {
  for (const c of '6789ABCDEFGH') assert.equal(addressMatches(`1${c}rest`, 1), true)
  for (const c of '12345IJKLMabcdefgh') assert.equal(addressMatches(`1${c}rest`, 1), false)
  assert.equal(addressMatches('1Chirest', 17), true)
  assert.equal(addressMatches('1Chjrest', 17), false)
  assert.equal(addressMatches('1ChickenNuggetrest', 27), true)
  assert.equal(addressMatches('1ChickenNuggerrest', 27), false)
})
test('TXIDs use display-order bits and exact version 1 from stage 13', () => {
  assert.equal(transactionMatches('8' + '0'.repeat(63), 2, 1), true)
  assert.equal(transactionMatches('0'.repeat(63) + '8', 1, 1), false)
  for (const version of [0, 2, 3, -1, 0x7fffffff]) assert.equal(transactionMatches('9'.repeat(64), version, 13), false)
  assert.equal(transactionMatches('9'.repeat(64), 1, 27), true)
  assert.equal(transactionMatches('9'.repeat(12) + '8' + '0'.repeat(51), 1, 27), false)
  assert.equal(scriptHashMatches('7'.repeat(18) + '6' + '0'.repeat(21), 27), true)
  assert.equal(scriptHashMatches('7'.repeat(18) + '5' + '0'.repeat(21), 27), false)
})
test('calendar math clamps from the UTC anchor, with exact final gate', () => {
  const anchor = Date.parse('2030-08-31T12:34:56Z') / 1000
  assert.equal(new Date(addCalendarMonths(anchor, 6) * 1000).toISOString(), '2031-02-28T12:34:56.000Z')
  assert.equal(eligibilityTime(anchor, 1), addCalendarMonths(anchor, 6))
  assert.equal(eligibilityTime(anchor, 27), addCalendarMonths(anchor, 78))
})
test('volume gate, frozen target, 14 MTP days and following-block activation', () => {
  const time = Date.parse('2030-01-01Z') / 1000
  let state = anchorState({ height: 1_000_000, hash: 'a', parentHash: 'p', mtp: time })
  const step = (mtp, count) => { state = advanceChain(state, { height: state.height + 1, hash: `h${state.height + 1}`, parentHash: state.hash, mtp, nonCoinbaseCount: count }); return state }
  const gate = eligibilityTime(time, 17)
  assert.equal(step(gate, '399999').pending, null)
  assert.equal(step(gate, '1').pending.target, 1)
  const deadline = state.pending.deadline
  assert.equal(step(deadline, '8000000000').stage, 0)
  const activated = step(deadline, '0')
  assert.equal(activated.stage, 1)
  assert.equal(activated.pending.target, 17)
  assert.equal(activated.pending.deadline, deadline + 1_209_600)
  assert.throws(() => advanceChain(state, { height: state.height + 1, hash: 'fork', parentHash: 'wrong', mtp: deadline, nonCoinbaseCount: '1' }), /Unlinked/)
})
test('retirement is sticky while coins and testnet semantics stay distinct', () => {
  const entry = { address: '1Ktest', keyID: '1', network: 'mainnet', targetStage: 0, retiredAt: { hash: 'f'.repeat(64), height: 1_000_002, mtp: 1, lastReceiveHeight: 1_000_001 } }
  assert.throws(() => assertReceivable(entry, 0), /Expired/)
  assert.match(coverageLabel(entry.address, 'mainnet', null, entry.retiredAt), /do not send/)
  assert.match(coverageLabel(entry.address, 'mainnet', null, null), /not yet determined/)
  assert.match(coverageLabel(entry.address, 'testnet', null, null), /no testnet sunset/)
})
test('public-only derivation matches the original wallet for each key, including 1', async () => {
  const wallet = new ProtoWallet(new PrivateKey(42))
  const { publicKey: identity } = await wallet.getPublicKey({ identityKey: true })
  const derive = publicDeriver(identity)
  for (let i = 1; i <= 50; i++) {
    const { publicKey } = await wallet.getPublicKey({ protocolID: [1, 'mountaintops'], keyID: String(i), counterparty: 'anyone', forSelf: true })
    const { PublicKey } = await import('@bsv/sdk')
    assert.equal(derive(String(i), 'mainnet'), PublicKey.fromString(publicKey).toAddress('mainnet'))
  }
  const result = firstMatch(identity, 8, 'mainnet', 10_000n)
  assert.ok(result)
  assert.ok(addressMatches(result.address, 8))
  for (let id = 1n; id < BigInt(result.keyID); id++) assert.equal(addressMatches(derive(id.toString(), 'mainnet'), 8), false)
  assert.equal(bookFromRecords(identity, 'mainnet', [])[0].keyID, '1')
})
test('key IDs and amounts preserve exact integers', () => {
  assert.equal(canonicalKeyID('9007199254740993'), '9007199254740993')
  for (const value of ['0', '01', '-1', '1.0', '1e3']) assert.throws(() => canonicalKeyID(value))
  assert.equal(parseSatoshis('0.00000001'), 1)
  assert.equal(parseSatoshis('1.00000001'), 100000001)
  for (const value of ['0', '-1', '1e-8', '0.000000001', ' 1', '1.']) assert.throws(() => parseSatoshis(value))
  assert.equal(suggestedStage(1000, 1), 14)
})
test('address validation rejects wrong network, checksum, whitespace and mixed casing', () => {
  validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'mainnet')
  for (const value of [' 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb']) assert.throws(() => validateAddress(value, 'mainnet'))
  assert.throws(() => validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'testnet'))
  assert.equal(primaryFromRecords([{ keyID: '1', address: '1Ktest', network: 'mainnet', targetStage: 0, retiredAt: null }], [], 1), null)
})
