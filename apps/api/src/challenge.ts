import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { OFFICIAL_SCENARIOS, START, fmtHf, fmtUnits, worstCase } from '../../../cre/liquidation-protection/scenarios.js'
import { decide, healthFactor, parseRules, type Governance } from '../../../cre/liquidation-protection/strategy.js'
import { readArchive } from './hcs.js'

/**
 * The Chainlink challenge, readable from a browser.
 *
 * Live state of ChallengeLending on Sepolia and of our position, the five published scenarios walked
 * with the example rules, and what the workflow would do right now. The rules the enclave actually
 * runs with are a secret; everything here uses the example set from cre/.env.example and says so.
 */

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const LENDING = (process.env.CHALLENGE_LENDING ?? '0x88574e7Cc0027afd04951daa09B64d4441931ba1') as Address
const VETH = (process.env.CHALLENGE_VETH ?? '0x5dED1a40c3D56dA42E7f932f781c0432556c9814') as Address
const VUSD = (process.env.CHALLENGE_VUSD ?? '0x6Fe92Ead5299040f50F095860b5A0A7A2D4041A2') as Address
const POSITION = (process.env.CHALLENGE_ADDRESS ?? '0x6c4c6AF01F3Ce02802119407b085EC7475A098E7') as Address
const MARKET = process.env.CHALLENGE_MARKET ?? '0x4426f7eAA169aa9B84E665CA0f28B75EC24c1ca2'
const EXAMPLE_RULES = '{"triggerHf":112,"targetHf":125,"criticalHf":102,"maxDepositUnits":300,"maxRepayPct":20,"preferDeposit":true,"cooldownBlocks":10,"minHonestQuorum":2,"maxDarkSigners":2}'

const abi = parseAbi([
  'function challengeOpen() view returns (bool)',
  'function scenarioStartTime() view returns (uint256)',
  'function scenarioEndTime() view returns (uint256)',
  'function vETHPrice() view returns (uint256)',
  'function numUsers() view returns (uint256)',
  'function isUser(address user) view returns (bool)',
  'function getUserPosition(address user) view returns ((uint256 collateral, uint256 debt, uint256 hf, uint256 numOperations, uint256 lastUpdateTime, uint256 cumulativeDebtTime))',
  'function balanceOf(address account) view returns (uint256)',
])

async function call<T>(to: Address, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as any)
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })
  const json: any = await res.json()
  if (json.error) throw new Error(json.error.message ?? 'rpc error')
  return decodeFunctionResult({ abi, functionName, data: json.result as Hex } as any) as T
}

const str = (v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export async function challengeSnapshot() {
  const rules = parseRules(EXAMPLE_RULES)
  const [open, start, end, price, users, joined, raw, veth, vusd] = await Promise.all([
    call<boolean>(LENDING, 'challengeOpen'),
    call<bigint>(LENDING, 'scenarioStartTime'),
    call<bigint>(LENDING, 'scenarioEndTime'),
    call<bigint>(LENDING, 'vETHPrice'),
    call<bigint>(LENDING, 'numUsers'),
    call<boolean>(LENDING, 'isUser', [POSITION]),
    call<any>(LENDING, 'getUserPosition', [POSITION]),
    call<bigint>(VETH, 'balanceOf', [POSITION]),
    call<bigint>(VUSD, 'balanceOf', [POSITION]),
  ])
  const position = { collateral: BigInt(raw.collateral ?? raw[0]), debt: BigInt(raw.debt ?? raw[1]) }
  const hf = healthFactor(position, price)

  // The governance signal, from the attestation archive, no credit spent.
  let governance: Governance | null = null
  let governanceAt: number | null = null
  try {
    const archive = await readArchive(MARKET, 10)
    const latest = (archive.messages as any[]).filter((m) => m?.metrics && typeof m.at === 'number').sort((a, b) => b.at - a.at)[0]
    if (latest) {
      governance = { honestQuorum: latest.metrics.effectiveQuorumMin, darkSigners: latest.metrics.darkSigners, canReachQuorum: latest.metrics.canReachThreshold }
      governanceAt = latest.at
    }
  } catch {
    governance = null
  }

  const plan = joined ? decide(position, price, { veth, vusd }, governance, rules, false) : null
  const healthy: Governance = { honestQuorum: 3, darkSigners: 0, canReachQuorum: true }
  const scenarios = OFFICIAL_SCENARIOS.map((s) => {
    const bare = worstCase(s.prices, null)
    const prot = worstCase(s.prices, rules, healthy)
    return {
      name: s.name, prices: s.prices, expected: s.expected,
      unprotected: { survived: bare.survived, minHf: fmtHf(bare.minHf) },
      protected: { survived: prot.survived, minHf: fmtHf(prot.minHf), interventions: prot.interventions, vethUsed: fmtUnits(prot.vethUsed), vusdUsed: fmtUnits(prot.vusdUsed), loanOpenPct: prot.continuityBp / 100 },
    }
  })
  const flat = [2000, 2000, 2000, 2000]
  const governanceDemo = {
    healthy: (() => { const o = worstCase(flat, rules, healthy); return { interventions: o.interventions, vusdRepaid: fmtUnits(o.vusdUsed), loanOpenPct: o.continuityBp / 100 } })(),
    degraded: (() => { const o = worstCase(flat, rules, { honestQuorum: 1, darkSigners: 4, canReachQuorum: false }); return { interventions: o.interventions, vusdRepaid: fmtUnits(o.vusdUsed), loanOpenPct: o.continuityBp / 100 } })(),
  }

  return {
    contract: LENDING,
    explorer: `https://sepolia.etherscan.io/address/${LENDING}`,
    registrationOpen: open,
    scenario: start === 0n ? 'not started' : end === 0n ? 'running' : 'stopped',
    participants: Number(users),
    vethPrice: fmtUnits(price),
    position: {
      address: POSITION,
      joined,
      collateral: fmtUnits(position.collateral),
      debt: fmtUnits(position.debt),
      hf: fmtHf(hf),
      wallet: { veth: fmtUnits(veth), vusd: fmtUnits(vusd) },
      explorer: `https://sepolia.etherscan.io/address/${POSITION}`,
    },
    governance: governance ? { ...governance, market: MARKET, attestedAt: governanceAt } : null,
    wouldDo: plan ? { action: plan.action, deposit: fmtUnits(plan.deposit), repay: fmtUnits(plan.repay), hfAfter: fmtHf(plan.hfAfter), sendsNow: open && start > 0n && end === 0n } : null,
    rules: 'example set from cre/.env.example; the enclave runs a private one',
    start: { collateral: fmtUnits(START.collateral), debt: fmtUnits(START.debt), walletVeth: fmtUnits(START.walletVeth), walletVusd: fmtUnits(START.walletVusd) },
    scenarios,
    governanceDemo,
    evidence: { simulation: 'cre/SIMULATION-RUN.txt', rootCause: 'cre/SIMULATION.md', tests: 50 },
  }
}

export const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => str(x)))
