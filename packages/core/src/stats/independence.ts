import { mulberry32, shuffle } from './rng.js'

/**
 * Co-signing independence.
 *
 * NULL HYPOTHESIS (stated, because a score without a null is a made-up number):
 *   Each signer independently decides whether to approve transaction t, at their own
 *   marginal participation rate, subject to the Safe's threshold constraint that exactly
 *   `k` signers approve each transaction.
 *
 * The threshold constraint is why a naive correlation is worthless here. In a 3-of-3 Safe with
 * exactly three active signers, everyone co-signs everything by construction. That is structure,
 * not collusion. The permutation below preserves BOTH each signer's marginal rate AND the
 * per-transaction signer count, so structural co-occurrence cancels out of the null.
 *
 * We report an empirical p-value from the permutation distribution. No distributional
 * assumptions, no magic constants.
 */

export interface Participation {
  /** One row per executed transaction; each row is the set of approver indices. */
  rows: number[][]
  signers: string[]
}

export interface PairDependence {
  a: string
  b: string
  observed: number
  expected: number
  /** Positive => co-sign more than independence predicts. */
  excess: number
  pValue: number
  permutations: number
  /** Raw counts so a reader can check the arithmetic by hand. */
  counts: { both: number; aOnly: number; bOnly: number; neither: number; n: number }
}

export function buildMatrix(p: Participation): boolean[][] {
  return p.rows.map((row) => {
    const set = new Set(row)
    return p.signers.map((_, i) => set.has(i))
  })
}

function coCount(m: boolean[][], i: number, j: number) {
  let both = 0, aOnly = 0, bOnly = 0, neither = 0
  for (const row of m) {
    if (row[i] && row[j]) both++
    else if (row[i]) aOnly++
    else if (row[j]) bOnly++
    else neither++
  }
  return { both, aOnly, bOnly, neither, n: m.length }
}

/**
 * Permute by reshuffling WHICH signers fill each transaction's slots, drawing without
 * replacement weighted by each signer's marginal rate. This preserves row sizes (threshold)
 * and approximately preserves column marginals.
 */
function permuteMatrix(m: boolean[][], marginals: number[], rnd: () => number): boolean[][] {
  const nSigners = marginals.length
  const idx = Array.from({ length: nSigners }, (_, i) => i)
  return m.map((row) => {
    const k = row.filter(Boolean).length
    // Weighted sampling without replacement (Efraimidis-Spirakis keys).
    const keyed = idx.map((i) => ({ i, key: Math.pow(rnd(), 1 / Math.max(marginals[i], 1e-9)) }))
    keyed.sort((x, y) => y.key - x.key)
    const chosen = new Set(keyed.slice(0, k).map((x) => x.i))
    return idx.map((i) => chosen.has(i))
  })
}

export function pairwiseDependence(
  p: Participation,
  opts: { permutations?: number; seed?: number } = {},
): PairDependence[] {
  const permutations = opts.permutations ?? 10_000
  const rnd = mulberry32(opts.seed ?? 42)
  const m = buildMatrix(p)
  const n = m.length
  const nS = p.signers.length
  if (n < 8 || nS < 2) return []

  const marginals = p.signers.map((_, i) => m.filter((r) => r[i]).length / n)

  // Observed statistic per pair: co-occurrence rate.
  const observed: number[][] = Array.from({ length: nS }, () => new Array(nS).fill(0))
  for (let i = 0; i < nS; i++)
    for (let j = i + 1; j < nS; j++) observed[i][j] = coCount(m, i, j).both / n

  // Null distribution.
  const ge: number[][] = Array.from({ length: nS }, () => new Array(nS).fill(0))
  const sum: number[][] = Array.from({ length: nS }, () => new Array(nS).fill(0))
  for (let p_ = 0; p_ < permutations; p_++) {
    const pm = permuteMatrix(m, marginals, rnd)
    for (let i = 0; i < nS; i++)
      for (let j = i + 1; j < nS; j++) {
        const c = coCount(pm, i, j).both / n
        sum[i][j] += c
        if (c >= observed[i][j]) ge[i][j]++
      }
  }

  const out: PairDependence[] = []
  for (let i = 0; i < nS; i++)
    for (let j = i + 1; j < nS; j++) {
      const expected = sum[i][j] / permutations
      out.push({
        a: p.signers[i],
        b: p.signers[j],
        observed: observed[i][j],
        expected,
        excess: observed[i][j] - expected,
        // +1 smoothing: an empirical p-value can never honestly be reported as exactly zero.
        pValue: (ge[i][j] + 1) / (permutations + 1),
        permutations,
        counts: coCount(m, i, j),
      })
    }
  return out.sort((a, b) => a.pValue - b.pValue)
}
