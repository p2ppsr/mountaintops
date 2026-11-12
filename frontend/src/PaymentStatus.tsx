type Props = {
  actions: Record<string, unknown>[]
  checkedAt: number | null
  disabled: boolean
  busy: boolean
  onReview: (action: Record<string, unknown>) => void
}

export default function PaymentStatus({ actions, checkedAt, disabled, busy, onReview }: Props) {
  return actions.map(action => {
    const prepared = action.state === 'prepared'
    return <section className={`payment-status ${prepared ? 'prepared' : 'needs-review'}`} aria-label="Wallet payment status" key={String(action.id)}>
      <div className="payment-status-heading">
        <span className="payment-status-mark" aria-hidden="true">{prepared ? '·' : '!'}</span>
        <div className="payment-status-copy">
          <h2>{prepared ? 'Unfinished payment' : 'Check your wallet'}</h2>
          <p>{prepared ? 'This payment has not been sent.' : 'Your wallet has not reported a clear result.'}</p>
        </div>
        <button className="secondary" disabled={disabled} aria-label={prepared ? 'Cancel unsent payment' : 'Check payment in wallet'} onClick={() => onReview(action)}>{busy ? 'Checking…' : prepared ? 'Cancel payment' : 'Check again'}</button>
      </div>
      <p className="payment-status-guidance">{prepared ? 'Cancel it to start a new payment.' : 'Check this attempt before sending the same payment again.'}</p>
      <details className="payment-status-details">
        <summary>Details</summary>
        {action.txid ? <p className="transaction">{String(action.txid)}</p> : <p>No transaction ID was returned.</p>}
        {checkedAt && <p className="small">Last checked <time dateTime={new Date(checkedAt).toISOString()}>{new Date(checkedAt).toLocaleTimeString()}</time>.</p>}
      </details>
    </section>
  })
}
