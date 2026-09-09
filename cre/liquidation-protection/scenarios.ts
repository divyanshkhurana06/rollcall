/**
 * The challenge's published market scenarios, walked through a model of ChallengeLending that
 * uses the contract's own arithmetic: two-decimal units, calcHF, liquidation at hf <= 100 with
 * the partial liquidation formula, and the time-weighted debt that produces loanContinuityScore.
 *
 * The organisers control the order of `updatevETHPrice` and `checkAllHF`, and the workflow only
 * sees a new price when its cron fires. So the harness runs each scenario under both orderings and
 * the honest number is the worse one: a strategy that only survives if it is allowed to react
 * before the liquidation check is not a strategy, it is a race.
 */
import { decide, healthFactor, LIQUI_PENALTY, MAX_LTV, type Governance, type Position, type Rules } from './strategy'

/** join(): 5.00 vETH locked, 7000.00 vUSD owed, and 5.00 vETH + 7000.00 vUSD free in the wallet. */
export const START = { collateral: 500n, debt: 700000n, walletVeth: 500n, walletVusd: 700000n }

export const toUnits = (usd: number): bigint => BigInt(Math.round(usd * 100))

export type Scenario = { name: string; prices: number[]; expected: string }

/** Verbatim from the challenge README. */
export const OFFICIAL_SCENARIOS: Scenario[] = [
	{ name: 'gradual decline', prices: [2000, 1850, 1750, 1650, 1550], expected: 'a proportionate intervention before liquidation' },
	{ name: 'sudden crash', prices: [2000, 1700, 1625, 1450], expected: 'react at the first dangerous update' },
	{ name: 'temporary wick', prices: [2000, 1750, 1620, 1900], expected: 'hold or intervene minimally' },
	{ name: 'two-stage decline', prices: [2000, 1750, 1650, 1650, 1500], expected: 'enough protection, or an efficient second intervention' },
	{ name: 'safe volatility', prices: [2000, 1800, 1950, 1750, 2050], expected: 'avoid unnecessary interventions' },
]

/** liquidateUser, verbatim: restore to MAX_LTV, seize the repaid value plus the penalty. */
export function liquidate(pos: Position, price: bigint): { pos: Position; debtRepaid: bigint; seized: bigint } {
	const collateralValue = (pos.collateral * price) / 100n
	const D = pos.debt
	const targetDebt = (collateralValue * MAX_LTV) / 100n
	if (targetDebt >= D) return { pos, debtRepaid: 0n, seized: 0n }
	let debtToRepay = D - targetDebt
	const seizeValueVUSD = (debtToRepay * (100n + LIQUI_PENALTY)) / 100n
	let collateralToSeize = (seizeValueVUSD * 100n + price - 1n) / price
	if (collateralToSeize > pos.collateral) {
		collateralToSeize = pos.collateral
		debtToRepay = D
	}
	return { pos: { collateral: pos.collateral - collateralToSeize, debt: D - debtToRepay }, debtRepaid: debtToRepay, seized: collateralToSeize }
}

export type Ordering = 'liquidate-then-react' | 'react-then-liquidate'

export type Outcome = {
	survived: boolean
	liquidations: number
	interventions: number
	vethUsed: bigint
	vusdUsed: bigint
	/** loanContinuityScore, basis points of the original debt kept open over the scenario. */
	continuityBp: number
	minHf: bigint
	finalHf: bigint
	log: string[]
}

export const fmtUnits = (u: bigint): string => `${u / 100n}.${String(u % 100n).padStart(2, '0')}`
export const fmtHf = (hf: bigint): string => (hf > 100000n ? 'inf' : `${hf / 100n}.${String(hf % 100n).padStart(2, '0')}`)

