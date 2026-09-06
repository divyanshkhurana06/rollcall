import 'dotenv/config'
import { largestAccounts, accountExposure, STANDARDIZED } from '../src/exposure.js'
import { fetchSafe } from '../src/extract/safeapi.js'

console.log(`querying ${STANDARDIZED.length} standardized deployments with one query shape\n`)
const top = await largestAccounts(50)
console.log(`${top.length} distinct large accounts across ${STANDARDIZED.map(s => s.label).join(', ')}\n`)

let found = 0
for (const a of top.slice(0, 60)) {
  const safe = await fetchSafe('ethereum', a.address)
  if (!safe) continue
  found++
  console.log(`  SAFE ${safe.address}  ${safe.threshold}/${safe.owners.length}  nonce=${safe.nonce}  openPositions=${a.openPositions}  [${a.protocols.join(', ')}]`)
  if (found >= 8) break
}
console.log(`\n${found} of the largest DeFi accounts are Safes`)

if (found) {
  const e = await accountExposure(top.find(async () => true)!.address)
  if (e) console.log(`\nexposure query shape verified across ${e.queriedProtocols} protocols`)
}
