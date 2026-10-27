import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PrivateKey } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { FixtureWallet } from './fixtureWallet.mjs'
import { WalletRecords } from '../src/walletRecords.ts'
import { sendCoins } from '../src/actions.ts'
import { assertWalletActionFinal, unfinishedWalletActions } from '../src/walletActionState.ts'
import { ACTION_LABEL, RECORD_LABEL, RECEIPT_LABEL } from '../src/walletScopes.ts'
import { publicDeriver } from '../src/derivation.ts'

const manifest = JSON.parse(fs.readFileSync(new URL('../public/manifest.json', import.meta.url)))
const group = manifest.metanet.groupPermissions
const labelNames = [ACTION_LABEL, RECORD_LABEL, RECEIPT_LABEL]
const coveredProtocol = (protocolID, counterparty = 'self') => group.protocolPermissions.some(x => x.protocolID[0] === protocolID[0] && x.protocolID[1] === protocolID[1] && (protocolID[0] === 1 || x.counterparty === counterparty))

function scopedWallet(wallet) {
  return new Proxy(wallet, { get(target, method) {
    const value = target[method]
    if (typeof value !== 'function') return value
    return async (...args) => {
      const request = args[0] ?? {}
      if (request.identityKey) assert.ok(coveredProtocol([1, 'identity key retrieval']))
      if (request.protocolID) assert.ok(coveredProtocol(request.protocolID, request.counterparty), `Undeclared protocol ${request.protocolID}`)
      const baskets = [request.basket, ...(request.outputs ?? []).map(x => x.basket ?? x.insertionRemittance?.basket)].filter(Boolean)
      for (const basket of baskets) assert.ok(group.basketAccess.some(x => x.basket === basket), `Undeclared basket ${basket}`)
      for (const label of request.labels ?? []) {
        assert.ok(labelNames.includes(label), `Request-specific permission label ${label}`)
        assert.ok(coveredProtocol([1, `action label ${label}`]))
      }
      if (method === 'createAction') assert.ok(group.spendingAuthorization.amount > 0)
      return value.apply(target, args)
    }
  } })
}

test('manifest uses current grouped schema and a consistent authored mountain logo', () => {
  assert.equal(manifest.name, 'Mountaintops')
  assert.equal(manifest.metanet.schemaVersion, 1)
  assert.equal(manifest.babbage, undefined)
  assert.equal(group.certificateAccess, undefined)
  assert.equal(manifest.metanet.counterpartyPermissions, undefined)
  assert.equal(group.spendingAuthorization.amount, 100000)
  assert.match(group.spendingAuthorization.description, /100,000 satoshis per month/)
  assert.deepEqual(group.basketAccess.map(x => x.basket).sort(), ['mntops v1', 'mountaintops receipts v1'])
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(html, /rel="manifest" href="\/manifest.json"/)
  assert.match(html, /rel="icon"[^>]+href="\/mountaintops.svg"/)
  assert.match(app, /className="mountain-mark" src="\/mountaintops.svg"/)
  assert.doesNotMatch(html, /vite.svg/)
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(x => x.sizes === `${size}x${size}`)
    const bytes = fs.readFileSync(new URL(`../public${icon.src}`, import.meta.url))
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size)
  }
})

test('real SDK encrypted save, fresh recovery, derivation and payment use only declared scopes', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async url => String(url).endsWith('/spent') ? new Response('', { status: 404 }) : Response.json({ blocks: 972777, bestblockhash: 'a'.repeat(64) })
  try {
    const raw = new FixtureWallet(), wallet = scopedWallet(raw)
    const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
    await wallet.getPublicKey({ protocolID: [1, 'mountaintops'], keyID: '1', counterparty: 'anyone', forSelf: true })
    const store = new WalletRecords(wallet, identity, 'mainnet')
    await store.append('address', { keyID: '17', address: publicDeriver(identity)('17', 'mainnet'), targetStage: 0, useForReceiving: true })
    const restored = new WalletRecords(scopedWallet(new FixtureWallet(raw.state)), identity, 'mainnet')
    assert.equal((await restored.load()).length, 1)
    await wallet.listOutputs({ basket: 'mountaintops receipts v1' })
    const txid = await sendCoins(wallet, store, new PrivateKey(43).toPublicKey().toAddress(), '0.00001000', { stage: 0, state: null }, () => {})
    const pending = await unfinishedWalletActions(wallet, 'mainnet')
    assert.equal(pending[0].data.id, txid)
    assert.deepEqual(raw.state.actions.at(-1).labels, [ACTION_LABEL])
    assert.deepEqual(raw.state.actions[0].labels, [ACTION_LABEL, RECORD_LABEL])
  } finally { globalThis.fetch = previous }
})

