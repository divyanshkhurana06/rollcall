import { createPublicClient, http, type PublicClient } from 'viem'
import { mainnet, optimism, arbitrum, base, polygon, gnosis } from 'viem/chains'

export type ChainKey = 'ethereum' | 'optimism' | 'arbitrum' | 'base' | 'polygon' | 'gnosis'

/**
 * Liveness is only meaningful if the search space is stated. A signer looks dead on one chain
 * and is busy on another, so every liveness claim Roll Call makes names the chains it searched.
 */
export const CHAINS: Record<ChainKey, { chain: any; rpc: string; label: string }> = {
  ethereum: { chain: mainnet, rpc: env('RPC_ETHEREUM', 'https://eth.drpc.org'), label: 'Ethereum' },
  optimism: { chain: optimism, rpc: env('RPC_OPTIMISM', 'https://optimism.drpc.org'), label: 'Optimism' },
  arbitrum: { chain: arbitrum, rpc: env('RPC_ARBITRUM', 'https://arbitrum.drpc.org'), label: 'Arbitrum' },
  base: { chain: base, rpc: env('RPC_BASE', 'https://base.drpc.org'), label: 'Base' },
  polygon: { chain: polygon, rpc: env('RPC_POLYGON', 'https://polygon.drpc.org'), label: 'Polygon' },
  gnosis: { chain: gnosis, rpc: env('RPC_GNOSIS', 'https://gnosis.drpc.org'), label: 'Gnosis' },
}

function env(key: string, fallback: string) {
  return (globalThis as any).process?.env?.[key] || fallback
}

const cache = new Map<ChainKey, PublicClient>()

export function client(key: ChainKey): PublicClient {
  if (!cache.has(key)) {
    const { chain, rpc } = CHAINS[key]
    cache.set(key, createPublicClient({ chain, transport: http(rpc, { batch: true, retryCount: 2 }) }) as PublicClient)
  }
  return cache.get(key)!
}

export interface RawLog {
  address: `0x${string}`
  topics: `0x${string}`[]
  data: `0x${string}`
  blockNumber: bigint
  transactionHash: `0x${string}`
  logIndex: number
}

/**
 * viem's getLogs helper does not forward raw topic arrays, and public RPCs cap block ranges at
 * wildly different sizes. Both problems go away by speaking eth_getLogs directly and walking
 * backwards in windows, halving on rejection.
 */
export async function windowedLogs(
  key: ChainKey,
  params: { address?: `0x${string}`; topics: (string | string[] | null)[]; fromBlock: bigint; toBlock: bigint },
  opts: { window?: bigint; max?: number } = {},
): Promise<RawLog[]> {
  const c = client(key)
  const max = opts.max ?? 400
  let window = opts.window ?? 40_000n
  const out: RawLog[] = []
  let to = params.toBlock

  while (to > params.fromBlock && out.length < max) {
    const from = to - window > params.fromBlock ? to - window : params.fromBlock
    const ok = await tryRange(c, params, from, to, out)
    if (!ok && window > 1_000n) {
      window = window / 4n > 0n ? window / 4n : 1_000n
      continue // retry the same `to` with a smaller window
    }
    to = from - 1n
  }
  return out.slice(0, max).map(normalise)
}

async function tryRange(c: PublicClient, params: any, from: bigint, to: bigint, out: any[]) {
  const filter: any = { fromBlock: hex(from), toBlock: hex(to) }
  if (params.address) filter.address = params.address
  if (params.topics?.length) filter.topics = params.topics
  try {
    const logs: any[] = await (c as any).request({ method: 'eth_getLogs', params: [filter] })
    out.push(...logs)
    return true
  } catch {
    return false
  }
}

const hex = (n: bigint) => (`0x` + n.toString(16)) as `0x${string}`

function normalise(l: any): RawLog {
  return {
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    transactionHash: l.transactionHash,
    logIndex: Number(l.logIndex),
  }
}
