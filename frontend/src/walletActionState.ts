import type { WalletAction, WalletInterface } from '@bsv/sdk'
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

function matches(action: Record<string, unknown>, row: WalletAction): boolean {
  return typeof action.txid === 'string' && action.txid !== '' ? row.txid === action.txid
    : typeof action.id === 'string' && Boolean(row.labels?.includes(`mountaintops request ${action.id}`))
}

function statusFromActions(actions: WalletAction[], action: Record<string, unknown>): 'completed' | 'failed' | 'unproven' | 'unknown' {
  const matching = actions.filter(row => matches(action, row))
  const statuses = new Set(matching.map(row => row.status))
  if (statuses.size !== 1) return 'unknown'
  const status = matching[0]?.status
  return status === 'completed' || status === 'failed' || status === 'unproven' ? status : 'unknown'
}

export async function walletActionStatus(wallet: WalletInterface, action: Record<string, unknown>): Promise<'completed' | 'failed' | 'unproven' | 'unknown'> {
  return statusFromActions(await walletActions(wallet), action)
}

export function walletStatusMessage(status: Awaited<ReturnType<typeof walletActionStatus>>): string {
  if (status === 'completed') return 'Payment confirmed by your wallet.'
  if (status === 'failed') return 'Your wallet reports this payment failed. Review wallet activity before starting another payment.'
  if (status === 'unproven') return 'Submitted; waiting for confirmation. Your wallet has not returned a mined proof yet. Do not send this payment again.'
  return 'The payment outcome is not known. Check wallet activity before continuing. Do not send it again.'
}

export async function assertWalletActionFinal(wallet: WalletInterface, action: Record<string, unknown>): Promise<void> {
  const status = await walletActionStatus(wallet, action)
  if (status !== 'completed' && status !== 'failed') throw new Error(walletStatusMessage(status))
}

function pendingFromActions(actions: WalletAction[], network: WalletRecords['network']): RecoveryRecord[] {
  const groups = new Map<string, WalletAction[]>()
  actions.forEach((action, index) => {
    const key = action.txid || action.labels?.find(label => label.startsWith('mountaintops request ')) || `unidentified ${index}`
    groups.set(key, [...(groups.get(key) ?? []), action])
  })
  const pending: RecoveryRecord[] = []
  for (const [key, group] of groups) {
    const action = group[0], statuses = new Set(group.map(row => row.status))
    const consistent = statuses.size === 1
    if (consistent && (action.status === 'completed' || action.status === 'failed')) continue
    if (consistent && action.status === 'unproven' && group.every(row => row.labels?.includes(RECORD_LABEL))) continue
    const id = action.labels?.find(label => label.startsWith('mountaintops request '))?.slice(21) ?? (action.txid || key)
    const canAbort = consistent && action.status === 'nosend' && /^[a-f0-9]{64}$/.test(action.txid)
    pending.push({ v: 1, network, kind: 'action', clock: 0, data: { id, state: canAbort ? 'prepared' : consistent && action.status === 'unproven' ? 'awaiting confirmation' : 'needs wallet review', reference: canAbort ? action.txid : null, txid: action.txid } })
  }
  return pending
}

function reconcileActionRecords(actions: WalletAction[], network: WalletRecords['network'], records: RecoveryRecord[]): RecoveryRecord[] {
  const native = pendingFromActions(actions, network)
  const carried: RecoveryRecord[] = []
  const resolved = new Set(['submitted', 'canceled', 'reviewed in wallet'])
  for (const record of records) {
    if (record.kind !== 'action') { carried.push(record); continue }
    if (resolved.has(String(record.data.state))) { if (record.clock > 0) carried.push(record); continue }
    const status = statusFromActions(actions, record.data)
    const matching = actions.filter(row => matches(record.data, row))
    const recordOnly = status === 'unproven' && matching.every(row => row.labels?.includes(RECORD_LABEL))
    if (recordOnly || status === 'completed' || status === 'failed') {
      // Resolve a legacy record only in memory; refresh never writes a token.
      if (record.clock > 0) carried.push({ ...record, data: { ...record.data, state: 'reviewed in wallet' } })
      continue
    }
    if (native.some(item => item.data.id === record.data.id || (record.data.txid && item.data.txid === record.data.txid))) continue
    // A previously observed action disappearing from history is not proof that
    // it failed. Keep the resend guard until the wallet supplies a final result.
    native.push({ ...record, data: { ...record.data, state: status === 'unproven' ? 'awaiting confirmation' : 'needs wallet review', reference: null } })
  }
  return [...carried, ...native]
}

export async function paymentActionRecords(wallet: WalletInterface, network: WalletRecords['network'], records: RecoveryRecord[]): Promise<RecoveryRecord[]> {
  return reconcileActionRecords(await walletActions(wallet), network, records)
}

export class WalletAccountChangedError extends Error {
  constructor() { super('Wallet account or network changed. Connect again to load its own records.') }
}

/** Only identity, network and action-history reads; never reload recovery state. */
export async function refreshPaymentStatus(wallet: WalletInterface, identity: string, network: WalletRecords['network'], records: RecoveryRecord[], action: Record<string, unknown>) {
  const [key, currentNetwork] = await Promise.all([wallet.getPublicKey({ identityKey: true }), wallet.getNetwork({})])
  if (key.publicKey !== identity || currentNetwork.network !== network) throw new WalletAccountChangedError()
  const actions = await walletActions(wallet)
  return { status: statusFromActions(actions, action), records: reconcileActionRecords(actions, network, records) }
}

export async function unfinishedWalletActions(wallet: WalletInterface, network: WalletRecords['network']): Promise<RecoveryRecord[]> {
  return pendingFromActions(await walletActions(wallet), network)
}
