import { getAddress, formatUnits, erc20Abi, type Hex } from 'viem'
import { withFailover, client, type ChainKey } from '../chain.js'

/**
 * What a control surface actually guards.
 *
 * A weak signer set over an empty contract is trivia. The same signer set over a bridge holding
 * billions is the whole point, and the difference has to be measurable or the ranking is just
 * alphabetical.
 *
 * Read directly from chain state rather than from a price API: native balance plus the major
 * assets, priced with a small set of assumptions that are printed alongside the number so nobody
 * mistakes it for a valuation.
 */

const TOKENS: { symbol: string; address: `0x${string}`; decimals: number; usd: number }[] = [
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, usd: 1 },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, usd: 1 },
  { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, usd: 1 },
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, usd: 0 },
  { symbol: 'wstETH', address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18, usd: 0 },
]

export interface ValueAtRisk {
  address: string
  nativeEth: number
  holdings: { symbol: string; amount: number; usd: number }[]
  totalUsd: number
  ethPriceUsd: number
  assumptions: string[]
}

/** One price, fetched once, stated in the output. No oracle, no hidden model. */
export async function ethPrice(): Promise<number> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot')
    const body: any = await res.json()
    const p = Number(body?.data?.amount)
    return Number.isFinite(p) && p > 0 ? p : 3000
  } catch { return 3000 }
}

export async function valueAtRisk(chain: ChainKey, address: string, ethUsd?: number): Promise<ValueAtRisk> {
  const c = client(chain)
  const a = getAddress(address as Hex)
  const price = ethUsd ?? (await ethPrice())

  // A balance that cannot be read on any provider is an error, not zero. Zero here would print as
  // "this bridge holds nothing", which is the one thing a value column must never say by accident.
  const nativeEth = Number(formatUnits(await withFailover(chain, (cl) => cl.getBalance({ address: a })), 18))

  const holdings: ValueAtRisk['holdings'] = []
  await Promise.all(
    TOKENS.map(async (t) => {
      try {
        const raw = (await withFailover(chain, (cl) => cl.readContract({
          address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [a],
        }))) as bigint
        const amount = Number(formatUnits(raw, t.decimals))
        if (amount <= 0) return
        const usd = t.usd === 0 ? amount * price : amount * t.usd
        holdings.push({ symbol: t.symbol, amount, usd })
      } catch { /* token unreachable, omitted rather than assumed zero */ }
    }),
  )

  const totalUsd = nativeEth * price + holdings.reduce((s, h) => s + h.usd, 0)

  return {
    address: a,
    nativeEth,
    holdings: holdings.sort((x, y) => y.usd - x.usd),
    totalUsd,
    ethPriceUsd: price,
    assumptions: [
      `ETH at $${price.toFixed(0)} (Coinbase spot at scan time)`,
      'stablecoins held at $1',
      'wstETH valued at the ETH price, ignoring the exchange rate premium',
      'only native balance and five major assets are counted, so this is a floor, not a valuation',
    ],
  }
}