/** One scenario. `rules === null` is the unprotected baseline. */
export function runScenario(
	pricesUsd: number[],
	rules: Rules | null,
	opts: { ordering?: Ordering; gov?: Governance | null; secondsPerRound?: number } = {},
): Outcome {
	const ordering = opts.ordering ?? 'liquidate-then-react'
	const round = BigInt(opts.secondsPerRound ?? 300)
	const gov = opts.gov ?? null

	let pos: Position = { collateral: START.collateral, debt: START.debt }
	const bal = { veth: START.walletVeth, vusd: START.walletVusd }
	let price = toUnits(pricesUsd[0])
	let t = 0n
	let lastUpdate = 0n
	let cumulativeDebtTime = 0n
	let interventions = 0
	let liquidations = 0
	let vethUsed = 0n
	let vusdUsed = 0n
	let minHf = healthFactor(pos, price)
	const log: string[] = []

	// _updateDebtTime: accrue debt x elapsed before any debt change.
	const touchDebt = () => {
		cumulativeDebtTime += pos.debt * (t - lastUpdate)
		lastUpdate = t
	}

	const react = () => {
		if (!rules) return
		const plan = decide(pos, price, bal, gov, rules, false)
		if (plan.action !== 'PROTECT' && plan.action !== 'UNWIND') {
			log.push(`t=${t}s price=${fmtUnits(price)} hf=${fmtHf(plan.hfBefore)} ${plan.action.toLowerCase()}`)
			return
		}
		if (plan.deposit > 0n) {
			pos = { ...pos, collateral: pos.collateral + plan.deposit }
			bal.veth -= plan.deposit
			vethUsed += plan.deposit
		}
		if (plan.repay > 0n) {
			touchDebt()
			pos = { ...pos, debt: pos.debt - plan.repay }
			bal.vusd -= plan.repay
			vusdUsed += plan.repay
		}
		interventions += 1
		log.push(
			`t=${t}s price=${fmtUnits(price)} hf=${fmtHf(plan.hfBefore)} ${plan.action.toLowerCase()} deposit=${fmtUnits(plan.deposit)} vETH repay=${fmtUnits(plan.repay)} vUSD -> hf=${fmtHf(plan.hfAfter)}`,
		)
	}

	// checkAllHF: calcHF then liquidate at or below 1.00.
	const check = () => {
		const hf = healthFactor(pos, price)
		if (hf < minHf) minHf = hf
		if (pos.debt > 0n && hf <= 100n) {
			touchDebt()
			const r = liquidate(pos, price)
			pos = r.pos
			liquidations += 1
			log.push(`t=${t}s price=${fmtUnits(price)} hf=${fmtHf(hf)} LIQUIDATED repaid=${fmtUnits(r.debtRepaid)} seized=${fmtUnits(r.seized)} vETH`)
		}
	}

	// start(): the clock begins at the opening price, and the cron fires once before any update.
	check()
	react()

	for (let i = 1; i < pricesUsd.length; i++) {
		t += round
		price = toUnits(pricesUsd[i])
		if (ordering === 'liquidate-then-react') {
			check()
			react()
		} else {
			react()
			check()
		}
	}

	// stop(): flush debt time and score continuity against the original debt held for the duration.
	t += round
	touchDebt()
	const maxDebtTime = START.debt * t
	let continuityBp = Number((cumulativeDebtTime * 10000n) / maxDebtTime)
	if (continuityBp > 10000) continuityBp = 10000

	return {
		survived: liquidations === 0,
		liquidations,
		interventions,
		vethUsed,
		vusdUsed,
		continuityBp,
		minHf,
		finalHf: healthFactor(pos, price),
		log,
	}
}

/** The worse of the two orderings, which is the only number worth reporting. */
export function worstCase(pricesUsd: number[], rules: Rules | null, gov: Governance | null = null): Outcome {
	const a = runScenario(pricesUsd, rules, { ordering: 'liquidate-then-react', gov })
	const b = runScenario(pricesUsd, rules, { ordering: 'react-then-liquidate', gov })
	if (a.survived !== b.survived) return a.survived ? b : a
	return a.minHf <= b.minHf ? a : b
}
