import type { ReactNode } from 'react'

export type Activity = { id: string; title: string; detail: string }

export function ActionButton({ active, disabled = false, label, activeLabel, ariaLabel, variant = 'secondary', icon, onClick }: { active: boolean; disabled?: boolean; label: string; activeLabel: string; ariaLabel?: string; variant?: string; icon?: ReactNode; onClick: () => void }) {
  return <button className={`${variant} action-button`} aria-label={ariaLabel} aria-busy={active} disabled={disabled || active} onClick={onClick}>{active && (icon ?? <span className="loading-spinner" aria-hidden="true" />)}{active ? activeLabel : label}</button>
}

export default function ActionFeedback({ activity }: { activity: Activity }) {
  return <section className="activity-progress" role="status" aria-label="Action progress" aria-live="polite" aria-atomic="true"><div className="refresh-mark"><span className="loading-spinner" aria-hidden="true" /></div><div><p className="progress-title">{activity.title}</p><p className="progress-phase">{activity.detail}</p></div></section>
}
