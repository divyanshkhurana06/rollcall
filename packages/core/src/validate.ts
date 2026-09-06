/**
 * VALIDATION HARNESS
 *
 * A score nobody has characterised the error rate of is a made-up number. This produces the two
 * numbers that make Roll Call's claims checkable:
 *
 *   PART A - Recovery agreement.
 *     Recover approvers from raw execTransaction signature blobs and compare against Safe's own
 *     confirmation records. Two independent derivations of the same fact; the agreement rate is
 *     the accuracy of the universal path that works on chains and Safes the service never saw.
 *
 *   PART B - Calibration of the independence test.
 *     Negative controls: synthetic signers drawn UNDER THE NULL (independent, same marginals,
 *     same threshold). Any pair flagged is a false positive by construction.
 *     Positive controls: one signer duplicated into two keys that always decide together.
 *     Detection rate is the statistical power.
 *
 * Both parts are deterministic given the seed printed in the output.
 */
import { mulberry32 } from './stats/rng.js'
import { pairwiseDependence } from './stats/independence.js'
import { fetchSafe, fetchServiceTxs } from './extract/safeapi.js'
import { readSafeState, fetchExecutions } from './extract/safe.js'
import type { ChainKey } from './chain.js'

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

// ─────────────────────────────────────────────────────────────────────────────
// PART A - recovery agreement against Safe's own records
// ─────────────────────────────────────────────────────────────────────────────
export async function validateRecovery(chain: ChainKey, address: string, sample = 12) {
  const svc = await fetchSafe(chain, address)
  const state = await readSafeState(chain, address as `0x${string}`)
  if (!svc || !state) return null

  const svcTxs = await fetchServiceTxs(chain, address, 120)
  const byHash = new Map(svcTxs.map((t) => [t.safeTxHash.toLowerCase(), t]))

  const execs = await fetchExecutions(chain, state, { lookbackBlocks: 80_000n, max: sample })

  let compared = 0, exactSets = 0, signerHits = 0, signerTotal = 0, unresolved = 0
  const misses: string[] = []

  for (const e of execs) {
    const svcTx = byHash.get(e.safeTxHash.toLowerCase())
    if (!svcTx) continue
    compared++
    unresolved += e.unresolved

    const recovered = new Set(e.approvers.map((a) => a.signer.toLowerCase()))
    const expected = new Set(svcTx.confirmations.map((c) => c.owner.toLowerCase()))

    for (const exp of expected) { signerTotal++; if (recovered.has(exp)) signerHits++; else misses.push(exp) }
    if (recovered.size === expected.size && [...expected].every((x) => recovered.has(x))) exactSets++
  }

  return {
    safe: svc.address,
    threshold: svc.threshold,
    comparedTransactions: compared,
    exactSetMatch: exactSets,
    signerAgreement: signerTotal ? signerHits / signerTotal : 0,
    signersCompared: signerTotal,
    unresolvedWords: unresolved,
    misses: [...new Set(misses)].slice(0, 5),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART B - calibration under synthetic controls
// ─────────────────────────────────────────────────────────────────────────────
function syntheticNull(nTx: number, nSigners: number, threshold: number, rnd: () => number) {
  const rows: number[][] = []
  for (let t = 0; t < nTx; t++) {
    const pool = Array.from({ length: nSigners }, (_, i) => i)
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
    rows.push(pool.slice(0, threshold))
  }
  return rows
}

/** Two keys that always decide together - the thing the test is supposed to catch. */
function syntheticDependent(nTx: number, nSigners: number, threshold: number, rnd: () => number) {
  const rows: number[][] = []
  for (let t = 0; t < nTx; t++) {
    const set = new Set<number>()
    if (rnd() < 0.85) { set.add(0); set.add(1) } // the coupled pair, present together or not at all
    const pool = Array.from({ length: nSigners }, (_, i) => i).filter((i) => !set.has(i))
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
    let k = 0
    while (set.size < threshold && k < pool.length) set.add(pool[k++])
    rows.push([...set])
  }
  return rows
}

export function calibrate(opts: { trials?: number; nTx?: number; nSigners?: number; threshold?: number; permutations?: number; seed?: number } = {}) {
  const trials = opts.trials ?? 40
  const nTx = opts.nTx ?? 120
  const nSigners = opts.nSigners ?? 6
  const threshold = opts.threshold ?? 3
  const permutations = opts.permutations ?? 1200
  /**
   * An empirical p-value from N permutations cannot go below 1/(N+1). Reporting power at an alpha
   * finer than that resolution yields a structural 0% that looks like a failure of the test but is
   * purely an artifact of how many draws we took. So the alpha grid is clipped to what this
   * permutation count can actually resolve, and the limit is reported alongside it.
   */
  const minResolvableP = 1 / (permutations + 1)
  const alphas = [0.05, 0.01, 0.001].filter((a) => a > minResolvableP)
  const rnd = mulberry32(opts.seed ?? 1234)
  const signers = Array.from({ length: nSigners }, (_, i) => `0x${'0'.repeat(39)}${i.toString(16)}`)

  const fp: Record<number, number> = {}, tp: Record<number, number> = {}
  for (const a of alphas) { fp[a] = 0; tp[a] = 0 }
  let fpPairs = 0, negTrials = 0

  for (let t = 0; t < trials; t++) {
    const nul = pairwiseDependence({ rows: syntheticNull(nTx, nSigners, threshold, rnd), signers }, { permutations, seed: 1000 + t })
    negTrials++
    for (const a of alphas) {
      const flagged = nul.filter((p) => p.pValue < a && p.excess > 0)
      if (flagged.length) fp[a]++
      if (a === 0.01) fpPairs += flagged.length
    }

    const dep = pairwiseDependence({ rows: syntheticDependent(nTx, nSigners, threshold, rnd), signers }, { permutations, seed: 2000 + t })
    for (const a of alphas) {
      const hit = dep.find((p) => (p.a === signers[0] && p.b === signers[1]) || (p.a === signers[1] && p.b === signers[0]))
      if (hit && hit.pValue < a && hit.excess > 0) tp[a]++
    }
  }

  const pairsPerTrial = (nSigners * (nSigners - 1)) / 2
  return {
    trials, nTx, nSigners, threshold, permutations,
    minResolvableP,
    alphasTested: alphas,
    familyWiseFPR: Object.fromEntries(alphas.map((a) => [a, fp[a] / trials])),
    perPairFPR_at_0_01: fpPairs / (negTrials * pairsPerTrial),
    power: Object.fromEntries(alphas.map((a) => [a, tp[a] / trials])),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2]

  console.log(`\n${C.b}ROLL CALL - VALIDATION${C.x}\n${C.d}${'─'.repeat(70)}${C.x}`)

  if (target) {
    console.log(`\n${C.b}PART A${C.x}  recovery from raw calldata vs Safe's own confirmation records`)
    const v = await validateRecovery('ethereum', target)
    if (!v) console.log(`  ${C.r}target unreadable${C.x}`)
    else {
      const pct = (v.signerAgreement * 100).toFixed(1)
      const col = v.signerAgreement >= 0.95 ? C.g : v.signerAgreement >= 0.8 ? C.y : C.r
      console.log(`  safe                 ${v.safe}  (threshold ${v.threshold})`)
      console.log(`  transactions compared ${v.comparedTransactions}`)
      console.log(`  exact approver-set match ${v.exactSetMatch}/${v.comparedTransactions}`)
      console.log(`  per-signer agreement  ${col}${pct}%${C.x}  (${v.signersCompared} signer-slots)`)
      console.log(`  unresolved sig words  ${v.unresolvedWords}`)
      if (v.misses.length) console.log(`  ${C.d}unmatched: ${v.misses.join(', ')}${C.x}`)
    }
  }

  console.log(`\n${C.b}PART B${C.x}  calibration of the independence test on synthetic controls`)
  const c = calibrate()
  console.log(`  design: ${c.trials} trials, ${c.nTx} txs, ${c.threshold}-of-${c.nSigners}, ${c.permutations} permutations`)
  console.log(`\n  ${C.d}negative controls (independent signers - any flag is a false positive)${C.x}`)
  for (const [a, r] of Object.entries(c.familyWiseFPR))
    console.log(`    alpha ${String(a).padEnd(7)} family-wise FPR ${((r as number) * 100).toFixed(1)}%`)
  console.log(`    per-pair FPR at 0.01: ${(c.perPairFPR_at_0_01 * 100).toFixed(2)}%`)
  console.log(`\n  ${C.d}positive controls (two keys that always decide together)${C.x}`)
  for (const [a, r] of Object.entries(c.power))
    console.log(`    alpha ${String(a).padEnd(7)} detection power ${C.g}${((r as number) * 100).toFixed(1)}%${C.x}`)
  console.log()
}
