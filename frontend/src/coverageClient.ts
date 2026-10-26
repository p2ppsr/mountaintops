import { ANCHOR_HEIGHT, anchorState, advanceChain, SPECIFICATION, type ChainState, type Network } from '../../shared/brc234.ts'
import { whatsOnChainFetch } from './whatsOnChainClient.ts'
import type { WalletRecords, RecoveryRecord } from './walletRecords.ts'

export type Activation = { stage: number; height: number; hash: string; mtp: number }
export type Coverage = { network: Network; height: number; hash: string; stage: number; anchorMtp: number | null; state: ChainState | null; activations: Activation[]; checkedAt: number; persistenceWarning?: string }
export type BlockInfo = { height: number; hash: string; previousblockhash: string; mediantime: number; txcount?: number; num_tx?: number }
const hex64 = /^[a-f0-9]{64}$/
export function apiBase(network: Network): string { return `https://api.whatsonchain.com/v1/bsv/${network === 'mainnet' ? 'main' : 'test'}` }

export async function wocJson<T>(network: Network, path: string): Promise<T> {
  const response = await whatsOnChainFetch(`${apiBase(network)}${path}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`WhatsOnChain lookup unavailable (${response.status}). Existing coins are not a zero balance.`)
  return await response.json() as T
}

export async function wocTransactionHex(network: Network, txid: string): Promise<string> {
  if (!hex64.test(txid)) throw new Error('Invalid transaction ID')
  const response = await whatsOnChainFetch(`${apiBase(network)}/tx/${txid}/hex`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Transaction bytes unavailable (${response.status})`)
  const hex = (await response.text()).trim()
  if (!/^(?:[a-f0-9]{2})+$/.test(hex)) throw new Error('Invalid transaction hex response')
  return hex
}

function validateBlock(block: BlockInfo, height: number): BlockInfo {
  if (block.height !== height || !hex64.test(block.hash) || !hex64.test(block.previousblockhash) || !Number.isSafeInteger(block.mediantime)) throw new Error('Invalid block coverage evidence')
  return block
}

export async function readCoverage(network: Network, records: RecoveryRecord[], store: WalletRecords, progress: (message: string) => void = () => {}): Promise<Coverage> {
  const tip = await wocJson<{ blocks: number; bestblockhash: string }>(network, '/chain/info')
  if (!Number.isSafeInteger(tip.blocks) || tip.blocks < 0 || !hex64.test(tip.bestblockhash)) throw new Error('Invalid chain tip')
  if (network !== 'mainnet' || tip.blocks < ANCHOR_HEIGHT) return { network, height: tip.blocks, hash: tip.bestblockhash, stage: 0, anchorMtp: null, state: null, activations: [], checkedAt: Date.now() }

  let state: ChainState | null = null
  let activations: Activation[] = []
  const checkpoints = records.filter(x => x.kind === 'checkpoint' && x.data.specification === SPECIFICATION).reverse()
  for (const checkpoint of checkpoints) {
    const saved = checkpoint.data.state as ChainState
    if (!saved || !Number.isSafeInteger(saved.height) || saved.height > tip.blocks || saved.height < ANCHOR_HEIGHT) continue
    const canonical = validateBlock(await wocJson<BlockInfo>(network, `/block/height/${saved.height}`), saved.height)
    if (canonical.hash === saved.hash) {
      const events = checkpoint.data.activations as Activation[]
      if (!Number.isSafeInteger(saved.mtp) || !Number.isSafeInteger(saved.anchorMtp) || saved.anchorMtp > saved.mtp ||
          !/^(0|[1-9][0-9]*)$/.test(saved.volume) || !Number.isInteger(saved.stage) || saved.stage < 0 || saved.stage > 27 ||
          !Array.isArray(events) || events.length > 27 || events.some((event, i) => !Number.isInteger(event.stage) || event.stage <= (events[i - 1]?.stage ?? 0) || event.stage > saved.stage || !Number.isSafeInteger(event.height) || event.height <= (events[i - 1]?.height ?? ANCHOR_HEIGHT) || event.height > saved.height || !hex64.test(event.hash) || !Number.isSafeInteger(event.mtp)) ||
          (events.at(-1)?.stage ?? 0) !== saved.stage) throw new Error('Invalid stored coverage transitions')
      if (saved.pending && (!Number.isInteger(saved.pending.target) || saved.pending.target <= saved.stage || saved.pending.target > 27 || !hex64.test(saved.pending.triggerHash) || !Number.isSafeInteger(saved.pending.triggerHeight) || saved.pending.triggerHeight > saved.height || saved.pending.triggerHeight < ANCHOR_HEIGHT || !Number.isSafeInteger(saved.pending.deadline))) throw new Error('Invalid stored pending transition')
      state = saved
      activations = events
      break
    }
  }
  if (!state) {
    const anchor = validateBlock(await wocJson<BlockInfo>(network, `/block/height/${ANCHOR_HEIGHT}`), ANCHOR_HEIGHT)
    state = anchorState({ height: anchor.height, hash: anchor.hash, parentHash: anchor.previousblockhash, mtp: anchor.mediantime })
  }
  let persistenceWarning: string | undefined
  const saveCheckpoint = async () => {
    try { await store.append('checkpoint', { specification: SPECIFICATION, state, activations }) }
    catch { persistenceWarning = 'Wallet could not save coverage progress. Coverage was checked, but a future session may need to repeat these chain lookups.' }
  }
  const originalHash = state.hash
  let sinceSave = 0
  while (state.height < tip.blocks) {
    progress(`Checking BRC-234 coverage: block ${state.height.toLocaleString()} of ${tip.blocks.toLocaleString()}. Progress is saved in your wallet.`)
    const block = validateBlock(await wocJson<BlockInfo>(network, `/block/height/${state.height + 1}`), state.height + 1)
    const total = block.txcount ?? block.num_tx
    if (!Number.isSafeInteger(total) || (total as number) < 1) throw new Error('Complete all-version block transaction count unavailable; coverage is unknown.')
    const next = advanceChain(state, { height: block.height, hash: block.hash, parentHash: block.previousblockhash, mtp: block.mediantime, nonCoinbaseCount: String((total as number) - 1) })
    if (next.stage !== state.stage) activations.push({ stage: next.stage, height: next.height, hash: next.hash, mtp: next.mtp })
    state = next
    if (++sinceSave >= 100) {
      await saveCheckpoint()
      sinceSave = 0
    }
  }
  if (state.hash !== tip.bestblockhash) throw new Error('Chain changed during coverage calculation; refresh before receiving or sending.')
  if (originalHash !== state.hash || checkpoints.length === 0) await saveCheckpoint()
  return { network, height: tip.blocks, hash: tip.bestblockhash, stage: state.stage, anchorMtp: state.anchorMtp, state, activations, checkedAt: Date.now(), persistenceWarning }
}
