import { ANCHOR_HEIGHT, NOTICE_SECONDS, assertReceivable, eligibilityTime, lastCoveredStage, type AddressRecord } from '../../shared/brc234.ts'
import type { Coverage } from './coverageClient.ts'

const BLOCK_SECONDS = 600
export type CalendarEstimate = { anchor: number; projectedAnchor: boolean }

// Presentation only. Estimated dates/heights must never activate a stage,
// retire an address, or establish transaction eligibility.
export function calendarEstimate(coverage: Pick<Coverage, 'network' | 'height' | 'anchorMtp' | 'tipMtp'>): CalendarEstimate | null {
  if (coverage.network !== 'mainnet') return null
  if (coverage.anchorMtp !== null) return { anchor: coverage.anchorMtp, projectedAnchor: false }
  if (coverage.height >= ANCHOR_HEIGHT || !Number.isSafeInteger(coverage.tipMtp)) return null
  return { anchor: coverage.tipMtp! + (ANCHOR_HEIGHT - coverage.height) * BLOCK_SECONDS, projectedAnchor: true }
}

export function stageEstimate(stage: number, calendar: CalendarEstimate): { time: number; height: number } {
  // Both gates must pass before the 14-chain-day waiting round can begin;
  // activation is in the following block. Volume can only postpone this model.
  const time = stage === 0 ? calendar.anchor : eligibilityTime(calendar.anchor, stage) + NOTICE_SECONDS
  return { time, height: ANCHOR_HEIGHT + Math.ceil((time - calendar.anchor) / BLOCK_SECONDS) + (stage === 0 ? 0 : 1) }
}

export function monthYear(timestamp: number): string {
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp * 1000))
}

export function expirationEstimate(lastStage: number, calendar: CalendarEstimate | null): string {
  if (lastStage === 27) return 'No expiration scheduled'
  if (!calendar) return 'Expiration estimate unavailable'
  return `Not earlier than ${monthYear(stageEstimate(lastStage + 1, calendar).time)}`
}

// A display choice is free, in-memory state. A fresh connection deterministically
// opens the longest-lasting eligible saved address, with a stable key-ID tie break.
// No preference token, browser storage, or device state is needed for recovery.
export function receivingKeyID(book: AddressRecord[], stage: number, choice?: string | null): string | null {
  const eligible = book.filter(entry => {
    try { assertReceivable(entry, stage); return true } catch { return false }
  })
  if (eligible.some(entry => entry.keyID === choice)) return choice!
  eligible.sort((a, b) => lastCoveredStage(b.address) - lastCoveredStage(a.address) || (BigInt(a.keyID) < BigInt(b.keyID) ? -1 : BigInt(a.keyID) > BigInt(b.keyID) ? 1 : 0))
  return eligible[0]?.keyID ?? null
}
