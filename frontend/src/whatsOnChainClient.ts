const FREE_TIER_REQUESTS_PER_SECOND = 3
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BASE_RETRY_DELAY_MS = 500
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

type Sleep = (milliseconds: number) => Promise<void>

export interface WhatsOnChainClientOptions {
  fetch?: typeof fetch
  maxRetries?: number
  minimumRequestIntervalMs?: number
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
  now?: () => number
  random?: () => number
  sleep?: Sleep
}

const defaultSleep: Sleep = async (milliseconds) => {
  await new Promise(resolve => globalThis.setTimeout(resolve, milliseconds))
}

export const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000
  }

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined

  return Math.max(0, retryAt - now)
}

class RequestScheduler {
  private nextRequestAt = 0
  private queue: Promise<void> = Promise.resolve()
  private readonly minimumRequestIntervalMs: number
  private readonly now: () => number
  private readonly sleep: Sleep

  constructor(
    minimumRequestIntervalMs: number,
    now: () => number,
    sleep: Sleep,
  ) {
    this.minimumRequestIntervalMs = minimumRequestIntervalMs
    this.now = now
    this.sleep = sleep
  }

  async waitForTurn(): Promise<void> {
    const turn = this.queue.then(async () => {
      const delay = Math.max(0, this.nextRequestAt - this.now())
      if (delay > 0) await this.sleep(delay)
      this.nextRequestAt = this.now() + this.minimumRequestIntervalMs
    })

    this.queue = turn.catch(() => undefined)
    await turn
  }
}

export class WhatsOnChainClient {
  private readonly fetchImplementation: typeof fetch
  private readonly maxRetries: number
  private readonly baseRetryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: Sleep
  private readonly scheduler: RequestScheduler
  private rejectedCredentials = false

  constructor(options: WhatsOnChainClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? defaultSleep
    this.scheduler = new RequestScheduler(
      options.minimumRequestIntervalMs ?? Math.ceil(1_000 / FREE_TIER_REQUESTS_PER_SECOND),
      this.now,
      this.sleep,
    )
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const mayRetry = method === 'GET' || method === 'HEAD'
    const headers = new Headers(init.headers)

    if (this.rejectedCredentials) headers.delete('Authorization')

    let retries = 0
    while (true) {
      await this.scheduler.waitForTurn()

      try {
        const response = await this.fetchImplementation(input, { ...init, headers })

        if ((response.status === 401 || response.status === 403) && headers.has('Authorization')) {
          // WoC supports anonymous access. Discard a rejected credential for this request and
          // all subsequent requests in this browser session instead of breaking the app.
          headers.delete('Authorization')
          this.rejectedCredentials = true
          continue
        }

        const retryableStatus = response.status === 429 || response.status >= 500
        if (!mayRetry || !retryableStatus || retries >= this.maxRetries) return response

        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'), this.now())
        if (retryAfter !== undefined && retryAfter > this.maxRetryDelayMs) return response

        await this.sleep(this.retryDelay(retries, retryAfter))
        retries += 1
      } catch (error) {
        if (!mayRetry || retries >= this.maxRetries) throw error

        await this.sleep(this.retryDelay(retries))
        retries += 1
      }
    }
  }

  private retryDelay(retry: number, retryAfter?: number): number {
    const exponentialCap = Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * (2 ** retry),
    )
    const jitteredBackoff = Math.floor(this.random() * exponentialCap)
    return Math.max(retryAfter ?? 0, jitteredBackoff)
  }
}

const whatsOnChainClient = new WhatsOnChainClient()

export const whatsOnChainFetch = whatsOnChainClient.fetch
