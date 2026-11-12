import { useEffect, useRef, useState } from 'react'
import { PublicKey, WalletClient } from '@bsv/sdk'
import { addressMatches, assertReceivable, coverageLabel, lastCoveredStage, stages, type AddressRecord, type Network } from '../../shared/brc234.ts'
import { WalletRecords, type RecoveryRecord } from './walletRecords.ts'
import { applyExpirations, bookFromRecords, validateAddress } from './addressBook.ts'
import { AddressCheckRequiredError, assertCopyableAddress, calendarEstimate, expirationEstimate, receivingKeyID } from './receiveUX.ts'
import ReceiveInfo from './ReceiveInfo.tsx'
import PaymentStatus from './PaymentStatus.tsx'
import PaymentReceipt, { type PaymentReceiptData } from './PaymentReceipt.tsx'
import PaymentProgress from './PaymentProgress.tsx'
import PaymentReview, { type PaymentDraft } from './PaymentReview.tsx'
import { bsvAmount, parseAmount, type AmountUnit } from './paymentAmount.ts'
import { readCoverage, type Coverage } from './coverageClient.ts'
import { availableRetainedCoins, refreshCoins, type Coin } from './coins.ts'
import { importCoins, sendCoins, PaymentOutcomeUnknownError } from './actions.ts'
import { preferCompatibleTransport } from './walletClient.ts'
import { paymentActionRecords, refreshPaymentStatus, WalletAccountChangedError, walletStatusMessage } from './walletActionState.ts'
import './style.css'

