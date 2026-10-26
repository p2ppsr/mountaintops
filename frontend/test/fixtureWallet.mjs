import { Beef, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'

// A consensus-independent wallet fixture: real SDK keys, encryption, PushDrop,
// BEEF serialization and signing, with synthetic funding and no network spend.
export function walletState() { return { transactions: new Map(), outputs: new Map(), pending: new Map(), actions: [] } }
export class FixtureWallet extends ProtoWallet {
  constructor(state = walletState(), key = new PrivateKey(42)) {
    super(key); this.state = state; this.key = key
    if (!state.transactions.size) {
      const funding = new Transaction(1, [], [{ satoshis: 10_000_000, lockingScript: new P2PKH().lock(key.toPublicKey().toAddress()) }])
      state.transactions.set(funding.id('hex'), funding)
      state.outputs.set(`${funding.id('hex')}.0`, { satoshis: 10_000_000, basket: 'default', tags: [], spendable: true })
    }
  }
  async getNetwork() { return { network: 'mainnet' } }
  async getVersion() { return { version: 'fixture-wallet-1' } }
  async isAuthenticated() { return { authenticated: true } }
  async waitForAuthentication() { return { authenticated: true } }
  beef() { const b = new Beef(); for (const t of this.state.transactions.values()) b.mergeTransaction(t); return b }
  async listOutputs(args) {
    const all = [...this.state.outputs.entries()].filter(([, v]) => v.basket === args.basket && (!args.tags || args.tags.every(tag => v.tags.includes(tag))))
    return { totalOutputs: all.length, outputs: all.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 10)).map(([outpoint, value]) => ({ outpoint, ...value })), BEEF: this.beef().toBinary() }
  }
  async createAction(args) {
    if (args.options?.sendWith && !args.inputs && !args.outputs) {
      for (const action of this.state.actions) if (args.options.sendWith.includes(action.txid)) action.status = 'unproven'
      return { sendWithResults: args.options.sendWith.map(txid => ({ txid, status: 'unproven' })) }
    }
    const requested = args.inputs ?? []
    const inputPoints = requested.map(x => x.outpoint)
    const spendable = [...this.state.outputs.entries()].find(([point, value]) => value.basket === 'default' && !inputPoints.includes(point))
    if (!spendable && !requested.length) throw new Error('Fixture funding exhausted')
    if (spendable) inputPoints.push(spendable[0])
    const tx = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
    let total = 0
    for (const point of inputPoints) {
      const [txid, vout] = point.split('.')
      const source = this.state.transactions.get(txid)
      const output = source.outputs[Number(vout)]
      total += Number(output.satoshis)
      tx.addInput({ sourceTXID: txid, sourceTransaction: source, sourceOutputIndex: Number(vout), sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
    }
    for (const output of args.outputs ?? []) tx.addOutput({ satoshis: output.satoshis, lockingScript: LockingScript.fromHex(output.lockingScript) })
    const change = total - (args.outputs ?? []).reduce((n, x) => n + Number(x.satoshis), 0) - 2
    tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(this.key.toPublicKey().toAddress()) })
    const reference = Utils.toBase64(Utils.toArray(`fixture ${this.state.pending.size} ${this.state.transactions.size}`, 'utf8'))
    this.state.pending.set(reference, { tx, args, inputPoints, requested: requested.length })
    return { signableTransaction: { reference, tx: tx.toAtomicBEEF() } }
  }
  async signAction({ reference, spends, options }) {
    const prepared = this.state.pending.get(reference)
    if (!prepared) throw new Error('Unknown fixture action')
    const { tx, args, inputPoints, requested } = prepared
    for (let i = 0; i < tx.inputs.length; i++) {
      if (spends[i]) {
        const { UnlockingScript } = await import('@bsv/sdk')
        tx.inputs[i].unlockingScript = UnlockingScript.fromHex(spends[i].unlockingScript)
      } else if (i >= requested) tx.inputs[i].unlockingScript = await new P2PKH().unlock(this.key).sign(tx, i)
    }
    const txid = tx.id('hex')
    for (const point of inputPoints) this.state.outputs.delete(point)
    this.state.transactions.set(txid, tx)
    tx.outputs.forEach((out, index) => {
      const original = args.outputs?.[index]
      this.state.outputs.set(`${txid}.${index}`, { basket: original?.basket ?? 'default', tags: original?.tags ?? [], satoshis: out.satoshis, customInstructions: original?.customInstructions, spendable: true })
    })
    this.state.actions.push({ txid, status: options?.noSend ? 'nosend' : 'unproven', labels: args.labels ?? [], description: args.description })
    return { txid, tx: tx.toAtomicBEEF() }
  }
  async abortAction() { return { aborted: true } }
  async listActions({ labels }) { const actions = this.state.actions.filter(x => labels.every(label => x.labels.includes(label))); return { totalActions: actions.length, actions } }
}
