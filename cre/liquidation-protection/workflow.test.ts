import { describe, expect, it } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, parseTransaction, toFunctionSelector, type Address, type Hex } from 'viem'
import { ERC20_ABI, LENDING_ABI, MAX_UINT256, readGovernance, tick, type Fetcher, type Transport } from './engine'
import { OFFICIAL_SCENARIOS, START, liquidate, runScenario, worstCase } from './scenarios'
import { collateralFor, debtFor, decide, healthFactor, parseRules, type Balances, type Governance, type Rules } from './strategy'

const RULES: Rules = {
	triggerHf: 112n,
	targetHf: 125n,
	criticalHf: 102n,
	maxDepositUnits: 300n,
	maxRepayPct: 20n,
	preferDeposit: true,
	cooldownBlocks: 10,
	minHonestQuorum: 2,
	maxDarkSigners: 2,
}
const HEALTHY: Governance = { honestQuorum: 3, darkSigners: 0, canReachQuorum: true }
const POS = { collateral: START.collateral, debt: START.debt }
const BAL: Balances = { veth: START.walletVeth, vusd: START.walletVusd }
const P = (usd: number) => BigInt(usd * 100)

describe('contract arithmetic', () => {
	it('reproduces the starting health factor the README quotes', () => {
		expect(healthFactor(POS, P(2000))).toBe(111n)
	})

	it('shows the untouched position is liquidated at 1800, not merely close', () => {
		// 1.0029 in floats. The contract truncates to 100 and liquidates at hf <= 100.
		expect(healthFactor(POS, P(1800))).toBe(100n)
	})

	it('collateralFor is the smallest collateral that reaches the target', () => {
		const c = collateralFor(125n, POS.debt, P(2000))
		expect(c).toBe(561n)
		expect(healthFactor({ collateral: c, debt: POS.debt }, P(2000))).toBeGreaterThanOrEqual(125n)
		expect(healthFactor({ collateral: c - 1n, debt: POS.debt }, P(2000))).toBeLessThan(125n)
	})

	it('debtFor is the largest debt that keeps the target', () => {
		const d = debtFor(125n, POS.collateral, P(2000))
		expect(healthFactor({ collateral: POS.collateral, debt: d }, P(2000))).toBeGreaterThanOrEqual(125n)
		expect(healthFactor({ collateral: POS.collateral, debt: d + 1n }, P(2000))).toBeLessThan(125n)
	})

	it('partial liquidation restores MAX_LTV and seizes the penalty', () => {
		const r = liquidate(POS, P(1700))
		expect(r.debtRepaid).toBeGreaterThan(0n)
		expect(r.seized).toBeGreaterThan(0n)
		expect(r.pos.debt).toBeLessThan(POS.debt)
		expect(r.pos.collateral).toBeLessThan(POS.collateral)
	})
})

