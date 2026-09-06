import { getAddress } from 'viem'
import type { ChainKey } from '../chain.js'

/**
 * Safe Transaction Service.
 *
 * Roll Call reads authority from three sources with different coverage, and says which one
 * every number came from:
 *
 *   1. Safe Transaction Service  - fast, complete confirmation history. Only covers Safes that
 *                                  were driven through Safe's own service, on supported chains.
 *   2. Signature-blob recovery   - universal. Works on any Safe, any chain, including ones that
 *                                  never touched the Safe UI. Slower over public RPC.
 *   3. Substreams                - the production path. Public RPCs cap eth_getLogs at 10k blocks,
 *                                  so a year of history is 260 sequential requests per Safe.
 *
 * Source (2) is also used to VALIDATE source (1): we recover approvers from raw calldata and
 * check them against Safe's own records. Agreement rate is reported in the method appendix.
 */

const HOSTS: Partial<Record<ChainKey, string>> = {
  ethereum: 'https://safe-transaction-mainnet.safe.global',
  optimism: 'https://safe-transaction-optimism.safe.global',
  arbitrum: 'https://safe-transaction-arbitrum.safe.global',
  base: 'https://safe-transaction-base.safe.global',
  polygon: 'https://safe-transaction-polygon.safe.global',
  gnosis: 'https://safe-transaction-gnosis-chain.safe.global',
}

export const supportedByService = (c: ChainKey) => Boolean(HOSTS[c])

export interface Confirmation {
  owner: `0x${string}`
  signatureType: 'EOA' | 'APPROVED_HASH' | 'ETH_SIGN' | 'CONTRACT_SIGNATURE' | string
  submittedAt: number | null
}

export interface ServiceTx {
  nonce: number
  safeTxHash: `0x${string}`
  transactionHash: `0x${string}` | null
  executedAt: number | null
  executor: `0x${string}` | null
  to: `0x${string}`
  value: string
  confirmations: Confirmation[]
}

export interface ServiceSafe {
  address: `0x${string}`
  owners: `0x${string}`[]
  threshold: number
  version: string | null
  nonce: number
}

async function get(url: string, tries = 3): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' })
      if (res.status === 429) { await sleep(700 * (i + 1)); continue }
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.json()
    } catch (e) { lastErr = e; await sleep(400 * (i + 1)) }
  }
  throw lastErr
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ts = (s: string | null | undefined) => (s ? Math.floor(new Date(s).getTime() / 1000) : null)

export async function fetchSafe(chain: ChainKey, address: string): Promise<ServiceSafe | null> {
  const host = HOSTS[chain]
  if (!host) return null
  try {
    const a = getAddress(address as `0x${string}`) // service rejects non-checksummed input
    const d = await get(`${host}/api/v1/safes/${a}/`)
    return {
      address: a,
      owners: (d.owners ?? []).map((o: string) => getAddress(o as `0x${string}`)),
      threshold: Number(d.threshold),
      version: d.version ?? null,
      nonce: Number(d.nonce ?? 0),
    }
  } catch { return null }
}

/** Executed multisig transactions, newest first, paged. */
export async function fetchServiceTxs(chain: ChainKey, address: string, max = 300): Promise<ServiceTx[]> {
  const host = HOSTS[chain]
  if (!host) return []
  const a = getAddress(address as `0x${string}`)
  const out: ServiceTx[] = []
  let url: string | null = `${host}/api/v1/safes/${a}/multisig-transactions/?limit=100&executed=true`

  while (url && out.length < max) {
    const page: any = await get(url)
    for (const r of page.results ?? []) {
      if (!r.isExecuted) continue
      out.push({
        nonce: Number(r.nonce),
        safeTxHash: r.safeTxHash,
        transactionHash: r.transactionHash ?? null,
        executedAt: ts(r.executionDate),
        executor: r.executor ? getAddress(r.executor) : null,
        to: getAddress(r.to),
        value: String(r.value ?? '0'),
        confirmations: (r.confirmations ?? []).map((c: any) => ({
          owner: getAddress(c.owner),
          signatureType: c.signatureType ?? 'UNKNOWN',
          submittedAt: ts(c.submissionDate),
        })),
      })
    }
    url = page.next ?? null
  }
  return out.sort((x, y) => (x.executedAt ?? 0) - (y.executedAt ?? 0)).slice(-max)
}

/**
 * All transfers/txs an address has ever produced according to the service - used as one input
 * to liveness. Returns the most recent timestamp, or null if the service has no record.
 */
export async function lastServiceActivity(chain: ChainKey, address: string): Promise<number | null> {
  const host = HOSTS[chain]
  if (!host) return null
  try {
    const a = getAddress(address as `0x${string}`)
    const d = await get(`${host}/api/v1/safes/${a}/multisig-transactions/?limit=1&executed=true`)
    return ts(d.results?.[0]?.executionDate)
  } catch { return null }
}
