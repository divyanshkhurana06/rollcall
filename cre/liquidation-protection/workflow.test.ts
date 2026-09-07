import { describe, expect, it } from 'bun:test'
import { ACTION_CODE, decide, healthFactor, readGovernance } from './workflow'
import type { Governance, Position, ProtectionRules } from './workflow'

const RULES: ProtectionRules = {
	liquidationThreshold: 0.825,
	interveneAtHealthFactor: 1.35,
	targetHealthFactor: 1.75,
	emergencyCapitalUsdc: 8000,
	minHonestQuorum: 3,
	maxDarkSigners: 2,
}

const HEALTHY: Governance = { honestQuorum: 3, darkSigners: 1, canReachQuorum: true }
const at = (ethPriceUsd: number, debtUsdc = 18000): Position => ({ collateralEth: 10, debtUsdc, ethPriceUsd })

describe('health factor', () => {
	it('is infinite with no debt', () => {
		expect(healthFactor({ collateralEth: 10, debtUsdc: 0, ethPriceUsd: 2400 }, 0.825)).toBe(Infinity)
	})

	it('falls as the collateral price falls', () => {
		expect(healthFactor(at(2400), 0.825)).toBeGreaterThan(healthFactor(at(1800), 0.825))
	})
})

describe('market trigger', () => {
	it('holds a healthy position and spends nothing', () => {
		const d = decide(at(4000), HEALTHY, RULES)
		expect(d.action).toBe('HOLD')
		expect(d.sizeUsdc).toBe(0)
	})

	it('repays the minimum that restores the target, not the whole loan', () => {
		const d = decide(at(2500), HEALTHY, RULES)
		expect(d.action).toBe('PARTIAL_REPAY')
		expect(d.sizeUsdc).toBeGreaterThan(0)
		// Preserving the carry is an explicit requirement: never close what can be trimmed.
		expect(d.sizeUsdc).toBeLessThan(18000)
	})

	it('restores the position to at least the target health factor', () => {
		const before = at(2500)
		const d = decide(before, HEALTHY, RULES)
		const after = { ...before, debtUsdc: before.debtUsdc - d.sizeUsdc }
		expect(healthFactor(after, RULES.liquidationThreshold)).toBeGreaterThanOrEqual(RULES.targetHealthFactor - 0.01)
	})

	it('spends what capital remains rather than nothing when it cannot restore the target', () => {
		const d = decide(at(1500), HEALTHY, RULES)
		expect(d.action).toBe('PARTIAL_REPAY')
		expect(d.sizeUsdc).toBe(RULES.emergencyCapitalUsdc)
		expect(d.reason).toContain('exhausted')
	})

	it('never spends more than the emergency capital', () => {
		for (const price of [3000, 2500, 2000, 1500, 1000, 500]) {
			expect(decide(at(price), HEALTHY, RULES).sizeUsdc).toBeLessThanOrEqual(RULES.emergencyCapitalUsdc)
		}
	})
})

describe('governance trigger', () => {
	// The point of the whole workflow: the position is perfectly healthy in every one of these.
	const healthyPosition = at(4000)

	it('unwinds when the market can no longer reach quorum', () => {
		const d = decide(healthyPosition, { ...HEALTHY, canReachQuorum: false }, RULES)
		expect(d.action).toBe('FULL_UNWIND')
		expect(d.reason).toBe('control surface degraded')
	})

	it('unwinds when the honest quorum is smaller than the market claims', () => {
		expect(decide(healthyPosition, { ...HEALTHY, honestQuorum: 1 }, RULES).action).toBe('FULL_UNWIND')
	})

	it('unwinds when too many signers have gone dark', () => {
		expect(decide(healthyPosition, { ...HEALTHY, darkSigners: 5 }, RULES).action).toBe('FULL_UNWIND')
	})

	it('takes precedence over a healthy health factor', () => {
		const hf = healthFactor(healthyPosition, RULES.liquidationThreshold)
		expect(hf).toBeGreaterThan(RULES.interveneAtHealthFactor)
		expect(decide(healthyPosition, { ...HEALTHY, honestQuorum: 0 }, RULES).action).toBe('FULL_UNWIND')
	})
})

describe('report encoding', () => {
	it('maps every action to a stable code', () => {
		expect(ACTION_CODE.HOLD).toBe(0)
		expect(ACTION_CODE.PARTIAL_REPAY).toBe(1)
		expect(ACTION_CODE.FULL_UNWIND).toBe(2)
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
		expect(readGovernance(body).honestQuorum).toBe(2)
	})

	it('carries dark signers and reachability through', () => {
		const g = readGovernance(body)
		expect(g.darkSigners).toBe(1)
		expect(g.canReachQuorum).toBe(true)
	})
})
