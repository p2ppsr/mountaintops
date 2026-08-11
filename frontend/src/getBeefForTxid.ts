import { Beef, FetchHttpClient } from '@bsv/sdk';
import { Services } from '@bsv/wallet-toolbox-client'
import { whatsOnChainFetch } from './whatsOnChainClient'

const whatsOnChainHttpClient = new FetchHttpClient(whatsOnChainFetch)

export default async function getBeefForTxid(txid: string, chain: 'main' | 'test'): Promise<Beef> {
  const so = Services.createDefaultOptions(chain)
  const s = new Services(so)

  // wallet-toolbox does not currently expose its WoC HTTP client as a constructor option.
  // Route it through the same anonymous, rate-limited client used by the rest of the app.
  Object.defineProperty(s.whatsonchain, 'httpClient', { value: whatsOnChainHttpClient })

  return await s.getBeefForTxid(txid)
}
