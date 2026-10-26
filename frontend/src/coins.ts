import { Beef, FetchHttpClient, P2PKH, Transaction, WhatsOnChain, type WalletInterface } from '@bsv/sdk'
import type { AddressRecord } from '../../shared/brc234.ts'
import { apiBase, wocTransactionHex, type Coverage } from './coverageClient.ts'
import { addressMatches, assertReceivable, transactionMatches } from '../../shared/brc234.ts'
import { whatsOnChainFetch } from './whatsOnChainClient.ts'
import getBeefForTxid from './getBeefForTxid.ts'
import type { WalletRecords } from './walletRecords.ts'

export const COIN_BASKET = 'mountaintops receipts v1'
export type Coin = { txid: string; vout: number; satoshis: number; keyID: string; address: string; height: number | null; fundingCoverage?: 'covered' | 'outside coverage' | 'unconfirmed' }
type UtxoPage = { address: string; error?: string; result: { height?: number; tx_pos: number; tx_hash: string; value: number; isSpentInMempoolTx: boolean }[]; nextPageToken?: string }
type HistoryPage = { address: string; error?: string; result: { height: number; tx_hash: string }[]; nextPageToken?: string }

async function pages<T extends { address: string; error?: string; result: unknown[]; nextPageToken?: string }>(entry: AddressRecord, path: string, consume: (page: T) => Promise<boolean>): Promise<void> {
  let token = ''
  const tokens = new Set<string>()
  for (let count = 0; count < 1000; count++) {
    const url = `${apiBase(entry.network)}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    const response = await whatsOnChainFetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`WhatsOnChain history unavailable (${response.status}); recovery is incomplete.`)
    const page = await response.json() as T
    if (page.address !== entry.address || page.error || !Array.isArray(page.result)) throw new Error(page.error || 'Invalid address discovery response')
    if (!(await consume(page))) return
    token = page.nextPageToken || response.headers.get('next-page') || ''
    if (!token) return
    if (tokens.has(token)) throw new Error('History pagination repeated; recovery is incomplete')
    tokens.add(token)
  }
  throw new Error('History exceeds the interactive page limit; no complete balance can be claimed.')
}

export function validateCoin(coin: Coin): Coin {
  if (!/^[a-f0-9]{64}$/.test(coin.txid) || !Number.isSafeInteger(coin.vout) || coin.vout < 0 ||
      !Number.isSafeInteger(coin.satoshis) || coin.satoshis < 0 || (coin.height !== null && (!Number.isSafeInteger(coin.height) || coin.height <= 0))) throw new Error('Invalid coin data')
  return coin
}

export function fundingCoverage(entry: AddressRecord, coin: Coin, tx: Transaction, coverage: Coverage): Coin['fundingCoverage'] {
  if (coin.height === null) return 'unconfirmed'
  const stage = entry.network === 'mainnet' ? coverage.activations.filter(x => x.height <= coin.height!).at(-1)?.stage ?? 0 : 0
  return (entry.network !== 'mainnet' || addressMatches(entry.address, stage)) && transactionMatches(coin.txid, tx.version, stage) ? 'covered' : 'outside coverage'
}

// Proof checks use only known TXIDs and canonical block roots, including after
// expiration. They never reopen an address-wide deposit query.
export async function verifyCoinProofs(beef: Beef, entry: AddressRecord, coins: Coin[]): Promise<void> {
  if (!coins.length) return
  const tracker = new WhatsOnChain(entry.network === 'mainnet' ? 'main' : 'test', { httpClient: new FetchHttpClient(whatsOnChainFetch) })
  if (!(await beef.verify(tracker))) throw new Error('Retained proof is incomplete or no longer canonical. Refresh the known transaction evidence before importing.')
  for (const coin of coins) {
    const bump = beef.findBump(coin.txid)
    if (coin.height !== null && (!bump || bump.blockHeight !== coin.height)) throw new Error('Retained confirmation height does not match its inclusion proof. Refresh the known transaction evidence.')
  }
}

async function retainCoins(wallet: WalletInterface, entry: AddressRecord, coins: Coin[]): Promise<void> {
  for (const txid of new Set(coins.map(x => x.txid))) {
    const beef = await getBeefForTxid(txid, entry.network === 'mainnet' ? 'main' : 'test')
    const tx = beef.findTransactionForSigning(txid)
    if (!tx || tx.id('hex') !== txid) throw new Error('Transaction evidence does not match the requested ID')
    const outputs = coins.filter(x => x.txid === txid)
    await verifyCoinProofs(beef, entry, outputs)
    for (const coin of outputs) {
      const source = tx.outputs[coin.vout]
      if (!source || source.lockingScript.toHex() !== new P2PKH().lock(entry.address).toHex() || BigInt(source.satoshis ?? -1) !== BigInt(coin.satoshis)) throw new Error('Coin amount or script does not match its transaction')
    }
    await saveCoinEvidence(wallet, entry, beef, outputs)
  }
}

async function saveCoinEvidence(wallet: WalletInterface, entry: AddressRecord, beef: Beef, outputs: Coin[]): Promise<void> {
    const txid = outputs[0].txid
    await wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid), description: 'Retain Mountaintops deposit evidence', labels: ['mountaintops receipts v1'],
      outputs: outputs.map(coin => ({ outputIndex: coin.vout, protocol: 'basket insertion', insertionRemittance: {
        basket: COIN_BASKET, tags: [`address ${entry.address}`], customInstructions: JSON.stringify({ v: 1, network: entry.network, ...coin })
      } }))
    })
}

export async function retainedCoins(wallet: WalletInterface, entry: AddressRecord): Promise<{ coins: Coin[]; beef: Beef }> {
  const coins: Coin[] = []
  const beef = new Beef()
  for (let offset = 0; ; offset += 100) {
    const page = await wallet.listOutputs({ basket: COIN_BASKET, tags: [`address ${entry.address}`], tagQueryMode: 'all', include: 'entire transactions', includeCustomInstructions: true, includeTags: true, limit: 100, offset })
    if (page.BEEF) beef.mergeBeef(page.BEEF)
    for (const output of page.outputs) {
      if (!output.customInstructions) throw new Error('Wallet omitted the derivation metadata needed for recovery')
      const metadata = JSON.parse(output.customInstructions) as Coin & { v: number; network: string }
      if (metadata.v !== 1 || metadata.network !== entry.network) throw new Error('Wallet coin network or schema mismatch')
      const coin = validateCoin(metadata)
      if (coin.keyID !== entry.keyID || coin.address !== entry.address || output.outpoint !== `${coin.txid}.${coin.vout}` || BigInt(output.satoshis) !== BigInt(coin.satoshis)) throw new Error('Wallet coin recovery metadata mismatch')
      // Every wallet-retained output was observed during receiving or admitted
      // by the bounded historical bootstrap. A reorg cannot erase its ownership.
      coins.push(coin)
    }
    if (page.outputs.length < 100) break
    if (offset >= 100_000) throw new Error('Wallet coin pagination limit reached; balance is incomplete')
  }
  return { coins, beef }
}


export async function verifiedEvidence(wallet: WalletInterface, entry: AddressRecord, coins: Coin[], retained: Beef): Promise<{ beef: Beef; coins: Coin[] }> {
  const scoped = new Beef()
  for (const txid of new Set(coins.map(x => x.txid))) {
    const tx = retained.findAtomicTransaction(txid)
    if (tx) scoped.mergeTransaction(tx)
  }
  try {
    if (coins.some(x => x.height === null)) throw new Error('Resolve known pending transactions')
    await verifyCoinProofs(scoped, entry, coins); return { beef: scoped, coins }
  } catch {
    // Repair only explicitly known transactions. This also resolves a pending
    // deposit or an orphaned confirmation without watching an expired address.
    const repaired = new Beef()
    const updated: Coin[] = []
    for (const txid of new Set(coins.map(x => x.txid))) {
      const evidence = await getBeefForTxid(txid, entry.network === 'mainnet' ? 'main' : 'test')
      const outputs = coins.filter(x => x.txid === txid).map(coin => ({ ...coin, height: evidence.findBump(txid)?.blockHeight ?? null }))
      const tx = evidence.findTransactionForSigning(txid)
      for (const coin of outputs) {
        const output = tx?.outputs[coin.vout]
        if (!output || output.lockingScript.toHex() !== new P2PKH().lock(entry.address).toHex() || BigInt(output.satoshis ?? -1) !== BigInt(coin.satoshis)) throw new Error('Repaired evidence does not match the retained output')
      }
      await verifyCoinProofs(evidence, entry, outputs)
      await saveCoinEvidence(wallet, entry, evidence, outputs)
      repaired.mergeBeef(evidence); updated.push(...outputs)
    }
    return { beef: repaired, coins: updated }
  }
}

// This is a known-outpoint query, including after an address expires. A generic
// failed lookup is never treated as spent, unspent, or zero. The 404 meaning is
// specific to WoC's documented /tx/:id/:vout/spent contract for a known output.
export async function coinIsUnspent(entry: AddressRecord, coin: Coin): Promise<boolean> {
  const response = await whatsOnChainFetch(`${apiBase(entry.network)}/tx/${coin.txid}/${coin.vout}/spent`, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return true
  if (!response.ok) throw new Error(`Spend status unknown (${response.status}); retry the check before importing.`)
  const spent = await response.json() as { txid: string; vin: number; status: string }
  if (!/^[a-f0-9]{64}$/.test(spent.txid) || !Number.isSafeInteger(spent.vin) || !['confirmed', 'unconfirmed'].includes(spent.status)) throw new Error('Invalid spend status response')
  const hex = await wocTransactionHex(entry.network, spent.txid)
  const spending = Transaction.fromHex(hex)
  const input = spending.inputs[spent.vin]
  if (spending.id('hex') !== spent.txid || !input || input.sourceTXID !== coin.txid || input.sourceOutputIndex !== coin.vout) throw new Error('Spend evidence does not consume the requested output')
  return false
}

export async function refreshCoins(wallet: WalletInterface, store: WalletRecords, entry: AddressRecord, coverage: Coverage, progress: (message: string) => void): Promise<Coin[]> {
  const found: Coin[] = []
  if (!entry.retiredAt) {
    assertReceivable(entry, coverage.stage)
    await pages<UtxoPage>(entry, `/address/${entry.address}/unspent/all`, async page => {
      for (const row of page.result) {
        if (row.isSpentInMempoolTx !== false) continue
        found.push(validateCoin({ txid: row.tx_hash, vout: row.tx_pos, satoshis: row.value, keyID: entry.keyID, address: entry.address, height: row.height && row.height > 0 ? row.height : null }))
      }
      return true
    })
  } else {
    const records = await store.load()
    const complete = records.some(x => x.kind === 'history' && x.data.keyID === entry.keyID && x.data.cutoffHash === entry.retiredAt?.hash)
    if (!complete) {
      progress('Recovering pre-expiration history once through WhatsOnChain. New deposits to this address are not monitored.')
      const cutoff = entry.retiredAt.lastReceiveHeight
      let previousHeight = 0
      await pages<HistoryPage>(entry, `/address/${entry.address}/confirmed/history?order=asc&limit=1000&height=0`, async page => {
        for (const row of page.result) {
          if (!Number.isSafeInteger(row.height) || row.height < previousHeight) throw new Error('Historical order or coverage is incomplete')
          previousHeight = row.height
          if (row.height > cutoff) return false
          const raw = await wocTransactionHex(entry.network, row.tx_hash)
          const tx = Transaction.fromHex(raw)
          if (tx.id('hex') !== row.tx_hash) throw new Error('Historical transaction ID mismatch')
          for (let vout = 0; vout < tx.outputs.length; vout++) {
            const output = tx.outputs[vout]
            if (output.lockingScript.toHex() === new P2PKH().lock(entry.address).toHex()) {
              const coin = validateCoin({ txid: row.tx_hash, vout, satoshis: Number(output.satoshis), keyID: entry.keyID, address: entry.address, height: row.height })
              if (await coinIsUnspent(entry, coin)) found.push(coin)
            }
          }
        }
        return true
      })
      // A complete historical receipt is saved only after every discovered coin
      // and its transaction/ancestry are acknowledged by the BRC-100 wallet.
    }
  }
  if (found.length) { progress('Saving deposit evidence in your wallet for device-independent recovery…'); await retainCoins(wallet, entry, found) }
  if (entry.retiredAt) {
    const records = await store.load()
    if (!records.some(x => x.kind === 'history' && x.data.keyID === entry.keyID && x.data.cutoffHash === entry.retiredAt?.hash)) await store.append('history', { keyID: entry.keyID, cutoffHash: entry.retiredAt.hash, lastReceiveHeight: entry.retiredAt.lastReceiveHeight })
  }
  const retained = await retainedCoins(wallet, entry)
  const unique = new Map<string, Coin>()
  for (const coin of retained.coins) {
    // Revalidate known evidence even for wallet rows omitted from current WoC
    // discovery; a disappearance from an address list cannot mean spentness.
    const tx = retained.beef.findTransactionForSigning(coin.txid)
    if (!tx) throw new Error('Retained transaction is missing from wallet BEEF')
    const output = tx.outputs[coin.vout]
    if (!output || output.lockingScript.toHex() !== new P2PKH().lock(entry.address).toHex() || BigInt(output.satoshis ?? -1) !== BigInt(coin.satoshis)) throw new Error('Retained transaction evidence is incomplete or inconsistent')
    if (coin.height !== null && coin.height > coverage.height) throw new Error('Retained confirmation is beyond the current chain snapshot')
    if (await coinIsUnspent(entry, coin)) unique.set(`${coin.txid}.${coin.vout}`, coin)
  }
  const verified = await verifiedEvidence(wallet, entry, [...unique.values()], retained.beef)
  return verified.coins.map(coin => ({ ...coin, fundingCoverage: fundingCoverage(entry, coin, verified.beef.findTransactionForSigning(coin.txid)!, coverage) }))
}
