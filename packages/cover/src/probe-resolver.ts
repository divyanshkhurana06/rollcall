import 'dotenv/config'
import { createPublicClient, http, parseAbi } from 'viem'

const RESOLVER = '0x2463a7603c43e99d5aefdca9fba752751caf7b56' as const
const rpc = process.env.HEDERA_RPC ?? 'https://testnet.hashio.io/api'

const client = createPublicClient({ transport: http(rpc) })
const abi = parseAbi([
  'function getConfigurationsLength() view returns (uint256)',
  'function getConfigurations(uint256 pageIndex, uint256 pageLength) view returns (bytes32[])',
  'function getLatestVersionByConfiguration(bytes32 configurationId) view returns (uint256)',
])

const len = await client.readContract({ address: RESOLVER, abi, functionName: 'getConfigurationsLength' })
console.log('configurations registered on the ATS resolver:', len.toString())

const ids = await client.readContract({ address: RESOLVER, abi, functionName: 'getConfigurations', args: [0n, 20n] })
for (const id of ids as readonly `0x${string}`[]) {
  let v = '?'
  try {
    v = (await client.readContract({ address: RESOLVER, abi, functionName: 'getLatestVersionByConfiguration', args: [id] })).toString()
  } catch {}
  console.log(`  ${id}  latestVersion=${v}`)
}