describe('market trigger', () => {
	it('holds above the trigger and spends nothing', () => {
		const d = decide(POS, P(2300), BAL, HEALTHY, RULES, false)
		expect(d.action).toBe('HOLD')
		expect(d.deposit + d.repay).toBe(0n)
	})

	it('tops up collateral first, and only as much as the target needs', () => {
		const d = decide(POS, P(2000), BAL, HEALTHY, RULES, false)
		expect(d.action).toBe('PROTECT')
		expect(d.deposit).toBe(61n)
		expect(d.repay).toBe(0n)
		expect(d.hfAfter).toBeGreaterThanOrEqual(RULES.targetHf)
		expect(healthFactor({ collateral: POS.collateral + d.deposit - 1n, debt: POS.debt }, P(2000))).toBeLessThan(RULES.targetHf)
	})

	it('falls back to repaying when the deposit cap cannot reach the target', () => {
		const d = decide(POS, P(2000), BAL, HEALTHY, { ...RULES, maxDepositUnits: 30n }, false)
		expect(d.action).toBe('PROTECT')
		expect(d.deposit).toBe(30n)
		expect(d.repay).toBeGreaterThan(0n)
		expect(d.hfAfter).toBeGreaterThanOrEqual(RULES.targetHf)
	})

	it('repays when there is no vETH left to deposit', () => {
		const d = decide(POS, P(1750), { veth: 0n, vusd: BAL.vusd }, HEALTHY, RULES, false)
		expect(d.action).toBe('PROTECT')
		expect(d.deposit).toBe(0n)
		expect(d.repay).toBeGreaterThan(0n)
	})

	it('spends debt first when told to', () => {
		const d = decide(POS, P(1750), BAL, HEALTHY, { ...RULES, preferDeposit: false }, false)
		expect(d.action).toBe('PROTECT')
		expect(d.repay).toBeGreaterThan(0n)
	})

	it('reports no reserve rather than sending an empty action', () => {
		expect(decide(POS, P(1750), { veth: 0n, vusd: 0n }, HEALTHY, RULES, false).action).toBe('NO_RESERVE')
	})

	it('never exceeds a balance, a cap, or the debt', () => {
		for (const usd of [1400, 1550, 1700, 1850, 2000])
			for (const veth of [0n, 40n, 500n])
				for (const vusd of [0n, 50000n, 700000n]) {
					const d = decide(POS, P(usd), { veth, vusd }, HEALTHY, RULES, false)
					expect(d.deposit).toBeLessThanOrEqual(veth)
					expect(d.deposit).toBeLessThanOrEqual(RULES.maxDepositUnits)
					expect(d.repay).toBeLessThanOrEqual(vusd)
					expect(d.repay).toBeLessThanOrEqual((POS.debt * RULES.maxRepayPct) / 100n)
					expect(d.repay).toBeLessThanOrEqual(POS.debt)
				}
	})
})

describe('intervention discipline', () => {
	it('skips a non-critical action inside the cooldown', () => {
		const price = P(1885) // health factor 1.05: below the trigger, above critical
		expect(healthFactor(POS, price)).toBe(105n)
		expect(decide(POS, price, BAL, HEALTHY, RULES, true).action).toBe('COOLDOWN')
		expect(decide(POS, price, BAL, HEALTHY, RULES, false).action).toBe('PROTECT')
	})

	it('ignores the cooldown once the position is critical', () => {
		const price = P(1830) // health factor 1.01
		expect(healthFactor(POS, price)).toBe(101n)
		expect(decide(POS, price, BAL, HEALTHY, RULES, true).action).toBe('PROTECT')
	})
})

describe('governance trigger', () => {
	// The point of the whole workflow: the position is perfectly healthy in every one of these.
	const price = P(2300)

	it('unwinds when the market can no longer reach quorum', () => {
		const d = decide(POS, price, BAL, { ...HEALTHY, canReachQuorum: false }, RULES, false)
		expect(d.action).toBe('UNWIND')
		expect(d.repay).toBe(POS.debt)
		expect(d.reason).toBe('control surface degraded')
	})

	it('unwinds when the honest quorum is smaller than the market claims', () => {
		expect(decide(POS, price, BAL, { ...HEALTHY, honestQuorum: 1 }, RULES, false).action).toBe('UNWIND')
	})

	it('unwinds when too many signers have gone dark', () => {
		expect(decide(POS, price, BAL, { ...HEALTHY, darkSigners: 5 }, RULES, false).action).toBe('UNWIND')
	})

	it('treats a missing signal as no signal, never as a breach', () => {
		expect(decide(POS, price, BAL, null, RULES, false).action).toBe('HOLD')
	})

	it('repays what it can when the wallet cannot cover the whole debt', () => {
		const d = decide(POS, price, { veth: 500n, vusd: 100000n }, { ...HEALTHY, honestQuorum: 0 }, RULES, false)
		expect(d.action).toBe('UNWIND')
		expect(d.repay).toBe(100000n)
	})
})

