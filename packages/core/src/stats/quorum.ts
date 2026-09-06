/**
 * Effective quorum.
 *
 * This is the number most likely to become a fabrication, so it is never reported as a constant.
 *
 * DEFINITION: a LOWER BOUND on the number of independent decision units required to reach the
 * Safe's threshold, where two signers are placed in the same unit if their co-signing dependence
 * is significant at level alpha. The answer is a FUNCTION of alpha, so we publish the curve.
 *
 * Reading it:
 *   - stable across three orders of magnitude of alpha -> robust finding
 *   - collapses only at loose alpha              -> a flag, not a finding
 */

export interface QuorumPoint {
  alpha: number
  units: number[][]        // clusters of signer indices
  unitCount: number
  effectiveQuorum: number  // min units needed to reach threshold
  declaredThreshold: number
}

export function quorumCurve(
  signers: string[],
  threshold: number,
  pairs: { a: string; b: string; pValue: number; excess: number }[],
  alphas: number[] = [0.05, 0.01, 0.005, 0.001, 0.0005],
): QuorumPoint[] {
  const idx = new Map(signers.map((s, i) => [s.toLowerCase(), i]))

  return alphas.map((alpha) => {
    const parent = signers.map((_, i) => i)
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
    const union = (x: number, y: number) => { const a = find(x), b = find(y); if (a !== b) parent[a] = b }

    for (const p of pairs) {
      // Only POSITIVE dependence merges. Signers who co-sign less than chance are not one party.
      if (p.pValue < alpha && p.excess > 0) {
        const i = idx.get(p.a.toLowerCase()), j = idx.get(p.b.toLowerCase())
        if (i != null && j != null) union(i, j)
      }
    }

    const groups = new Map<number, number[]>()
    signers.forEach((_, i) => {
      const r = find(i)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r)!.push(i)
    })
    const units = [...groups.values()].sort((a, b) => b.length - a.length)

    // Worst case for decentralisation: the largest units cooperate first.
    let acc = 0, needed = 0
    for (const u of units) { acc += u.length; needed++; if (acc >= threshold) break }

    return {
      alpha,
      units,
      unitCount: units.length,
      effectiveQuorum: acc >= threshold ? needed : threshold,
      declaredThreshold: threshold,
    }
  })
}

/** A finding is robust when it holds across the whole tested range of alpha. */
export function robustness(curve: QuorumPoint[]) {
  const vals = new Set(curve.map((c) => c.effectiveQuorum))
  return {
    stable: vals.size === 1,
    min: Math.min(...curve.map((c) => c.effectiveQuorum)),
    max: Math.max(...curve.map((c) => c.effectiveQuorum)),
    verdict: vals.size === 1 ? 'robust' : 'alpha-sensitive',
  }
}
