import { client, CHAINS, type ChainKey } from '../chain.js'

/**
 * Signer liveness.
 *
 * A dormant emergency key is not a theoretical risk: if enough guardians go dark, the protocol
 * permanently loses the ability to pause or upgrade itself, and nobody notices until the day it
 * matters.
 *
 * Two independent signals, because either alone is misleading:
 *
 *   1. LAST OUTGOING TRANSACTION. Found by binary-searching eth_getTransactionCount over block
 *      height - the nonce is monotonic, so the block where it last increased is exactly the
 *      block of the signer's last gas-paying transaction. ~25 archive reads per address, no
 *      indexer required. This catches signers who are active but never sign for this Safe.
 *
 *   2. LAST OBSERVED APPROVAL. From recovered signature blobs and confirmation records. This
 *      catches the opposite case: an owner who signs offchain every week while their nonce sits
 *      frozen, invisible to every block explorer.
 *
 * HONEST FRAMING: we never claim a key is lost. We report "no observed signature in N days
 * across M chains", and we name the chains. Absence of evidence is not proof - nobody may have
 * asked them to sign.
 */

export interface SignerLiveness {
  signer: string
  chainsSearched: string[]
  lastOutgoingTx: { chain: ChainKey; blockNumber: number; timestamp: number } | null
  lastApproval: { timestamp: number; source: string } | null
  /** Days since the most recent evidence of ANY kind. null when no evidence exists at all. */
  daysSinceAnySignal: number | null
  nonce: number
  /**
   * Set when a lookup could not complete (rate limit, non-archive provider). CRITICAL: an
   * indeterminate signer is never counted as dark. Reporting "no signal ever" because our own
   * request failed would be a false claim, and one false claim discredits every true one.
   */
  indeterminate: boolean
  /** Explicit, so a reader knows what "dark" was measured against. */
  statement: string
}

/** Binary search the block at which this address's nonce last increased. */
export type NonceProbe =
  | { status: 'found'; blockNumber: number; timestamp: number; nonce: number }
  | { status: 'never-sent'; nonce: 0 }
  | { status: 'failed'; reason: string }

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { last = e; await new Promise((r) => setTimeout(r, 250 * 2 ** i)) }
  }
  throw last
}

export async function lastNonceIncrease(chain: ChainKey, address: `0x${string}`): Promise<NonceProbe> {
  const c = client(chain)
  try {
    const head = await withRetry(() => c.getBlockNumber())
    const nonceNow = await withRetry(() => c.getTransactionCount({ address, blockNumber: head }))
    if (nonceNow === 0) return { status: 'never-sent', nonce: 0 }

    let lo = 0n, hi = head
    // Lowest block where nonce == nonceNow is the block holding the last outgoing transaction.
    while (lo < hi) {
      const mid = (lo + hi) / 2n
      const n = await withRetry(() => c.getTransactionCount({ address, blockNumber: mid }))
      if (n >= nonceNow) hi = mid
      else lo = mid + 1n
    }
    const block = await withRetry(() => c.getBlock({ blockNumber: lo }))
    return { status: 'found', blockNumber: Number(lo), timestamp: Number(block.timestamp), nonce: nonceNow }
  } catch (e: any) {
    return { status: 'failed', reason: e?.shortMessage ?? e?.message ?? 'rpc error' }
  }
}

export async function signerLiveness(
  signer: `0x${string}`,
  chains: ChainKey[],
  lastApproval: { timestamp: number; source: string } | null,
): Promise<SignerLiveness> {
  let best: SignerLiveness['lastOutgoingTx'] = null
  let nonce = 0
  let failures = 0

  for (const chain of chains) {
    const r = await lastNonceIncrease(chain, signer)
    if (r.status === 'failed') { failures++; continue }
    if (r.status === 'never-sent') continue
    nonce += r.nonce
    if (!best || r.timestamp > best.timestamp) best = { chain, blockNumber: r.blockNumber, timestamp: r.timestamp }
  }
  // Indeterminate only when we have no evidence AND at least one probe failed.
  const indeterminate = failures > 0 && !best && !lastApproval

  const candidates = [best?.timestamp, lastApproval?.timestamp].filter((x): x is number => typeof x === 'number')
  const newest = candidates.length ? Math.max(...candidates) : null
  const days = newest ? Math.floor((Date.now() / 1000 - newest) / 86400) : null
  const labels = chains.map((c) => CHAINS[c].label)

  return {
    signer,
    chainsSearched: labels,
    lastOutgoingTx: best,
    lastApproval,
    daysSinceAnySignal: days,
    nonce,
    indeterminate,
    statement: indeterminate
      ? `Indeterminate: ${failures} of ${labels.length} chain lookups did not complete, so no claim is made about this signer.`
      : days === null
        ? `No activity of any kind observed across ${labels.length} chains (${labels.join(', ')}).`
        : `No observed signature or transaction in ${days} days across ${labels.length} chains (${labels.join(', ')}).`,
  }
}

/**
 * The consequence nobody computes: if dormant signers cannot be reached, can the remaining
 * live signers still meet threshold? If not, the Safe is functionally frozen.
 */
export function reachability(liveness: SignerLiveness[], threshold: number, darkAfterDays = 180) {
  const indeterminate = liveness.filter((l) => l.indeterminate)
  const known = liveness.filter((l) => !l.indeterminate)
  const dark = known.filter((l) => l.daysSinceAnySignal === null || l.daysSinceAnySignal >= darkAfterDays)
  const live = known.length - dark.length
  return {
    darkAfterDays,
    owners: liveness.length,
    threshold,
    liveSigners: live,
    darkSigners: dark.length,
    // Counted separately and never folded into either bucket.
    indeterminateSigners: indeterminate.length,
    canStillReachThreshold: live + indeterminate.length >= threshold,
    marginToFrozen: live - threshold,
    darkList: dark.map((d) => d.signer),
    indeterminateList: indeterminate.map((d) => d.signer),
  }
}
