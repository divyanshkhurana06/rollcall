import 'dotenv/config'
import { accountExposure } from '../src/exposure.js'
import { loadLeaderboard } from '../src/leaderboard.js'

const lb = loadLeaderboard()!
let withExposure = 0
for (const r of lb.rows) {
  const e = await accountExposure(r.address)
  if (!e) continue
  const hit = e.detail.filter(d => d.hasAccount)
  if (hit.length) {
    withExposure++
    console.log(`  ${r.address}  ${hit.map(h => `${h.label}:${h.openPositions}open/${h.totalPositions}total`).join('  ')}`)
  }
}
console.log(`\n${withExposure} of ${lb.rows.length} scanned Safes appear as accounts in the standardized set`)
const sample = await accountExposure(lb.rows[0].address)
console.log('\nprotocol context from the same query shape:')
for (const d of sample!.detail) console.log(`  ${d.label.padEnd(12)} ${d.protocolType?.padEnd(9)} TVL $${((d.protocolTvlUsd ?? 0)/1e9).toFixed(2)}B  users ${(d.protocolUsers ?? 0).toLocaleString()}`)
