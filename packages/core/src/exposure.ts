/**
 * The Graph: standardized schemas, one query shape, N protocols.
 *
 * Authority means nothing without exposure. A 2-of-9 that has gone dark over an empty wallet is
 * trivia; the same control surface over a position in a lending market is a real problem. So Roll
 * Call needs to know what money sits behind the keys it is analysing.
 *
 * Doing that per protocol would normally mean a bespoke integration each time: different entity
 * names, different field names, different units. The Messari standardized schemas remove that
 * entirely. Every deployment below answers the SAME query, and they are not even the same kind of
 * protocol - Aave is LENDING, Uniswap is EXCHANGE. Adding another costs one line in this table and
 * zero lines of query code.
 *
 * That is the whole argument for standardization, and it is why discovery below can run in the
 * other direction: start from the largest accounts in real protocols, find which of them are
 * multisigs, and analyse the control surface over money that actually exists.
 */

import { existsSync, readFileSync } from 'node:fs'

export interface StandardDeployment {
  key: string
  label: string
  subgraphId: string
  /** Schema family, per the standardized spec. */
  family: 'lending' | 'dex-amm'
  network: string
  schemaVersion: string
  /** Provenance from the last verification pass: the deployment hash and the block it had indexed. */
  deployment?: string
  verifiedBlock?: number
  tvlUsd?: number
}

/**
 * The registry: every Messari standardized deployment on the decentralized network that answered
 * the schema-level query when `packages/core/test/probe-standardized.ts` last ran. Adding a
 * protocol is a data change; the query code never moves. This is the piece every team that used
 * standardized subgraphs at Lisbon ended up building, so here it is as a file.
 */
export interface StandardRegistry {
  verifiedAt: number
  query: string
  deployments: StandardDeployment[]
}

