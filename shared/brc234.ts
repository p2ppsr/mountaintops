import schedule from './schedule.json' with { type: 'json' }

export const ANCHOR_HEIGHT = 1_000_000
export const SPECIFICATION = 'brc234-v1-85eaa6219cec77350170d52d243e65122e453d39'
export const NOTICE_SECONDS = 1_209_600
export const stages = schedule.rows
export type Network = 'mainnet' | 'testnet'
export type PendingRound = { target: number; triggerHash: string; triggerHeight: number; deadline: number }
export type ChainState = {
  height: number; hash: string; mtp: number; anchorMtp: number;
  volume: string; stage: number; pending: PendingRound | null;
}
export type CountedBlock = { height: number; hash: string; parentHash: string; mtp: number; nonCoinbaseCount: string }
export type AddressRecord = {
  address: string; keyID: string; network: Network; targetStage: number;
  retiredAt: null | { hash: string; height: number; mtp: number; lastReceiveHeight: number };
}

function stageRow(stage: number) {
  if (!Number.isInteger(stage) || stage < 0 || stage > 27) throw new Error('Invalid BRC-234 stage')
  return stages[stage]
}

// The caller must validate the complete canonical mainnet Base58Check address.
// These are the normative explicit character sets, never character-code ranges.
export function addressMatches(address: string, stage: number): boolean {
  return new RegExp(`^${stageRow(stage).addressRule}`).test(address)
}

export function leadingBitsMatch(hex: string, digit: '7' | '9', bits: number): boolean {
  if (!/^[a-f0-9]+$/.test(hex) || !Number.isInteger(bits) || bits < 0 || bits > hex.length * 4) return false
  const whole = Math.floor(bits / 4)
  const partial = bits % 4
  if (hex.slice(0, whole) !== digit.repeat(whole)) return false
  return partial === 0 || (parseInt(hex[whole], 16) >> (4 - partial)) === (parseInt(digit, 16) >> (4 - partial))
}

export function transactionMatches(txid: string, version: number, stage: number): boolean {
  const row = stageRow(stage)
  return /^[a-f0-9]{64}$/.test(txid) && Number.isInteger(version) &&
    (stage <= 12 || version === 1) && leadingBitsMatch(txid, '9', row.txidBits)
}

export function scriptHashMatches(hash160: string, stage: number): boolean {
  return /^[a-f0-9]{40}$/.test(hash160) && leadingBitsMatch(hash160, '7', stageRow(stage).scriptHashBits)
}

export function lastCoveredStage(address: string): number {
  let last = 0
  for (let stage = 1; stage <= 27; stage++) {
    if (!addressMatches(address, stage)) break
    last = stage
  }
  return last
}

export function canonicalKeyID(value: string): string {
  if (!/^[1-9][0-9]{0,79}$/.test(value)) throw new Error('Key ID must be a canonical positive decimal integer')
  return value
}

export function addCalendarMonths(timestamp: number, months: number): number {
  if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid anchor timestamp')
  const date = new Date(timestamp * 1000)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Math.floor(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()) / 1000)
}

export function eligibilityTime(anchorMtp: number, stage: number): number {
  if (stage === 0) return anchorMtp
  const row = stageRow(stage)
  const grace = addCalendarMonths(anchorMtp, 6)
  const duration = BigInt(addCalendarMonths(anchorMtp, 78) - grace)
  const numerator = duration * BigInt(row.postGraceWeightNumerator)
  const denominator = BigInt(row.postGraceWeightDenominator)
  return grace + Number((numerator + denominator - 1n) / denominator)
}

export function eligibleCandidate(anchorMtp: number, mtp: number, volume: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(volume)) throw new Error('Invalid cumulative transaction count')
  const count = BigInt(volume)
  let candidate = 0
  for (let stage = 1; stage <= 27; stage++) {
    if (mtp >= eligibilityTime(anchorMtp, stage) && count >= BigInt(stages[stage].volume)) candidate = stage
  }
  return candidate
}

export function anchorState(block: Omit<CountedBlock, 'nonCoinbaseCount'>): ChainState {
  if (block.height !== ANCHOR_HEIGHT || !Number.isSafeInteger(block.mtp)) throw new Error('Invalid anchor block')
  return { height: block.height, hash: block.hash, mtp: block.mtp, anchorMtp: block.mtp, volume: '0', stage: 0, pending: null }
}

// Replay only accepted, parent-linked block counts. Reorg callers roll back to
// a persisted common ancestor first; neither heights nor a maximum stage suffice.
export function advanceChain(parent: ChainState, block: CountedBlock): ChainState {
  if (block.height !== parent.height + 1 || block.parentHash !== parent.hash || block.mtp < parent.mtp ||
      !Number.isSafeInteger(block.mtp) || !/^(0|[1-9][0-9]*)$/.test(block.nonCoinbaseCount)) {
    throw new Error('Unlinked or invalid accepted block/count')
  }
  let stage = parent.stage
  let pending = parent.pending
  if (pending && parent.mtp >= pending.deadline && eligibleCandidate(parent.anchorMtp, parent.mtp, parent.volume) >= pending.target) {
    stage = pending.target
    pending = null
  }
  const volume = (BigInt(parent.volume) + BigInt(block.nonCoinbaseCount)).toString()
  const candidate = eligibleCandidate(parent.anchorMtp, block.mtp, volume)
  if (!pending && candidate > stage) {
    pending = { target: candidate, triggerHash: block.hash, triggerHeight: block.height, deadline: block.mtp + NOTICE_SECONDS }
  }
  return { ...parent, height: block.height, hash: block.hash, mtp: block.mtp, volume, stage, pending }
}

export function retirementFor(record: AddressRecord, state: ChainState): AddressRecord['retiredAt'] {
  if (record.retiredAt) return record.retiredAt
  if (record.network !== 'mainnet' || addressMatches(record.address, state.stage)) return null
  return { hash: state.hash, height: state.height, mtp: state.mtp, lastReceiveHeight: state.height - 1 }
}

export function assertReceivable(record: AddressRecord, stage: number): void {
  if (record.retiredAt || (record.network === 'mainnet' && !addressMatches(record.address, stage))) {
    throw new Error('Expired — do not send coins to this address. Choose an eligible address.')
  }
}

export function coverageLabel(address: string, network: Network, anchorMtp: number | null, retiredAt: AddressRecord['retiredAt']): string {
  if (retiredAt) return 'Expired — do not send coins to this address.'
  if (network !== 'mainnet') return 'BRC-234 specifies mainnet coverage; no testnet sunset is defined.'
  const last = lastCoveredStage(address)
  if (last === 27) return 'No later free-coverage cutoff is scheduled.'
  if (anchorMtp === null) return 'Sunset date not yet determined — schedule begins at mainnet block 1,000,000.'
  const gate = new Date(eligibilityTime(anchorMtp, last + 1) * 1000).toISOString().slice(0, 10)
  return `Free-coverage eligibility gate: ${gate} UTC. Actual expiration also depends on volume and chain-time activation.`
}

// 95% search-work estimate, rather than the mean being mistaken for a deadline.
export function suggestedStage(trialsPerSecond: number, minimumStage: number, seconds = 30): number {
  stageRow(minimumStage)
  let target = minimumStage
  for (let stage = minimumStage; stage <= 27; stage++) {
    const mean = stages[stage].addressTrials
    const p95 = mean <= 1 ? 1 : Math.ceil(Math.log(0.05) / Math.log1p(-1 / mean))
    if (p95 <= Math.max(0, trialsPerSecond) * seconds) target = stage
  }
  return target
}
