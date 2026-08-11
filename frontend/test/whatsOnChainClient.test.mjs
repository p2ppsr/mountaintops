import assert from 'node:assert/strict'
import test from 'node:test'
import { WhatsOnChainClient, parseRetryAfter } from '../src/whatsOnChainClient.ts'

const response = (status, headers = {}) => new Response('', { status, headers })

test('works without an Authorization header', async () => {
  const seenHeaders = []
  const client = new WhatsOnChainClient({
    fetch: async (_input, init) => {
      seenHeaders.push(new Headers(init?.headers))
      return response(200)
    },
    minimumRequestIntervalMs: 0,
  })

  const result = await client.fetch('https://api.whatsonchain.com/example')

  assert.equal(result.status, 200)
  assert.equal(seenHeaders[0].has('Authorization'), false)
})

test('paces anonymous requests at no more than three per second', async () => {
  let now = 0
  const delays = []
  const client = new WhatsOnChainClient({
    fetch: async () => response(200),
    now: () => now,
    sleep: async delay => {
      delays.push(delay)
      now += delay
    },
  })

  await Promise.all([
    client.fetch('https://api.whatsonchain.com/one'),
    client.fetch('https://api.whatsonchain.com/two'),
    client.fetch('https://api.whatsonchain.com/three'),
    client.fetch('https://api.whatsonchain.com/four'),
  ])

  assert.deepEqual(delays, [334, 334, 334])
  assert.equal(now, 1_002)
})

test('falls back to anonymous access after a credential is rejected', async () => {
  const seenAuthorization = []
  const client = new WhatsOnChainClient({
    fetch: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization')
      seenAuthorization.push(authorization)
      return response(authorization ? 401 : 200)
    },
    minimumRequestIntervalMs: 0,
  })

  const first = await client.fetch('https://api.whatsonchain.com/example', {
    headers: { Authorization: 'invalid' },
  })
  const second = await client.fetch('https://api.whatsonchain.com/example', {
    headers: { Authorization: 'still-invalid' },
  })

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(seenAuthorization, ['invalid', null, null])
})

test('retries 429 responses and honors Retry-After', async () => {
  const delays = []
  let requests = 0
  const client = new WhatsOnChainClient({
    fetch: async () => {
      requests += 1
      return requests === 1 ? response(429, { 'Retry-After': '2' }) : response(200)
    },
    minimumRequestIntervalMs: 0,
    random: () => 0,
    sleep: async delay => { delays.push(delay) },
  })

  const result = await client.fetch('https://api.whatsonchain.com/example')

  assert.equal(result.status, 200)
  assert.equal(requests, 2)
  assert.deepEqual(delays, [2_000])
})

test('uses capped exponential backoff for transient server errors', async () => {
  const delays = []
  let requests = 0
  const client = new WhatsOnChainClient({
    fetch: async () => {
      requests += 1
      return requests < 4 ? response(503) : response(200)
    },
    minimumRequestIntervalMs: 0,
    baseRetryDelayMs: 100,
    random: () => 1,
    sleep: async delay => { delays.push(delay) },
  })

  const result = await client.fetch('https://api.whatsonchain.com/example')

  assert.equal(result.status, 200)
  assert.deepEqual(delays, [100, 200, 400])
})

test('parses both Retry-After formats', () => {
  const now = Date.parse('2026-08-10T00:00:00Z')

  assert.equal(parseRetryAfter('3', now), 3_000)
  assert.equal(parseRetryAfter('Mon, 10 Aug 2026 00:00:05 GMT', now), 5_000)
  assert.equal(parseRetryAfter('invalid', now), undefined)
})
