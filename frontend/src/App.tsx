import { useEffect, useRef, useState } from 'react'
import { PublicKey, WalletClient } from '@bsv/sdk'
import { addressMatches, assertReceivable, coverageLabel, lastCoveredStage, stages, type AddressRecord, type Network } from '../../shared/brc234.ts'
import { WalletRecords, type RecoveryRecord } from './walletRecords.ts'
import { applyExpirations, bookFromRecords } from './addressBook.ts'
import { calendarEstimate, expirationEstimate, receivingKeyID } from './receiveUX.ts'
import ReceiveInfo from './ReceiveInfo.tsx'
import { readCoverage, type Coverage } from './coverageClient.ts'
import { refreshCoins, type Coin } from './coins.ts'
import { importCoins, sendCoins, unfinishedWalletActions } from './actions.ts'
import { preferCompatibleTransport } from './walletClient.ts'
import { assertWalletActionFinal } from './walletActionState.ts'
import './style.css'

const client = new WalletClient('auto')
type Session = { identity: string; network: Network; store: WalletRecords; book: AddressRecord[]; records: RecoveryRecord[]; coverage: Coverage; primary: string | null; receivingBlocked: string | null }
const money = (satoshis: number) => `${Math.floor(satoshis / 100_000_000)}.${String(satoshis % 100_000_000).padStart(8, '0')} BSV`

function unresolvedActions(records: RecoveryRecord[]) {
  const actions = new Map<string, Record<string, unknown>>()
  for (const record of records) if (record.kind === 'action') actions.set(String(record.data.id), record.data)
  return [...actions.values()].filter(x => !['submitted', 'canceled', 'reviewed in wallet'].includes(String(x.state)))
}

