import { useEffect, useRef } from 'react'
import { bsvAmount } from './paymentAmount.ts'
import PaymentProgress from './PaymentProgress.tsx'

export type PaymentDraft = { recipient: string; satoshis: number }

export default function PaymentReview({ payment, busy, sending, phase, onBack, onSend }: { payment: PaymentDraft; busy: boolean; sending: boolean; phase: string; onBack: () => void; onSend: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return <section className="send-review" aria-label="Review payment">
    {sending ? <PaymentProgress message={phase} /> : <p className="eyebrow">Review payment</p>}
    <h2 ref={heading} tabIndex={-1}>{payment.satoshis.toLocaleString()} <span>sats</span></h2>
    <p className="small">{bsvAmount(payment.satoshis)} BSV</p>
    <div className="review-recipient"><span className="small">To</span><code>{payment.recipient}</code></div>
    <p className="small review-fees">Wallet and network fees are additional.</p>
    <div className="review-actions"><button className="secondary" disabled={busy} onClick={onBack}>Back</button><button className="accent" disabled={busy} onClick={onSend}>{sending ? 'Sending…' : 'Send payment'}</button></div>
  </section>
}
