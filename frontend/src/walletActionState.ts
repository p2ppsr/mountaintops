import type { WalletInterface } from '@bsv/sdk'
import type { RecoveryRecord, WalletRecords } from './walletRecords.ts'
import { ACTION_LABEL, RECORD_LABEL } from './walletScopes.ts'

async function walletActions(wallet: WalletInterface) {
  const actions = []
  for (let offset = 0; ; offset += 100) {
    const page = await wallet.listActions({ labels: [ACTION_LABEL], includeLabels: true, limit: 100, offset })
    if (!Number.isSafeInteger(page.totalActions) || page.totalActions < offset + page.actions.length) throw new Error('Wallet action history is incomplete. Check the wallet before another payment.')
    actions.push(...page.actions)
    if (offset + page.actions.length >= page.totalActions) return actions
    if (page.actions.length !== 100 || offset >= 10000) throw new Error('Wallet action history is incomplete. Check the wallet before another payment.')
  }
}

export async function assertWalletActionFinal(wallet: WalletInterface, action: Record<string, unknown>): Promise<void> {
  // Read legacy UUID labels from results without requesting that dynamic scope.
  const actions = (await walletActions(wallet)).filter(x => action.txid
    ? x.txid === action.txid
    : typeof action.id === 'string' && x.labels?.includes(`mountaintops request ${action.id}`))
  if (!actions.length || actions.some(x => !['completed', 'failed'].includes(x.status))) throw new Error('Your wallet has no final result yet. Do not retry this payment.')
}

export async function unfinishedWalletActions(wallet: WalletInterface, network: WalletRecords['network']): Promise<RecoveryRecord[]> {
  const pending: RecoveryRecord[] = []
  for (const action of await walletActions(wallet)) {
    if (!['unsigned', 'nosend', 'nonfinal', 'unprocessed', 'sending', 'unproven'].includes(action.status)) continue
    if (action.status === 'unproven' && action.labels?.includes(RECORD_LABEL)) continue
    const id = action.labels?.find(x => x.startsWith('mountaintops request '))?.slice(21) ?? action.txid
    const canAbort = action.status === 'nosend' && /^[a-f0-9]{64}$/.test(action.txid)
    pending.push({ v: 1, network, kind: 'action', clock: 0, data: { id, state: canAbort ? 'prepared' : 'needs wallet review', reference: canAbort ? action.txid : null, txid: action.txid } })
  }
  return pending
}

