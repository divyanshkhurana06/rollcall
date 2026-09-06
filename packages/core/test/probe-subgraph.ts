import 'dotenv/config'
import { subgraphHead, indexedApprovals, indexedSignerActivity, subgraphConfigured } from '../src/graph.js'
import { loadLeaderboard } from '../src/leaderboard.js'

console.log('configured:', subgraphConfigured())
console.log('head:', JSON.stringify(await subgraphHead()))

const lb = loadLeaderboard()!
for (const row of lb.rows.slice(0, 6)) {
  const a = await indexedApprovals(row.address, 5)
  if (a?.length) {
    console.log(`\n${row.address}  ${a.length} indexed approvals`)
    for (const x of a.slice(0, 3)) console.log(`  ${x.signer}  ${x.kind}  ${new Date(Number(x.signedAt) * 1000).toISOString().slice(0, 16)}`)
    const act = await indexedSignerActivity(a.map((x) => x.signer))
    console.log(`  cross-safe activity for ${act?.size ?? 0} signers in one query`)
    for (const [s, v] of act ?? []) console.log(`    ${s.slice(0,12)}  ${v.approvals} approvals across ${v.safes} safe(s)`)
    break
  }
}