describe('the published scenarios', () => {
	it('liquidate the untouched position in every single one, including safe volatility', () => {
		for (const s of OFFICIAL_SCENARIOS) {
			const o = worstCase(s.prices, null)
			expect(o.survived).toBe(false)
		}
	})

	it('survive under both orderings of price update and liquidation check', () => {
		for (const s of OFFICIAL_SCENARIOS) {
			for (const ordering of ['liquidate-then-react', 'react-then-liquidate'] as const) {
				const o = runScenario(s.prices, RULES, { ordering, gov: HEALTHY })
				expect(o.survived).toBe(true)
				expect(o.minHf).toBeGreaterThan(100n)
			}
		}
	})

	it('keep the whole loan open and never spend vUSD', () => {
		for (const s of OFFICIAL_SCENARIOS) {
			const o = worstCase(s.prices, RULES, HEALTHY)
			expect(o.continuityBp).toBe(10000)
			expect(o.vusdUsed).toBe(0n)
			expect(o.vethUsed).toBeLessThanOrEqual(START.walletVeth)
		}
	})

	it('do not over-intervene on the wick or the safe path', () => {
		const wick = OFFICIAL_SCENARIOS.find((s) => s.name === 'temporary wick')!
		const safe = OFFICIAL_SCENARIOS.find((s) => s.name === 'safe volatility')!
		expect(worstCase(wick.prices, RULES, HEALTHY).interventions).toBeLessThanOrEqual(2)
		expect(worstCase(safe.prices, RULES, HEALTHY).interventions).toBeLessThanOrEqual(2)
	})

	it('unwind a healthy position the moment governance degrades, with the price flat', () => {
		const flat = [2000, 2000, 2000]
		const healthy = worstCase(flat, RULES, HEALTHY)
		const degraded = worstCase(flat, RULES, { honestQuorum: 1, darkSigners: 4, canReachQuorum: false })
		expect(healthy.vusdUsed).toBe(0n)
		expect(degraded.vusdUsed).toBe(START.debt)
		expect(degraded.interventions).toBe(1)
	})
})

describe('rules secret', () => {
	it('parses numbers and strings alike', () => {
		const r = parseRules('{"triggerHf":"112","targetHf":125,"criticalHf":102,"maxDepositUnits":300,"maxRepayPct":20,"cooldownBlocks":10,"minHonestQuorum":2,"maxDarkSigners":2}')
		expect(r.triggerHf).toBe(112n)
		expect(r.preferDeposit).toBe(true)
	})

	it('rejects a target below the trigger', () => {
		expect(() => parseRules('{"triggerHf":120,"targetHf":110,"criticalHf":102,"maxDepositUnits":300,"maxRepayPct":20,"cooldownBlocks":10,"minHonestQuorum":2,"maxDarkSigners":2}')).toThrow()
	})
})

describe('reading a Roll Call report', () => {
	const body = JSON.stringify({
		report: {
			inferred: { quorumCurve: [{ effectiveQuorum: 3 }, { effectiveQuorum: 2 }, { effectiveQuorum: 2 }] },
			reachability: { darkSigners: 1, canStillReachThreshold: true },
		},
	})

	it('takes the lowest honest quorum across the alpha grid', () => {
		expect(readGovernance(body)!.honestQuorum).toBe(2)
	})

	it('carries dark signers and reachability through', () => {
		const g = readGovernance(body)!
		expect(g.darkSigners).toBe(1)
		expect(g.canReachQuorum).toBe(true)
	})

	it('reads the warm signal shape and treats pending as no signal', () => {
		const warm = readGovernance(JSON.stringify({ ready: true, honestQuorum: 2, darkSigners: 1, canReachQuorum: true }))!
		expect(warm.honestQuorum).toBe(2)
		expect(readGovernance(JSON.stringify({ ready: false, pending: true }))).toBeNull()
	})
})

// --- the engine, against an in-memory model of the contract ---------------------------------

