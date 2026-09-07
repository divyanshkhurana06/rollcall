import { cre, hexToBase64, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

/**
 * Control surface watch - a Chainlink CRE Confidential Workflow.
 *
 * WHY THE ENCLAVE IS LOAD BEARING HERE, NOT DECORATIVE:
 *
 * A watchlist is an exposure map. Knowing which protocols an institution monitors, and at what
 * thresholds it de-risks, tells you where its money is and what would make it move. That is the
 * one piece of information a monitoring service must hold and must never reveal, and it is
 * exactly what node operators would otherwise see.
 *
 * Inside the enclave:  the watchlist, the per-subscriber thresholds, the API credential, the
 *                      reports themselves, and every intermediate comparison.
 * Crossing to the DON:  a count of breaches and a commitment to the report digests that produced
 *                       it. Nothing that identifies whose exposure it was.
 *
 * The commitment matters: a subscriber can prove afterwards which assessments drove an alert,
 * without publishing them at the time. Roll Call's report digest is already a commitment to one
 * timestamped assessment, so committing to a set of them is a commitment all the way down.
 */

export const configSchema = z.object({
	schedule: z.string(),
	rollcallApiUrl: z.string(),
	apiKeySecretId: z.string(),
	watchlistSecretId: z.string(),
})
type Config = z.infer<typeof configSchema>

/** One watched control surface. Both bounds are the subscriber's, and both stay in the enclave. */
type WatchEntry = {
	chain: string
	safe: string
	/** Breach if the honest quorum falls below this. */
	minHonestQuorum: number
	/** Breach if more than this many signers have gone dark. */
	maxDarkSigners: number
}

type Assessment = {
	digest: string
	honestQuorum: number
	darkSigners: number
	canReachQuorum: boolean
}

/**
 * Parse a Roll Call report into the three numbers a breach test needs.
 *
 * Deterministic for a given input, because the enclave result is attested and verified by DON
 * consensus. Anything non-deterministic here would fail that verification.
 */
export const readAssessment = (body: string): Assessment => {
	const parsed = JSON.parse(body)
	const report = parsed.report ?? parsed
	const curve: { effectiveQuorum: number }[] = report.inferred.quorumCurve
	return {
		digest: report.header.inputDigest,
		honestQuorum: Math.min(...curve.map((c) => c.effectiveQuorum)),
		darkSigners: report.reachability.darkSigners,
		canReachQuorum: report.reachability.canStillReachThreshold,
	}
}

/** A control surface is breached when it can no longer act, or acts with fewer parties than claimed. */
export const isBreached = (a: Assessment, entry: WatchEntry): boolean =>
	!a.canReachQuorum || a.honestQuorum < entry.minHonestQuorum || a.darkSigners > entry.maxDarkSigners

/** Order independent, so two nodes observing the same set commit to the same value. */
export const commitTo = (digests: string[]): string =>
	digests.length === 0 ? '' : [...digests].sort().join('|')

export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// Released by the Vault DON into the attested enclave, decrypted at this moment.
	const apiKey = runtime.getSecret({ id: config.apiKeySecretId }).result().value
	const watchlist: WatchEntry[] = JSON.parse(
		runtime.getSecret({ id: config.watchlistSecretId }).result().value,
	)

	const http = new cre.capabilities.HTTPClient()
	const digests: string[] = []
	let breaches = 0

	for (const entry of watchlist) {
		// Executed from inside the enclave, so both the request (which names the protocol) and the
		// response (which carries the assessment) stay confidential from node operators.
		const response = http
			.sendRequest(runtime, {
				url: `${config.rollcallApiUrl}/report/${entry.chain}/${entry.safe}?max=150`,
				method: 'GET',
				multiHeaders: { 'X-PAYMENT': { values: [apiKey] } },
			})
			.result()

		if (!ok(response)) {
			throw new Error(`Roll Call request failed with status: ${response.statusCode}`)
		}

		const assessment = readAssessment(text(response))
		digests.push(assessment.digest)
		if (isBreached(assessment, entry)) breaches += 1
	}

	// Only the aggregate crosses. `usingTheDons()` returns a normal Runtime, and anything passed
	// into a capability call on it is no longer confidential - so the watchlist, the thresholds
	// and the reports never appear beyond this line.
	const donRuntime = runtime.usingTheDons()

	const encodedPayload = encodeAbiParameters(
		parseAbiParameters('uint256 breaches, uint256 watched, string commitment'),
		[BigInt(breaches), BigInt(watchlist.length), commitTo(digests)],
	)

	donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	return `${breaches} of ${watchlist.length} watched control surfaces degraded`
}

export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
