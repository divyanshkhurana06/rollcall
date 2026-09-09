/**
 * Liquidation protection strategy, in the challenge contract's own integers.
 *
 * ChallengeLending keeps two decimal places everywhere: 500 vETH units is 5.00 vETH, 700000 vUSD
 * units is 7000.00 vUSD, a price of 200000 is 2000.00 vUSD per vETH, and a health factor of 112
 * means 1.12. Everything below is bigint so that the numbers the workflow acts on are the numbers
 * the contract will compute, rounding included. A strategy that reasons in floats and acts in
 * integers gets liquidated by a rounding error: the starting position at a price of 1800.00 has a
 * health factor of 1.0029, which the contract truncates to 100 and liquidates.
 *
 * The contract only refreshes its stored health factor inside calcHF, so after a price update the
 * stored value is stale. The strategy always recomputes from collateral, debt and the live price.
 *
 * Every rule in `Rules` is a private input. The trigger says where the position can be pushed, the
 * target says how much protection is bought each time, the caps say how far emergency capital
 * stretches, and the priority says which leg is spent first. None of them appear in config, logs,
 * or on chain.
 */

export const LIQUI_THRESHOLD = 78n
export const MAX_LTV = 75n
export const LIQUI_PENALTY = 5n
export const HF_MAX = (1n << 256n) - 1n

export type Position = { collateral: bigint; debt: bigint }
export type Balances = { veth: bigint; vusd: bigint }

export type Rules = {
	/** Health factor (x100) at or below which the workflow acts. */
	triggerHf: bigint
	/** Health factor (x100) an action restores to. The gap to `triggerHf` is the hysteresis. */
	targetHf: bigint
	/** Health factor (x100) at or below which the cooldown no longer applies. */
	criticalHf: bigint
	/** Most vETH units one action may deposit. */
	maxDepositUnits: bigint
	/** Most debt one action may repay, as a percentage of current debt. */
	maxRepayPct: bigint
	/** Spend collateral before debt. Deposits keep the loan open, repayments shrink it. */
	preferDeposit: boolean
	/** Blocks after an action during which non-critical actions are skipped. */
	cooldownBlocks: number
	/** Governance leg: the market's control surface must keep at least this honest quorum. */
	minHonestQuorum: number
	/** Governance leg: and no more than this many signers may be dark. */
	maxDarkSigners: number
}

export type Governance = { honestQuorum: number; darkSigners: number; canReachQuorum: boolean }

export type Action = 'HOLD' | 'PROTECT' | 'UNWIND' | 'COOLDOWN' | 'NO_RESERVE'

export type Plan = {
	action: Action
	deposit: bigint
	repay: bigint
	hfBefore: bigint
	hfAfter: bigint
	/** Names the rule that fired. Stays inside the enclave; tests and the harness read it. */
	reason: string
}

/** calcHF, verbatim: collateral * price * 78 / (100 * debt). */
export const healthFactor = (p: Position, price: bigint): bigint =>
	p.debt === 0n ? HF_MAX : (p.collateral * price * LIQUI_THRESHOLD) / (100n * p.debt)

/** Smallest collateral whose health factor at `price` is at least `targetHf`. Ceiling division. */
export const collateralFor = (targetHf: bigint, debt: bigint, price: bigint): bigint => {
	const denom = price * LIQUI_THRESHOLD
	return (targetHf * 100n * debt + denom - 1n) / denom
}

/** Largest debt whose health factor at `price` with `collateral` is at least `targetHf`. */
export const debtFor = (targetHf: bigint, collateral: bigint, price: bigint): bigint =>
	(collateral * price * LIQUI_THRESHOLD) / (100n * targetHf)

const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (a < b ? a : b))
const floor0 = (x: bigint): bigint => (x < 0n ? 0n : x)

/**
 * An unavailable signal is not a degraded one. If the governance leg cannot be read the workflow
 * falls back to price alone rather than unwinding a healthy position on missing data.
 */
export function governanceDegraded(g: Governance | null, rules: Rules): boolean {
	if (!g) return false
	return !g.canReachQuorum || g.honestQuorum < rules.minHonestQuorum || g.darkSigners > rules.maxDarkSigners
}