export default function Mountaintops() {
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [balances, setBalances] = useState<Record<string, Coin[] | undefined>>({})
  const [view, setView] = useState<'receive' | 'send'>('receive')
  const [target, setTarget] = useState('auto')
  const [candidate, setCandidate] = useState<{ stage: number; keyID: string; address: string } | null>(null)
  const [pausedSearch, setPausedSearch] = useState<{ stage: number; next: string } | null>(null)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [txid, setTxid] = useState('')
  const [history, setHistory] = useState<{ txid: string; description: string; status: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [infoStage, setInfoStage] = useState<number | null>(null)
  const worker = useRef<Worker | null>(null)
  const searchProgress = useRef<{ stage: number; next: string } | null>(null)
  const operation = useRef(false)
  const current = useRef<Session | null>(null)
  current.current = session

  useEffect(() => () => { worker.current?.terminate() }, [])
  const run = async (task: () => Promise<void>, quiet = false) => {
    if (operation.current) return
    operation.current = true; setBusy(true)
    if (!quiet) { setError(''); setMessage('Working… Check your wallet if prompted.') }
    try { await task() } catch (e) { setError(e instanceof Error ? e.message : 'Operation unavailable. Check your wallet before retrying a payment.') }
    finally { operation.current = false; setBusy(false) }
  }

  const reload = async (previous: Session | null = current.current): Promise<Session> => {
    await preferCompatibleTransport(client)
    const { network } = await client.getNetwork({})
    const { publicKey: identity } = await client.getPublicKey({ identityKey: true })
    if (previous && (previous.identity !== identity || previous.network !== network)) {
      setSession(null); setBalances({}); setCandidate(null); setPausedSearch(null); setHistory([]); setTxid('')
      throw new Error('Wallet account or network changed. Connect again to load its own records.')
    }
    const store = previous?.store ?? new WalletRecords(client, identity, network)
    let records = await store.load()
    const coverage = await readCoverage(network, records, store, setMessage)
    let book = bookFromRecords(identity, network, records)
    const legacy = await client.getPublicKey({ protocolID: [1, 'mountaintops'], keyID: '1', counterparty: 'anyone', forSelf: true })
    if (PublicKey.fromString(legacy.publicKey).toAddress(network) !== book[0].address) throw new Error('Wallet does not match the original Mountaintops derivation')
    // ID 1 is always reconstructible. Only newly mined addresses need a durable
    // publication record, so connecting alone creates no storage transaction.
    const receivingBlocked = await applyExpirations(book, coverage, store)
    records = await store.load()
    if (!receivingBlocked) book = bookFromRecords(identity, network, records)
    records = [...records, ...await unfinishedWalletActions(client, network)]
    const next = { identity, network, store, records, book, coverage, primary: receivingBlocked ? null : receivingKeyID(book, coverage.stage, previous?.primary), receivingBlocked }
    setSession(next)
    return next
  }

  // Only chain coverage is rechecked. No background address-deposit polling.
  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => {
      if (!operation.current && !worker.current) void run(async () => { await reload() }, true)
    }, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(session)])

  const publishFound = async (result: { stage: number; keyID: string; address: string }) => {
    await run(async () => {
      const fresh = await reload()
      if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked)
      const existing = fresh.book.find(x => x.keyID === result.keyID)
      if (existing) assertReceivable(existing, fresh.coverage.stage)
      if (fresh.network === 'mainnet' && !addressMatches(result.address, fresh.coverage.stage)) throw new Error('Found address has expired. Choose a stricter target.')
      const expected = await client.getPublicKey({ protocolID: [1, 'mountaintops'], keyID: result.keyID, counterparty: 'anyone', forSelf: true })
      if (PublicKey.fromString(expected.publicKey).toAddress(fresh.network) !== result.address) throw new Error('Mined public key does not match the wallet')
      if (!existing) await fresh.store.append('address', { keyID: result.keyID, address: result.address, targetStage: result.stage, useForReceiving: true })
      const next = await reload(fresh)
      setSession({ ...next, primary: receivingKeyID(next.book, next.coverage.stage, result.keyID) }); setCandidate(null)
      setMessage('New address saved and ready to receive.')
    })
  }

  const mine = async (resumeStage?: number) => {
    await run(async () => {
      const fresh = await reload()
      if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked)
      if (fresh.network !== 'mainnet') throw new Error('BRC-234 mining targets mainnet; testnet has no sunset schedule.')
      const minimum = Math.min(27, Math.max(1, fresh.coverage.stage, fresh.coverage.state?.pending?.target ?? 0, ...fresh.book.map(x => lastCoveredStage(x.address) + 1)))
      const chosen = resumeStage ?? (target === 'auto' ? undefined : Number(target))
      if (chosen !== undefined && chosen < minimum) throw new Error(`Choose stage ${minimum} or later to improve the saved addresses.`)
      const saved = fresh.records.filter(x => x.kind === 'search' && x.data.stage === chosen).at(-1)
      const resume = pausedSearch && pausedSearch.stage === chosen ? pausedSearch.next : saved?.data.next
      const nextWorker = new Worker(new URL('./miner.worker.ts', import.meta.url), { type: 'module' })
      worker.current = nextWorker; searchProgress.current = null; setSearching(true); setCandidate(null); setPausedSearch(null)
      nextWorker.onmessage = ({ data }) => {
        if (worker.current !== nextWorker) return
        if (data.kind === 'started') setMessage(`Finding an address… up to 30 seconds.`)
        if (data.kind === 'progress') {
          searchProgress.current = { stage: data.stage, next: data.next }
          setMessage(`${Math.floor(data.elapsed / 1000)} seconds · ${(BigInt(data.next) - 1n).toLocaleString()} addresses tried`)
        }
        if (['found', 'paused', 'error'].includes(data.kind)) {
          nextWorker.terminate(); worker.current = null; setSearching(false)
          if (data.kind === 'found') { setCandidate(data); setMessage('New address found. Save it before using it.') }
          if (data.kind === 'paused') {
            setPausedSearch({ stage: data.stage, next: data.next }); setTarget(String(data.stage))
            setMessage('No match yet. You can keep searching for free.')
          }
          if (data.kind === 'error') setError(String(data.message))
        }
      }
      nextWorker.onerror = () => { nextWorker.terminate(); worker.current = null; setSearching(false); setError('Address worker failed. Published addresses remain in your wallet.') }
      nextWorker.postMessage({ identityKey: fresh.identity, network: fresh.network, minimumStage: minimum, targetStage: chosen, start: resume ?? '1' })
    })
  }

  const cancelMine = () => {
    worker.current?.terminate(); worker.current = null; setSearching(false)
    const progress = searchProgress.current
    if (progress) { setPausedSearch(progress); setTarget(String(progress.stage)) }
    setMessage('Search paused. Your saved addresses are safe in your wallet.')
  }
  const choose = (keyID: string) => {
    const fresh = current.current
    if (!fresh || disabled || fresh.receivingBlocked) return
    const entry = fresh.book.find(x => x.keyID === keyID)
    if (!entry) return
    try {
      assertReceivable(entry, fresh.coverage.stage)
      setSession({ ...fresh, primary: keyID }); setError(''); setMessage('Receiving address changed. Switching is free.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Address unavailable') }
  }
  const checkCoins = (keyID: string) => void run(async () => {
    const fresh = await reload(); const entry = fresh.book.find(x => x.keyID === keyID)!
    const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
    setBalances(x => ({ ...x, [keyID]: coins })); await reload(fresh)
    setMessage('Payments checked.')
  })
  const checkAllCoins = () => void run(async () => {
    const fresh = await reload()
    for (const entry of fresh.book) {
      const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
      setBalances(x => ({ ...x, [entry.keyID]: coins }))
    }
    await reload(fresh); setMessage('Payments checked.')
  })
  const importMoney = (keyID: string) => void run(async () => {
    const fresh = await reload()
    if (unresolvedActions(fresh.records).length) throw new Error('Review the unfinished wallet action before another payment.')
    const entry = fresh.book.find(x => x.keyID === keyID)!
    const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
    const submitted = await importCoins(client, fresh.store, entry, coins, fresh.coverage, setMessage)
    setTxid(submitted); setHistory(x => [{ txid: submitted, description: 'Import to wallet', status: 'Submitted' }, ...x]); setBalances(x => ({ ...x, [keyID]: undefined }))
    await reload(fresh); setMessage('Transfer submitted. Check your wallet for the final result.')
  })
  const send = () => void run(async () => {
    const fresh = await reload()
    if (unresolvedActions(fresh.records).length) throw new Error('Review the unfinished wallet action before another payment.')
    if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked)
    const own = fresh.book.find(x => x.address === recipient)
    if (own) assertReceivable(own, fresh.coverage.stage)
    const submitted = await sendCoins(client, fresh.store, recipient, amount, fresh.coverage, setMessage)
    setTxid(submitted); setHistory(x => [{ txid: submitted, description: `Send ${amount} BSV`, status: 'Submitted' }, ...x])
    setRecipient(''); setAmount(''); await reload(fresh)
    setMessage('Payment submitted. Check your wallet for the final result.')
  })

  const disabled = busy || searching
  const calendar = session ? calendarEstimate(session.coverage) : null
  const primary = session?.book.find(x => x.keyID === session.primary)
  const suggestedEntry = !candidate && !pausedSearch && !searching && session?.book.filter(x => !x.retiredAt && lastCoveredStage(x.address) > (primary ? lastCoveredStage(primary.address) : -1)).sort((a, b) => lastCoveredStage(b.address) - lastCoveredStage(a.address))[0]
  const pendingActions = session ? unresolvedActions(session.records) : []
  const savedSearches = session ? [...new Map(session.records.filter(x => x.kind === 'search').map(x => [Number(x.data.stage), x.data])).values()]
    .filter(x => Number(x.stage) > Math.max(...session.book.map(entry => lastCoveredStage(entry.address)))) : []
  const card = (entry: AddressRecord, selected = false) => {
    const coins = balances[entry.keyID]
    const total = coins?.reduce((sum, coin) => sum + coin.satoshis, 0)
    const pending = session!.coverage.state?.pending
    const pendingExpiry = !entry.retiredAt && pending && !addressMatches(entry.address, pending.target)
    const longest = Math.max(...session!.book.filter(x => !x.retiredAt).map(x => lastCoveredStage(x.address)))
    const level = lastCoveredStage(entry.address)
    const name = selected ? 'Your receiving address' : entry.keyID === '1' ? 'Original address' : 'Saved address'
    const expiration = entry.retiredAt ? 'Expired — do not send here' : pendingExpiry ? 'Expiration pending — stop sharing' : entry.network !== 'mainnet' ? 'No testnet expiration schedule' : expirationEstimate(level, calendar)
    return <article className={`address-card ${selected ? 'selected' : ''} ${entry.retiredAt ? 'expired' : ''}`} key={entry.keyID}>
      <div className="card-heading"><h3>{name}</h3><span className={`badge ${entry.retiredAt || pendingExpiry ? 'caution' : ''}`}>{entry.retiredAt ? 'Expired' : pendingExpiry ? 'Expiring' : 'Active'}</span></div>
      <code className="address">{entry.address}</code>
      <p className={entry.retiredAt || pendingExpiry ? 'expiry-warning' : 'coverage'}>{expiration}</p>
      {entry.network === 'mainnet' && <div className="lifetime-meta"><span>{!entry.retiredAt && !pendingExpiry && level < 27 ? 'Estimated · ' : ''}Stage {level}</span><button className="text-button" onClick={() => setInfoStage(level)} aria-label={`More info about stage ${level} address expiration`}>More info</button></div>}
      {!entry.retiredAt && !pendingExpiry && entry.network === 'mainnet' && longest > 0 && <p className="small coverage-comparison">{level === longest ? 'Longest coverage of your saved addresses.' : 'Expires earlier than your longest-lasting saved address.'}</p>}
      {entry.retiredAt && <p className="small">Receiving is disabled. You can still move earlier payments to your wallet.</p>}
      {pendingExpiry && <p className="expiry-warning">Stop sharing this address. The chain-time notice ends {new Date(pending.deadline * 1000).toISOString().replace('.000Z', ' UTC')}; expiration begins in the following accepted block.</p>}
      <div className="buttons">
        {!entry.retiredAt && <button className={selected ? 'accent' : 'secondary'} disabled={disabled || Boolean(session?.receivingBlocked)} onClick={() => void run(async () => { const fresh = await reload(); if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked); assertReceivable(fresh.book.find(x => x.keyID === entry.keyID)!, fresh.coverage.stage); await navigator.clipboard.writeText(entry.address); setMessage('Address copied. Share its expiration information too.'); })}>Copy address</button>}
        {!entry.retiredAt && !selected && <button disabled={disabled || Boolean(session?.receivingBlocked)} onClick={() => choose(entry.keyID)}>Use for receiving</button>}
      </div>
      {!selected && <><div className="funds-row"><div>{total !== undefined ? <><strong className="funds">{total.toLocaleString()} sats</strong><span className="small">{money(total)} · available here</span></> : <span className="small">Payments</span>}</div><button className="secondary" disabled={disabled} onClick={() => checkCoins(entry.keyID)}>{entry.retiredAt ? 'Check earlier payments' : total === undefined ? 'Check for payments' : 'Refresh'}</button></div>
      {Boolean(coins?.length) && <div className="import-row"><button disabled={disabled || pendingActions.length > 0} onClick={() => importMoney(entry.keyID)}>Move to wallet</button><span className="small">Wallet fees apply.</span></div>}</>}
      <details className="technical"><summary>Address details</summary><p>{coverageLabel(entry.address, entry.network, session!.coverage.anchorMtp, entry.retiredAt)}</p>{entry.retiredAt && <p>Expired at block {entry.retiredAt.height.toLocaleString()}. New-deposit lookups have stopped permanently.</p>}<p>Key ID {entry.keyID} · address rules satisfied through stage {level}. Payment transaction rules also apply.</p>{coins && <p>Funding transactions: {coins.filter(x => x.fundingCoverage === 'covered').length} covered at confirmation, {coins.filter(x => x.fundingCoverage === 'outside coverage').length} outside coverage, {coins.filter(x => x.fundingCoverage === 'unconfirmed').length} unconfirmed. These labels do not change ownership.</p>}</details>
    </article>
  }

  return <main aria-busy={busy || searching}>
    <header><div className="brand"><img className="mountain-mark" src="/mountaintops.svg" width="40" height="40" alt="" aria-hidden="true" /><h1>Mountaintops</h1></div><p>Public BSV payments.</p></header>
    {!session ? <section className="connect"><h2>Your BSV, ready to receive.</h2><p>Connect your wallet to find your addresses and payments.</p><button className="accent" disabled={disabled} onClick={() => void run(async () => { await reload(null); setMessage(''); })}>{busy ? 'Connecting…' : 'Connect wallet'}</button><p className="small">Use the same BRC-100 wallet on any device.</p></section> : <>
      <nav className="view-tabs" aria-label="Payment direction"><button aria-pressed={view === 'receive'} onClick={() => setView('receive')}>Receive</button><button aria-pressed={view === 'send'} onClick={() => setView('send')}>Send</button><span className="connection">{session.network === 'mainnet' ? 'Mainnet' : 'Testnet'} · Connected</span></nav>
      {pendingActions.length > 0 && <section className="warning"><h2>Check your wallet before continuing</h2><p>A previous payment has no final result yet. Do not send it again.</p>{pendingActions.map(action => <div key={String(action.id)}><details><summary>Payment details</summary><p className="transaction">{String(action.state)} {action.txid ? `· ${String(action.txid)}` : ''}</p></details><button disabled={disabled} onClick={() => void run(async () => {
        const fresh = await reload()
        if (action.state === 'prepared' && typeof action.reference === 'string') {
          const aborted = await client.abortAction({ reference: action.reference })
          if (!aborted.aborted) throw new Error('Wallet did not acknowledge cancellation')
        } else {
          await assertWalletActionFinal(client, action)
        }
        await reload(fresh); setMessage('Wallet payment status checked.')
      })}>{action.state === 'prepared' ? 'Cancel unsent payment' : 'Check wallet result'}</button></div>)}</section>}
      {session.receivingBlocked && <p className="error" role="alert">{session.receivingBlocked}</p>}
      {session.coverage.persistenceWarning && <p className="notice">{session.coverage.persistenceWarning}</p>}
      {(message || error) && <div className="feedback">{message && !searching && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}</div>}
      {view === 'receive' ? <section className="receive-panel" aria-label="Receive BSV">
        {primary ? card(primary, true) : <div className="empty-state"><h2>Choose a receiving address</h2><p>Find a new address or choose an active one below. Earlier payments remain yours.</p></div>}
        <div className="payments-panel"><div className="section-heading"><h3>Payments to your addresses</h3><button className="secondary" disabled={disabled} onClick={checkAllCoins}>Check payments</button></div>
          {session.book.every(x => balances[x.keyID] !== undefined) ? <p className="small">All addresses checked this session.</p> : <p className="small">Check here for payments to current and earlier addresses.</p>}
          {session.book.filter(x => balances[x.keyID]?.length).map(entry => <div className="payment-row" key={entry.keyID}><div><strong>{balances[entry.keyID]!.reduce((sum, coin) => sum + coin.satoshis, 0).toLocaleString()} sats</strong><span className="small">{entry.keyID === '1' ? 'Original address' : `Address …${entry.address.slice(-6)}`}{entry.retiredAt ? ' · earlier payments' : ''}</span></div><button disabled={disabled || pendingActions.length > 0} onClick={() => importMoney(entry.keyID)}>Move to wallet</button></div>)}
          {session.book.some(x => balances[x.keyID]?.length) && <p className="small">Wallet fees apply when moving coins.</p>}
          {session.book.every(x => balances[x.keyID] !== undefined && balances[x.keyID]?.length === 0) && <p className="small">No available payments found.</p>}
        </div>
        <div className="mining"><div className="section-heading"><div><h3>A longer-lasting address</h3><p className="small">{suggestedEntry ? 'Already saved. Free to switch.' : 'Free to find. Wallet fees apply to save it.'}</p></div>{searching ? <button className="secondary" onClick={cancelMine}>Pause</button> : <button disabled={disabled || session.network !== 'mainnet'} onClick={() => suggestedEntry ? choose(suggestedEntry.keyID) : void mine()}>{suggestedEntry ? 'Use saved address' : pausedSearch ? 'Keep searching' : 'Find an address'}</button>}</div>
          {suggestedEntry && <div className="saved-preview"><p className="coverage">{expirationEstimate(lastCoveredStage(suggestedEntry.address), calendar)}</p><span className="small">Estimated · stage {lastCoveredStage(suggestedEntry.address)}</span></div>}
          {searching && <p className="notice" role="status">{message}</p>}
          {candidate && <div className="result"><h3>New address found</h3><p className="coverage">{expirationEstimate(lastCoveredStage(candidate.address), calendar)}</p><div className="lifetime-meta"><span>Estimated · Stage {lastCoveredStage(candidate.address)}</span><button className="text-button" onClick={() => setInfoStage(lastCoveredStage(candidate.address))}>More info</button></div><p className="small">Save once to recover this address on any device.</p><button disabled={disabled} onClick={() => void publishFound(candidate)}>Save &amp; use address</button><span className="small fee-note">Wallet fees apply to save. Switching saved addresses is free.</span></div>}
          <details className="advanced"><summary>Advanced search</summary><p className="small">Search runs for up to 30 seconds at a time. Higher stages take more work and pass stricter future address rules.</p>{suggestedEntry && <button disabled={disabled} onClick={() => void mine()}>Find another address</button>}<label>Search target<select value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}><option value="auto">Recommended · about 30 seconds</option>{stages.slice(1).map(row => <option key={row.stage} value={row.stage}>Stage {row.stage} · {expirationEstimate(row.stage, calendar).replace("Not earlier than", "not before")}</option>)}</select></label>
            {pausedSearch && <><button disabled={disabled} onClick={() => void run(async () => { const fresh = await reload(); await fresh.store.append('search', pausedSearch); await reload(fresh); setMessage('Search progress saved in your wallet.') })}>Save progress</button><p className="small">Wallet fees apply. Otherwise you can repeat this search on another device for free.</p></>}
            {!searching && savedSearches.map(search => <p key={String(search.stage)}><button disabled={disabled} onClick={() => { setTarget(String(search.stage)); void mine(Number(search.stage)) }}>Resume stage {String(search.stage)}</button> <span className="small">Saved in your wallet · next key ID {String(search.next)}</span></p>)}
          </details>
        </div>
        <details className="address-list"><summary>Other addresses <span className="count">{session.book.filter(x => x.keyID !== primary?.keyID).length}</span></summary><p className="small">Switching is free for this session. Reconnecting opens your longest-lasting eligible saved address.</p>{session.book.filter(x => x.keyID !== primary?.keyID).map(x => card(x))}<button className="secondary" disabled={disabled} onClick={() => void run(async () => { await reload(); setMessage('Addresses and expiration checked.') })}>Refresh addresses</button></details>
        <p className="ownership-note">An address can expire. Your coins are still yours.</p>
      </section> : <section className="send-panel"><h2>Send BSV</h2><p className="small">Public payment · wallet fees apply</p><label>To<input value={recipient} disabled={disabled} onChange={e => setRecipient(e.target.value)} placeholder="BSV address" autoComplete="off" spellCheck={false} /></label><label>Amount in BSV<input value={amount} disabled={disabled} onChange={e => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" /></label><button className="accent" disabled={disabled || pendingActions.length > 0 || !recipient || !amount} onClick={send}>Send BSV</button><p className="small">Expired addresses are blocked. Confirm the result in your wallet before retrying.</p>{txid && <p className="transaction">Submitted: {txid}</p>}</section>}
      <details className="activity"><summary>Activity this session <span className="count">{history.length}</span></summary><p className="small">Clears when you leave. Your wallet keeps its own payment records.</p>{!history.length && <p className="small">No payments yet.</p>}{history.map(x => <p className="transaction" key={x.txid}>{x.description} · {x.status}<br />{x.txid}</p>)}</details>
    </>}
    {!session && error && <p className="error" role="alert">{error}</p>}
    <details className="help"><summary>Expiration, fees & recovery</summary><h3>When does my address expire?</h3><p>Each address shows a month-and-year estimate and the stage it meets. Choose More info for the schedule. Before block 1,000,000 arrives, estimates can move earlier or later. Low transaction volume can delay expiration.</p><p>When an address expires, stop using it everywhere. Mountaintops disables receiving and stops looking for new deposits. Earlier coins remain yours and can still be moved to your wallet.</p><h3>Can I recover on another device?</h3><p>Connect the same BRC-100 wallet account. Your saved addresses and coin evidence come from the wallet, without browser data or files from this device. Keep your wallet account and its recovery service available.</p><h3>What costs money?</h3><p>Searching and pausing are free. Saving a new address also makes it your receiving address in one encrypted 1-satoshi wallet record. Switching saved addresses is free for this session; reconnecting opens the longest-lasting eligible saved address. Saving search progress also needs a wallet record. Network and wallet service fees may apply to records. Moving or sending coins also incurs wallet fees.</p><h3>Does a longer-lasting address cover every payment?</h3><p>No. Funding TXID rules also apply, and from stage 13 the transaction must use version 1. Mountaintops prepares eligible transactions within a bounded work budget. External senders may create payments outside those rules. Eligibility never changes who owns the coins.</p><details><summary>Technical status</summary>{session && <p>{session.network} · checked through block {session.coverage.height.toLocaleString()} · stage {session.coverage.stage}</p>}<p>Client-only. Encrypted PushDrop recovery records use your BRC-100 wallet’s baskets. WhatsOnChain supplies chain data and historical recovery; unavailable or incomplete data cannot establish a balance.</p></details></details>
    {session && infoStage !== null && <ReceiveInfo stage={infoStage} coverage={session.coverage} onClose={() => setInfoStage(null)} />}
    <footer><span>Public transactions. No privacy.</span><div><a href="https://whatsonchain.com" target="_blank" rel="noreferrer">WhatsOnChain</a><a href="https://docs.projectbabbage.com/docs/metanet-client/funding" target="_blank" rel="noreferrer">Wallet help</a></div></footer>
  </main>
}
