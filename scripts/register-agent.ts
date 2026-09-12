import 'dotenv/config'
import { config as loadEnv } from 'dotenv'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Registers Roll Call as an ERC-8004 agent, so other agents can find it through the Identity
 * Registry rather than through a human. Two registrations: Hedera testnet, which is where the
 * service settles, and Ethereum Sepolia, which the Agent0 subgraphs index, so the identity can be
 * read back through The Graph.
 *
 *   npm run agent:register -- https://rollcall.example
 *
 * The registration file travels inline as a data: URI, which is what most registrations on these
 * registries do; nothing has to be hosted for the identity to resolve.
 */

loadEnv({ path: 'cre/.env', quiet: true })

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', x: '\x1b[0m' }
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address
const ABI = parseAbi(['function register(string agentURI) returns (uint256)', 'function tokenURI(uint256 tokenId) view returns (string)'])
const publicUrl = (process.argv[2] ?? process.env.ROLLCALL_PUBLIC_URL ?? '').replace(/\/$/, '')
if (!publicUrl) {
  console.error(`${C.r}usage: npm run agent:register -- https://public-api-url${C.x}`)
  process.exit(1)
}

const card = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Roll Call',
  description:
    'Control surface reports for protocol multisigs: who can take everything, how fast, and whether they are still awake. Honest quorum, dark signers, time to harm and value at risk, every number tiered as observed, tested or inferred. Paid per request over x402 on Hedera, or with prepaid credits.',
  image: `${publicUrl}/favicon.svg`,
  active: true,
  x402Support: true,
  supportedTrust: ['reputation'],
  services: [
    { name: 'x402 API', endpoint: `${publicUrl}/api`, description: 'GET /report/{chain}/{address}, priced by work, settled on hedera:testnet' },
    { name: 'discovery', endpoint: `${publicUrl}/api/.well-known/x402`, description: 'every resource, its price, the network, the audit trail' },
    { name: 'MCP', endpoint: 'stdio: npm run mcp', description: 'who_controls, signer_liveness, independence_test, effective_quorum, method_calibration' },
  ],
  source: 'https://github.com/divyanshkhurana06/rollcall',
}
const agentURI = `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString('base64')}`

type Chain = { key: string; caip: string; chainId: number; rpc: string; privateKey: Hex; explorer: (h: string) => string; agentExplorer: (id: string) => string }
const chains: Chain[] = [
  {
    key: 'hedera-testnet',
    caip: 'eip155:296',
    chainId: 296,
    rpc: 'https://testnet.hashio.io/api',
    privateKey: process.env.HEDERA_PRIVATE_KEY as Hex,
    explorer: (h) => `https://hashscan.io/testnet/transaction/${h}`,
    agentExplorer: (id) => `https://hashscan.io/testnet/contract/${REGISTRY}`,
  },
  {
    key: 'sepolia',
    caip: 'eip155:11155111',
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    privateKey: process.env.SECRET_CHALLENGE_PRIVATE_KEY as Hex,
    explorer: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    agentExplorer: (id) => `https://sepolia.etherscan.io/token/${REGISTRY}?a=${id}`,
  },
]

const rpcCall = async (url: string, method: string, params: unknown[]) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const json: any = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`)
  return json.result
}

const out = existsSync('data/agent-identity.json') ? JSON.parse(readFileSync('data/agent-identity.json', 'utf8')) : { registry: REGISTRY, registrations: {} }

console.log(`\n${C.b}ERC-8004 REGISTRATION${C.x}  ${C.d}registry ${REGISTRY}${C.x}`)
for (const c of chains) {
  if (!c.privateKey) {
    console.log(`  ${c.key.padEnd(15)} ${C.y}skipped, no key${C.x}`)
    continue
  }
  if (out.registrations[c.key]?.agentId) {
    console.log(`  ${c.key.padEnd(15)} already registered as agent ${out.registrations[c.key].agentId}`)
    continue
  }
  const account = privateKeyToAccount(c.privateKey)
  const data = encodeFunctionData({ abi: ABI, functionName: 'register', args: [agentURI] })
  const sim = (await rpcCall(c.rpc, 'eth_call', [{ from: account.address, to: REGISTRY, data }, 'latest'])) as Hex
  const agentId = decodeFunctionResult({ abi: ABI, functionName: 'register', data: sim }) as bigint
  const nonce = Number(BigInt(await rpcCall(c.rpc, 'eth_getTransactionCount', [account.address, 'pending'])))
  const gas = BigInt(await rpcCall(c.rpc, 'eth_estimateGas', [{ from: account.address, to: REGISTRY, data }]))
  const block: any = await rpcCall(c.rpc, 'eth_getBlockByNumber', ['latest', false])
  const base = BigInt(block?.baseFeePerGas ?? (await rpcCall(c.rpc, 'eth_gasPrice', [])))
  const tip = c.chainId === 296 ? 0n : 1_000_000_000n
  const signed = await account.signTransaction({ type: 'eip1559', chainId: c.chainId, to: REGISTRY, data, gas: (gas * 13n) / 10n, nonce, value: 0n, maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip })
  const hash = (await rpcCall(c.rpc, 'eth_sendRawTransaction', [signed])) as string
  let receipt: any = null
  for (let i = 0; i < 40 && !receipt; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    receipt = await rpcCall(c.rpc, 'eth_getTransactionReceipt', [hash])
  }
  if (!receipt || receipt.status !== '0x1') throw new Error(`${c.key}: registration failed ${c.explorer(hash)}`)
  out.registrations[c.key] = { caip: c.caip, chainId: c.chainId, agentId: agentId.toString(), owner: account.address, tx: hash, explorer: c.explorer(hash), registeredAt: Math.floor(Date.now() / 1000) }
  console.log(`  ${c.key.padEnd(15)} ${C.g}agent ${agentId}${C.x}  ${C.d}${c.explorer(hash)}${C.x}`)
}
out.card = card
out.agentURI = agentURI
mkdirSync('data', { recursive: true })
writeFileSync('data/agent-identity.json', JSON.stringify(out, null, 2))
console.log(`\n${C.d}written to data/agent-identity.json; served at /.well-known/x402 under "identity"${C.x}\n`)
