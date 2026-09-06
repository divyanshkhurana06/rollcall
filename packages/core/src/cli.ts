import { buildReport } from './report.js'
import type { ChainKey } from './chain.js'

const args = process.argv.slice(2)
const address = args[0]
if (!address) {
  console.error('usage: npm run report -- <safe-address> [--chain ethereum] [--chains ethereum,base] [--max 250] [--perms 10000]')
  process.exit(1)
}
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }

const C = { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', x: '\x1b[0m' }
const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`

const report = await buildReport(address, {
  chain: (flag('chain', 'ethereum') as ChainKey),
  livenessChains: (flag('chains', 'ethereum')!.split(',') as ChainKey[]),
  maxTxs: Number(flag('max', '250')),
  permutations: Number(flag('perms', '10000')),
})

const h = report.header, o = report.observed
console.log(`\n${C.b}ROLL CALL${C.x} ${C.d}- control surface report${C.x}`)
console.log(`${C.d}${'─'.repeat(74)}${C.x}`)
console.log(`target      ${C.c}${report.target.address}${C.x} on ${report.target.chain}`)
console.log(`method      v${h.methodVersion}   seed ${h.seed}   perms ${h.permutations.independence}`)
console.log(`digest      ${C.d}${h.inputDigest}${C.x}`)
console.log(`window      ${h.txWindow.count} executed txs${h.txWindow.firstAt ? `, ${new Date(h.txWindow.firstAt * 1000).toISOString().slice(0, 10)} -> ${new Date(h.txWindow.lastAt! * 1000).toISOString().slice(0, 10)}` : ''}`)

console.log(`\n${C.b}OBSERVED${C.x} ${C.d}(read from chain - facts)${C.x}`)
console.log(`  threshold ${C.b}${o.threshold} of ${o.owners.length}${C.x}   Safe v${o.version ?? '?'}   nonce ${o.nonce}`)
for (const l of report.liveness) {
  const d = l.daysSinceAnySignal
  const col = d === null || d >= 365 ? C.r : d >= 180 ? C.y : C.g
  const label = d === null ? 'no signal ever' : `${d}d since last signal`
  console.log(`  ${col}●${C.x} ${short(l.signer)}  ${col}${label.padEnd(22)}${C.x}${C.d}nonce ${l.nonce}${C.x}`)
}
const R = report.reachability
console.log(`  ${R.canStillReachThreshold ? C.g + '✓' : C.r + '✗'}${C.x} live signers ${R.liveSigners}/${R.owners} vs threshold ${R.threshold}` +
  (R.canStillReachThreshold ? `  ${C.d}(margin ${R.marginToFrozen} before frozen)${C.x}` : `  ${C.r}CANNOT REACH QUORUM${C.x}`))

console.log(`\n${C.b}TESTED${C.x} ${C.d}(statistics with stated nulls)${C.x}`)
const sig = report.tested.independence.filter((p) => p.pValue < 0.05 && p.excess > 0)
if (!sig.length) console.log(`  ${C.d}no pair shows co-signing dependence at p < 0.05${C.x}`)
for (const p of sig.slice(0, 6))
  console.log(`  ${short(p.a)} ~ ${short(p.b)}  observed ${(p.observed * 100).toFixed(0)}% vs expected ${(p.expected * 100).toFixed(0)}%  ${C.y}p=${p.pValue < 0.001 ? '<0.001' : p.pValue.toFixed(4)}${C.x} ${C.d}(both ${p.counts.both}/${p.counts.n})${C.x}`)
for (const t of report.tested.timing.filter((t) => t.pValue < 0.05).slice(0, 4))
  console.log(`  ${short(t.a)} ~ ${short(t.b)}  median gap ${t.observedMedianGapSec}s vs null ${t.nullMedianGapSec}s  ${C.y}p=${t.pValue.toFixed(4)}${C.x} ${C.d}(n=${t.samples})${C.x}`)

console.log(`\n${C.b}INFERRED${C.x} ${C.d}(parameterised - reported as a curve, never a constant)${C.x}`)
for (const q of report.inferred.quorumCurve)
  console.log(`  alpha ${String(q.alpha).padEnd(7)} ${q.unitCount} independent unit(s)  ->  effective quorum ${C.b}${q.effectiveQuorum}${C.x} of ${q.declaredThreshold}`)
console.log(`  ${C.d}verdict: ${report.inferred.robustness.verdict}${C.x}`)

console.log(`\n${C.b}FINDINGS${C.x}`)
if (!report.findings.length) console.log(`  ${C.g}none${C.x}`)
for (const f of report.findings) {
  const col = f.severity === 'critical' ? C.r : f.severity === 'warning' ? C.y : C.d
  console.log(`  ${col}[${f.tier.toUpperCase()}]${C.x} ${C.b}${f.title}${C.x}`)
  console.log(`     ${f.detail}`)
  if (f.caveat) console.log(`     ${C.d}caveat: ${f.caveat}${C.x}`)
}
console.log(`\n${C.d}${report.coverage.note}${C.x}`)
if (process.env.JSON) console.log('\n' + JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2))
