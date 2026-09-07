import 'dotenv/config'
import { proveParticipation } from '../src/extract/participation.js'
import { client } from '../src/chain.js'

const safe = process.argv[2] ?? '0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5'
const p = await proveParticipation('ethereum', safe, { max: 6 })
if (!p) { console.log('not a Safe'); process.exit(1) }

// Nonces so we can say which approvers are invisible to explorers.
const c = client('ethereum')
const nonces = new Map<string, number>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
for (const o of p.owners) {
  for (let i = 0; i < 5; i++) {
    try { nonces.set(o.toLowerCase(), await c.getTransactionCount({ address: o as `0x${string}` })); break }
    catch { await sleep(600 * (i + 1)) }
  }
  await sleep(150)
}

console.log(`\nSafe ${p.safe}  ${p.threshold} of ${p.owners.length}\n`)
for (const r of p.rows) {
  console.log(`tx ${r.txHash.slice(0, 18)}...  ${new Date(r.timestamp * 1000).toISOString().slice(0, 16)}`)
  console.log(`  gas paid by      ${r.executor}`)
  console.log(`  approved by (recovered from the signature blob):`)
  for (const a of r.approvers) {
    const n = nonces.get(a.signer.toLowerCase()) ?? -1
    console.log(`    ${a.signer}  ${a.kind.padEnd(14)} nonce=${n}${n === 0 ? '  <- never sent a transaction, invisible to explorers' : ''}`)
  }
  if (r.serviceApprovers) console.log(`  cross-check      ${r.agreement} vs Safe Transaction Service`)
  console.log()
}
const s = p.summary
console.log(`recovered ${s.signerSlotsRecovered} approvals across ${s.transactionsRecovered} transactions`)
console.log(`cross-checked ${s.crossChecked}, exact set match ${s.exactSetMatches}, agreement ${(s.agreementRate * 100).toFixed(1)}%, unresolved ${s.unresolvedWords}`)
console.log(`approvers invisible to explorers: ${s.invisibleApprovers.length}`)
