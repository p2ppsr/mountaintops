import { useEffect, useRef } from 'react'
import { ANCHOR_HEIGHT, stages } from '../../shared/brc234.ts'
import type { Coverage } from './coverageClient.ts'
import { calendarEstimate, expirationEstimate, monthYear, stageEstimate } from './receiveUX.ts'

export default function ReceiveInfo({ stage, expired, coverage, onClose }: { stage: number; expired: boolean; coverage: Coverage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const calendar = calendarEstimate(coverage)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="receive-info" aria-labelledby="receive-info-title" onClose={onClose}>
    <div className="modal-heading"><h2 id="receive-info-title">How address expiration works</h2><button className="secondary" aria-label="Close address information" onClick={() => dialog.current?.close()}>Close</button></div>
    <p>BRC-234 gradually narrows free blockchain lookups. Higher stages need harder-to-find addresses and last longer.</p>
    <div className="stage-summary"><strong>This address: stage {stage}</strong><p>{expired ? 'Expired — do not send here.' : <>{expirationEstimate(stage, calendar)}{calendar && stage < 27 ? ' (estimate).' : '.'}</>}</p><span className="small">{expired ? 'Receiving is disabled. Earlier coins remain yours.' : stage === 27 ? 'BRC-234 defines no later stage. Provider availability and payment rules still apply.' : `Receiving expires when stage ${stage + 1} or a stricter stage activates.`}</span></div>
    <p>{calendar?.projectedAnchor ? `Block 1,000,000 is projected for ${monthYear(calendar.anchor)} at about 10 minutes per block. Until it arrives, “not earlier than” dates are estimates that may move earlier or later.` : calendar ? `The schedule starts at block 1,000,000 (${monthYear(calendar.anchor)}). Dates use that block’s chain time.` : 'The calendar estimate is unavailable. Receiving eligibility still follows verified chain conditions.'} Low transaction volume can delay expiration.</p>
    <p><strong>Earlier coins remain yours.</strong> At expiration, replace this address everywhere. Mountaintops stops receiving and checking for new deposits; earlier coins can still be moved to your wallet.</p>
    <a href="https://github.com/bsv-blockchain/BRCs/blob/master/opinions/0234.md" target="_blank" rel="noreferrer">Read the full BRC-234 proposal ↗</a>
    <details><summary>Stage schedule &amp; payment rules</summary>
      <p className="small">An address passing stage N expires at the first active stage above N. Calendar and volume gates must pass, followed by a 14-day chain-time wait and activation in the following block. Stages may be skipped. These are the earliest modeled activations with enough transactions; block estimates assume 10 minutes per block. Pre-anchor estimates are not guaranteed minimum dates.</p>
      {calendar && <div className="schedule-scroll"><table><caption>Estimated stage activations · chain time</caption><thead><tr><th>Stage</th><th>Not earlier than</th><th>Approx. block</th></tr></thead><tbody>
        <tr><td>Anchor</td><td>{monthYear(calendar.anchor)}{calendar.projectedAnchor ? ' · projected' : ''}</td><td>{ANCHOR_HEIGHT.toLocaleString()}</td></tr>
        {stages.slice(1).map(row => {
          const estimate = stageEstimate(row.stage, calendar)
          const activated = coverage.activations.find(event => event.stage === row.stage)
          return <tr key={row.stage}><td>{row.stage}</td><td>{activated ? `${monthYear(activated.mtp)} · activated` : monthYear(estimate.time)}</td><td>{(activated?.height ?? estimate.height).toLocaleString()}{activated ? '' : ' ≈'}</td></tr>
        })}
      </tbody></table></div>}
      <p>Payment transactions have their own eligibility rules, including transaction version 1 from stage 13. A longer-lasting address alone does not make every payment eligible for free lookup. These rules do not change coin ownership.</p>
    </details>
  </dialog>
}
