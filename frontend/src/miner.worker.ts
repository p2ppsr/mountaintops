import { addressMatches, suggestedStage, type Network } from '../../shared/brc234.ts'
import { publicDeriver } from './derivation.ts'

type Request = { identityKey: string; network: Network; minimumStage: number; targetStage?: number; start?: string }
// One worker per work slice; termination cancels safely. Only the acknowledged
// wallet checkpoint can be supplied as start by the UI.
self.onmessage = ({ data }: MessageEvent<Request>) => {
  try {
    const derive = publicDeriver(data.identityKey)
    const benchmark = performance.now()
    for (let i = 1; i <= 25; i++) derive(String(i), data.network)
    const rate = 25_000 / Math.max(1, performance.now() - benchmark)
    const stage = data.targetStage ?? suggestedStage(rate, Math.max(1, data.minimumStage))
    const started = performance.now()
    let next = BigInt(data.start ?? '1')
    let lastProgress = started
    self.postMessage({ kind: 'started', stage, trialsPerSecond: rate })
    while (performance.now() - started < 30_000) {
      const address = derive(next.toString(), data.network)
      if (data.network !== 'mainnet' || addressMatches(address, stage)) {
        self.postMessage({ kind: 'found', stage, keyID: next.toString(), address, next: (next + 1n).toString() })
        return
      }
      next++
      if (performance.now() - lastProgress >= 500) {
        self.postMessage({ kind: 'progress', stage, next: next.toString(), elapsed: performance.now() - started })
        lastProgress = performance.now()
      }
    }
    self.postMessage({ kind: 'paused', stage, next: next.toString(), elapsed: performance.now() - started })
  } catch (error) {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Address search failed' })
  }
}