const LENDING = '0x88574e7Cc0027afd04951daa09B64d4441931ba1' as Address
const VETH = '0x5dED1a40c3D56dA42E7f932f781c0432556c9814' as Address
const VUSD = '0x6Fe92Ead5299040f50F095860b5A0A7A2D4041A2' as Address
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const CONFIG = { chainId: 11155111, lendingAddress: LENDING, vethAddress: VETH, vusdAddress: VUSD, rollcallApiUrl: 'http://rollcall', market: '0xmarket' }

type ChainState = {
	joined: boolean
	open: boolean
	started: boolean
	ended?: boolean
	price: bigint
	collateral: bigint
	debt: bigint
	veth: bigint
	vusd: bigint
	allowVeth?: bigint
	allowVusd?: bigint
	logs?: unknown[]
}

function fakeChain(s: ChainState) {
	const sent: { to: string; fn: string; args: readonly unknown[] }[] = []
	const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
	const transport: Transport = (method, params) => {
		if (method === 'eth_call') {
			const { to, data } = params[0] as { to: Address; data: Hex }
			const sel = data.slice(0, 10)
			const is = (sig: string) => sel === toFunctionSelector(sig)
			const out = (abi: any, functionName: string, result: unknown) => encodeFunctionResult({ abi, functionName, result } as any)
			if (is('challengeOpen()')) return out(LENDING_ABI, 'challengeOpen', s.open)
			if (is('scenarioStartTime()')) return out(LENDING_ABI, 'scenarioStartTime', s.started ? 1000n : 0n)
			if (is('scenarioEndTime()')) return out(LENDING_ABI, 'scenarioEndTime', s.ended ? 2000n : 0n)
			if (is('vETHPrice()')) return out(LENDING_ABI, 'vETHPrice', s.price)
			if (is('isUser(address)')) return out(LENDING_ABI, 'isUser', s.joined)
			if (is('getUserPosition(address)'))
				return out(LENDING_ABI, 'getUserPosition', { collateral: s.collateral, debt: s.debt, hf: 0n, numOperations: 0n, lastUpdateTime: 0n, cumulativeDebtTime: 0n })
			if (is('balanceOf(address)')) return out(ERC20_ABI, 'balanceOf', eq(to, VETH) ? s.veth : s.vusd)
			if (is('allowance(address,address)')) return out(ERC20_ABI, 'allowance', eq(to, VETH) ? (s.allowVeth ?? 0n) : (s.allowVusd ?? 0n))
			throw new Error(`unexpected call ${sel}`)
		}
		if (method === 'eth_blockNumber') return '0x100'
		if (method === 'eth_getLogs') return s.logs ?? []
		if (method === 'eth_getTransactionCount') return '0x7'
		if (method === 'eth_gasPrice') return '0x3b9aca00'
		if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' }
		if (method === 'eth_maxPriorityFeePerGas') return '0x5f5e100'
		if (method === 'eth_sendRawTransaction') {
			const tx = parseTransaction(params[0] as Hex)
			const d = decodeFunctionData({ abi: [...LENDING_ABI, ...ERC20_ABI], data: tx.data! })
			sent.push({ to: tx.to!, fn: d.functionName, args: d.args ?? [] })
			return `0x${'ab'.repeat(32)}`
		}
		throw new Error(`unexpected rpc ${method}`)
	}
	return { transport, sent }
}

const govFetcher = (g: Governance): Fetcher => () => ({
	ok: true,
	status: 200,
	body: JSON.stringify({ report: { inferred: { quorumCurve: [{ effectiveQuorum: g.honestQuorum }] }, reachability: { darkSigners: g.darkSigners, canStillReachThreshold: g.canReachQuorum } } }),
})
const paywalled: Fetcher = () => ({ ok: false, status: 402, body: '' })
const unreachable: Fetcher = () => {
	throw new Error('connection refused')
}

const base: ChainState = { joined: true, open: true, started: true, price: P(1750), collateral: 500n, debt: 700000n, veth: 500n, vusd: 700000n }
const run = (s: ChainState, extra: Partial<Parameters<typeof tick>[0]> = {}) => {
	const chain = fakeChain(s)
	return tick({ transport: chain.transport, fetcher: govFetcher(HEALTHY), config: CONFIG, privateKey: KEY, rules: RULES, send: true, ...extra }).then((r) => ({ r, sent: chain.sent }))
}