const client = new WalletClient('auto')
type Session = { identity: string; network: Network; store: WalletRecords; book: AddressRecord[]; records: RecoveryRecord[]; coverage: Coverage; primary: string | null; receivingBlocked: string | null }
const money = (satoshis: number) => `${bsvAmount(satoshis)} BSV`

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
  const [statusCheckedAt, setStatusCheckedAt] = useState<number | null>(null)
  const [balances, setBalances] = useState<Record<string, Coin[] | undefined>>({})
  const [checkedPayments, setCheckedPayments] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<'receive' | 'send'>('receive')
  const [target, setTarget] = useState('auto')
  const [candidate, setCandidate] = useState<{ stage: number; keyID: string; address: string } | null>(null)
  const [pausedSearch, setPausedSearch] = useState<{ stage: number; next: string } | null>(null)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<AmountUnit>('sats')
  const [review, setReview] = useState<PaymentDraft | null>(null)
  const [receipt, setReceipt] = useState<PaymentReceiptData | null>(null)
  const [paymentInFlight, setPaymentInFlight] = useState<'send' | 'move' | null>(null)
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null)
  const [manualCopyAddress, setManualCopyAddress] = useState<string | null>(null)
  const [history, setHistory] = useState<PaymentReceiptData[]>([])
  const [searching, setSearching] = useState(false)
  const [info, setInfo] = useState<{ stage: number; expired: boolean } | null>(null)
  const worker = useRef<Worker | null>(null)
  const searchProgress = useRef<{ stage: number; next: string } | null>(null)
  const operation = useRef(false)
  const current = useRef<Session | null>(null)
  current.current = session

  useEffect(() => () => { worker.current?.terminate() }, [])
  useEffect(() => {
    if (!copiedAddress) return
    const timer = setTimeout(() => setCopiedAddress(null), 2000)
    return () => clearTimeout(timer)
  }, [copiedAddress])
  const run = async (task: () => Promise<void>, quiet = false) => {
    if (operation.current) return
    operation.current = true; setBusy(true)
    if (!quiet) { setError(''); setMessage('Working… Check your wallet if prompted.') }
    try { await task() } catch (e) { setMessage(''); setError(e instanceof Error ? e.message : 'Operation unavailable. Check your wallet before retrying a payment.') }
    finally { operation.current = false; setBusy(false) }
  }
  const runPayment = (kind: 'send' | 'move', task: () => Promise<void>) => run(async () => {
    setPaymentInFlight(kind); setReceipt(null)
    try { await task() } finally { setPaymentInFlight(null) }
  })

  const clearWalletSession = () => {
    setCopiedAddress(null); setManualCopyAddress(null)
    setSession(null); setBalances({}); setCheckedPayments({}); setCandidate(null); setPausedSearch(null); setHistory([]); setReceipt(null); setReview(null); setRecipient(''); setAmount('')
  }

  const reload = async (previous: Session | null = current.current): Promise<Session> => {
    await preferCompatibleTransport(client)
    const { network } = await client.getNetwork({})
    const { publicKey: identity } = await client.getPublicKey({ identityKey: true })
    if (previous && (previous.identity !== identity || previous.network !== network)) {
      clearWalletSession()
      throw new WalletAccountChangedError()
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
    records = await paymentActionRecords(client, network, [...records, ...(previous?.records.filter(record => record.kind === 'action' && record.clock === 0) ?? [])])
    const next = { identity, network, store, records, book, coverage, primary: receivingBlocked ? null : receivingKeyID(book, coverage.stage, previous?.primary), receivingBlocked }
    setSession(next)
    setStatusCheckedAt(Date.now())
    return next
  }

  const connect = () => void run(async () => {
    setBalances({}); setCheckedPayments({})
    const fresh = await reload(null)
    setMessage('Restoring payments from your wallet…')
    let failure: unknown
    for (const entry of fresh.book) {
      try {
        const coins = await availableRetainedCoins(client, entry, fresh.coverage)
        setBalances(x => ({ ...x, [entry.keyID]: coins }))
      } catch (e) { failure ??= e }
    }
    await reload(fresh)
    if (failure) throw failure
    setMessage('')
  })

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
  const copyAddress = (displayed: AddressRecord) => {
    const fresh = current.current
    if (!fresh) return
    const entry = fresh.book.find(item => item.keyID === displayed.keyID && item.address === displayed.address)
    try {
      if (!entry) throw new Error('Address changed. Choose the current receiving address.')
      assertCopyableAddress(entry, fresh.coverage, fresh.receivingBlocked)
    } catch (error) {
      if (error instanceof AddressCheckRequiredError && !operation.current) {
        void run(async () => { await reload(); setMessage('Address checked. Click Copy address to copy it.') })
      } else { setMessage(''); setError(error instanceof AddressCheckRequiredError ? 'Address status is updating. Copy it when the check finishes.' : error instanceof Error ? error.message : 'Address unavailable.') }
      return
    }
    const manualCopy = () => {
      setCopiedAddress(null); setManualCopyAddress(entry.address)
      const node = document.getElementById(`address-${entry.keyID}`)
      if (node) { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range) }
    }
    setError(''); setMessage(''); setManualCopyAddress(null)
    try {
      // Start the clipboard write directly in the click, before any await/RPC.
      if (!navigator.clipboard?.writeText) { manualCopy(); return }
      void navigator.clipboard.writeText(entry.address).then(() => setCopiedAddress(entry.address), manualCopy)
    } catch { manualCopy() }
  }
  const checkCoins = (keyID: string) => void run(async () => {
    const fresh = await reload(); const entry = fresh.book.find(x => x.keyID === keyID)!
    setCheckedPayments(x => ({ ...x, [keyID]: false }))
    const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
    setBalances(x => ({ ...x, [keyID]: coins })); setCheckedPayments(x => ({ ...x, [keyID]: true })); await reload(fresh)
    setMessage('Payments checked for this address.')
  })
  const checkAllCoins = () => void run(async () => {
    const fresh = await reload()
    for (const entry of fresh.book) {
      setCheckedPayments(x => ({ ...x, [entry.keyID]: false }))
      const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
      setBalances(x => ({ ...x, [entry.keyID]: coins }))
      setCheckedPayments(x => ({ ...x, [entry.keyID]: true }))
    }
    await reload(fresh); setMessage('Payments checked.')
  })
  const finishPayment = async (fresh: Session, task: () => Promise<string>, details: Omit<PaymentReceiptData, 'txid'>, onAccepted: () => void) => {
    let submitted: string
    try { submitted = await task() } catch (error) {
      if (!(error instanceof PaymentOutcomeUnknownError)) throw error
      const guard: RecoveryRecord = { v: 1, kind: 'action', clock: 0, network: fresh.network, data: { id: error.txid, txid: error.txid, state: 'needs wallet review', reference: null } }
      setSession(previous => previous && previous.identity === fresh.identity && previous.network === fresh.network ? { ...previous, records: [...previous.records.filter(record => record.kind !== 'action' || record.data.txid !== error.txid), guard] } : previous)
      setReceipt(null); setReview(null); setRecipient(''); setAmount(''); setError(''); setMessage('')
      return
    }
    const payment = { ...details, txid: submitted }
    setReceipt(payment); setHistory(items => [payment, ...items]); setReview(null); setRecipient(''); setAmount(''); setMessage('')
    onAccepted()
    // The wallet acknowledged this transaction. Do not turn a later chain or
    // metadata read into a payment failure, or wait for the wallet's mined proof.
  }

  const importMoney = (keyID: string) => void runPayment('move', async () => {
    const fresh = await reload()
    if (unresolvedActions(fresh.records).length) throw new Error('Review the unfinished wallet action before another payment.')
    const entry = fresh.book.find(x => x.keyID === keyID)!
    const coins = await refreshCoins(client, fresh.store, entry, fresh.coverage, setMessage)
    await finishPayment(fresh, () => importCoins(client, fresh.store, entry, coins, fresh.coverage, setMessage), { kind: 'move' }, () => {
      setBalances(values => ({ ...values, [keyID]: (values[keyID] ?? []).filter(coin => !coins.some(spent => spent.txid === coin.txid && spent.vout === coin.vout)) }))
    })
  })
  const reviewPayment = () => {
    if (!session || disabled || unresolvedActions(session.records).length) return
    try {
      const destination = recipient.trim()
      validateAddress(destination, session.network)
      const satoshis = parseAmount(amount, unit)
      setReview({ recipient: destination, satoshis }); setReceipt(null); setError(''); setMessage('')
    } catch (error) { setError(error instanceof Error ? error.message : 'Check the recipient and amount.'); setMessage('') }
  }
  const send = () => void runPayment('send', async () => {
    if (!review) throw new Error('Review the recipient and amount before sending.')
    const intent = review
    const fresh = await reload()
    if (unresolvedActions(fresh.records).length) throw new Error('Review the unfinished wallet action before another payment.')
    if (fresh.receivingBlocked) throw new Error(fresh.receivingBlocked)
    const own = fresh.book.find(x => x.address === intent.recipient)
    if (own) assertReceivable(own, fresh.coverage.stage)
    await finishPayment(fresh, () => sendCoins(client, fresh.store, intent.recipient, bsvAmount(intent.satoshis), fresh.coverage, setMessage), { ...intent, kind: 'send' }, () => {})
  })

  const disabled = busy || searching
  const calendar = session ? calendarEstimate(session.coverage) : null
  const primary = session?.book.find(x => x.keyID === session.primary)
  const suggestedEntry = !candidate && !pausedSearch && !searching && session?.book.filter(x => !x.retiredAt && lastCoveredStage(x.address) > (primary ? lastCoveredStage(primary.address) : -1)).sort((a, b) => lastCoveredStage(b.address) - lastCoveredStage(a.address))[0]
  const pendingActions = session ? unresolvedActions(session.records) : []
  const paymentHold = pendingActions.length ? 'Check your wallet to continue.' : ''
  const allPaymentsChecked = Boolean(session?.book.every(x => checkedPayments[x.keyID]))
  const checkedCount = session?.book.filter(x => checkedPayments[x.keyID]).length ?? 0
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
    const expiration = entry.retiredAt ? 'Expired — do not send here' : pendingExpiry ? 'Expiration pending — stop sharing' : entry.network !== 'mainnet' ? 'No testnet expiration schedule' : expirationEstimate(level, calendar).replace(/^Not earlier than /, 'Estimated expiry: ')
    return <article className={`address-card ${selected ? 'selected' : ''} ${entry.retiredAt ? 'expired' : ''}`} key={entry.keyID}>
      <div className="card-heading"><h3>{name}</h3><span className={`badge ${entry.retiredAt || pendingExpiry ? 'caution' : ''}`}>{entry.retiredAt ? 'Expired' : pendingExpiry ? 'Expiring' : 'Active'}</span></div>
      <code className="address" id={`address-${entry.keyID}`}>{entry.address}</code>
      <div className="expiry-summary"><p className={entry.retiredAt || pendingExpiry ? 'expiry-warning' : 'coverage'}>{expiration}</p>{entry.network === 'mainnet' && <button className="text-button" onClick={() => setInfo({ stage: level, expired: Boolean(entry.retiredAt) })} aria-label={`More info about stage ${level} address expiration`}>More info</button>}</div>
      {entry.retiredAt && <p className="small">Receiving is disabled. You can still move earlier payments to your wallet.</p>}
      {pendingExpiry && <p className="expiry-warning">Stop sharing this address. The chain-time notice ends {new Date(pending.deadline * 1000).toISOString().replace('.000Z', ' UTC')}; expiration begins in the following accepted block.</p>}
      <div className="buttons">
        {!entry.retiredAt && <button className={selected ? 'accent' : 'secondary'} aria-label="Copy address" disabled={Boolean(session?.receivingBlocked) || Boolean(pendingExpiry)} onClick={() => copyAddress(entry)}>{copiedAddress === entry.address ? 'Copied!' : 'Copy address'}</button>}
        {!entry.retiredAt && !selected && <button disabled={disabled || Boolean(session?.receivingBlocked)} onClick={() => choose(entry.keyID)}>Use for receiving</button>}
      </div>
      {copiedAddress === entry.address && <span className="copy-feedback small" role="status">Address copied.</span>}
      {manualCopyAddress === entry.address && <p className="small" role="status">Automatic copy is unavailable. Select the address above and use your browser’s Copy command.</p>}
      {!selected && <><div className="funds-row"><div>{total !== undefined && (total > 0 || checkedPayments[entry.keyID]) ? <><strong className="funds">{total.toLocaleString()} sats</strong><span className="small">{money(total)} · available here</span></> : <span className="small">{total === undefined ? 'Payments not checked' : 'Not checked for new payments'}</span>}</div><button className="secondary" disabled={disabled} onClick={() => checkCoins(entry.keyID)}>{entry.retiredAt ? 'Check earlier payments' : total === undefined ? 'Check for payments' : 'Refresh'}</button></div>
      {Boolean(coins?.length) && <><div className="import-row"><button disabled={disabled || pendingActions.length > 0} onClick={() => importMoney(entry.keyID)}>Move to wallet</button><span className="small">Wallet fees apply.</span></div>{paymentHold && <p className="small">{paymentHold}</p>}</>}</>}
      <details className="technical"><summary>Address details</summary><p>{coverageLabel(entry.address, entry.network, session!.coverage.anchorMtp, entry.retiredAt)}</p>{!entry.retiredAt && !pendingExpiry && entry.network === 'mainnet' && longest > 0 && <p>{level === longest ? 'Longest coverage of your saved addresses.' : 'Expires earlier than your longest-lasting saved address.'}</p>}{entry.retiredAt && <p>Expired at block {entry.retiredAt.height.toLocaleString()}. New-deposit lookups have stopped permanently.</p>}<p>Key ID {entry.keyID} · address rules satisfied through stage {level}. Payment transaction rules also apply.</p>{coins && <p>Funding transactions: {coins.filter(x => x.fundingCoverage === 'covered').length} covered at confirmation, {coins.filter(x => x.fundingCoverage === 'outside coverage').length} outside coverage, {coins.filter(x => x.fundingCoverage === 'unconfirmed').length} unconfirmed. These labels do not change ownership.</p>}</details>
    </article>
  }

  return <main aria-busy={busy || searching}>
    <header><div className="brand"><img className="mountain-mark" src="/mountaintops.svg" width="40" height="40" alt="" aria-hidden="true" /><h1>Mountaintops</h1></div><p>Public BSV payments.</p></header>
    {!session ? <section className="connect"><h2>Your BSV, ready to receive.</h2><p>Connect your wallet to find your addresses and payments.</p><button className="accent" disabled={disabled} onClick={connect}>{busy ? 'Connecting…' : 'Connect wallet'}</button><p className="small">Use the same BRC-100 wallet on any device.</p></section> : <>
      <nav className="view-tabs" aria-label="Payment direction"><button disabled={Boolean(paymentInFlight)} aria-pressed={view === 'receive'} onClick={() => setView('receive')}>Receive</button><button disabled={Boolean(paymentInFlight)} aria-pressed={view === 'send'} onClick={() => setView('send')}>Send</button><span className="connection">{session.network === 'mainnet' ? 'Mainnet' : 'Testnet'} · Connected</span></nav>
      <PaymentStatus actions={pendingActions} checkedAt={statusCheckedAt} disabled={disabled} busy={busy} onReview={action => void run(async () => {
        setError(''); setMessage('')
        try {
          let result = await refreshPaymentStatus(client, session.identity, session.network, session.records, action)
          let canceled = false
          const prepared = result.records.find(record => record.kind === 'action' && record.data.id === action.id && record.data.state === 'prepared' && record.data.reference === action.reference)
          if (action.state === 'prepared' && typeof action.reference === 'string' && prepared) {
            const aborted = await client.abortAction({ reference: action.reference })
            if (!aborted.aborted) throw new Error('Wallet did not acknowledge cancellation')
            canceled = true
            result = await refreshPaymentStatus(client, session.identity, session.network, result.records, action)
          }
          setSession({ ...session, records: result.records }); setStatusCheckedAt(Date.now())
          if (!canceled && result.status === 'accepted' && typeof action.txid === 'string') {
            setReceipt({ txid: action.txid, kind: 'recovered' }); setReview(null)
          }
          setMessage(canceled ? 'Unsent payment canceled.' : unresolvedActions(result.records).length || result.status === 'accepted' ? '' : walletStatusMessage(result.status))
        } catch (error) {
          if (error instanceof WalletAccountChangedError) clearWalletSession()
          throw error
        }
      }, true)} />
      {receipt && <PaymentReceipt payment={receipt} onDone={() => { setReceipt(null); setView('receive') }} onAnother={() => { setReceipt(null); setReview(null); setView('send') }} />}
      {paymentInFlight === 'move' && <section className="moving-payment"><PaymentProgress message={message} moving /></section>}
      {session.receivingBlocked && <p className="error" role="alert">{session.receivingBlocked}</p>}
      {session.coverage.persistenceWarning && <p className="notice">{session.coverage.persistenceWarning}</p>}
      {((message && !paymentInFlight) || error) && <div className="feedback">{message && !searching && !paymentInFlight && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}</div>}
      {view === 'receive' ? <section className="receive-panel" aria-label="Receive BSV">
        {primary ? card(primary, true) : <div className="empty-state"><h2>Choose a receiving address</h2><p>Find a new address or choose an active one below. Earlier payments remain yours.</p></div>}
        <div className="payments-panel"><div className="section-heading"><h3>Your payments</h3><button className="secondary" aria-label="Refresh payments" disabled={disabled} onClick={checkAllCoins}>Refresh</button></div>
          {checkedCount > 0 && !allPaymentsChecked ? <p className="small">{checkedCount} of {session.book.length} addresses checked for new payments.</p> : session.book.some(x => balances[x.keyID] === undefined) && <p className="small">Some payments still need checking.</p>}
          {session.book.filter(x => balances[x.keyID]?.length).map(entry => <div className="payment-row" key={entry.keyID}><div><span className="received-label">Received</span><strong>{balances[entry.keyID]!.reduce((sum, coin) => sum + coin.satoshis, 0).toLocaleString()} sats</strong>{(session.book.length > 1 || entry.retiredAt) && <span className="small">{entry.keyID === '1' ? 'Original address' : `Address …${entry.address.slice(-6)}`}{entry.retiredAt ? ' · earlier payments' : ''}</span>}</div><div className="payment-actions"><button disabled={disabled || pendingActions.length > 0} onClick={() => importMoney(entry.keyID)}>Move to wallet</button><span className="small">Wallet fees apply</span></div></div>)}
          {paymentHold && session.book.some(x => balances[x.keyID]?.length) && <p className="small payment-hold">{paymentHold}</p>}
          {allPaymentsChecked && session.book.every(x => balances[x.keyID]?.length === 0) && <p className="small">No available payments found.</p>}
        </div>
        <details className="address-search"><summary>{suggestedEntry ? 'Use a longer-lasting address' : 'Find a longer-lasting address'}</summary><div className="mining"><div className="section-heading"><p className="small">{suggestedEntry ? 'Already saved. Free to switch.' : 'Searching is free. Saving an address has wallet fees.'}</p>{searching ? <button className="secondary" onClick={cancelMine}>Pause</button> : <button disabled={disabled || session.network !== 'mainnet'} onClick={() => suggestedEntry ? choose(suggestedEntry.keyID) : void mine()}>{suggestedEntry ? 'Use saved address' : pausedSearch ? 'Keep searching' : 'Find an address'}</button>}</div>
          {suggestedEntry && <div className="saved-preview"><p className="coverage">{expirationEstimate(lastCoveredStage(suggestedEntry.address), calendar)}</p><span className="small">Estimated · stage {lastCoveredStage(suggestedEntry.address)}</span></div>}
          {searching && <p className="notice" role="status">{message}</p>}
          {candidate && <div className="result"><h3>New address found</h3><p className="coverage">{expirationEstimate(lastCoveredStage(candidate.address), calendar)}</p><div className="lifetime-meta"><span>Estimated · Stage {lastCoveredStage(candidate.address)}</span><button className="text-button" onClick={() => setInfo({ stage: lastCoveredStage(candidate.address), expired: false })}>More info</button></div><p className="small">Save once to recover this address on any device.</p><button disabled={disabled} onClick={() => void publishFound(candidate)}>Save &amp; use address</button><span className="small fee-note">Wallet fees apply to save. Switching saved addresses is free.</span></div>}
          <details className="advanced"><summary>Advanced search</summary><p className="small">Search runs for up to 30 seconds at a time. Higher stages take more work and pass stricter future address rules.</p>{suggestedEntry && <button disabled={disabled} onClick={() => void mine()}>Find another address</button>}<label>Search target<select value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}><option value="auto">Recommended · about 30 seconds</option>{stages.slice(1).map(row => <option key={row.stage} value={row.stage}>Stage {row.stage} · {expirationEstimate(row.stage, calendar).replace("Not earlier than", "not before")}</option>)}</select></label>
            {pausedSearch && <><button disabled={disabled} onClick={() => void run(async () => { const fresh = await reload(); await fresh.store.append('search', pausedSearch); await reload(fresh); setMessage('Search progress saved in your wallet.') })}>Save progress</button><p className="small">Wallet fees apply. Otherwise you can repeat this search on another device for free.</p></>}
            {!searching && savedSearches.map(search => <p key={String(search.stage)}><button disabled={disabled} onClick={() => { setTarget(String(search.stage)); void mine(Number(search.stage)) }}>Resume stage {String(search.stage)}</button> <span className="small">Saved in your wallet · next key ID {String(search.next)}</span></p>)}
          </details>
        </div></details>
        <details className="address-list"><summary>Other addresses <span className="count">{session.book.filter(x => x.keyID !== primary?.keyID).length}</span></summary><p className="small">Switching is free for this session. Reconnecting opens your longest-lasting eligible saved address.</p>{session.book.filter(x => x.keyID !== primary?.keyID).map(x => card(x))}<button className="secondary" disabled={disabled} onClick={() => void run(async () => { await reload(); setMessage('Addresses and expiration checked.') })}>Refresh addresses</button></details>
      </section> : receipt ? null : review ? <PaymentReview payment={review} busy={disabled || pendingActions.length > 0} sending={paymentInFlight === 'send'} phase={message} onBack={() => setReview(null)} onSend={send} /> : <section className="send-panel">
        <h2>Send BSV</h2>
        <form onSubmit={event => { event.preventDefault(); reviewPayment() }}>
          <label>To<input value={recipient} disabled={disabled} onChange={e => setRecipient(e.target.value)} placeholder="Paste a BSV address" autoComplete="off" spellCheck={false} maxLength={80} /></label>
          <label htmlFor="payment-amount">Amount</label>
          <div className="amount-entry"><input id="payment-amount" value={amount} disabled={disabled} onChange={e => setAmount(e.target.value)} placeholder="0" inputMode={unit === 'sats' ? 'numeric' : 'decimal'} maxLength={32} /><select aria-label="Amount unit" value={unit} disabled={disabled} onChange={event => {
            const next = event.target.value as AmountUnit
            if (amount) {
              try { const satoshis = parseAmount(amount, unit); setAmount(next === 'sats' ? String(satoshis) : bsvAmount(satoshis)) } catch { setAmount('') }
            }
            setUnit(next)
          }}><option value="sats">sats</option><option value="BSV">BSV</option></select></div>
          <button className="accent" type="submit" disabled={disabled || pendingActions.length > 0 || !recipient || !amount}>Review payment</button>
          {paymentHold && <p className="small">{paymentHold}</p>}
        </form>
      </section>}
      {history.length > 0 && <details className="activity"><summary>Recent activity <span className="count">{history.length}</span></summary><p className="small">This session only. Your wallet keeps the payment records.</p>{history.map(payment => <details className="activity-payment" key={payment.txid}><summary>{payment.kind === 'move' ? 'Moved to wallet' : 'Sent'}{payment.satoshis !== undefined ? ` · ${payment.satoshis.toLocaleString()} sats` : ''}</summary>{payment.recipient && <p className="small">To {payment.recipient}</p>}<p className="transaction">{payment.txid}</p></details>)}</details>}
    </>}
    {!session && error && <p className="error" role="alert">{error}</p>}
    <details className="help"><summary>Expiration, fees & recovery</summary><h3>When does my address expire?</h3><p>Each address shows a month-and-year estimate and the stage it meets. Choose More info for the schedule. Before block 1,000,000 arrives, estimates can move earlier or later. Low transaction volume can delay expiration.</p><p>When an address expires, stop using it everywhere. Mountaintops disables receiving and stops looking for new deposits. Earlier coins remain yours and can still be moved to your wallet.</p><h3>Can I recover on another device?</h3><p>Connect the same BRC-100 wallet account. Your saved addresses and coin evidence come from the wallet, without browser data or files from this device. Keep your wallet account and its recovery service available.</p><h3>What costs money?</h3><p>Searching and pausing are free. Saving a new address also makes it your receiving address in one encrypted 1-satoshi wallet record. Switching saved addresses is free for this session; reconnecting opens the longest-lasting eligible saved address. Saving search progress also needs a wallet record. Network and wallet service fees may apply to records. Moving or sending coins also incurs wallet fees.</p><h3>Does a longer-lasting address cover every payment?</h3><p>No. Funding TXID rules also apply, and from stage 13 the transaction must use version 1. Mountaintops prepares eligible transactions within a bounded work budget. External senders may create payments outside those rules. Eligibility never changes who owns the coins.</p><details><summary>Technical status</summary>{session && <p>{session.network} · checked through block {session.coverage.height.toLocaleString()} · stage {session.coverage.stage}</p>}<p>Client-only. Encrypted PushDrop recovery records use your BRC-100 wallet’s baskets. WhatsOnChain supplies chain data and historical recovery; unavailable or incomplete data cannot establish a balance.</p></details></details>
    {session && info && <ReceiveInfo stage={info.stage} expired={info.expired} coverage={session.coverage} onClose={() => setInfo(null)} />}
    <footer><span>Public transactions. No privacy.</span><div><a href="https://whatsonchain.com" target="_blank" rel="noreferrer">WhatsOnChain</a><a href="https://docs.projectbabbage.com/docs/metanet-client/funding" target="_blank" rel="noreferrer">Wallet help</a></div></footer>
  </main>
}
