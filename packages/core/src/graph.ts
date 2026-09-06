import type { ChainKey } from './chain.js'

/**
 * The Graph - the production data path.
 *
 * Public RPCs cap eth_getLogs at 10,000 blocks. A year of Ethereum is ~2.6M blocks, so
 * reconstructing one Safe's history over RPC costs ~260 sequential requests, and doing it for
 * every Safe on every chain is simply not possible that way. That is not a complaint about
 * providers - it is the reason indexed data exists.
 *
 * Roll Call's authority schema is deliberately protocol-agnostic. Authority is expressed through
 * the same handful of events in nearly every contract ever deployed:
 *
 *     OwnershipTransferred   Ownable
 *     RoleGranted/Revoked    AccessControl
 *     AdminChanged/Upgraded  EIP-1967 proxies
 *     AddedOwner/Threshold   Safe
 *
 * One query shape therefore spans every protocol, which is exactly the leverage a standardised
 * schema is supposed to give: adding a protocol to Roll Call costs zero new code.
 */

export interface SignerApproval {
  id: string
  signer: string
  safeTxHash: string
  signedAt: string
  kind: string
  chain: string
}

export interface SignerAggregate {
  id: string
  approvals: string
  firstApprovalAt: string
  lastApprovalAt: string
  chains: string[]
  safes: string[]
}

const ENDPOINT = () => process.env.SUBGRAPH_URL ?? ''

export const subgraphConfigured = () => Boolean(ENDPOINT())

async function query<T>(q: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  const url = ENDPOINT()
  if (!url) return null
  try {
    const res = await fetch(url, {
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
 * Cross-Safe, cross-chain liveness in ONE query.
 *
 * Over RPC this is a binary search per signer per chain, roughly 25 archive reads each. Indexed,
 * it is a single request. That difference is the entire reason the subgraph exists, and it is the
 * only way this scales past a handful of Safes.
 */
export const SIGNER_ACTIVITY_QUERY = `
  query SignerActivity($signers: [ID!]!) {
    signers(where: { id_in: $signers }) {
      id approvals firstApprovalAt lastApprovalAt chains safes
    }
  }`

export const SAFE_APPROVALS_QUERY = `
  query SafeApprovals($safe: String!, $first: Int!) {
    signerApprovals(
      where: { safe: $safe }
      orderBy: signedAt orderDirection: desc first: $first
    ) { id signer safeTxHash signedAt kind chain }
  }`

export const META_QUERY = `{ _meta { block { number } hasIndexingErrors } }`

export async function indexedSignerActivity(signers: string[]) {
  const d = await query<{ signers: SignerAggregate[] }>(SIGNER_ACTIVITY_QUERY, {
    signers: signers.map((s) => s.toLowerCase()),
  })
  if (!d) return null
  const out = new Map<string, { lastApprovalAt: number; approvals: number; chains: string[]; safes: number }>()
  for (const s of d.signers) {
    out.set(s.id.toLowerCase(), {
      lastApprovalAt: Number(s.lastApprovalAt),
      approvals: Number(s.approvals),
      chains: s.chains,
      safes: s.safes.length,
    })
  }
  return out
}

export async function indexedApprovals(safe: string, first = 200) {
  const d = await query<{ signerApprovals: SignerApproval[] }>(SAFE_APPROVALS_QUERY, {
    safe: `ethereum:${safe.toLowerCase()}`, first,
  })
  return d?.signerApprovals ?? null
}

export async function subgraphHead() {
  const d = await query<{ _meta: { block: { number: number }; hasIndexingErrors: boolean } }>(META_QUERY)
  return d?._meta ?? null
}

export function sourceNote(chain: string) {
  return subgraphConfigured()
    ? `Roll Call subgraph (${chain}) - indexed authority and recovered approvals.`
    : `RPC fallback (${chain}) - bounded by the provider 10k block log window. Set SUBGRAPH_URL for indexed history.`
}
