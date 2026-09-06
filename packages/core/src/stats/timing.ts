import { mulberry32 } from './rng.js'

/**
 * Timing dependence.
 *
 * Two people in different timezones, reading a proposal on their own schedule, produce broadly
 * independent approval latencies. Two signatures from the same machine do not.
 *
 * NULL: approval times are exchangeable across transactions. We build the null by pairing each
 * signer's approval with a DIFFERENT transaction's approval by the other signer, which destroys
 * any real coupling while preserving each signer's own latency distribution.
 *
 * IMPORTANT CAVEAT, printed next to every result:
 *   Two humans on the same video call also sign within seconds of each other. Tight timing is
 *   consistent with "same operator" AND with "same meeting". This is an indicator, not identity.
 */

export interface TimingPair {
  a: string
  b: string
  samples: number
  observedMedianGapSec: number
  nullMedianGapSec: number
  /** Fraction of null draws with a median gap at least as tight as observed. */
  pValue: number
}

export function timingDependence(
  txs: { executedAt?: number | null; confirmations: { owner: string; submittedAt: number | null }[] }[],
  signers: string[],
  opts: { permutations?: number; seed?: number; coSubmissionWindowSec?: number } = {},
): TimingPair[] {
  const permutations = opts.permutations ?? 2_000
  const rnd = mulberry32(opts.seed ?? 7)
  const window = opts.coSubmissionWindowSec ?? 5
  const out: TimingPair[] = []

  /**
   * CO-SUBMISSION ARTIFACT FILTER.
   *
   * Signatures are frequently collected offchain and posted together at execution time. The
   * service then records identical submission timestamps for several owners, which looks like
   * perfect timing coupling but is purely a recording artifact.
   *
   * Without this filter the timing test fires on almost every Safe. Confirmations recorded
   * within `window` seconds of execution are treated as undated, not as simultaneous.
   */
  const dated = txs.map((tx) => ({
    executedAt: tx.executedAt ?? null,
    confirmations: tx.confirmations.map((c) => ({
      owner: c.owner,
      submittedAt:
        c.submittedAt != null && tx.executedAt != null && Math.abs(c.submittedAt - tx.executedAt) <= window
          ? null
          : c.submittedAt,
    })),
  }))

  for (let i = 0; i < signers.length; i++) {
    for (let j = i + 1; j < signers.length; j++) {
      const a = signers[i], b = signers[j]
      const gaps: number[] = []
      const aTimes: number[] = []
      const bTimes: number[] = []

      for (const tx of dated) {
        const ca = tx.confirmations.find((c) => eq(c.owner, a))?.submittedAt
        const cb = tx.confirmations.find((c) => eq(c.owner, b))?.submittedAt
        if (ca != null) aTimes.push(ca)
        if (cb != null) bTimes.push(cb)
        if (ca != null && cb != null) gaps.push(Math.abs(ca - cb))
      }
      if (gaps.length < 5 || aTimes.length < 5 || bTimes.length < 5) continue

      const observed = median(gaps)
      let tighter = 0
      const nulls: number[] = []
      for (let p = 0; p < permutations; p++) {
        const draw: number[] = []
        for (let k = 0; k < gaps.length; k++) {
          const ta = aTimes[Math.floor(rnd() * aTimes.length)]
          const tb = bTimes[Math.floor(rnd() * bTimes.length)]
          draw.push(Math.abs(ta - tb))
        }
        const m = median(draw)
        nulls.push(m)
        if (m <= observed) tighter++
      }

      out.push({
        a, b,
        samples: gaps.length,
        observedMedianGapSec: Math.round(observed),
        nullMedianGapSec: Math.round(median(nulls)),
        pValue: (tighter + 1) / (permutations + 1),
      })
    }
  }
  return out.sort((x, y) => x.pValue - y.pValue)
}

const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase()
function median(xs: number[]) {
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
