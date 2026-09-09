import { toFunctionSelector } from 'viem'

/**
 * Which published version does the deployed factory implement?
 *
 * The implementation's dispatch table gave us 14 unresolved selectors. Computing the deployBond
 * selector for every published version and matching against that set identifies the deployed
 * version exactly, rather than by simulation and elimination.
 */
const UNKNOWN = new Set([
  '0x50d71072', '0x8f3af183', '0x507e68fd', '0x7fbdf37a', '0x7b1df196', '0x65fa0b29', '0x70d162dc',
  '0xc047bb6c', '0x57620012', '0x620016cf', '0x62cacc95', '0x8d39a792', '0x0a82dd73', '0x05cf6131',
])

const VERSIONS = ['1.14.2','1.14.3','1.15.0','1.15.1','1.15.2','1.17.0','2.0.0','3.1.0','4.1.1','4.2.0','5.0.0','6.0.0','7.0.0','8.0.0']
const PATHS = [
  'artifacts/contracts/factory/IFactory.sol/IFactory.json',
  'artifacts/contracts/interfaces/factory/IFactory.sol/IFactory.json',
  'artifacts/contracts/factory/Factory.sol/Factory.json',
]

const sig = (cs: any[]): string =>
  '(' + cs.map((c) => (c.components ? sig(c.components) : c.type)).join(',') + ')'

const hits: { v: string; sel: string; s: string; fn: string }[] = []

for (const v of VERSIONS) {
  let abi: any[] | null = null
  for (const p of PATHS) {
    try {
      const r = await fetch(`https://unpkg.com/@hashgraph/asset-tokenization-contracts@${v}/${p}`)
      if (!r.ok) continue
      abi = (await r.json() as any).abi
      if (abi?.some((e) => e.name === 'deployBond')) break
      abi = null
    } catch { /* next path */ }
  }
  if (!abi) { console.log(`  ${v.padEnd(8)} (no artifact)`); continue }

  const line: string[] = []
  for (const fnName of ['deployBond', 'deployEquity']) {
    const fn = abi.find((e) => e.name === fnName)
    if (!fn) continue
    const s = `${fnName}(${fn.inputs.map((i: any) => (i.components ? sig(i.components) : i.type)).join(',')})`
    const sel = toFunctionSelector(s)
    const match = UNKNOWN.has(sel)
    if (match) hits.push({ v, sel, s, fn: fnName })
    line.push(`${fnName}=${sel}${match ? ' MATCH' : ''}`)
  }
  console.log(`  ${v.padEnd(8)} ${line.join('  ')}`)
}

console.log()
if (hits.length) {
  console.log('MATCHED the deployed factory:')
  for (const h of hits) console.log(`  version ${h.v}  ${h.fn} ${h.sel}\n    ${h.s.slice(0, 260)}\n`)
} else {
  console.log('No published version produces a selector present in the deployed factory.')
  console.log('The deployed implementation predates the published packages, or was built from an unreleased branch.')
}