test('wallet permission manager groups every declared capability, with no individual fallback', { timeout: 10000 }, async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    assert.equal(String(url), 'http://localhost/manifest.json')
    return Response.json(manifest)
  }
  try {
    const requests = [
      ...group.protocolPermissions.map(p => manager => manager.ensureProtocolPermission({ originator: 'localhost', privileged: false, protocolID: p.protocolID, counterparty: p.counterparty ?? 'self', usageType: 'generic' })),
      ...group.basketAccess.map(b => manager => manager.ensureBasketAccess({ originator: 'localhost', basket: b.basket, usageType: 'listing' })),
      manager => manager.ensureSpendingAuthorization({ originator: 'localhost', satoshis: 1000 })
    ]
    for (const request of requests) {
      const manager = new WalletPermissionsManager(new FixtureWallet(), 'wallet.test')
      let grouped = 0, individual = 0, callbackError
      manager.bindCallback('onGroupedPermissionRequested', async r => {
        grouped++
        try {
          // A self-only Level 2 renewal may use the wallet's narrower grouped
          // path. The first identity request presents the complete app group.
          if (r.requestID.startsWith('group-peer:')) {
            assert.deepEqual(r.permissions.protocolPermissions, group.protocolPermissions.filter(x => x.protocolID[0] === 2))
          } else {
            assert.equal(r.permissions.protocolPermissions.length, group.protocolPermissions.length)
            assert.equal(r.permissions.basketAccess.length, 2)
            assert.equal(r.permissions.spendingAuthorization.amount, 100000)
          }
        } catch (error) { callbackError = error }
        finally { await manager.denyGroupedPermission(r.requestID) }
      })
      for (const event of ['onProtocolPermissionRequested', 'onBasketAccessRequested', 'onSpendingAuthorizationRequested']) manager.bindCallback(event, async r => { individual++; await manager.denyPermission(r.requestID) })
      // Deny in the disposable manager so the test creates no permission tokens.
      await assert.rejects(request(manager), error => error.code === 'ERR_PERMISSION_DENIED')
      if (callbackError) throw callbackError
      assert.equal(grouped, 1); assert.equal(individual, 0)
    }
  } finally { globalThis.fetch = previous }
})

test('legacy and new pending actions resolve using one fixed label across pages', async () => {
  const actions = Array.from({ length: 101 }, (_, i) => ({ txid: i.toString(16).padStart(64, '0'), status: 'failed', labels: [ACTION_LABEL] }))
  actions[100].labels.push('mountaintops request old-request')
  const wallet = { listActions: async args => {
    assert.deepEqual(args.labels, [ACTION_LABEL])
    return { totalActions: actions.length, actions: actions.slice(args.offset, args.offset + args.limit) }
  } }
  await assertWalletActionFinal(wallet, { id: 'old-request' })
  await assertWalletActionFinal(wallet, { txid: actions[100].txid })
  actions[100].status = 'unproven'
  await assert.rejects(assertWalletActionFinal(wallet, { id: 'old-request' }), /no final result/)
  await assert.rejects(assertWalletActionFinal(wallet, { txid: 'f'.repeat(64) }), /no final result/)
  await assert.rejects(unfinishedWalletActions({ listActions: async () => ({ totalActions: 200, actions: [] }) }, 'mainnet'), /incomplete/)
})
