type Props = { message: string; moving?: boolean }

export default function PaymentProgress({ message, moving = false }: Props) {
  const phase = message === 'Finishing with your wallet…' ? 'Review the request in your wallet.'
    : message === 'Sending payment…' ? 'Submitting to your wallet…'
    : ['Checking your payment…', 'Updating your payments…'].includes(message) ? message
    : 'Preparing your payment…'
  return <div className="payment-progress" role="status" aria-label="Payment progress" aria-live="polite" aria-atomic="true">
    <div className="payment-motion" aria-hidden="true">
      <span className="payment-orbit" />
      <svg viewBox="0 0 32 32" fill="none"><path d="m7 15 19-9-8 20-3-9-8-2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="m15 17 7-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
    </div>
    <div><p className="progress-title">{moving ? 'Moving to your wallet' : 'Sending your payment'}</p><p className="progress-phase">{phase}</p><p className="progress-hint">Approve in your wallet if prompted.</p></div>
  </div>
}
