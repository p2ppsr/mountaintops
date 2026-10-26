import { KeyDeriver, PublicKey } from '@bsv/sdk'
import { addressMatches, canonicalKeyID, type Network } from '../../shared/brc234.ts'

// Counterparty 'anyone' is private scalar 1. This derives the owner's PUBLIC
// child using the owner's identity public key, and never exports a signing key.
export function publicDeriver(identityKey: string) {
  const identity = PublicKey.fromString(identityKey)
  const anyone = new KeyDeriver('anyone')
  return (keyID: string, network: Network) => anyone.derivePublicKey([1, 'mountaintops'], canonicalKeyID(keyID), identity, false).toAddress(network)
}

export function firstMatch(identityKey: string, stage: number, network: Network, maximum: bigint): { keyID: string; address: string } | null {
  const derive = publicDeriver(identityKey)
  for (let id = 1n; id <= maximum; id++) {
    const address = derive(id.toString(), network)
    if (network !== 'mainnet' || addressMatches(address, stage)) return { keyID: id.toString(), address }
  }
  return null
}
