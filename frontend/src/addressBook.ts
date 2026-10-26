import { P2PKH, Utils } from '@bsv/sdk'
import { addressMatches, assertReceivable, canonicalKeyID, type AddressRecord, type Network } from '../../shared/brc234.ts'
import { publicDeriver } from './derivation.ts'
import type { Activation, Coverage } from './coverageClient.ts'
import type { RecoveryRecord, WalletRecords } from './walletRecords.ts'

export function validateAddress(address: string, network: Network): void {
  const decoded = Utils.fromBase58Check(address)
  if (!Array.isArray(decoded.prefix) || !Array.isArray(decoded.data)) throw new Error('Address decoder returned an unsupported representation')
  const expected = network === 'mainnet' ? 0 : 111
  if (decoded.prefix.length !== 1 || decoded.prefix[0] !== expected || decoded.data.length !== 20 ||
      Utils.toBase58Check(decoded.data, decoded.prefix) !== address) throw new Error('Enter a checksum-valid P2PKH address for the connected network.')
  new P2PKH().lock(address)
}

export function bookFromRecords(identity: string, network: Network, records: RecoveryRecord[]): AddressRecord[] {
  const derive = publicDeriver(identity)
  const book = new Map<string, AddressRecord>()
  book.set('1', { keyID: '1', address: derive('1', network), network, targetStage: 0, retiredAt: null })
  for (const record of records) {
    if (record.kind !== 'address') continue
    const keyID = canonicalKeyID(String(record.data.keyID))
    const address = derive(keyID, network)
    if (record.data.address !== address || !Number.isInteger(record.data.targetStage) || Number(record.data.targetStage) < 0 || Number(record.data.targetStage) > 27) throw new Error('Stored address does not match wallet derivation')
    book.set(keyID, { keyID, address, network, targetStage: Number(record.data.targetStage), retiredAt: null })
  }
  for (const record of records) {
    if (record.kind !== 'retirement') continue
    const keyID = canonicalKeyID(String(record.data.keyID))
    const entry = book.get(keyID)
    if (!entry) throw new Error('Recovery data is missing a retired address')
    const boundary = record.data.boundary as AddressRecord['retiredAt']
    if (!boundary || !Number.isSafeInteger(boundary.height) || boundary.height < 1_000_001 || boundary.lastReceiveHeight !== boundary.height - 1 || !/^[a-f0-9]{64}$/.test(boundary.hash) || !Number.isSafeInteger(boundary.mtp)) throw new Error('Invalid stored expiration boundary')
    if (!entry.retiredAt || boundary.height < entry.retiredAt.height) entry.retiredAt = boundary
  }
  return [...book.values()].sort((a, b) => BigInt(a.keyID) < BigInt(b.keyID) ? -1 : 1)
}

function exclusion(entry: AddressRecord, activations: Activation[]): AddressRecord['retiredAt'] {
  if (entry.network !== 'mainnet') return null
  const event = activations.find(x => !addressMatches(entry.address, x.stage))
  return event ? { height: event.height, hash: event.hash, mtp: event.mtp, lastReceiveHeight: event.height - 1 } : null
}

export async function applyExpirations(book: AddressRecord[], coverage: Coverage, store: WalletRecords): Promise<string | null> {
  let warning: string | null = null
  for (const entry of book) {
    if (entry.retiredAt) continue
    const boundary = exclusion(entry, coverage.activations)
    if (boundary) {
      entry.retiredAt = boundary
      try { await store.append('retirement', { keyID: entry.keyID, boundary }) }
      catch { warning = 'Wallet could not save expiration records. Receiving is blocked until they are saved. Historical funds remain accessible; wallet record fees may require a funded wallet.' }
    }
    if (entry.network === 'mainnet' && !addressMatches(entry.address, coverage.stage) && !entry.retiredAt) throw new Error('Expiration boundary unavailable; this address cannot be used for receiving.')
  }
  return warning
}

export function primaryFromRecords(book: AddressRecord[], records: RecoveryRecord[], stage: number): string | null {
  const selected = records.filter(x => x.kind === 'primary').at(-1)?.data.keyID ?? '1'
  const entry = book.find(x => x.keyID === selected)
  if (!entry) return null
  try { assertReceivable(entry, stage); return entry.keyID } catch { return null }
}
