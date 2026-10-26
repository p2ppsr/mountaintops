import assert from 'node:assert/strict'
import test from 'node:test'
import { PrivateKey, Utils, WalletClient, WalletWireTransceiver } from '@bsv/sdk'
import { preferCompatibleTransport } from '../src/walletClient.ts'
import { FixtureWallet } from './fixtureWallet.mjs'

function legacyClient(wallet) {
  return new WalletClient(new WalletWireTransceiver({ transmitToWallet: async frame => {
    if (frame[0] === 27) return [0, 0] // mainnet
    if (frame[0] === 8) return [0, ...Utils.toArray((await wallet.getPublicKey({ identityKey: true })).publicKey, 'hex')]
    if (frame[0] === 6) {
      const writer = new Utils.Writer()
      writer.writeUInt8(0).writeVarIntNum(1).writeVarIntNum(-1)
      writer.write(new Array(32).fill(1)).writeVarIntNum(0).writeVarIntNum(1)
      // Pre-v4: no spendable byte between script and custom instructions.
      writer.writeVarIntNum(-1).writeVarIntNum(-1).writeVarIntNum(0).writeVarIntNum(0)
      return writer.toArray()
    }
    throw new Error(`Unexpected wire call ${frame[0]}`)
  } }))
}

test('old binary output format is replaced by validated JSON for the same wallet', async () => {
  const wallet = new FixtureWallet()
  const client = legacyClient(wallet)
  await assert.rejects(client.listOutputs({ basket: 'mntops v1' }), /spendable flag/)
  await preferCompatibleTransport(client, new WalletClient(wallet))
  assert.equal(client.substrate, wallet)
  assert.equal((await client.listOutputs({ basket: 'mntops v1' })).totalOutputs, 0)
})
test('transport change never crosses wallet account or network boundaries', async () => {
  const original = new FixtureWallet()
  const client = legacyClient(original)
  const before = client.substrate
  const other = new FixtureWallet(undefined, new PrivateKey(43))
  await assert.rejects(preferCompatibleTransport(client, new WalletClient(other)), /different accounts or networks/)
  assert.equal(client.substrate, before)
  original.getNetwork = async () => ({ network: 'testnet' })
  await assert.rejects(preferCompatibleTransport(client, new WalletClient(original)), /different accounts or networks/)
  assert.equal(client.substrate, before)
})
test('native CWI and unavailable JSON leave the selected transport intact', async () => {
  const wallet = new FixtureWallet()
  const client = new WalletClient(wallet)
  const unavailable = new WalletClient({ getVersion: async () => { throw new Error('Unavailable') } })
  await preferCompatibleTransport(client, unavailable)
  assert.equal(client.substrate, wallet)
  const binary = legacyClient(wallet)
  const before = binary.substrate
  await preferCompatibleTransport(binary, unavailable)
  assert.equal(binary.substrate, before)
})
