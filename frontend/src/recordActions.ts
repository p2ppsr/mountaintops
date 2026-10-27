import { Transaction, type WalletInterface } from '@bsv/sdk'
import type { Network } from '../../shared/brc234.ts'
import { assertInputsUnspent } from './inputChecks.ts'

type Prepared = { tx: Transaction; txid?: string; submitted: boolean }

// LocalKVStore binds the token and final template. Keep its action noSend until
// that validation returns, then check all inputs before one explicit release.
export class RecordActions {
  readonly wallet: WalletInterface
  private readonly prepared = new Map<string, Prepared>()
  private readonly signed = new Map<string, string>()
  error: string | undefined
  cleanupFailed = false
  private readonly original: WalletInterface
  private readonly network: Network
  constructor(original: WalletInterface, network: Network) {
    this.original = original; this.network = network
    this.wallet = new Proxy(original, { get: (target, property) => {
      if (property === 'createAction') return async (...[args, originator]: Parameters<WalletInterface['createAction']>) => {
        if (args.options?.signAndProcess !== false || args.options?.sendWith?.length) throw new Error('Wallet record must be prepared before submission.')
        const result = await original.createAction({ ...args, labels: [...(args.labels ?? []), 'mountaintops actions v1', 'mountaintops record v1', `mountaintops request ${crypto.randomUUID()}`], options: { ...args.options, noSend: true, returnTXIDOnly: false } }, originator)
        if (result.signableTransaction) this.prepared.set(result.signableTransaction.reference, { tx: Transaction.fromAtomicBEEF(result.signableTransaction.tx), submitted: false })
        return result
      }
      if (property === 'signAction') return async (...[args, originator]: Parameters<WalletInterface['signAction']>) => {
        const state = this.prepared.get(args.reference)
        if (!state || args.options?.sendWith?.length) throw new Error('Wallet record preparation is unavailable. Saving stopped.')
        await this.check(state.tx)
        const result = await original.signAction({ ...args, options: { ...args.options, noSend: true, returnTXIDOnly: false } }, originator)
        if (!result.tx || !result.txid) throw new Error('Wallet omitted the signed recovery record.')
        state.tx = Transaction.fromAtomicBEEF(result.tx)
        if (state.tx.id('hex') !== result.txid) throw new Error('Wallet recovery record TXID mismatch.')
        state.txid = result.txid; this.signed.set(result.txid, args.reference)
        return result
      }
      if (property === 'abortAction') return async (...[args, originator]: Parameters<WalletInterface['abortAction']>) => {
        if (this.prepared.get(args.reference)?.submitted) throw new Error('Record submission already started; review the wallet.')
        try {
          const result = await original.abortAction(args, originator)
          if (!result.aborted) this.cleanupFailed = true
          else this.forget(args.reference)
          return result
        } catch (error) { this.cleanupFailed = true; throw error }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  begin(): void { this.error = undefined; this.cleanupFailed = false }
  private forget(reference: string): void {
    const state = this.prepared.get(reference)
    if (state?.txid) this.signed.delete(state.txid)
    this.prepared.delete(reference)
  }
  private async check(tx: Transaction): Promise<void> {
    try { await assertInputsUnspent(tx, this.network) }
    catch (error) { this.error = error instanceof Error ? error.message : 'Wallet coin check failed. Saving stopped.'; throw error }
  }
  async submit(outpoint: string): Promise<void> {
    const txid = outpoint.split('.')[0], reference = this.signed.get(txid)
    const state = reference && this.prepared.get(reference)
    if (!reference || !state || state.submitted) throw new Error('Wallet did not prepare a verifiable new recovery record.')
    try {
      await this.check(state.tx)
      state.submitted = true
      const result = await this.original.createAction({ description: 'Submit Mountaintops recovery record', options: { sendWith: [txid], acceptDelayedBroadcast: false, returnTXIDOnly: false } })
      const status = result.sendWithResults?.find(x => x.txid === txid)?.status
      if (!status || status === 'failed') throw new Error('Wallet record submission needs review.')
      this.forget(reference)
    } catch (error) {
      if (!state.submitted) {
        try { const aborted = await this.original.abortAction({ reference }); if (!aborted.aborted) this.cleanupFailed = true; else this.forget(reference) }
        catch { this.cleanupFailed = true }
      } else this.error = 'Wallet record submission is uncertain. Check your wallet before saving again.'
      throw error
    }
  }
}
