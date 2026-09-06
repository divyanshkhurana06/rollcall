import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildReport } from './report.js'
import { fetchSafe } from './extract/safeapi.js'
import { client, windowedLogs, type ChainKey } from './chain.js'
import { TOPICS } from './abi.js'

/**
 * The leaderboard.
 *
 * A single report answers "is this Safe what it claims to be". It cannot answer the question a
 * user actually arrives with, which is "which of the things I depend on is worst". That needs a
 * population, and a population needs discovery.
 *
 * Safes are found by scanning ExecutionSuccess logs rather than from a hand-picked list, so the
 * ranking is not curated. We keep only Safes with enough signers and enough history for the
 * statistics to mean anything, and we say what those cutoffs are.
 */

export interface LeaderboardRow {
  address: string
  chain: ChainKey
  threshold: number
  owners: number
  /** Lowest effective quorum across the tested alpha grid. */
  effectiveQuorum: number
  /** declared threshold minus effective quorum. The headline number. */
  gap: number
  robust: boolean
  darkSigners: number
  liveSigners: number
  indeterminateSigners: number
  marginToFrozen: number
  canStillReachThreshold: boolean
  dependentPairs: number
  invisibleSigners: number
  txWindow: number
  oldestSignalDays: number | null
  digest: string
  scannedAt: number
}

export interface Leaderboard {
  generatedAt: number
  methodVersion: string
  criteria: { minOwners: number; minTransactions: number; maxTxsAnalysed: number; permutations: number }
  scanned: number
  skipped: number
  rows: LeaderboardRow[]
}

const CACHE = 'data/leaderboard.json'

/** Discover active Safes from chain activity. No curated list. */
export async function discoverSafes(
  chain: ChainKey,
  opts: { lookbackBlocks?: bigint; window?: bigint; maxLogs?: number } = {},
): Promise<string[]> {
  const c = client(chain)
  const head = await c.getBlockNumber()
  const lookback = opts.lookbackBlocks ?? 20_000n
  const logs = await windowedLogs(
    chain,
    { topics: [TOPICS.ExecutionSuccess], fromBlock: head - lookback, toBlock: head },
    { window: opts.window ?? 2_000n, max: opts.maxLogs ?? 900 },
  )
  const counts = new Map<string, number>()
  for (const l of logs) counts.set(l.address, (counts.get(l.address) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)
}

export async function buildLeaderboard(opts: {
  chain?: ChainKey
  limit?: number
  minOwners?: number
  minTransactions?: number
  maxTxsAnalysed?: number
  permutations?: number
  onProgress?: (msg: string) => void
} = {}): Promise<Leaderboard> {
  const chain = opts.chain ?? 'ethereum'
  const limit = opts.limit ?? 18
  const minOwners = opts.minOwners ?? 4
  const minTransactions = opts.minTransactions ?? 30
  const maxTxsAnalysed = opts.maxTxsAnalysed ?? 150
  const permutations = opts.permutations ?? 2_500
  const log = opts.onProgress ?? (() => {})

  log('discovering active Safes from ExecutionSuccess logs')
  const candidates = await discoverSafes(chain)
  log(`found ${candidates.length} distinct Safes`)

  const rows: LeaderboardRow[] = []
  let skipped = 0

  for (const address of candidates) {
    if (rows.length >= limit) break

    const safe = await fetchSafe(chain, address)
    if (!safe) { skipped++; continue }

    // Statistical power, stated rather than implied: too few signers gives no pairs to test,
    // too little history gives a permutation distribution too coarse to resolve anything.
    if (safe.owners.length < minOwners || safe.nonce < minTransactions) { skipped++; continue }

    try {
      log(`scanning ${safe.address}  ${safe.threshold}/${safe.owners.length}  (${rows.length + 1}/${limit})`)
      const r = await buildReport(address, {
        chain, livenessChains: [chain], maxTxs: maxTxsAnalysed, permutations,
      })
      if (r.header.txWindow.count < 12) { skipped++; continue }

      const curve = r.inferred.quorumCurve
      const effectiveQuorum = Math.min(...curve.map((c) => c.effectiveQuorum))
      const days = r.liveness.map((l) => l.daysSinceAnySignal).filter((d): d is number => d !== null)

      rows.push({
        address: r.target.address,
        chain,
        threshold: r.observed.threshold,
        owners: r.observed.owners.length,
        effectiveQuorum,
        gap: r.observed.threshold - effectiveQuorum,
        robust: r.inferred.robustness.stable,
        darkSigners: r.reachability.darkSigners,
        liveSigners: r.reachability.liveSigners,
        indeterminateSigners: r.reachability.indeterminateSigners,
        marginToFrozen: r.reachability.marginToFrozen,
        canStillReachThreshold: r.reachability.canStillReachThreshold,
        dependentPairs: r.tested.independence.filter((p) => p.pValue < 0.01 && p.excess > 0).length,
        invisibleSigners: r.liveness.filter((l) => l.nonce === 0 && l.daysSinceAnySignal !== null).length,
        txWindow: r.header.txWindow.count,
        oldestSignalDays: days.length ? Math.max(...days) : null,
        digest: r.header.inputDigest,
        scannedAt: Math.floor(Date.now() / 1000),
      })
    } catch { skipped++ }
  }

  rows.sort(rank)

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    methodVersion: '1.0.0',
    criteria: { minOwners, minTransactions, maxTxsAnalysed, permutations },
    scanned: rows.length,
    skipped,
    rows,
  }
}

/**
 * Ranking. Deliberately ordered by consequence, not by how alarming a number looks:
 *   1. Can it still act at all? A Safe below quorum is a different category of problem.
 *   2. How far is the honest quorum from the declared one?
 *   3. How close is it to being frozen?
 *   4. How many signers have gone quiet?
 */
function rank(a: LeaderboardRow, b: LeaderboardRow) {
  if (a.canStillReachThreshold !== b.canStillReachThreshold) return a.canStillReachThreshold ? 1 : -1
  if (b.gap !== a.gap) return b.gap - a.gap
  if (a.marginToFrozen !== b.marginToFrozen) return a.marginToFrozen - b.marginToFrozen
  return b.darkSigners - a.darkSigners
}

export function saveLeaderboard(lb: Leaderboard, path = CACHE) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(lb, null, 2))
}

export function loadLeaderboard(path = CACHE): Leaderboard | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
