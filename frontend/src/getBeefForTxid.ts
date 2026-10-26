import { Beef, FetchHttpClient } from '@bsv/sdk';
import { fallBackOnChaintracksNotFound } from './chaintracksFallback.ts'
import { whatsOnChainFetch } from './whatsOnChainClient.ts'

const whatsOnChainHttpClient = new FetchHttpClient(whatsOnChainFetch)

export default async function getBeefForTxid(txid: string, chain: 'main' | 'test'): Promise<Beef> {
  const { Services } = await import('@bsv/wallet-toolbox-client')
  const so = Services.createDefaultOptions(chain)

  // wallet-toolbox-client 1.x throws when Chaintracks returns ERR_NOT_FOUND,
  // preventing its built-in WhatsOnChain fallback from running.
  if (so.chaintracks) {
    const findHeaderForBlockHash = so.chaintracks.findHeaderForBlockHash.bind(so.chaintracks)
    so.chaintracks.findHeaderForBlockHash = fallBackOnChaintracksNotFound(findHeaderForBlockHash)
  }

  const s = new Services(so)

  // wallet-toolbox does not currently expose its WoC HTTP client as a constructor option.
  // Route it through the same anonymous, rate-limited client used by the rest of the app.
  Object.defineProperty(s.whatsonchain, 'httpClient', { value: whatsOnChainHttpClient })

  return await s.getBeefForTxid(txid)
}
