import { type Transaction } from '@bsv/sdk'
import type { Network } from '../../shared/brc234.ts'
import { coinIsUnspent } from './coins.ts'

// A wallet signature or balance does not prove its added inputs are unspent.
export async function assertInputsUnspent(tx: Transaction, network: Network): Promise<void> {
  const seen = new Set<string>()
  for (const input of tx.inputs) {
    const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    const vout = input.sourceOutputIndex
    if (!txid || !/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) throw new Error('Wallet omitted input evidence. Payment stopped.')
    const outpoint = `${txid}.${vout}`
    if (seen.has(outpoint)) throw new Error('Wallet repeated an input. Payment stopped.')
    seen.add(outpoint)
    if (!(await coinIsUnspent({ network }, { txid, vout }))) throw new Error('Your wallet chose coins that have already been spent. Payment stopped. Resolve this in your wallet before trying again.')
  }
}

