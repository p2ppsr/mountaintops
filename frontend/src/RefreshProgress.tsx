import { ActionButton } from './ActionFeedback.tsx'
export type RefreshState = { kind: 'payments' | 'single' | 'addresses'; keyID?: string; detail: string }

export function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={`refresh-icon${spinning ? ' is-spinning' : ''}`} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.2 8a7.5 7.5 0 0 1 12.4-3L20 8M4 16l2.4 3A7.5 7.5 0 0 0 18.8 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export function RefreshButton({ active, disabled, label, ariaLabel, onClick }: { active: boolean; disabled: boolean; label: string; ariaLabel?: string; onClick: () => void }) {
  return <ActionButton active={active} disabled={disabled} label={label} activeLabel="Refreshing…" ariaLabel={ariaLabel ?? label} icon={<RefreshIcon spinning />} onClick={onClick} />
}

export default function RefreshProgress({ progress }: { progress: RefreshState }) {
  return <section className="refresh-progress" role="status" aria-label="Refresh progress" aria-live="polite" aria-atomic="true"><div className="refresh-mark"><RefreshIcon spinning /></div><div><p className="progress-title">{progress.kind === 'addresses' ? 'Checking your addresses' : 'Checking for payments'}</p><p className="progress-phase">{progress.detail}</p></div></section>
}
