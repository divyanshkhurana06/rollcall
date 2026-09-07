import { client, lastLogCoverage, type ChainKey, type LogCoverage } from '../chain.js'
import { readSafeState, fetchExecutions } from './safe.js'
import { fetchServiceTxs } from './safeapi.js'

/**
 * Per-transaction approver recovery, as a first class result rather than a validation step.
 *
 * The distinction this exists to make:
 *
 *   "has this address sent transactions?"    -> answerable from any explorer, and useless here
 *   "has this address approved anything?"    -> answerable only from the signature blob
 *
 * A Safe signer can approve every transaction for years without ever sending one themselves; the
 * executor pays gas, everyone else signs offchain. Judged by nonce alone those signers look dead.
 * Recovering them from the packed `signatures` argument of `execTransaction` is the only way their
 * participation is visible at all.
 *
 * Each row below is one transaction with the addresses that actually approved it, recovered from
 * calldata, alongside whether each of those addresses has ever sent a transaction of its own.
 */

export interface ApprovalRow {
  safeTxHash: string
  txHash: string
  timestamp: number
  /** Paid the gas. Frequently not one of the approvers. */
  executor: string
  approvers: { signer: string; kind: string; position: number }[]
  unresolved: number
  /** Present when the Safe Transaction Service also has this transaction, for cross-checking. */
  serviceApprovers: string[] | null
  agreement: 'exact' | 'partial' | 'unavailable'
}

export interface ParticipationProof {
  safe: string
  chain: ChainKey
  threshold: number
  owners: string[]
  rows: ApprovalRow[]
  /** Nonce per approver, so "invisible to explorers" is verifiable rather than asserted. */
  nonces: Record<string, number>
  /**
   * Which blocks were actually searched. Zero approvals with an incomplete search is not evidence
   * that none exist, and the two must never be reported the same way.
   */
  coverage: LogCoverage
  summary: {
    transactionsRecovered: number
    signerSlotsRecovered: number
    unresolvedWords: number
    crossChecked: number
    exactSetMatches: number
    agreementRate: number
    /** Signers who approved here but have never sent a transaction anywhere. */
    invisibleApprovers: string[]
    /** Executors that are not owners at all: a relayer or module paid the gas. */
    nonOwnerExecutors: string[]
  }
  note: string
}

export async function proveParticipation(
  chain: ChainKey,
  address: string,
  opts: { lookbackBlocks?: bigint; max?: number; nonces?: Map<string, number> } = {},
): Promise<ParticipationProof | null> {
  const state = await readSafeState(chain, address as `0x${string}`)
  if (!state) return null

  const execs = await fetchExecutions(chain, state, {
    // Wide enough to reach a Safe that acts monthly rather than daily. Public RPCs cap log
    // queries at 10k blocks, so this is ~35 sequential requests: slow, but a Safe that only signs
    // occasionally is exactly the one whose signers look dead.
    lookbackBlocks: opts.lookbackBlocks ?? 350_000n,
    max: opts.max ?? 12,
  })

  // Independent derivation of the same fact, used to cross-check rather than to source.
  const coverage = lastLogCoverage()
  const service = await fetchServiceTxs(chain, address, 250).catch(() => [])
  const byHash = new Map(service.map((t) => [t.safeTxHash.toLowerCase(), t]))

  const ownerSet = new Set(state.owners.map((o) => o.toLowerCase()))
  const rows: ApprovalRow[] = []
  let slots = 0, unresolved = 0, crossChecked = 0, exact = 0, matched = 0, compared = 0
  const invisible = new Set<string>()
  const nonOwnerExecutors = new Set<string>()

  for (const e of execs) {
    const svc = byHash.get(e.safeTxHash.toLowerCase())
    const recovered = e.approvers.map((a) => a.signer.toLowerCase())
    const expected = svc ? svc.confirmations.map((c) => c.owner.toLowerCase()) : null

    let agreement: ApprovalRow['agreement'] = 'unavailable'
    if (expected) {
      crossChecked++
      compared += expected.length
      const hit = expected.filter((x) => recovered.includes(x)).length
      matched += hit
      const same = hit === expected.length && recovered.length === expected.length
      if (same) exact++
      agreement = same ? 'exact' : 'partial'
    }

    slots += e.approvers.length
    unresolved += e.unresolved
    if (!ownerSet.has(e.executor.toLowerCase())) nonOwnerExecutors.add(e.executor)

    rows.push({
      safeTxHash: e.safeTxHash,
      txHash: e.txHash,
      timestamp: e.timestamp,
      executor: e.executor,
      approvers: e.approvers.map((a) => ({ signer: a.signer, kind: a.kind, position: a.position })),
      unresolved: e.unresolved,
      serviceApprovers: svc ? svc.confirmations.map((c) => c.owner) : null,
      agreement,
    })
  }

  // An approver with nonce 0 has never sent a transaction, so no explorer will show them as active.
  // Resolved here rather than left to the caller: the claim is only meaningful with the nonce beside it.
  const nonces = opts.nonces ?? new Map<string, number>()
  const c = client(chain)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const approverAddrs = [...new Set(rows.flatMap((r) => r.approvers.map((a) => a.signer)))]
  for (const addr of approverAddrs) {
    if (nonces.has(addr.toLowerCase())) continue
    for (let i = 0; i < 4; i++) {
      try { nonces.set(addr.toLowerCase(), await c.getTransactionCount({ address: addr as `0x${string}` })); break }
      catch { await sleep(500 * (i + 1)) }
    }
  }
  for (const r of rows) {
    for (const a of r.approvers) {
      if (nonces.get(a.signer.toLowerCase()) === 0) invisible.add(a.signer)
    }
  }

  return {
    safe: state.address,
    chain,
    threshold: state.threshold,
    owners: state.owners,
    rows,
    nonces: Object.fromEntries(nonces),
    coverage,
    summary: {
      transactionsRecovered: rows.length,
      signerSlotsRecovered: slots,
      unresolvedWords: unresolved,
      crossChecked,
      exactSetMatches: exact,
      agreementRate: compared ? matched / compared : 0,
      invisibleApprovers: [...invisible],
      nonOwnerExecutors: [...nonOwnerExecutors],
    },
    note:
      `Approvers recovered from execTransaction calldata for ${rows.length} transaction(s) ` +
      `across ${coverage.coveredBlocks.toLocaleString()} blocks searched. ` +
      (coverage.complete ? '' : `${coverage.failedRanges} range(s) could not be served by any endpoint, so this window is incomplete. `) +
      (crossChecked
        ? `${crossChecked} cross-checked against the Safe Transaction Service, an independent derivation of the same fact.`
        : 'No service records available for this window, so recovery stands alone.'),
  }
}
