import { Beef, P2PKH, Transaction, type CreateActionArgs, type SignActionArgs, type WalletInterface } from '@bsv/sdk'
import { addressMatches, assertReceivable, transactionMatches, type AddressRecord } from '../../shared/brc234.ts'
import { bookFromRecords, validateAddress } from './addressBook.ts'
import { readCoverage, type Coverage } from './coverageClient.ts'
import { coinIsUnspent, retainedCoins, verifiedEvidence, type Coin } from './coins.ts'
import Importer from './Importer.ts'
import type { RecoveryRecord, WalletRecords } from './walletRecords.ts'

export function parseSatoshis(bsv: string): number {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(bsv)) throw new Error('Enter a positive BSV amount with at most 8 decimal places.')
  const [whole, fraction = ''] = bsv.split('.')
  const satoshis = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
  if (satoshis <= 0n || satoshis > 2_100_000_000_000_000n) throw new Error('Amount is outside the valid BSV range.')
  return Number(satoshis)
}

type Progress = (message: string) => void
export function assertSameTemplate(before: Transaction, after: Transaction): void {
  if (before.version !== after.version || before.lockTime !== after.lockTime || before.inputs.length !== after.inputs.length || before.outputs.length !== after.outputs.length) throw new Error('Wallet changed the authorized transaction template')
  for (let i = 0; i < before.inputs.length; i++) {
    const a = before.inputs[i], b = after.inputs[i]
    if ((a.sourceTXID ?? a.sourceTransaction?.id('hex')) !== (b.sourceTXID ?? b.sourceTransaction?.id('hex')) || a.sourceOutputIndex !== b.sourceOutputIndex || a.sequence !== b.sequence) throw new Error('Wallet changed an authorized transaction input')
  }
  for (let i = 0; i < before.outputs.length; i++) {
    const a = before.outputs[i], b = after.outputs[i]
    if (BigInt(a.satoshis ?? -1) !== BigInt(b.satoshis ?? -1) || a.lockingScript.toHex() !== b.lockingScript.toHex()) throw new Error('Wallet changed an authorized payment or change output')
  }
}
// Native wallet action history is durable before submission and does not need
// an extra fee-paying record. In particular, an empty wallet can import its first
// external coins. Signed noSend actions can be aborted by TXID on a fresh device.
export async function unfinishedWalletActions(wallet: WalletInterface, network: WalletRecords['network']): Promise<RecoveryRecord[]> {
  const pending: RecoveryRecord[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await wallet.listActions({ labels: ['mountaintops actions v1'], includeLabels: true, limit: 100, offset })
    for (const action of page.actions) {
      if (!['unsigned', 'nosend', 'nonfinal', 'unprocessed', 'sending', 'unproven'].includes(action.status)) continue
      const id = action.labels?.find(x => x.startsWith('mountaintops request '))?.slice(21) ?? action.txid
      const canAbort = action.status === 'nosend' && /^[a-f0-9]{64}$/.test(action.txid)
      pending.push({ v: 1, network, kind: 'action', clock: 0, data: { id, state: canAbort ? 'prepared' : 'needs wallet review', reference: canAbort ? action.txid : null, txid: action.txid } })
    }
    if (offset + page.actions.length >= page.totalActions) break
    if (page.actions.length !== 100 || offset >= 10000) throw new Error('Wallet action history is incomplete. Check the wallet before another payment.')
  }
  return pending
}

