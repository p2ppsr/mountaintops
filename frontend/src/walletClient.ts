import { WalletClient, WalletWireTransceiver } from '@bsv/sdk'

// SDK 4 changed binary listOutputs responses. Existing desktop wallets also
// expose the standard JSON interface, whose named fields avoid that mismatch.
// Keep the same WalletClient object so LocalKVStore and all callers share it.
export async function preferCompatibleTransport(client: WalletClient, json = new WalletClient('json-api')): Promise<void> {
  await client.connectToSubstrate()
  if (!(client.substrate instanceof WalletWireTransceiver)) return
  try { await json.getVersion({}) } catch { return }
  const [originalKey, originalNetwork, jsonKey, jsonNetwork] = await Promise.all([
    client.getPublicKey({ identityKey: true }), client.getNetwork({}),
    json.getPublicKey({ identityKey: true }), json.getNetwork({})
  ])
  if (originalKey.publicKey !== jsonKey.publicKey || originalNetwork.network !== jsonNetwork.network) {
    throw new Error('Wallet connections refer to different accounts or networks. Select the same wallet before continuing.')
  }
  client.substrate = json.substrate
}
