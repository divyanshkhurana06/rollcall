import { buildLeaderboard, saveLeaderboard } from './leaderboard.js'

const args = process.argv.slice(2)
const flag = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const C = { d: '\x1b[2m', b: '\x1b[1m', y: '\x1b[33m', r: '\x1b[31m', g: '\x1b[32m', x: '\x1b[0m' }

const lb = await buildLeaderboard({
  limit: Number(flag('limit', '18')),
  minOwners: Number(flag('min-owners', '4')),
  minTransactions: Number(flag('min-txs', '30')),
  permutations: Number(flag('perms', '2500')),
  onProgress: (m) => console.log(`${C.d}  ${m}${C.x}`),
})

saveLeaderboard(lb)

console.log(`\n${C.b}DECENTRALISATION GAP${C.x} ${C.d}declared threshold vs honest quorum${C.x}`)
console.log(`${C.d}${'-'.repeat(88)}${C.x}`)
console.log(`${C.d}  safe                  declared  effective  gap  dark  margin  dep  invisible${C.x}`)
for (const r of lb.rows) {
  const gapCol = r.gap >= 2 ? C.r : r.gap === 1 ? C.y : C.d
  const frozen = !r.canStillReachThreshold
  console.log(
    `  ${r.address.slice(0, 10)}...${r.address.slice(-6)}  ` +
    `${String(r.threshold + '/' + r.owners).padEnd(9)} ` +
    `${String(r.effectiveQuorum).padEnd(10)} ` +
    `${gapCol}${String(r.gap).padEnd(4)}${C.x} ` +
    `${String(r.darkSigners).padEnd(5)} ` +
    `${frozen ? C.r + 'FROZEN' + C.x : String(r.marginToFrozen).padEnd(7)} ` +
    `${String(r.dependentPairs).padEnd(4)} ` +
    `${r.invisibleSigners}`,
  )
}
console.log(`\n${C.d}${lb.scanned} scanned, ${lb.skipped} skipped (fewer than ${lb.criteria.minOwners} owners or ${lb.criteria.minTransactions} transactions)${C.x}`)
console.log(`${C.d}written to data/leaderboard.json${C.x}`)
