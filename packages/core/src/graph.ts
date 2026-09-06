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

export interface AuthorityRecord {
  id: string
  contract: string
  kind: 'owner' | 'role' | 'proxy-admin' | 'safe-owner' | 'threshold' | 'pauser'
  holder: string | null
  role: string | null
  grantedAt: number
  revokedAt: number | null
  txHash: string
  chain: string
}

export interface SignerApproval {
  id: string
  safe: string
  signer: string
  safeTxHash: string
  signedAt: number
  kind: string
  chain: string
}

const ENDPOINT = () => process.env.SUBGRAPH_URL ?? ''
const KEY = () => process.env.GRAPH_API_KEY ?? ''

export const graphConfigured = () => Boolean(ENDPOINT())

async function query<T>(q: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  const url = ENDPOINT()
  if (!url) return null
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(KEY() ? { authorization: `Bearer ${KEY()}` } : {}) },
      body: JSON.stringify({ query: q, variables }),
    })
    const body: any = await res.json()
    if (body.errors) return null
    return body.data as T
  } catch { return null }
}

/** One query shape, every protocol. */
export const AUTHORITY_QUERY = `
  query Authority($contract: String!, $first: Int!) {
    authorityRecords(
      where: { contract: $contract, revokedAt: null }
      orderBy: grantedAt orderDirection: desc first: $first
    ) { id contract kind holder role grantedAt revokedAt txHash chain }
  }`

export const APPROVALS_QUERY = `
  query Approvals($safe: String!, $first: Int!) {
    signerApprovals(where: { safe: $safe } orderBy: signedAt orderDirection: desc first: $first) {
      id safe signer safeTxHash signedAt kind chain
    }
  }`

export const SIGNER_ACTIVITY_QUERY = `
  query SignerActivity($signer: String!) {
    signerApprovals(where: { signer: $signer } orderBy: signedAt orderDirection: desc first: 1) {
      signedAt safe chain
    }
  }`

export async function authorityFor(contract: string, first = 100) {
  const d = await query<{ authorityRecords: AuthorityRecord[] }>(AUTHORITY_QUERY, { contract: contract.toLowerCase(), first })
  return d?.authorityRecords ?? null
}

export async function approvalsFor(safe: string, first = 500) {
  const d = await query<{ signerApprovals: SignerApproval[] }>(APPROVALS_QUERY, { safe: safe.toLowerCase(), first })
  return d?.signerApprovals ?? null
}

/**
 * Cross-chain liveness in ONE query instead of a binary search per signer per chain.
 * This is the single largest reason the subgraph exists.
 */
export async function lastApprovalAnywhere(signer: string) {
  const d = await query<{ signerApprovals: { signedAt: number; safe: string; chain: string }[] }>(
    SIGNER_ACTIVITY_QUERY, { signer: signer.toLowerCase() },
  )
  return d?.signerApprovals?.[0] ?? null
}

export function sourceNote(chain: ChainKey) {
  return graphConfigured()
    ? `Subgraph (${chain}) - indexed authority + approval history.`
    : `RPC fallback (${chain}) - bounded by the provider's 10k-block log window. Set SUBGRAPH_URL for full history.`
}