describe('engine', () => {
	it('does nothing for an address that has not joined', async () => {
		const { r, sent } = await run({ ...base, joined: false })
		expect(r.state).toBe('not-joined')
		expect(sent).toHaveLength(0)
	})

	it('plans but does not act before the scenario starts', async () => {
		const { r, sent } = await run({ ...base, started: false })
		expect(r.state).toBe('not-active')
		expect(r.plan?.action).toBe('PROTECT')
		expect(sent).toHaveLength(0)
	})

	it('holds a healthy position', async () => {
		const { r, sent } = await run({ ...base, price: P(2300) })
		expect(r.state).toBe('held')
		expect(sent).toHaveLength(0)
	})

	it('approves once, then deposits exactly what the target needs', async () => {
		const { r, sent } = await run(base)
		expect(r.state).toBe('protected')
		expect(sent.map((t) => t.fn)).toEqual(['approve', 'deposit'])
		expect(sent[0].to.toLowerCase()).toBe(VETH.toLowerCase())
		expect(sent[0].args[1]).toBe(MAX_UINT256)
		expect(sent[1].to.toLowerCase()).toBe(LENDING.toLowerCase())
		expect(sent[1].args[0]).toBe(collateralFor(RULES.targetHf, 700000n, P(1750)) - 500n)
		expect(r.txHashes).toHaveLength(2)
	})

	it('skips the approval when the allowance already covers it', async () => {
		const { sent } = await run({ ...base, allowVeth: MAX_UINT256 })
		expect(sent.map((t) => t.fn)).toEqual(['deposit'])
	})

	it('unwinds a healthy position when governance degrades', async () => {
		const { r, sent } = await run({ ...base, price: P(2300) }, { fetcher: govFetcher({ ...HEALTHY, honestQuorum: 1 }) })
		expect(r.state).toBe('unwound')
		expect(sent.map((t) => t.fn)).toEqual(['approve', 'repay'])
		expect(sent[0].to.toLowerCase()).toBe(VUSD.toLowerCase())
		expect(sent[1].args[0]).toBe(700000n)
	})

	it('falls back to price alone when the governance signal is paywalled or down', async () => {
		for (const fetcher of [paywalled, unreachable]) {
			const { r, sent } = await run({ ...base, price: P(2300) }, { fetcher })
			expect(r.state).toBe('held')
			expect(r.governance).toBeNull()
			expect(r.governanceError).not.toBeNull()
			expect(sent).toHaveLength(0)
		}
	})

	it('treats a pending signal as no signal', async () => {
		const pendingFetcher: Fetcher = () => ({ ok: false, status: 202, body: JSON.stringify({ ready: false, pending: true }) })
		const { r, sent } = await run({ ...base, price: P(2300) }, { fetcher: pendingFetcher })
		expect(r.state).toBe('held')
		expect(r.governance).toBeNull()
		expect(r.governanceError).toBe('pending')
		expect(sent).toHaveLength(0)
	})

	it('respects the cooldown unless the position is critical', async () => {
		const recent = [{ topics: ['0x'] }]
		const calm = await run({ ...base, price: P(1885), logs: recent })
		expect(calm.r.state).toBe('cooldown')
		expect(calm.sent).toHaveLength(0)
		const critical = await run({ ...base, price: P(1830), logs: recent })
		expect(critical.r.state).toBe('protected')
		expect(critical.sent.map((t) => t.fn)).toContain('deposit')
	})

	it('dry runs without sending', async () => {
		const { r, sent } = await run(base, { send: false })
		expect(r.state).toBe('protected')
		expect(r.plan?.deposit).toBeGreaterThan(0n)
		expect(sent).toHaveLength(0)
		expect(r.txHashes).toHaveLength(0)
	})
})
