import 'dotenv/config'
import { resolveControlSurface } from '../src/extract/authority.js'

/** Real, recognisable protocol contracts. Public addresses, verifiable on any explorer. */
const TARGETS: [string, string][] = [
  ['Aave v3 Pool',            '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'],
  ['Aave v3 PoolAddressesProvider', '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e'],
  ['Lido stETH',              '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'],
  ['Lido Withdrawal Queue',   '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1'],
  ['ENS Registry',            '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'],
  ['Uniswap v3 Factory',      '0x1F98431c8aD98523631AE4a59f267346ea31F984'],
  ['Compound v3 USDC',        '0xc3d688B66703497DAA19211EEdff47f25384cdc3'],
  ['Rocket Pool Storage',     '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'],
  ['Arbitrum Bridge',         '0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a'],
  ['Optimism Portal',         '0xbEb5Fc579115071764c7423A4f12eDde41f106Ed'],
]

for (const [name, addr] of TARGETS) {
  const cs = await resolveControlSurface('ethereum', addr)
  const held = cs.holders.map((h) => `${h.kind}${h.isSafe ? ` SAFE ${h.threshold}/${h.owners}` : ''}`).join(', ')
  console.log(`${name.padEnd(32)} ${cs.safes.length ? 'SAFE FOUND' : '-'.padEnd(10)}  ${held || 'none'}`)
  for (const s of cs.safes) console.log(`  ${' '.repeat(32)} -> ${s}`)
}