export async function eligibleAction(wallet: WalletInterface, store: WalletRecords, args: CreateActionArgs, coverage: Coverage, progress: Progress, coins: Coin[] = [], recipient?: string): Promise<string> {
  const id = crypto.randomUUID()
  const requestLabel = `mountaintops request ${id}`
  if ((await unfinishedWalletActions(wallet, store.network)).length) throw new Error('Review the unfinished wallet action before another payment.')
  let reference: string | undefined
  let signedTxid: string | undefined
  let submissionStarted = false
  try {
    const started = performance.now()
    let nonce = 0
    while (performance.now() - started < 30_000) {
      progress(`Preparing an eligible transaction (attempt ${nonce + 1}). Your wallet may request permission; payment fees apply to the submitted payment.`)
      const prepared = await wallet.createAction({ ...args, version: 1, lockTime: nonce++, labels: [...(args.labels ?? []), 'mountaintops actions v1', requestLabel], options: { signAndProcess: false, noSend: true, returnTXIDOnly: false, randomizeOutputs: false } })
      if (!prepared.signableTransaction) throw new Error('The wallet did not return a signable transaction; no automatic retry is safe.')
      reference = prepared.signableTransaction.reference
      const tx = Transaction.fromAtomicBEEF(prepared.signableTransaction.tx)
      if (tx.version !== 1) throw new Error('Wallet did not preserve transaction version 1')
      for (const output of args.outputs ?? []) {
        if (tx.outputs.filter(x => x.lockingScript.toHex() === output.lockingScript && BigInt(x.satoshis ?? -1) === BigInt(output.satoshis)).length !== 1) throw new Error('Wallet did not preserve the requested recipient and amount')
      }
      const spends: SignActionArgs['spends'] = {}
      for (const coin of coins) {
        const indices = tx.inputs.flatMap((input, index) => (input.sourceTXID ?? input.sourceTransaction?.id('hex')) === coin.txid && input.sourceOutputIndex === coin.vout ? [index] : [])
        if (indices.length !== 1) throw new Error('Wallet changed or duplicated a requested import input')
        const index = indices[0]
        const script = await new Importer().unlock(wallet, coin.keyID).sign(tx, index)
        spends[index] = { unlockingScript: script.toHex() }
      }
      const signed = await wallet.signAction({ reference, spends, options: { noSend: true, returnTXIDOnly: false } })
      if (!signed.tx || !signed.txid) throw new Error('Wallet omitted signed transaction evidence')
      const final = Transaction.fromAtomicBEEF(signed.tx)
      assertSameTemplate(tx, final)
      for (const [index, spend] of Object.entries(spends)) if (final.inputs[Number(index)].unlockingScript?.toHex() !== spend.unlockingScript) throw new Error('Wallet changed an import signature')
      signedTxid = final.id('hex')
      if (signedTxid !== signed.txid) throw new Error('Signed TXID mismatch')
      const target = Math.max(coverage.stage, coverage.state?.pending?.target ?? 0)
      if (!transactionMatches(signedTxid, final.version, target)) {
        const aborted = await wallet.abortAction({ reference })
        if (!aborted.aborted) throw new Error('Wallet could not release the rejected candidate; stop and check the wallet.')
        reference = undefined
        signedTxid = undefined
        continue
      }
      // Refresh immediately before releasing the transaction. Old tabs cannot
      // rely on the stage observed before a wallet permission dialog.
      const currentRecords = await store.load()
      const fresh = await readCoverage(store.network, currentRecords, store, progress)
      const freshTarget = Math.max(fresh.stage, fresh.state?.pending?.target ?? 0)
      if (!transactionMatches(signedTxid, final.version, freshTarget)) throw new Error('Coverage changed during preparation. This transaction was not submitted.')
      if (recipient) {
        validateAddress(recipient, store.network)
        if (store.identityKey) {
          const own = bookFromRecords(store.identityKey, store.network, currentRecords).find(x => x.address === recipient)
          if (own) assertReceivable(own, fresh.stage)
        }
        if (store.network === 'mainnet' && !addressMatches(recipient, fresh.stage)) throw new Error('Expired — do not send coins to this address.')
        if (fresh.state?.pending && !addressMatches(recipient, fresh.state.pending.target)) throw new Error('This address expires at the pending transition. Use a longer-coverage destination.')
      }
      submissionStarted = true
      const result = await wallet.createAction({ description: 'Submit eligible Mountaintops payment', options: { sendWith: [signedTxid], acceptDelayedBroadcast: false, returnTXIDOnly: false } })
      const status = result.sendWithResults?.find(x => x.txid === signedTxid)?.status
      if (!status || status === 'failed') throw new Error('Wallet reported a submission failure; inspect its transaction status before another payment.')
      return signedTxid
    }
    throw new Error('No eligible transaction found within the 30-second work budget. Nothing was submitted.')
  } catch (error) {
    if (!submissionStarted && reference) {
      try {
        const result = await wallet.abortAction({ reference })
        if (!result.aborted) throw new Error('Abort not acknowledged')
      } catch {
        throw new Error('Wallet action cleanup is unresolved. Open the wallet transaction history before preparing another payment.')
      }
    }
    if (submissionStarted) throw new Error(`Submission outcome is uncertain${signedTxid ? ` for ${signedTxid}` : ''}. The wallet may retry automatically. Do not send again; check wallet history.`)
    throw error
  }
}

export async function importCoins(wallet: WalletInterface, store: WalletRecords, entry: AddressRecord, coins: Coin[], coverage: Coverage, progress: Progress): Promise<string> {
  if (!coins.length) throw new Error('No verified unspent coins available to import')
  const retained = await retainedCoins(wallet, entry)
  const beef = new Beef()
  const verified = await verifiedEvidence(wallet, entry, coins, retained.beef)
  beef.mergeBeef(verified.beef)
  const unique = new Set<string>()
  for (const coin of coins) {
    const outpoint = `${coin.txid}.${coin.vout}`
    if (coin.keyID !== entry.keyID || coin.address !== entry.address || unique.has(outpoint)) throw new Error('Invalid or duplicate import outpoint')
    unique.add(outpoint)
    if (!(await coinIsUnspent(entry, coin))) throw new Error('An import output is already spent or pending a spend. Refresh the retained funds.')
  }
  return await eligibleAction(wallet, store, { description: 'Import Mountaintops retained coins', inputBEEF: beef.toBinary(), inputs: coins.map(x => ({ outpoint: `${x.txid}.${x.vout}`, inputDescription: 'Import retained Mountaintops coin', unlockingScriptLength: 108 })) }, coverage, progress, coins)
}

export async function sendCoins(wallet: WalletInterface, store: WalletRecords, recipient: string, amount: string, coverage: Coverage, progress: Progress): Promise<string> {
  validateAddress(recipient, store.network)
  if (store.network === 'mainnet' && !addressMatches(recipient, coverage.stage)) throw new Error('Expired — do not send coins to this address.')
  return await eligibleAction(wallet, store, { description: 'Shout BSV to an eligible address', outputs: [{ lockingScript: new P2PKH().lock(recipient).toHex(), satoshis: parseSatoshis(amount), outputDescription: 'Public BSV payment to recipient' }] }, coverage, progress, [], recipient)
}