/**
 * The decision. Pure and deterministic, so the same function runs in the enclave, in the tests,
 * in the scenario harness and in the local dry run, and none of them can drift from the others.
 */
export function decide(
	p: Position,
	price: bigint,
	bal: Balances,
	gov: Governance | null,
	rules: Rules,
	recentAction: boolean,
): Plan {
	const hfBefore = healthFactor(p, price)
	const idle = { deposit: 0n, repay: 0n, hfBefore, hfAfter: hfBefore }

	if (p.debt === 0n) return { ...idle, action: 'HOLD', reason: 'no debt' }

	// A market whose control surface has degraded is not a market to hold leverage in, however
	// healthy the price says the position is. No price feed reports this.
	if (governanceDegraded(gov, rules)) {
		const repay = min(p.debt, bal.vusd)
		if (repay === 0n) return { ...idle, action: 'NO_RESERVE', reason: 'unwind requested, no vUSD to repay with' }
		return { ...idle, action: 'UNWIND', repay, hfAfter: healthFactor({ ...p, debt: p.debt - repay }, price), reason: 'control surface degraded' }
	}

	if (hfBefore > rules.triggerHf) return { ...idle, action: 'HOLD', reason: 'within tolerance' }
	if (recentAction && hfBefore > rules.criticalHf) return { ...idle, action: 'COOLDOWN', reason: 'acted recently and not critical' }

	const maxRepay = min((p.debt * rules.maxRepayPct) / 100n, bal.vusd, p.debt)
	const maxDeposit = min(rules.maxDepositUnits, bal.veth)

	const depositLeg = (debt: bigint) => min(floor0(collateralFor(rules.targetHf, debt, price) - p.collateral), maxDeposit)
	const repayLeg = (collateral: bigint) => min(floor0(p.debt - debtFor(rules.targetHf, collateral, price)), maxRepay)

	let deposit = 0n
	let repay = 0n
	if (rules.preferDeposit) {
		deposit = depositLeg(p.debt)
		if (healthFactor({ collateral: p.collateral + deposit, debt: p.debt }, price) < rules.targetHf) repay = repayLeg(p.collateral + deposit)
	} else {
		repay = repayLeg(p.collateral)
		if (healthFactor({ collateral: p.collateral, debt: p.debt - repay }, price) < rules.targetHf) deposit = depositLeg(p.debt - repay)
	}

	if (deposit === 0n && repay === 0n) return { ...idle, action: 'NO_RESERVE', reason: 'no emergency capital left' }

	const hfAfter = healthFactor({ collateral: p.collateral + deposit, debt: p.debt - repay }, price)
	return {
		action: 'PROTECT',
		deposit,
		repay,
		hfBefore,
		hfAfter,
		reason: hfAfter >= rules.targetHf ? 'restored to target' : 'partial protection, capital capped',
	}
}

/** Parses the rules secret. Numbers arrive as JSON numbers or strings; both are accepted. */
export function parseRules(json: string): Rules {
	const r = JSON.parse(json)
	const big = (k: string) => {
		if (r[k] === undefined) throw new Error(`rules: missing ${k}`)
		return BigInt(r[k])
	}
	const num = (k: string) => {
		if (r[k] === undefined) throw new Error(`rules: missing ${k}`)
		return Number(r[k])
	}
	const rules: Rules = {
		triggerHf: big('triggerHf'),
		targetHf: big('targetHf'),
		criticalHf: big('criticalHf'),
		maxDepositUnits: big('maxDepositUnits'),
		maxRepayPct: big('maxRepayPct'),
		preferDeposit: r.preferDeposit !== false,
		cooldownBlocks: num('cooldownBlocks'),
		minHonestQuorum: num('minHonestQuorum'),
		maxDarkSigners: num('maxDarkSigners'),
	}
	if (rules.targetHf <= rules.triggerHf) throw new Error('rules: targetHf must exceed triggerHf')
	if (rules.criticalHf > rules.triggerHf) throw new Error('rules: criticalHf must not exceed triggerHf')
	return rules
}
