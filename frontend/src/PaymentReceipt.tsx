import { useEffect, useRef } from 'react'
import { bsvAmount } from './paymentAmount.ts'

export type PaymentReceiptData = { txid: string; kind: 'send' | 'move' | 'recovered'; satoshis?: number; recipient?: string }

export default function PaymentReceipt({ payment, onDone, onAnother }: { payment: PaymentReceiptData; onDone: () => void; onAnother: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [payment.txid])
  return <section className="payment-receipt" aria-label="Payment receipt" role="status">
    <div className="receipt-mark" aria-hidden="true">✓</div>
    <p className="eyebrow">{payment.kind === 'move' ? 'Moved to your wallet' : payment.kind === 'send' ? 'Payment sent' : 'Payment accepted'}</p>
    <h2 ref={heading} tabIndex={-1}>{payment.satoshis !== undefined ? <>{payment.satoshis.toLocaleString()} <span>sats</span></> : 'All done'}</h2>
    {payment.recipient && <div className="receipt-recipient"><span className="small">To</span><code>{payment.recipient}</code></div>}
    <div className="receipt-actions"><button className="accent" onClick={onDone}>Done</button>{payment.kind === 'send' && <button className="secondary" onClick={onAnother}>Send another</button>}</div>
    <details className="technical"><summary>Transaction details</summary>{payment.satoshis !== undefined && <p>{bsvAmount(payment.satoshis)} BSV to the recipient. Wallet fees are additional.</p>}<p className="transaction">{payment.txid}</p></details>
  </section>
}
