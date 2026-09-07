import { describe, expect, it } from 'bun:test'
import { commitTo, isBreached, readAssessment } from './workflow'

const report = (over: Partial<{ quorum: number[]; dark: number; reachable: boolean; digest: string }> = {}) =>
	JSON.stringify({
		report: {
			header: { inputDigest: over.digest ?? '0xabc123' },
			inferred: { quorumCurve: (over.quorum ?? [3, 2, 2]).map((effectiveQuorum) => ({ effectiveQuorum })) },
			reachability: { darkSigners: over.dark ?? 1, canStillReachThreshold: over.reachable ?? true },
		},
	})

const entry = { chain: 'ethereum', safe: '0xabc', minHonestQuorum: 2, maxDarkSigners: 2 }

describe('reading an assessment', () => {
	it('takes the lowest honest quorum across the alpha grid', () => {
		// The grid is a range; the breach test must use its most conservative point.
		expect(readAssessment(report({ quorum: [3, 3, 2, 2, 1] })).honestQuorum).toBe(1)
	})

	it('carries the report digest through, so the commitment means something', () => {
		expect(readAssessment(report({ digest: '0xdeadbeef' })).digest).toBe('0xdeadbeef')
	})

	it('accepts a bare report as well as a wrapped one', () => {
		const bare = JSON.parse(report())
		expect(readAssessment(JSON.stringify(bare.report)).honestQuorum).toBe(2)
	})
})

describe('breach test', () => {
	it('passes a healthy control surface', () => {
		expect(isBreached(readAssessment(report()), entry)).toBe(false)
	})

	it('breaches when quorum can no longer be reached', () => {
		expect(isBreached(readAssessment(report({ reachable: false })), entry)).toBe(true)
	})

	it('breaches when the honest quorum falls below the subscriber bound', () => {
		expect(isBreached(readAssessment(report({ quorum: [1, 1, 1] })), entry)).toBe(true)
	})

	it('breaches when too many signers have gone dark', () => {
		expect(isBreached(readAssessment(report({ dark: 6 })), entry)).toBe(true)
	})

	it('honours each subscriber bound independently', () => {
		const strict = { ...entry, minHonestQuorum: 3 }
		const assessment = readAssessment(report({ quorum: [2, 2] }))
		expect(isBreached(assessment, entry)).toBe(false)
		expect(isBreached(assessment, strict)).toBe(true)
	})
})

describe('commitment', () => {
	it('is order independent, so two nodes agree', () => {
		expect(commitTo(['0xa', '0xb', '0xc'])).toBe(commitTo(['0xc', '0xa', '0xb']))
	})

	it('changes when any underlying assessment changes', () => {
		expect(commitTo(['0xa', '0xb'])).not.toBe(commitTo(['0xa', '0xc']))
	})

	it('is empty for an empty watchlist', () => {
		expect(commitTo([])).toBe('')
	})
})
