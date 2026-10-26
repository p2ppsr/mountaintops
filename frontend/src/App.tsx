import { useEffect, useRef, useState } from 'react'
import { PublicKey, WalletClient } from '@bsv/sdk'
import { addressMatches, assertReceivable, coverageLabel, lastCoveredStage, stages, type AddressRecord, type Network } from '../../shared/brc234.ts'
import { WalletRecords, type RecoveryRecord } from './walletRecords.ts'
import { applyExpirations, bookFromRecords, primaryFromRecords } from './addressBook.ts'
import { readCoverage, type Coverage } from './coverageClient.ts'
import { refreshCoins, type Coin } from './coins.ts'
import { importCoins, sendCoins, unfinishedWalletActions } from './actions.ts'
import { preferCompatibleTransport } from './walletClient.ts'
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
  const [target, setTarget] = useState('auto')
  const [found, setFound] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<{ stage: number; keyID: string; address: string } | null>(null)
  const [pausedSearch, setPausedSearch] = useState<{ stage: number; next: string } | null>(null)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [txid, setTxid] = useState('')
  const [history, setHistory] = useState<{ txid: string; description: string; status: string }[]>([])
  const [searching, setSearching] = useState(false)
  const worker = useRef<Worker | null>(null)
  const searchProgress = useRef<{ stage: number; next: string } | null>(null)
  const operation = useRef(false)
  const current = useRef<Session | null>(null)
  current.current = session

  useEffect(() => () => { worker.current?.terminate() }, [])
  const run = async (task: () => Promise<void>, quiet = false) => {
    if (operation.current) return
    operation.current = true; setBusy(true)
    if (!quiet) { setError(''); setMessage('Working… Check your wallet for any permission request.') }
    try { await task() } catch (e) { setError(e instanceof Error ? e.message : 'Operation unavailable. Check your wallet before retrying a payment.') }
    finally { operation.current = false; setBusy(false) }
  }

  const reload = async (previous: Session | null = current.current): Promise<Session> => {
    await preferCompatibleTransport(client)
    const { network } = await client.getNetwork({})
    const { publicKey: identity } = await client.getPublicKey({ identityKey: true })
    if (previous && (previous.identity !== identity || previous.network !== network)) {
      setSession(null); setBalances({}); setFound(null); setCandidate(null); setPausedSearch(null); setHistory([]); setTxid('')
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
    const next = { identity, network, store, records, book, coverage, primary: receivingBlocked ? null : primaryFromRecords(book, records, coverage.stage), receivingBlocked }
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
      if (!existing) await fresh.store.append('address', { keyID: result.keyID, address: result.address, targetStage: result.stage })
      await reload(fresh); setFound(result.keyID); setCandidate(null)
      setMessage('Address saved as an encrypted PushDrop record in your wallet. Review it, then select “Use this address”.')
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
      worker.current = nextWorker; searchProgress.current = null; setSearching(true); setFound(null); setCandidate(null); setPausedSearch(null)
      nextWorker.onmessage = ({ data }) => {
        if (worker.current !== nextWorker) return
        if (data.kind === 'started') setMessage(`Searching stage ${data.stage}. Suggested work budget: 30 seconds; completion time is uncertain.`)
        if (data.kind === 'progress') {
          searchProgress.current = { stage: data.stage, next: data.next }
          setMessage(`Searching stage ${data.stage}: ${(BigInt(data.next) - 1n).toLocaleString()} key IDs checked · ${Math.floor(data.elapsed / 1000)} seconds.`)
        }
        if (['found', 'paused', 'error'].includes(data.kind)) {
          nextWorker.terminate(); worker.current = null; setSearching(false)
          if (data.kind === 'found') { setCandidate(data); setMessage('Match found. Save it to your wallet before using or sharing it. Saving incurs a 1-satoshi record plus network fees.') }
          if (data.kind === 'paused') {
            setPausedSearch({ stage: data.stage, next: data.next }); setTarget(String(data.stage))
            setMessage('No match in this 30-second slice. Continue here for free, or save progress in your wallet to resume on another device.')
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
    setMessage('Search paused. Continue here for free, or save progress in your wallet to resume on another device. Saved addresses are already recoverable.')
  }
  const choose = (keyID: string) => void run(async () => {
    const fresh = await reload(); const entry = fresh.book.find(x => x.keyID === keyID)
    if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked)
    if (!entry) throw new Error('Address not found')
    assertReceivable(entry, fresh.coverage.stage)
    await fresh.store.append('primary', { keyID }); await reload(fresh); setFound(null); setMessage('Receiving address selected. Previous addresses keep their own sunset dates.')
  })
  const checkCoins = (keyID: string) => void run(async () => {
    const fresh = await reload(); const entry = fresh.book.find(x => x.keyID === keyID)!
    const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
    setBalances(x => ({ ...x, [keyID]: coins })); await reload(fresh)
    setMessage('Funds checked and deposit evidence retained in your wallet. Network checks depend on WoC availability.')
  })
  const importMoney = (keyID: string) => void run(async () => {
    const fresh = await reload()
    if (unresolvedActions(fresh.records).length) throw new Error('Review the unfinished wallet action before another payment.')
    const entry = fresh.book.find(x => x.keyID === keyID)!
    const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
    const submitted = await importCoins(client, fresh.store, entry, coins, fresh.coverage, setMessage)
    setTxid(submitted); setHistory(x => [{ txid: submitted, description: 'Import to wallet', status: 'Submitted' }, ...x]); setBalances(x => ({ ...x, [keyID]: undefined }))
    await reload(fresh); setMessage('Import submitted. Check wallet status; confirmations and wallet credit may follow later.')
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
    setMessage('Payment submitted. Exchange credit and confirmation are separate; check wallet history before retrying.')
  })

  const disabled = busy || searching
  const primary = session?.book.find(x => x.keyID === session.primary)
  const foundEntry = session?.book.find(x => x.keyID === found)
  const pendingActions = session ? unresolvedActions(session.records) : []
  const savedSearches = session ? [...new Map(session.records.filter(x => x.kind === 'search').map(x => [Number(x.data.stage), x.data])).values()]
    .filter(x => Number(x.stage) > Math.max(...session.book.map(entry => lastCoveredStage(entry.address)))) : []
  const card = (entry: AddressRecord, selected = false) => {
    const coins = balances[entry.keyID]
    const pending = session!.coverage.state?.pending
    const pendingExpiry = !entry.retiredAt && pending && !addressMatches(entry.address, pending.target)
    return <article className={`address-card ${entry.retiredAt ? 'expired' : ''}`} key={entry.keyID}>
      <h3>{entry.keyID === '1' ? 'Original address' : 'Mined address'} {selected && <span className="badge">Receiving</span>}</h3>
      <code className="address">{entry.address}</code>
      <p className={entry.retiredAt ? 'expiry-warning' : 'coverage'}>{coverageLabel(entry.address, entry.network, session!.coverage.anchorMtp, entry.retiredAt)}</p>
      <p>{entry.retiredAt ? 'Mountaintops no longer checks this address for new deposits. Coins received before expiration remain yours and can still be imported.' : 'Stop using this address when it expires. Coins already received remain yours.'}</p>
      {pendingExpiry && <p className="expiry-warning">Pending sunset at stage {pending.target}: the chain-time notice ends {new Date(pending.deadline * 1000).toISOString().replace('.000Z', ' UTC')}. Expiration starts in the following accepted block. This is a chain-time deadline, not a wall-clock guarantee. Use a longer-coverage address for new payment instructions.</p>}
      {entry.retiredAt && <p>Expired at block {entry.retiredAt.height.toLocaleString()}, {new Date(entry.retiredAt.mtp * 1000).toISOString().slice(0, 10)} UTC. Receiving is permanently disabled.</p>}
      <div className="buttons">
        {!entry.retiredAt && <button disabled={disabled || Boolean(session?.receivingBlocked)} onClick={() => void run(async () => { const fresh = await reload(); if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked); assertReceivable(fresh.book.find(x => x.keyID === entry.keyID)!, fresh.coverage.stage); await navigator.clipboard.writeText(entry.address); setMessage('Address copied. Include its coverage information when sharing.'); })}>Copy address</button>}
        {!entry.retiredAt && !selected && <button disabled={disabled || Boolean(session?.receivingBlocked)} onClick={() => choose(entry.keyID)}>Use this address</button>}
        <button disabled={disabled} onClick={() => checkCoins(entry.keyID)}>{entry.retiredAt ? 'Check retained funds' : 'Get Balance'}</button>
        <button disabled={disabled || !coins?.length || pendingActions.length > 0} onClick={() => importMoney(entry.keyID)}>Import Money</button>
      </div>
      {!entry.retiredAt && !selected && <p className="small">Selecting this address saves your preference in the wallet: a 1-satoshi record plus network fees.</p>}
      <p>{coins === undefined ? 'Funds not checked in this session.' : `${entry.retiredAt ? 'Verified retained funds' : 'Verified unspent funds'}: ${money(coins.reduce((sum, coin) => sum + coin.satoshis, 0))}`}</p>
      <details><summary>Address details</summary><p>Key ID {entry.keyID}. Address filter satisfied through stage {lastCoveredStage(entry.address)}. Transaction eligibility also affects receiving.</p>{coins && <p>Funding transactions: {coins.filter(x => x.fundingCoverage === 'covered').length} covered at confirmation, {coins.filter(x => x.fundingCoverage === 'outside coverage').length} outside the coverage rules, {coins.filter(x => x.fundingCoverage === 'unconfirmed').length} unconfirmed. These labels do not change ownership or actual unspent funds.</p>}</details>
    </article>
  }

  return <main aria-busy={busy || searching}>
    <header><h1>Mountaintops</h1><p>Shout your BSV transactions from the mountaintops.<br /><strong>Absolutely no privacy!</strong></p></header>
    <section><h2>Your receiving addresses</h2><p>Coverage deadlines apply to receiving and free lookups. Your coins remain yours after an address expires.</p>
      {!session ? <><button disabled={disabled} onClick={() => void run(async () => { await reload(null); setMessage('Address history loaded from your BRC-100 wallet. No browser data is needed.'); })}>{busy ? 'Connecting to wallet…' : 'Show My BSV Address'}</button><p>Connect your BRC-100 wallet. Recovery records use encrypted on-chain PushDrop tokens in your wallet’s basket. Saving records uses a 1-satoshi token plus network fees; your wallet controls approval. Mountaintops has no application server.</p></> : <>
        <p className="small">{session.network} · coverage through block {session.coverage.height.toLocaleString()}{session.network === 'mainnet' && ` · stage ${session.coverage.stage}`}</p>
        {session.receivingBlocked && <p className="error" role="alert">{session.receivingBlocked}</p>}
        {session.coverage.persistenceWarning && <p className="notice">{session.coverage.persistenceWarning}</p>}
        {primary ? card(primary, true) : <p className="expiry-warning">No eligible receiving address selected. Find or select one below. Historical coins remain accessible.</p>}
        <div className="mining"><h3>Find longer coverage</h3><p>Search in your browser for free, in 30-second work slices. A match may arrive sooner. Save a result to your wallet before using it, then select it as your receiving address.</p>
          <label>Search target<select value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}><option value="auto">Suggested for this device · about 30 seconds</option>{stages.slice(1).map(row => <option key={row.stage} value={row.stage}>Stage {row.stage} · {row.compactAddressRule}</option>)}</select></label>
          {searching ? <button onClick={cancelMine}>Pause search</button> : <button disabled={disabled || session.network !== 'mainnet'} onClick={() => void mine()}>{pausedSearch ? 'Continue search' : 'Find longer-coverage address'}</button>}
          {searching && <p className="notice">{message}</p>}
          {pausedSearch && <button disabled={disabled} onClick={() => void run(async () => {
            const fresh = await reload(); await fresh.store.append('search', pausedSearch); await reload(fresh)
            setMessage('Search progress saved in your wallet. You can resume this target on another device.')
          })}>Save progress to wallet · fees apply</button>}
          {!searching && savedSearches.map(search => <p key={String(search.stage)}><button disabled={disabled} onClick={() => { setTarget(String(search.stage)); void mine(Number(search.stage)) }}>Resume saved stage {String(search.stage)} search</button> <span className="small">Recovered from your wallet; next key ID {String(search.next)}.</span></p>)}
          {candidate && <div className="notice"><h3>Match found · not saved yet</h3><p>Passes the address filter through stage {lastCoveredStage(candidate.address)}. Your receiving address has not changed.</p><button disabled={disabled} onClick={() => void publishFound(candidate)}>Save address to wallet · fees apply</button><p className="small">Creates an encrypted 1-satoshi PushDrop record plus network fees. Only saved addresses can be selected or shared.</p></div>}
          {foundEntry && <div><p>Found and saved. Review before switching:</p>{card(foundEntry)}</div>}
        </div><h3>Previous and saved addresses</h3><p>Previous addresses can receive until their own expiration. Expired addresses are kept for historical access.</p>
        {session.book.filter(x => x.keyID !== primary?.keyID && x.keyID !== foundEntry?.keyID).map(x => card(x))}
        <button disabled={disabled} onClick={() => void run(async () => { await reload(); setMessage('Coverage and wallet records refreshed.') })}>Refresh coverage</button>
      </>}
    </section>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
    {session && <>
      {pendingActions.length > 0 && <section className="warning"><h2>Review unfinished wallet actions</h2><p>Check wallet history before sending again. The wallet may already be retrying a submission.</p>{pendingActions.map(action => <div key={String(action.id)}><p>{String(action.state)} {action.txid ? `· ${String(action.txid)}` : ''}</p><button disabled={disabled} onClick={() => void run(async () => {
        const fresh = await reload()
        if (action.state === 'prepared' && typeof action.reference === 'string') {
          const aborted = await client.abortAction({ reference: action.reference })
          if (!aborted.aborted) throw new Error('Wallet did not acknowledge cancellation')
        } else {
          const page = await client.listActions({ labels: [`mountaintops request ${String(action.id)}`], limit: 100 })
          if (!page.actions.length || page.actions.some(x => !['completed', 'failed'].includes(x.status))) throw new Error('Wallet has not established a final outcome. Do not retry this payment.')
        }
        await reload(fresh); setMessage('Wallet action state checked.')
      })}>{action.state === 'prepared' ? 'Cancel unsubmitted preparation' : 'Check wallet outcome'}</button></div>)}</section>}
      <section><h2>SHOUT BSV Across To Someone</h2><p>Pay from your connected wallet. Expired destinations are blocked. Wallet network fees apply.</p><label>Recipient Address<input value={recipient} disabled={disabled} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} /></label><label>Amount (BSV)<input value={amount} disabled={disabled} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></label><button className="accent" disabled={disabled || pendingActions.length > 0 || !recipient || !amount} onClick={send}>SHOUT BSV</button>{txid && <p className="transaction">Submitted TXID: {txid}</p>}<p className="small">Submission, confirmation and exchange credit are separate. Check wallet history after an uncertain outcome before another send.</p></section>
      <section><h2>Transactions this session</h2><p className="small">This list clears when you reload or leave. Your wallet keeps its own payment records; address and coin recovery do not depend on this list.</p>{!history.length && <p>No transactions submitted in this session.</p>}{history.map(x => <p className="transaction" key={x.txid}>{x.description} · {x.status}<br />{x.txid}</p>)}</section>
    </>}
    <section><h2>About expiration and recovery</h2><details><summary>What expires?</summary><p>An address stops being available for receiving here when it leaves BRC-234 coverage. New-deposit lookups stop. Ownership and spending/importing existing coins remain intact. Do not send to expired addresses from any application.</p></details><details><summary>Can I use a new device?</summary><p>Restore the same BRC-100 wallet account and connect here. Encrypted PushDrop records in its basket recover your addresses and retirement history; the wallet retains coin evidence. No browser data or exports from the original device are needed. Keep your wallet account and its own recovery/storage service available.</p></details><details><summary>Why isn’t the sunset a fixed date?</summary><p>BRC-234 begins at mainnet block 1,000,000. Transitions also depend on volume and chain-time waiting periods. An eligibility gate differs from actual expiration.</p></details><details><summary>Does mining guarantee every payment is covered?</summary><p>Coverage also depends on the confirmed funding TXID and, from stage 13, version 1. The app prepares eligible payments within a bounded work budget. External senders may create payments outside those rules. A filtered ledger total is never treated as spendable money.</p></details></section>
    <footer>Powered by your BRC-100 wallet and <a href="https://whatsonchain.com" target="_blank" rel="noreferrer">WhatsOnChain</a>. <a href="https://docs.projectbabbage.com/docs/metanet-client/funding" target="_blank" rel="noreferrer">Funding and exchange guide</a></footer>
  </main>
}
