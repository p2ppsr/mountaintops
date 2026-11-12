type Props = {
  actions: Record<string, unknown>[]
  checkedAt: number | null
  disabled: boolean
  busy: boolean
  onReview: (action: Record<string, unknown>) => void
}

export default function PaymentStatus({ actions, checkedAt, disabled, busy, onReview }: Props) {
  return actions.map(action => {
    const sent = action.state === 'awaiting confirmation'
    const prepared = action.state === 'prepared'
    return <section className={`payment-status ${sent ? 'sent' : prepared ? 'prepared' : 'needs-review'}`} aria-label="Wallet payment status" key={String(action.id)}>
      <div className="payment-status-heading">
        <span className="payment-status-mark" aria-hidden="true">{sent ? '✓' : prepared ? '·' : '!'}</span>
        <div className="payment-status-copy">
          <h2>{sent ? 'Payment sent' : prepared ? 'Payment not sent' : 'Check payment status'}</h2>
          <p>{sent ? 'Waiting for confirmation.' : prepared ? 'A prepared payment is waiting in your wallet.' : 'Your wallet has not reported a clear result.'}</p>
        </div>
        <button className="secondary" disabled={disabled} aria-label={prepared ? 'Cancel unsent payment' : 'Refresh payment status'} onClick={() => onReview(action)}>{busy ? 'Checking…' : prepared ? 'Cancel payment' : 'Refresh'}</button>
      </div>
      {!sent && <p className="payment-status-guidance">{prepared ? 'Cancel it before starting another payment.' : 'Check wallet activity before trying again.'}</p>}
      <details className="payment-status-details">
        <summary>Payment details</summary>
        {sent && <p>Your payment has been submitted. Do not send the same payment again.</p>}
        {action.txid ? <p className="transaction">{String(action.txid)}</p> : <p>No transaction ID was returned.</p>}
        {checkedAt && <p className="small">Last checked <time dateTime={new Date(checkedAt).toISOString()}>{new Date(checkedAt).toLocaleTimeString()}</time>.</p>}
      </details>
    </section>
  })
}
