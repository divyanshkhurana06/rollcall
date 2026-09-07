import 'dotenv/config'
import { scanProtocols, saveProtocolScan } from './protocolScan.js'

const C = { d: '\x1b[2m', b: '\x1b[1m', y: '\x1b[33m', r: '\x1b[31m', g: '\x1b[32m', c: '\x1b[36m', x: '\x1b[0m' }
const usd = (n: number) => n >= 1e9 ? `$${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n/1e6).toFixed(0)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(0)}K` : `$${n.toFixed(0)}`

const scan = await scanProtocols({ onProgress: (m) => console.log(`${C.d}  ${m}${C.x}`) })
saveProtocolScan(scan)

console.log(`\n${C.b}CONTROL SURFACES OF PROTOCOLS YOU HAVE HEARD OF${C.x}`)
console.log(`${C.d}${'-'.repeat(104)}${C.x}`)
console.log(`${C.d}  protocol         role                    value      declared  honest  dark  margin  hidden${C.x}`)
for (const r of scan.rows.filter((x) => x.status === 'measured')) {
  const frozen = r.marginToFrozen !== null && r.marginToFrozen <= 0
  console.log(
    `  ${r.protocol.padEnd(16)} ${r.role.slice(0,22).padEnd(23)} ${usd(r.valueUsd).padEnd(10)} ` +
    `${String(`${r.threshold}/${r.owners}`).padEnd(9)} ${String(r.honestQuorum).padEnd(7)} ` +
    `${String(r.darkSigners).padEnd(5)} ${frozen ? C.r + String(r.marginToFrozen).padEnd(7) + C.x : String(r.marginToFrozen).padEnd(7)} ${r.invisibleSigners}`,
  )
}
const noSafe = scan.rows.filter((x) => x.status === 'no-safe')
if (noSafe.length) {
  console.log(`\n${C.d}  no Safe in the authority path (timelock, DAO or EOA):${C.x}`)
  for (const r of noSafe) console.log(`${C.d}    ${r.protocol} ${r.role} - ${usd(r.valueUsd)} via ${r.authorityPath}${C.x}`)
}
console.log(`\n${C.b}HEADLINE${C.x}`)
console.log(`  ${usd(scan.totalValueUsd)} across ${scan.scanned} contracts, ${scan.measured} with a Safe in the authority path`)
if (scan.valueOneKeyFromFrozen > 0) console.log(`  ${C.r}${usd(scan.valueOneKeyFromFrozen)}${C.x} sits behind a Safe with zero margin: one lost key and it can never be upgraded again`)
if (scan.valueBehindWeakQuorum > 0) console.log(`  ${C.y}${usd(scan.valueBehindWeakQuorum)}${C.x} sits behind a Safe whose honest quorum is below its declared threshold`)
console.log(`${C.d}\n  written to data/protocol-scan.json${C.x}`)
