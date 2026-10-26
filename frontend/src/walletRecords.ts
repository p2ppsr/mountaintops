import { LocalKVStore, Utils, type WalletInterface } from '@bsv/sdk'
import type { Network } from '../../shared/brc234.ts'

export const RECORD_BASKET = 'mntops v1'
export type RecoveryRecord = { v: 1; network: Network; kind: 'address' | 'primary' | 'retirement' | 'checkpoint' | 'search' | 'history' | 'action'; clock: number; data: Record<string, unknown>; serial?: string }

// Immutable, encrypted PushDrop entries. Independent keys make address and
// retirement records a union across devices, without a shared mutable manifest.
// All discovery and decryption uses the BRC-100 wallet; no browser persistence.
export class WalletRecords {
  private readonly kv: LocalKVStore
  readonly wallet: WalletInterface
  readonly identityKey: string
  readonly network: Network
  constructor(wallet: WalletInterface, identityKey: string, network: Network) {
    this.wallet = wallet; this.identityKey = identityKey; this.network = network
    this.kv = new LocalKVStore(wallet, RECORD_BASKET, true, undefined, false)
  }

  async load(): Promise<RecoveryRecord[]> {
    const records: RecoveryRecord[] = []
    const seen = new Set<string>()
    for (let offset = 0; ; offset += 100) {
      if (offset >= 10_000) throw new Error('Recovery record limit reached; wallet records were not truncated.')
      const page = await this.wallet.listOutputs({ basket: RECORD_BASKET, includeTags: true, limit: 100, offset })
      const total = Number(page.totalOutputs)
      if (!Number.isSafeInteger(total) || String(total) !== String(page.totalOutputs) || total < page.outputs.length) throw new Error('Wallet returned incomplete recovery metadata')
      for (const output of page.outputs) {
        const keys = output.tags?.filter(x => /^r[a-f0-9]{24}$/.test(x)) ?? []
        if (keys.length !== 1 || seen.has(keys[0])) throw new Error('Ambiguous PushDrop recovery record; no data was discarded')
        seen.add(keys[0])
        // LocalKVStore authenticates the exact PushDrop source, controller,
        // signature, amount, and encrypted value against the wallet's BEEF.
        const payload = await this.kv.get(keys[0])
        if (!payload || payload.length > 64_000) throw new Error('Missing or invalid encrypted recovery record')
        const record = JSON.parse(payload) as RecoveryRecord
        if (record.v !== 1 || !['mainnet', 'testnet'].includes(record.network) ||
            !['address', 'primary', 'retirement', 'checkpoint', 'search', 'history', 'action'].includes(record.kind) ||
            !Number.isSafeInteger(record.clock) || record.clock < 1 || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) throw new Error('Unsupported wallet recovery record')
        if (record.network === this.network) records.push({ ...record, serial: output.outpoint })
      }
      if (offset + page.outputs.length >= total) break
      if (page.outputs.length !== 100) throw new Error('Wallet recovery pagination is incomplete')
    }
    return records.sort((a, b) => a.clock - b.clock || (a.serial ?? '').localeCompare(b.serial ?? ''))
  }

  async append(kind: RecoveryRecord['kind'], data: RecoveryRecord['data']): Promise<RecoveryRecord[]> {
    const before = await this.load()
    const record: RecoveryRecord = { v: 1, network: this.network, kind, clock: Math.max(0, ...before.map(x => x.clock)) + 1, data }
    const payload = JSON.stringify(record)
    if (payload.length > 64_000) throw new Error('Recovery record is too large')
    const key = `r${Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(12))))}`
    const outpoint = await this.kv.set(key, payload)
    if (await this.kv.get(key) !== payload) throw new Error('Wallet did not acknowledge the encrypted recovery record. Do not publish this address.')
    const after = await this.load()
    if (!after.some(x => x.serial === outpoint)) throw new Error('Wallet recovery record could not be read back')
    return after
  }
}
