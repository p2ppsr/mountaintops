import type { WalletInterface } from '@bsv/sdk'
import type { RecoveryRecord, WalletRecords } from './walletRecords.ts'

export async function unfinishedWalletActions(wallet: WalletInterface, network: WalletRecords['network']): Promise<RecoveryRecord[]> {
  const pending: RecoveryRecord[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await wallet.listActions({ labels: ['mountaintops actions v1'], includeLabels: true, limit: 100, offset })
    for (const action of page.actions) {
      if (!['unsigned', 'nosend', 'nonfinal', 'unprocessed', 'sending', 'unproven'].includes(action.status)) continue
      if (action.status === 'unproven' && action.labels?.includes('mountaintops record v1')) continue
      const id = action.labels?.find(x => x.startsWith('mountaintops request '))?.slice(21) ?? action.txid
      const canAbort = action.status === 'nosend' && /^[a-f0-9]{64}$/.test(action.txid)
      pending.push({ v: 1, network, kind: 'action', clock: 0, data: { id, state: canAbort ? 'prepared' : 'needs wallet review', reference: canAbort ? action.txid : null, txid: action.txid } })
    }
    if (offset + page.actions.length >= page.totalActions) break
    if (page.actions.length !== 100 || offset >= 10000) throw new Error('Wallet action history is incomplete. Check the wallet before another payment.')
  }
  return pending
}

