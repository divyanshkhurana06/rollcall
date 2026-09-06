/** Find real, busy Safes to test against - no hand-picked addresses. */
import { client, windowedLogs } from '../src/chain.js'
import { TOPICS } from '../src/abi.js'
import { fetchSafe } from '../src/extract/safeapi.js'

const c = client('ethereum')
const head = await c.getBlockNumber()
const logs = await windowedLogs('ethereum', { topics: [TOPICS.ExecutionSuccess], fromBlock: head - 8000n, toBlock: head }, { window: 2000n, max: 400 })
const counts = new Map<string, number>()
for (const l of logs) counts.set(l.address, (counts.get(l.address) ?? 0) + 1)
console.log(`${logs.length} executions across ${counts.size} Safes in last 8000 blocks`)

const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
const rows: any[] = []
for (const [addr] of ranked) {
  const s = await fetchSafe('ethereum', addr)
  if (s && s.owners.length >= 3 && s.nonce >= 25) rows.push({ addr: s.address, t: `${s.threshold}/${s.owners.length}`, nonce: s.nonce, v: s.version })
}
rows.sort((a, b) => b.nonce - a.nonce)
console.log('\ncandidates (owners>=3, nonce>=25):')
for (const r of rows.slice(0, 12)) console.log(`  ${r.addr}  ${r.t.padEnd(6)} nonce=${String(r.nonce).padEnd(5)} v${r.v}`)
