import { createHash } from 'node:crypto'
import type { ChainKey } from './chain.js'
import { fetchSafe, fetchServiceTxs, type ServiceTx } from './extract/safeapi.js'
import { pairwiseDependence, type PairDependence } from './stats/independence.js'
import { timingDependence, type TimingPair } from './stats/timing.js'
import { quorumCurve, robustness, type QuorumPoint } from './stats/quorum.js'
import { signerLiveness, reachability, type SignerLiveness } from './stats/liveness.js'

export const METHOD_VERSION = '1.0.0'

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

/**
 * Every number Roll Call prints belongs to exactly one tier, and the tiers are never mixed:
 *
 *   OBSERVED  - read directly from chain state or event logs. A fact. No inference.
 *   TESTED    - a statistic with a stated null hypothesis and an empirical p-value.
 *   INFERRED  - depends on a parameter we chose. Always reported as a function of that parameter.
 *
 * A reader who only trusts OBSERVED still gets a useful report. That is the design goal.
 */
export type Tier = 'observed' | 'tested' | 'inferred'

export interface Finding {
  tier: Tier
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  /** Everything a reader needs to check this by hand. */
  evidence: { label: string; value: string; link?: string }[]
  caveat?: string
}

export interface RollCallReport {
  target: { address: string; chain: ChainKey; label?: string }
  header: {
    methodVersion: string
    generatedAt: string
    chainsSearched: ChainKey[]
    txWindow: { count: number; firstAt: number | null; lastAt: number | null }
    sources: string[]
    seed: number
    permutations: { independence: number; timing: number }
    /** Deterministic digest of the inputs - re-running with these inputs reproduces the report. */
    inputDigest: string
  }
  observed: {
    owners: string[]
    threshold: number
    version: string | null
    nonce: number
    executionsAnalysed: number
  }
  liveness: SignerLiveness[]
  reachability: ReturnType<typeof reachability>
  tested: { independence: PairDependence[]; timing: TimingPair[] }
  inferred: { quorumCurve: QuorumPoint[]; robustness: ReturnType<typeof robustness> }
  findings: Finding[]
  coverage: { note: string; limitations: string[] }
}

export interface BuildOpts {
  chain?: ChainKey
  livenessChains?: ChainKey[]
  maxTxs?: number
  permutations?: number
  seed?: number
  darkAfterDays?: number
  label?: string
}

export async function buildReport(address: string, opts: BuildOpts = {}): Promise<RollCallReport> {
  const chain = opts.chain ?? 'ethereum'
  const livenessChains = opts.livenessChains ?? ['ethereum']
  const seed = opts.seed ?? 42
  const permIndep = opts.permutations ?? 10_000
  const permTiming = 2_000
  const darkAfterDays = opts.darkAfterDays ?? 180

  const safe = await fetchSafe(chain, address)
  if (!safe) throw new Error(`Not a readable Safe on ${chain}: ${address}`)

  const txs = await fetchServiceTxs(chain, address, opts.maxTxs ?? 250)

  // ---- participation matrix -------------------------------------------------------------
  const signers = safe.owners.slice()
  const lower = signers.map((s) => s.toLowerCase())
  const rows = txs.map((t) =>
    t.confirmations.map((c) => lower.indexOf(c.owner.toLowerCase())).filter((i) => i >= 0),
  )

  const independence = pairwiseDependence({ rows, signers }, { permutations: permIndep, seed })
  const timing = timingDependence(txs, signers, { permutations: permTiming, seed })
  const curve = quorumCurve(signers, safe.threshold, independence)

  // ---- liveness -------------------------------------------------------------------------
  const lastApprovalBySigner = new Map<string, number>()
  for (const t of txs)
    for (const c of t.confirmations) {
      const at = c.submittedAt ?? t.executedAt
      if (at == null) continue
      const k = c.owner.toLowerCase()
      if (!lastApprovalBySigner.has(k) || lastApprovalBySigner.get(k)! < at) lastApprovalBySigner.set(k, at)
    }

  // Each signer needs ~log2(head) archive reads. Sequentially that is minutes; in parallel it is
  // one binary search deep, because the probes for different signers are entirely independent.
  // Bounded concurrency: fully parallel binary searches trip public-RPC rate limits, and a
  // throttled probe that fails is worse than a slow one that succeeds - it produces a signer we
  // cannot make any claim about.
  const liveness: SignerLiveness[] = await mapLimit(signers, 3, (s) => {
    const at = lastApprovalBySigner.get(s.toLowerCase())
    return signerLiveness(s as `0x${string}`, livenessChains, at ? { timestamp: at, source: 'safe-confirmation' } : null)
  })
  const reach = reachability(liveness, safe.threshold, darkAfterDays)
  const rob = robustness(curve)

  const report: RollCallReport = {
    target: { address: safe.address, chain, label: opts.label },
    header: {
      methodVersion: METHOD_VERSION,
      generatedAt: new Date().toISOString(),
      chainsSearched: livenessChains,
      txWindow: {
        count: txs.length,
        firstAt: txs[0]?.executedAt ?? null,
        lastAt: txs[txs.length - 1]?.executedAt ?? null,
      },
      sources: ['safe-transaction-service', 'rpc-archive-nonce', 'rpc-state'],
      seed,
      permutations: { independence: permIndep, timing: permTiming },
      inputDigest: digest(safe, txs, seed, permIndep),
    },
    observed: {
      owners: safe.owners,
      threshold: safe.threshold,
      version: safe.version,
      nonce: safe.nonce,
      executionsAnalysed: txs.length,
    },
    liveness,
    reachability: reach,
    tested: { independence, timing },
    inferred: { quorumCurve: curve, robustness: rob },
    findings: [],
    coverage: {
      note:
        `Analysed ${txs.length} executed transactions from the Safe Transaction Service, and ` +
        `searched ${livenessChains.length} chain(s) for signer activity.`,
      limitations: [
        'Transactions executed outside the Safe Transaction Service are not in the participation matrix.',
        'Liveness is bounded by the chains listed in the header. A signer active elsewhere reads as dark here.',
        'Module-executed transactions bypass owner signatures entirely and are out of scope for independence.',
        'Timing dependence cannot distinguish one operator from two people in the same meeting.',
        'Confirmations recorded within 5s of execution are treated as undated: signatures gathered offchain and posted together would otherwise register as perfect timing coupling.',
      ],
    },
  }

  report.findings = deriveFindings(report)
  return report
}

