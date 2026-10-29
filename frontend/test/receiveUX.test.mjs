import assert from 'node:assert/strict'
import test from 'node:test'
import { ANCHOR_HEIGHT, NOTICE_SECONDS, eligibilityTime, assertReceivable } from '../../shared/brc234.ts'
import { calendarEstimate, stageEstimate, expirationEstimate, monthYear, receivingKeyID } from '../src/receiveUX.ts'
import { readCoverage } from '../src/coverageClient.ts'

const anchor = Date.parse('2030-08-31T12:34:56Z') / 1000
const coverage = { network: 'mainnet', height: ANCHOR_HEIGHT - 144, anchorMtp: null, tipMtp: anchor - 86400 }

test('pre-anchor estimates project from validated chain time, including the notice round and following block', () => {
  const calendar = calendarEstimate(coverage)
  assert.deepEqual(calendar, { anchor, projectedAnchor: true })
  assert.deepEqual(stageEstimate(0, calendar), { time: anchor, height: ANCHOR_HEIGHT })
  assert.equal(stageEstimate(1, calendar).time, eligibilityTime(anchor, 1) + NOTICE_SECONDS)
  assert.equal(expirationEstimate(0, calendar), 'Not earlier than March 2031')
  for (let stage = 1; stage <= 27; stage++) {
    const current = stageEstimate(stage, calendar)
    assert.ok(current.time > stageEstimate(stage - 1, calendar).time)
    assert.equal(current.height, ANCHOR_HEIGHT + Math.ceil((current.time - anchor) / 600) + 1)
  }
  assert.equal(stageEstimate(27, calendar).time, eligibilityTime(anchor, 27) + NOTICE_SECONDS)
  assert.equal(expirationEstimate(27, calendar), 'No expiration scheduled')
  assert.equal(monthYear(Date.parse('2031-03-01T00:00:00Z') / 1000), 'March 2031')
})

test('actual anchor replaces the projection, testnet and missing chain evidence never invent dates', () => {
  assert.deepEqual(calendarEstimate({ ...coverage, height: 1000002, anchorMtp: anchor + 50 }), { anchor: anchor + 50, projectedAnchor: false })
  for (const unknown of [{ ...coverage, tipMtp: undefined }, { ...coverage, network: 'testnet' }, { ...coverage, height: 1000001 }]) assert.equal(calendarEstimate(unknown), null)
  assert.equal(expirationEstimate(0, null), 'Expiration estimate unavailable')
  // Calendar presentation cannot disable a valid address or reactivate an expired one.
  const entry = { keyID: '1', address: '1Ktest', network: 'mainnet', retiredAt: null }
  assert.doesNotThrow(() => assertReceivable(entry, 0))
  assert.throws(() => assertReceivable({ ...entry, retiredAt: { height: 1000002 } }, 0), /Expired/)
})

test('free session choices survive refresh, fresh sessions default deterministically, and expired choices fall back', () => {
  const book = [
    { keyID: '1', address: '1Ktest', network: 'mainnet', retiredAt: null },
    { keyID: '18', address: '1Chitest', network: 'mainnet', retiredAt: null },
    { keyID: '17', address: '1Chitest', network: 'mainnet', retiredAt: null }
  ]
  assert.equal(receivingKeyID(book, 0), '17')
  assert.equal(receivingKeyID([...book].reverse(), 0), '17')
  assert.equal(receivingKeyID(book, 0, '1'), '1')
  assert.equal(receivingKeyID(book, 1, '1'), '17')
  book[2].retiredAt = { height: 1000002 }
  assert.equal(receivingKeyID(book, 0, '17'), '18')
  assert.equal(receivingKeyID(book, 27), null)
  assert.equal(receivingKeyID(book.map(x => ({ ...x, retiredAt: { height: 1000002 } })), 0), null)
})

test('pre-anchor calendar lookup validates tip identity, remains read-only and fails independently of coverage', async () => {
  const previous = globalThis.fetch
  let mode = 'valid', writes = 0
  const calls = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (String(url).endsWith('/chain/info')) return Response.json({ blocks: coverage.height, bestblockhash: 'a'.repeat(64) })
    if (mode === 'unavailable') throw new Error('Display estimate unavailable')
    return Response.json({ height: coverage.height, hash: (mode === 'reorg' ? 'b' : 'a').repeat(64), previousblockhash: 'c'.repeat(64), mediantime: coverage.tipMtp })
  }
  const store = { append: async () => { writes++; throw new Error('Unexpected wallet transaction') } }
  try {
    const fresh = await readCoverage('mainnet', [], store)
    assert.equal(fresh.tipMtp, coverage.tipMtp)
    assert.equal(calendarEstimate(fresh).anchor, anchor)
    for (mode of ['reorg', 'unavailable']) {
      const incomplete = await readCoverage('mainnet', [], store)
      assert.equal(incomplete.stage, 0)
      assert.equal(calendarEstimate(incomplete), null)
    }
    calls.length = 0
    assert.equal(calendarEstimate(await readCoverage('testnet', [], store)), null)
    assert.equal(calls.length, 1)
    assert.equal(writes, 0)
  } finally { globalThis.fetch = previous }
})
