import 'dotenv/config'
import { createPublicClient, http, toFunctionSelector } from 'viem'

/**
 * Which deployBond does the deployed factory actually implement?
 *
 * Simulating every layout tells you which one is rejected, not why. The bytecode settles it: a
 * function selector either appears in the implementation's dispatch table or it does not.
 */
const pub = createPublicClient({ transport: http(process.env.HEDERA_RPC ?? 'https://testnet.hashio.io/api') })
const FACTORY = '0xc4028832d0b086e52a8771c39da08529fd3e0d3c' as const
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as const

const raw = await pub.getStorageAt({ address: FACTORY, slot: IMPL_SLOT })
const impl = raw && raw !== `0x${'0'.repeat(64)}` ? (`0x${raw.slice(-40)}` as `0x${string}`) : null
const adminRaw = await pub.getStorageAt({ address: FACTORY, slot: ADMIN_SLOT })
console.log('factory implementation:', impl ?? '(no EIP-1967 slot; not a transparent proxy)')
console.log('factory admin        :', adminRaw && adminRaw !== `0x${'0'.repeat(64)}` ? `0x${adminRaw.slice(-40)}` : '(none)')

const target = impl ?? FACTORY
const code = await pub.getCode({ address: target })
console.log('bytecode length      :', code?.length ?? 0)

const SIGS: Record<string, string> = {
  'v1 (1.15.x)': 'deployBond(((bool,bool,address,(bytes32,uint256),(bytes32,address[])[],bool,bool,uint256,(string,string,string,uint8),bool,bool,address[],address[],address[],address,address),(bytes3,uint256,uint256,uint256),(uint256,uint256,uint256)),(uint8,uint8,(bool,string,string)))',
  'v7 (2.0-7.0)': 'deployBond(((bool,bool,address,(bytes32,uint256),(bytes32,address[])[],bool,bool,uint256,(string,string,string,uint8),bool,bool,address[],address[],address[],bool,address,address),(bytes3,uint256,uint8,uint256,uint256),address[],bytes[]),(uint8,uint8,(bool,string,string)))',
  'v8 (8.0.0)': 'deployBond(((address,uint256,(bytes32,uint256),(string,string,string,uint8),(bytes32,address[])[],address[],address[],address[],address,address,bool,bool,bool,bool,bool,bool,bool),(bytes3,uint256,uint8,uint256,uint256),address[],bytes[]),(uint8,uint8,(bool,string,string)))',
  'getAppliedRegulationData (control)': 'getAppliedRegulationData(uint8,uint8)',
  'deployEquity v7 shape': 'deployEquity(((bool,bool,address,(bytes32,uint256),(bytes32,address[])[],bool,bool,uint256,(string,string,string,uint8),bool,bool,address[],address[],address[],bool,address,address),(bool,bool,bool,bool,bool,bool,bytes3,uint256,uint8)),(uint8,uint8,(bool,string,string)))',
}

console.log('\nselector present in bytecode:')
for (const [name, sig] of Object.entries(SIGS)) {
  const sel = toFunctionSelector(sig)
  const present = Boolean(code?.includes(sel.slice(2)))
  console.log(`  ${present ? 'YES' : ' no'}  ${name.padEnd(36)} ${sel}`)
}

// If none match, list every 4-byte-looking selector near a dispatch pattern for manual comparison.
if (code) {
  const hex = code.slice(2)
  const found = new Set<string>()
  // PUSH4 opcode is 0x63; a dispatch table is a run of PUSH4 <selector> comparisons.
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === '63') found.add('0x' + hex.slice(i + 2, i + 10))
  }
  console.log(`\n${found.size} PUSH4 selectors in the implementation. First 24:`)
  console.log('  ' + [...found].slice(0, 24).join(' '))
}