const FALLBACK: StandardDeployment[] = [
  { key: 'aave-v3-ethereum', label: 'Aave v3', subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk', family: 'lending', network: 'ethereum', schemaVersion: '3.1.0' },
  { key: 'aave-v2-ethereum', label: 'Aave v2', subgraphId: 'C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j', family: 'lending', network: 'ethereum', schemaVersion: '3.1.0' },
  { key: 'uniswap-v3-ethereum', label: 'Uniswap V3', subgraphId: 'FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS', family: 'dex-amm', network: 'ethereum', schemaVersion: '4.0.0' },
]

export function loadRegistry(path = process.env.STANDARDIZED_REGISTRY ?? 'data/standardized-registry.json'): StandardRegistry {
  try {
    if (!existsSync(path)) return { verifiedAt: 0, query: '', deployments: FALLBACK }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const deployments: StandardDeployment[] = (raw.deployments ?? []).map((d: any) => ({
      key: d.key,
      label: d.name ?? d.protocol ?? d.key,
      subgraphId: d.subgraphId,
      family: d.schema === 'lending' ? 'lending' : 'dex-amm',
      network: d.network,
      schemaVersion: d.schemaVersion,
      deployment: d.deployment,
      verifiedBlock: d.block,
      tvlUsd: d.tvlUsd ?? undefined,
    }))
    return { verifiedAt: raw.verifiedAt ?? 0, query: raw.query ?? '', deployments: deployments.length ? deployments : FALLBACK }
  } catch {
    return { verifiedAt: 0, query: '', deployments: FALLBACK }
  }
}

export const REGISTRY = loadRegistry()

/** Sane TVL only. A few deployments report totals in the wrong unit; those never make the cut. */
const plausible = (d: StandardDeployment) => (d.tvlUsd ?? 0) >= 1e6 && (d.tvlUsd ?? 0) < 1e12

/**
 * The deployments a report queries for exposure: the lending family, where an account's open
 * positions mean borrowed or supplied money, largest first, capped so a report stays fast.
 */
export const STANDARDIZED: StandardDeployment[] = REGISTRY.deployments
  .filter((d) => d.family === 'lending' && plausible(d))
  .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
  .slice(0, 30)

const gateway = () => process.env.GRAPH_GATEWAY ?? 'https://gateway.thegraph.com/api'
const key = () => process.env.GRAPH_API_KEY ?? ''

export const graphConfigured = () => Boolean(key())

async function query<T>(subgraphId: string, q: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  if (!key()) return null
  try {
    const res = await fetch(`${gateway()}/${key()}/subgraphs/id/${subgraphId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q, variables }),
    })
    const body: any = await res.json()
    if (body.errors) return null
    return body.data as T
  } catch { return null }
}

/**
 * ONE QUERY SHAPE. Sent verbatim to every deployment above, across both schema families.
 * This is the leverage: adding a protocol changes the table, never this string.
 */
export const EXPOSURE_QUERY = `
  query Exposure($account: ID!) {
    _meta { block { number } deployment }
    protocols { name type totalValueLockedUSD cumulativeUniqueUsers }
    accounts(first: 1, where: { id: $account }) { id positionCount openPositionCount }
  }`

export const TOP_ACCOUNTS_QUERY = `
  query TopAccounts($first: Int!) {
    accounts(first: $first, orderBy: openPositionCount, orderDirection: desc) {
      id openPositionCount positionCount
    }
  }`

export interface ProtocolExposure {
  key: string
  label: string
  family: string
  network: string
  /** Provenance: which deployment answered, and the block it had indexed when it did. */
  deployment: string | null
  indexedBlock: number | null
  protocolType: string | null
  protocolTvlUsd: number | null
  protocolUsers: number | null
  hasAccount: boolean
  openPositions: number
  totalPositions: number
}

export interface Exposure {
  address: string
  queriedProtocols: number
  protocolsWithExposure: number
  openPositions: number
  /** Combined TVL of the protocols this account holds open positions in. */
  exposedProtocolTvlUsd: number
  detail: ProtocolExposure[]
  source: string
}

export async function accountExposure(address: string): Promise<Exposure | null> {
  if (!graphConfigured()) return null
  const id = address.toLowerCase()

  const detail = await Promise.all(
    STANDARDIZED.map(async (d): Promise<ProtocolExposure> => {
      const data = await query<any>(d.subgraphId, EXPOSURE_QUERY, { account: id })
      const p = data?.protocols?.[0]
      const a = data?.accounts?.[0]
      return {
        key: d.key,
        label: d.label,
        family: d.family,
        network: d.network,
        deployment: data?._meta?.deployment ?? null,
        indexedBlock: data?._meta?.block?.number ?? null,
        protocolType: p?.type ?? null,
        protocolTvlUsd: p ? Number(p.totalValueLockedUSD) : null,
        protocolUsers: p ? Number(p.cumulativeUniqueUsers) : null,
        hasAccount: Boolean(a),
        openPositions: Number(a?.openPositionCount ?? 0),
        totalPositions: Number(a?.positionCount ?? 0),
      }
    }),
  )

  const exposed = detail.filter((d) => d.openPositions > 0)
  return {
    address,
    queriedProtocols: detail.length,
    protocolsWithExposure: exposed.length,
    openPositions: exposed.reduce((a, d) => a + d.openPositions, 0),
    exposedProtocolTvlUsd: exposed.reduce((a, d) => a + (d.protocolTvlUsd ?? 0), 0),
    detail,
    source: `The Graph gateway, ${detail.length} standardized deployments across ${new Set(detail.map((d) => d.network)).size} networks, one query shape, registry of ${REGISTRY.deployments.length} verified`,
  }
}

/**
 * Discovery in reverse: the largest accounts in real protocols, so the population Roll Call ranks
 * is chosen by where the money is rather than by which Safe happened to transact recently.
 */
export async function largestAccounts(perProtocol = 40): Promise<{ address: string; openPositions: number; protocols: string[] }[]> {
  if (!graphConfigured()) return []
  const merged = new Map<string, { openPositions: number; protocols: Set<string> }>()

  await Promise.all(
    STANDARDIZED.map(async (d) => {
      const data = await query<any>(d.subgraphId, TOP_ACCOUNTS_QUERY, { first: perProtocol })
      for (const a of data?.accounts ?? []) {
        const cur = merged.get(a.id) ?? { openPositions: 0, protocols: new Set<string>() }
        cur.openPositions += Number(a.openPositionCount ?? 0)
        cur.protocols.add(d.label)
        merged.set(a.id, cur)
      }
    }),
  )

  return [...merged.entries()]
    .map(([address, v]) => ({ address, openPositions: v.openPositions, protocols: [...v.protocols] }))
    .sort((a, b) => b.openPositions - a.openPositions)
}
