/**
 * One protection tick against ChallengeLending, with the transport injected.
 *
 * The same function runs in three places:
 *   - inside the enclave, where the transport is the CRE HTTP capability
 *   - from a laptop, where the transport is fetch (`npm run challenge -- tick`)
 *   - in the tests, where the transport is an in-memory model of the contract
 *
 * That is deliberate. The execution path that will defend the position during the organisers'
 * scenario run is the one exercised offline, not a copy of it.
 *
 * Nothing that identifies the rules leaves this module through the log. Amounts and health
 * factors do, because the transaction publishes them anyway.
 */
import {
	decodeFunctionResult,
	encodeFunctionData,
	keccak256,
	pad,
	parseAbi,
	toHex,
	type Address,
	type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { decide, healthFactor, type Balances, type Governance, type Plan, type Position, type Rules } from './strategy'

export const LENDING_ABI = parseAbi([
	'function challengeOpen() view returns (bool)',
	'function scenarioStartTime() view returns (uint256)',
	'function scenarioEndTime() view returns (uint256)',
	'function vETHPrice() view returns (uint256)',
	'function isUser(address user) view returns (bool)',
	'function getUserPosition(address user) view returns ((uint256 collateral, uint256 debt, uint256 hf, uint256 numOperations, uint256 lastUpdateTime, uint256 cumulativeDebtTime))',
	'function deposit(uint256 amount)',
	'function repay(uint256 amount)',
	'function join()',
])

export const ERC20_ABI = parseAbi([
	'function balanceOf(address account) view returns (uint256)',
	'function allowance(address owner, address spender) view returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)',
])

export const DEPOSIT_TOPIC = keccak256(toHex('Deposit(address,uint256)'))
export const REPAY_TOPIC = keccak256(toHex('Repay(address,uint256)'))
export const MAX_UINT256 = (1n << 256n) - 1n

const GAS = { approve: 80_000n, deposit: 160_000n, repay: 160_000n }

export type Transport = (method: string, params: unknown[]) => Promise<unknown> | unknown
export type FetchResult = { ok: boolean; status: number; body: string }
export type Fetcher = (url: string, headers: Record<string, string>) => Promise<FetchResult> | FetchResult

export type EngineConfig = {
	chainId: number
	lendingAddress: Address
	vethAddress: Address
	vusdAddress: Address
	rollcallApiUrl: string
	/** The Safe whose control surface stands in for the market's governance. Public. */
	market: string
}

export type TickInput = {
	transport: Transport
	fetcher: Fetcher
	config: EngineConfig
	privateKey: Hex
	rules: Rules
	apiKey?: string
	/** False runs everything except the transactions. */
	send: boolean
	log?: (line: string) => void
}

export type TickState = 'not-joined' | 'not-active' | 'held' | 'cooldown' | 'no-reserve' | 'protected' | 'unwound'

export type TickResult = {
	address: Address
	state: TickState
	challengeOpen: boolean
	active: boolean
	price: bigint
	position: Position
	balances: Balances
	hf: bigint
	governance: Governance | null
	governanceError: string | null
	recentAction: boolean
	plan: Plan | null
	txHashes: string[]
}

const hex = (v: unknown): bigint => BigInt(String(v ?? '0x0'))

/** Reads the honest quorum, dark signer count and reachability out of a Roll Call report. */
export function readGovernance(body: string): Governance {
	const parsed = JSON.parse(body)
	const report = parsed.report ?? parsed
	const curve: { effectiveQuorum: number }[] = report.inferred.quorumCurve
	return {
		honestQuorum: Math.min(...curve.map((c) => c.effectiveQuorum)),
		darkSigners: report.reachability.darkSigners,
		canReachQuorum: report.reachability.canStillReachThreshold,
	}
}

export async function tick(input: TickInput): Promise<TickResult> {
	const { transport, fetcher, config, rules } = input
	const log = input.log ?? (() => {})
	const account = privateKeyToAccount(input.privateKey)
	const me = account.address

	const call = async <T>(to: Address, abi: any, functionName: string, args: unknown[] = []): Promise<T> => {
		const data = encodeFunctionData({ abi, functionName, args } as any)
		const result = (await transport('eth_call', [{ to, data }, 'latest'])) as Hex
		return decodeFunctionResult({ abi, functionName, data: result } as any) as T
	}

	// --- chain state -------------------------------------------------------------------------
	const challengeOpen = await call<boolean>(config.lendingAddress, LENDING_ABI, 'challengeOpen')
	const startTime = await call<bigint>(config.lendingAddress, LENDING_ABI, 'scenarioStartTime')
	const endTime = await call<bigint>(config.lendingAddress, LENDING_ABI, 'scenarioEndTime')
	const price = await call<bigint>(config.lendingAddress, LENDING_ABI, 'vETHPrice')
	const joined = await call<boolean>(config.lendingAddress, LENDING_ABI, 'isUser', [me])
	const raw = await call<any>(config.lendingAddress, LENDING_ABI, 'getUserPosition', [me])
	const position: Position = { collateral: BigInt(raw.collateral ?? raw[0]), debt: BigInt(raw.debt ?? raw[1]) }
	const balances: Balances = {
		veth: await call<bigint>(config.vethAddress, ERC20_ABI, 'balanceOf', [me]),
		vusd: await call<bigint>(config.vusdAddress, ERC20_ABI, 'balanceOf', [me]),
	}
	const active = challengeOpen && startTime > 0n && endTime === 0n
	const hf = healthFactor(position, price)

	const base = {
		address: me,
		challengeOpen,
		active,
		price,
		position,
		balances,
		hf,
		governance: null as Governance | null,
		governanceError: null as string | null,
		recentAction: false,
		plan: null as Plan | null,
		txHashes: [] as string[],
	}

	if (!joined) {
		log(`not joined as ${me}`)
		return { ...base, state: 'not-joined' }
	}

	// --- governance leg: the trigger nobody else has ------------------------------------------
	// Fails safe. A report that cannot be fetched is treated as no signal, never as a breach.
	let governance: Governance | null = null
	let governanceError: string | null = null
	try {
		const headers: Record<string, string> = {}
		if (input.apiKey) headers['Authorization'] = `Bearer ${input.apiKey}`
		const res = await fetcher(`${config.rollcallApiUrl}/report/ethereum/${config.market}?max=100&perms=2000`, headers)
		if (res.ok) governance = readGovernance(res.body)
		else governanceError = `status ${res.status}`
	} catch (e: any) {
		governanceError = e?.message ?? 'unreachable'
	}

	// --- cooldown: on-chain evidence of a recent action, so the tick stays stateless -----------
	// Fails open. If the lookup breaks, protecting the position outranks intervention discipline.
	let recentAction = false
	try {
		if (rules.cooldownBlocks > 0) {
			const latest = hex(await transport('eth_blockNumber', []))
			const from = latest > BigInt(rules.cooldownBlocks) ? latest - BigInt(rules.cooldownBlocks) : 0n
			const logs = (await transport('eth_getLogs', [
				{
					fromBlock: toHex(from),
					toBlock: 'latest',
					address: config.lendingAddress,
					topics: [[DEPOSIT_TOPIC, REPAY_TOPIC], pad(me.toLowerCase() as Hex, { size: 32 })],
				},
			])) as unknown[]
			recentAction = Array.isArray(logs) && logs.length > 0
		}
	} catch {
		recentAction = false
	}

	const plan = decide(position, price, balances, governance, rules, recentAction)
	const decided = { ...base, governance, governanceError, recentAction, plan }

	log(`price=${price} hf=${hf} action=${plan.action} deposit=${plan.deposit} repay=${plan.repay}`)

	if (plan.action === 'HOLD') return { ...decided, state: 'held' }
	if (plan.action === 'COOLDOWN') return { ...decided, state: 'cooldown' }
	if (plan.action === 'NO_RESERVE') return { ...decided, state: 'no-reserve' }
	if (!active) {
		log(`scenario not active, no transaction sent`)
		return { ...decided, state: 'not-active' }
	}
	if (!input.send) return { ...decided, state: plan.action === 'UNWIND' ? 'unwound' : 'protected' }

	// --- execution: approve if needed, then act. Legacy transactions, like the reference. --------
	let nonce = Number(hex(await transport('eth_getTransactionCount', [me, 'latest'])))
	const gasPrice = hex(await transport('eth_gasPrice', []))
	const txHashes: string[] = []

	const send = async (to: Address, data: Hex, gas: bigint): Promise<string> => {
		const signed = await account.signTransaction({ type: 'legacy', chainId: config.chainId, to, data, gas, gasPrice, nonce, value: 0n })
		nonce += 1
		const hash = (await transport('eth_sendRawTransaction', [signed])) as string
		txHashes.push(hash)
		return hash
	}

	const ensureAllowance = async (token: Address, amount: bigint) => {
		const allowance = await call<bigint>(token, ERC20_ABI, 'allowance', [me, config.lendingAddress])
		if (allowance >= amount) return
		const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [config.lendingAddress, MAX_UINT256] })
		log(`approve ${token} -> ${await send(token, data, GAS.approve)}`)
	}

	if (plan.deposit > 0n) {
		await ensureAllowance(config.vethAddress, plan.deposit)
		const data = encodeFunctionData({ abi: LENDING_ABI, functionName: 'deposit', args: [plan.deposit] })
		log(`deposit ${plan.deposit} -> ${await send(config.lendingAddress, data, GAS.deposit)}`)
	}
	if (plan.repay > 0n) {
		await ensureAllowance(config.vusdAddress, plan.repay)
		const data = encodeFunctionData({ abi: LENDING_ABI, functionName: 'repay', args: [plan.repay] })
		log(`repay ${plan.repay} -> ${await send(config.lendingAddress, data, GAS.repay)}`)
	}

	return { ...decided, txHashes, state: plan.action === 'UNWIND' ? 'unwound' : 'protected' }
}
