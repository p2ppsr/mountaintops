export type AmountUnit = 'sats' | 'BSV'
const MAX_SATOSHIS = 2_100_000_000_000_000n

export function parseSatoshis(bsv: string): number {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(bsv)) throw new Error('Enter a positive BSV amount with at most 8 decimal places.')
  const [whole, fraction = ''] = bsv.split('.')
  const satoshis = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
  if (satoshis <= 0n || satoshis > MAX_SATOSHIS) throw new Error('Amount is outside the valid BSV range.')
  return Number(satoshis)
}

export function parseAmount(value: string, unit: AmountUnit): number {
  if (unit === 'BSV') return parseSatoshis(value)
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Enter a whole number of satoshis greater than zero.')
  const amount = BigInt(value)
  if (amount > MAX_SATOSHIS) throw new Error('Amount is outside the valid BSV range.')
  return Number(amount)
}

export function bsvAmount(satoshis: number): string {
  if (!Number.isSafeInteger(satoshis) || satoshis < 0 || BigInt(satoshis) > MAX_SATOSHIS) throw new Error('Invalid satoshi amount.')
  return `${Math.floor(satoshis / 100_000_000)}.${String(satoshis % 100_000_000).padStart(8, '0')}`
}
