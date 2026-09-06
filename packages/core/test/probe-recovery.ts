/**
 * Kill the load-bearing risk first.
 * If we cannot recover approvers from real Safe signature blobs, Roll Call does not exist.
 */
import { client, windowedLogs } from '../src/chain.js'
import { TOPICS } from '../src/abi.js'
import { readSafeState, fetchExecutions } from '../src/extract/safe.js'

const c = client('ethereum')
const head = await c.getBlockNumber()
console.log('head block:', head)

// Find real, active Safes by scanning for ExecutionSuccess with no address filter.
const logs = await windowedLogs('ethereum', { topics: [TOPICS.ExecutionSuccess], fromBlock: head - 900n, toBlock: head }, { window: 400n, max: 60 })
const safes = [...new Set(logs.map((l) => l.address))]
console.log(`found ${logs.length} executions across ${safes.length} distinct Safes in last 900 blocks`)

let proven = 0
for (const addr of safes.slice(0, 6)) {
  const state = await readSafeState('ethereum', addr as `0x${string}`)
  if (!state) { console.log(`  ${addr}  not a readable Safe`); continue }
  const execs = await fetchExecutions('ethereum', state, { lookbackBlocks: 300_000n, max: 6 })
  if (!execs.length) { console.log(`  ${addr}  ${state.threshold}/${state.owners.length}  no executions in window`); continue }

  const ownerSet = new Set(state.owners.map((o) => o.toLowerCase()))
  let matched = 0, total = 0
  for (const e of execs) {
    for (const a of e.approvers) { total++; if (ownerSet.has(a.signer.toLowerCase())) matched++ }
  }
  const pct = total ? Math.round((matched / total) * 100) : 0
  if (pct >= 80) proven++
  console.log(`  ${addr}  ${state.threshold}/${state.owners.length}  v${state.version ?? '?'}  execs=${execs.length}  recovered=${total}  matched-current-owners=${matched} (${pct}%)`)
  console.log(`     kinds: ${JSON.stringify(execs.flatMap(e=>e.approvers).reduce((m:any,a)=>{m[a.kind]=(m[a.kind]||0)+1;return m},{}))}`)
}
console.log(`\nVERDICT: recovery validated on ${proven} Safe(s)`)
