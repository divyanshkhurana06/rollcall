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

export interface StandardDeployment {
  key: string
  label: string
  subgraphId: string
  /** Schema family, per the standardized spec. */
  family: 'lending' | 'dex-amm-extended'
}

export const STANDARDIZED: StandardDeployment[] = [
  { key: 'aave-v3', label: 'Aave v3', subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk', family: 'lending' },
  { key: 'aave-v2', label: 'Aave v2', subgraphId: 'C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j', family: 'lending' },
  { key: 'uniswap-v3', label: 'Uniswap V3', subgraphId: 'FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS', family: 'dex-amm-extended' },
]

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
    source: `The Graph gateway, ${detail.length} standardized deployments, one query shape`,
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