function deriveFindings(r: RollCallReport): Finding[] {
  const f: Finding[] = []
  const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

  // --- OBSERVED ---------------------------------------------------------------------------
  const dark = r.liveness.filter(
    (l) => l.daysSinceAnySignal === null || l.daysSinceAnySignal >= r.reachability.darkAfterDays,
  )
  if (dark.length) {
    f.push({
      tier: 'observed',
      severity: r.reachability.canStillReachThreshold ? 'warning' : 'critical',
      title: `${dark.length} of ${r.observed.owners.length} signers show no activity in ${r.reachability.darkAfterDays}+ days`,
      detail: r.reachability.canStillReachThreshold
        ? `Threshold is still reachable, with a margin of ${r.reachability.marginToFrozen} signer(s). ` +
          `Losing ${r.reachability.marginToFrozen + 1} more makes this Safe permanently unable to act.`
        : `Only ${r.reachability.liveSigners} signer(s) show recent activity against a threshold of ${r.observed.threshold}. ` +
          `On the evidence searched, this Safe can no longer reach quorum.`,
      evidence: dark.map((d) => ({ label: short(d.signer), value: d.statement })),
      caveat:
        'Absence of an observed signature is not proof a key is lost. A signer may hold their key and simply not have been asked to use it.',
    })
  }

  // --- TESTED -----------------------------------------------------------------------------
  for (const p of r.tested.independence.filter((x) => x.pValue < 0.01 && x.excess > 0).slice(0, 6)) {
    f.push({
      tier: 'tested',
      severity: 'warning',
      title: `${short(p.a)} and ${short(p.b)} do not co-sign independently`,
      detail:
        `Observed co-signing rate ${(p.observed * 100).toFixed(1)}% against ${(p.expected * 100).toFixed(1)}% ` +
        `expected under independence (permutation test, ${p.permutations} draws, p = ${fmtP(p.pValue)}).`,
      evidence: [
        { label: 'both signed', value: `${p.counts.both} of ${p.counts.n} transactions` },
        { label: 'a only / b only', value: `${p.counts.aOnly} / ${p.counts.bOnly}` },
        { label: 'null model', value: 'marginals + per-tx signer count preserved' },
      ],
      caveat:
        'This measures statistical dependence, not identity. Two independent people who always agree produce the same signal as one person with two keys.',
    })
  }

  for (const t of r.tested.timing.filter((x) => x.pValue < 0.01).slice(0, 4)) {
    f.push({
      tier: 'tested',
      severity: 'info',
      title: `${short(t.a)} and ${short(t.b)} approve unusually close together`,
      detail:
        `Median gap ${fmtDur(t.observedMedianGapSec)} against ${fmtDur(t.nullMedianGapSec)} expected when ` +
        `approvals are shuffled across transactions (p = ${fmtP(t.pValue)}, n = ${t.samples}).`,
      evidence: [{ label: 'paired approvals', value: String(t.samples) }],
      caveat:
        'Two people on the same call also sign seconds apart. Tight timing is consistent with one operator AND with coordinated humans.',
    })
  }

  // --- INFERRED ---------------------------------------------------------------------------
  const tightest = r.inferred.quorumCurve[r.inferred.quorumCurve.length - 1]
  const loosest = r.inferred.quorumCurve[0]
  if (loosest.effectiveQuorum < r.observed.threshold) {
    f.push({
      tier: 'inferred',
      severity: 'warning',
      title: `Effective quorum may be lower than the declared ${r.observed.threshold}`,
      detail:
        `At alpha = ${loosest.alpha}, signers cluster into ${loosest.unitCount} independent unit(s), giving an ` +
        `effective quorum of ${loosest.effectiveQuorum}. At alpha = ${tightest.alpha} it is ${tightest.effectiveQuorum}. ` +
        `The finding is ${r.inferred.robustness.verdict}.`,
      evidence: r.inferred.quorumCurve.map((c) => ({
        label: `alpha = ${c.alpha}`,
        value: `${c.unitCount} unit(s) -> effective quorum ${c.effectiveQuorum} of ${c.declaredThreshold}`,
      })),
      caveat:
        'This is a lower bound under a chosen clustering parameter, not a claim about who controls these keys. It is reported as a curve precisely because a single number here would be unfalsifiable.',
    })
  }

  return f
}

const fmtP = (p: number) => (p < 0.001 ? '< 0.001' : p.toFixed(4))
function fmtDur(s: number) {
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`
  return `${(s / 86400).toFixed(1)}d`
}

function digest(safe: any, txs: ServiceTx[], seed: number, perms: number) {
  const h = createHash('sha256')
  h.update(METHOD_VERSION)
  h.update(safe.address + safe.threshold + safe.owners.join(','))
  h.update(txs.map((t) => t.safeTxHash + t.confirmations.map((c) => c.owner).sort().join('')).join('|'))
  h.update(`${seed}:${perms}`)
  return '0x' + h.digest('hex').slice(0, 32)
}
