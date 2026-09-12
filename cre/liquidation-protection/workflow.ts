import { cre, hexToBase64, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { toHex } from 'viem'
import { z } from 'zod'
import { tick, type Fetcher, type Transport } from './engine'
import { parseRules } from './strategy'

/**
 * Automated liquidation protection - a Chainlink CRE Confidential Workflow, entered in the
 * official challenge on Ethereum Sepolia.
 *
 * THE SPEC, AND WHAT IS ADDED TO IT:
 *
 * The challenge asks for a workflow that protects a virtual vETH-collateral / vUSD-debt position
 * on ChallengeLending through market movements the organisers drive, avoids liquidation,
 * preserves the benefit of keeping the loan open, uses emergency capital efficiently, and keeps
 * its rules and credentials private. All of that is implemented here, in the contract's own
 * integer arithmetic (`strategy.ts`), and walked through the five published scenarios under both
 * possible orderings of price update and liquidation check (`scenarios.ts`).
 *
 * What Roll Call adds is a second trigger no liquidation protection has. Every existing system
 * watches ONE variable: price. But a position becomes unsafe for reasons that never touch a price
 * feed. If the market's control surface loses quorum, or its signer set turns out to be one party
 * wearing several hats, the people who can pause, upgrade or seize that market are not who you
 * thought, and the correct response is to de-risk no matter how healthy the health factor looks.
 *
 *   MARKET      health factor reaches the private trigger                  -> restore to target
 *   GOVERNANCE  the market's control surface degrades past a private bound -> unwind regardless
 *
 * WHY THE ENCLAVE IS LOAD BEARING:
 *
 * A protection strategy is front-runnable in both directions. Publishing the health factor at
 * which you act tells an adversary where to push the price to force your hand. Publishing your
 * caps tells them how far they can push before you run out. The governance bounds are worse:
 * they are a map of which markets you have decided not to trust.
 *
 * Inside the enclave:  the signing key, every threshold and cap, the action priority, the
 *                      cooldown, the governance bounds, the Roll Call credential, the report,
 *                      and which rule fired.
 * Leaves the enclave:  a signed transaction. An observer sees that the position was defended
 *                      and by how much, which the chain would have told them anyway.
 */

export const configSchema = z.object({
	schedule: z.string(),
	rpcUrl: z.string(),
	/** ChallengeLending on Ethereum Sepolia. Public: it is the organisers' contract. */
	lendingAddress: z.string(),
	vethAddress: z.string(),
	vusdAddress: z.string(),
	rollcallApiUrl: z.string(),
	/** The Safe whose control surface stands in for the market's governance. Public. */
	market: z.string(),
	privateKeySecretId: z.string(),
	rulesSecretId: z.string(),
	apiKeySecretId: z.string(),
})
type Config = z.infer<typeof configSchema>

const SEPOLIA = 11155111

export const onCronTrigger = async (runtime: TeeRuntime<Config>): Promise<string> => {
	const config = runtime.config

	// Released by the Vault DON directly into the attested enclave.
	const privateKey = runtime.getSecret({ id: config.privateKeySecretId }).result().value as `0x${string}`
	const rules = parseRules(runtime.getSecret({ id: config.rulesSecretId }).result().value)
	let apiKey: string | undefined
	try {
		apiKey = runtime.getSecret({ id: config.apiKeySecretId }).result().value
	} catch {
		apiKey = undefined
	}

	const http = new cre.capabilities.HTTPClient()

	// JSON-RPC over the HTTP capability. Requests and responses stay inside the enclave, so the
	// address being defended and the state of its position are not visible to node operators.
	const transport: Transport = (method, params) => {
		const body = hexToBase64(toHex(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })))
		const response = http
			.sendRequest(runtime, { url: config.rpcUrl, method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
			.result()
		const raw = text(response)
		if (!ok(response)) throw new Error(`rpc ${method}: http ${response.statusCode}`)
		const json = JSON.parse(raw)
		if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? 'error'}`)
		return json.result
	}

	// Inside the enclave the plain HTTP capability is already confidential, and it carries a ten
	// second budget. So the governance leg reads a signal the API keeps warm in the background
	// rather than asking it to compute a report on the spot: a quick answer, or "pending", which
	// the engine treats as no signal.
	const fetcher: Fetcher = (url, headers) => {
		const response = http.sendRequest(runtime, { url, method: 'GET', headers, timeout: '9s' }).result()
		return { ok: ok(response), status: response.statusCode, body: text(response) }
	}

	const result = await tick({
		transport,
		fetcher,
		config: {
			chainId: SEPOLIA,
			lendingAddress: config.lendingAddress as `0x${string}`,
			vethAddress: config.vethAddress as `0x${string}`,
			vusdAddress: config.vusdAddress as `0x${string}`,
			rollcallApiUrl: config.rollcallApiUrl,
			market: config.market,
		},
		privateKey,
		rules,
		apiKey,
		send: true,
		log: (line) => runtime.log(line),
	})

	// The reason names which rule fired, so it does not cross this line.
	const summary: Record<string, unknown> = {
		state: result.state,
		hf: result.hf.toString(),
		price: result.price.toString(),
		deposit: result.plan?.deposit.toString() ?? '0',
		repay: result.plan?.repay.toString() ?? '0',
		txHashes: result.txHashes,
	}
	if (result.governanceError) summary.governance = 'unavailable'
	return JSON.stringify(summary)
}

export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
