import { createPublicClient, http, type PublicClient } from 'viem'
import { mainnet, optimism, arbitrum, base, polygon, gnosis } from 'viem/chains'

export type ChainKey = 'ethereum' | 'optimism' | 'arbitrum' | 'base' | 'polygon' | 'gnosis'

/**
 * Liveness is only meaningful if the search space is stated. A signer looks dead on one chain
 * and is busy on another, so every liveness claim Roll Call makes names the chains it searched.
 */
/**
 * Several endpoints per chain, because one is not enough.
 *
 * Public RPCs fail in ways that look like data: a provider that cannot route a request returns an
 * error, and a log walk that swallows it reports "no events found". That is the difference between
 * "this signer never approved anything" and "we could not look", and the two must never be
 * confused - the same reason liveness distinguishes dark from indeterminate.
 *
 * So every read tries the list in order, and a range that no endpoint could serve is recorded as a
 * coverage gap rather than as an absence.
 */
export const CHAINS: Record<ChainKey, { chain: any; rpc: string; rpcs: string[]; label: string }> = {
  ethereum: {
    chain: mainnet, label: 'Ethereum',
    rpc: env('RPC_ETHEREUM', 'https://eth.drpc.org'),
    rpcs: [env('RPC_ETHEREUM', 'https://eth.drpc.org'), 'https://rpc.mevblocker.io', 'https://eth.drpc.org', 'https://rpc.flashbots.net'],
  },
  optimism: {
    chain: optimism, label: 'Optimism',
    rpc: env('RPC_OPTIMISM', 'https://optimism.drpc.org'),
    rpcs: [env('RPC_OPTIMISM', 'https://optimism.drpc.org'), 'https://mainnet.optimism.io'],
  },
  arbitrum: {
    chain: arbitrum, label: 'Arbitrum',
    rpc: env('RPC_ARBITRUM', 'https://arbitrum.drpc.org'),
    rpcs: [env('RPC_ARBITRUM', 'https://arbitrum.drpc.org'), 'https://arb1.arbitrum.io/rpc'],
  },
  base: {
    chain: base, label: 'Base',
    rpc: env('RPC_BASE', 'https://base.drpc.org'),
    rpcs: [env('RPC_BASE', 'https://base.drpc.org'), 'https://mainnet.base.org'],
  },
  polygon: {
    chain: polygon, label: 'Polygon',
    rpc: env('RPC_POLYGON', 'https://polygon.drpc.org'),
    rpcs: [env('RPC_POLYGON', 'https://polygon.drpc.org'), 'https://polygon-rpc.com'],
  },
  gnosis: {
    chain: gnosis, label: 'Gnosis',
    rpc: env('RPC_GNOSIS', 'https://gnosis.drpc.org'),
    rpcs: [env('RPC_GNOSIS', 'https://gnosis.drpc.org'), 'https://rpc.gnosischain.com'],
  },
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

const poolCache = new Map<ChainKey, PublicClient[]>()

/** One client per configured provider, primary first, duplicates removed. */
export function clients(key: ChainKey): PublicClient[] {
  if (!poolCache.has(key)) {
    const { chain, rpcs } = CHAINS[key]
    const urls = [...new Set(rpcs)]
    poolCache.set(key, urls.map((rpc) => createPublicClient({ chain, transport: http(rpc, { batch: true, retryCount: 1, timeout: 15_000 }) }) as PublicClient))
  }
  return poolCache.get(key)!
}

/** A transport error is the provider's problem. A revert is the contract's answer. Only the first kind fails over. */
export function isTransportError(e: any): boolean {
  const name = String(e?.name ?? '')
  const msg = String(e?.shortMessage ?? e?.message ?? '').toLowerCase()
  if (['HttpRequestError', 'TimeoutError', 'RpcRequestError', 'InternalRpcError', 'LimitExceededRpcError', 'ResourceUnavailableRpcError'].includes(name)) return true
  return /fetch failed|timeout|timed out|429|503|502|rate limit|econnreset|socket hang up|network/.test(msg)
}

/**
 * Runs a read against each provider in turn until one answers. A read that fails on every provider
 * throws, so the caller reports "unreadable" instead of mistaking a dead RPC for an empty slot.
 */
export async function withFailover<T>(key: ChainKey, fn: (c: PublicClient) => Promise<T>): Promise<T> {
  let last: unknown
  for (const c of clients(key)) {
    try {
      return await fn(c)
    } catch (e) {
      last = e
      if (!isTransportError(e)) throw e
    }
  }
  throw last instanceof Error ? last : new Error(`all providers failed for ${key}`)
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
  const max = opts.max ?? 400
  let window = opts.window ?? 40_000n
  const out: RawLog[] = []
  let to = params.toBlock
  let covered = 0n
  let failed = 0

  while (to > params.fromBlock && out.length < max) {
    const from = to - window > params.fromBlock ? to - window : params.fromBlock
    const ok = await tryRange(key, params, from, to, out)
    if (!ok && window > 1_000n) {
      window = window / 4n > 0n ? window / 4n : 1_000n
      continue // retry the same `to` with a smaller window
    }
    if (ok) covered += to - from
    else failed++
    to = from - 1n
  }

  const requested = params.toBlock - params.fromBlock
  lastCoverage = {
    requestedBlocks: Number(requested),
    coveredBlocks: Number(covered),
    failedRanges: failed,
    complete: failed === 0,
  }
  return out.slice(0, max).map(normalise)
}

/** Ask every endpoint for the chain before giving up on a range. */
async function tryRange(key: ChainKey, params: any, from: bigint, to: bigint, out: any[]) {
  const filter: any = { fromBlock: hex(from), toBlock: hex(to) }
  if (params.address) filter.address = params.address
  if (params.topics?.length) filter.topics = params.topics

  for (const url of [...new Set(CHAINS[key].rpcs)]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [filter] }),
      })
      const body: any = await res.json()
      if (body.error) continue
      out.push(...(body.result ?? []))
      return true
    } catch { /* next endpoint */ }
  }
  return false
}

/** Ranges no endpoint could serve. An empty result with gaps is not evidence of absence. */
export interface LogCoverage {
  requestedBlocks: number
  coveredBlocks: number
  failedRanges: number
  complete: boolean
}

let lastCoverage: LogCoverage = { requestedBlocks: 0, coveredBlocks: 0, failedRanges: 0, complete: true }
export const lastLogCoverage = () => lastCoverage

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
