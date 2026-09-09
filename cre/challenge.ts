import { config as loadEnv } from 'dotenv'
import { readFileSync, writeFileSync } from 'node:fs'
import { encodeFunctionData, decodeFunctionResult, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ERC20_ABI, LENDING_ABI, MAX_UINT256, tick, type Fetcher, type Transport } from './liquidation-protection/engine'
import { fmtHf, fmtUnits } from './liquidation-protection/scenarios'
import { healthFactor, parseRules } from './liquidation-protection/strategy'

/**
 * The challenge from a laptop: keygen, join, status, and one protection tick.
 *
 *   npm run challenge -- keygen          a dedicated Sepolia key for the position
 *   npm run challenge -- status          chain state, our position, and what the workflow would do
 *   npm run challenge -- join            join() plus the two approvals, so the enclave never needs to approve
 *   npm run challenge -- tick [--send]   one cron iteration of the exact enclave code path; --send transacts
 *
 * `tick` runs `engine.ts`, the same function the Confidential Workflow runs, over plain fetch instead
 * of the CRE HTTP capability. It exists so the execution path can be exercised end to end against the
 * real contract before the organisers run their scenarios.
 */

loadEnv({ path: 'cre/.env', quiet: true })
loadEnv({ quiet: true })

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', x: '\x1b[0m' }
const cfg = JSON.parse(readFileSync('cre/liquidation-protection/config.staging.json', 'utf8'))
const RPC: string = process.env.SEPOLIA_RPC_URL ?? cfg.rpcUrl
const LENDING = cfg.lendingAddress as Address
const VETH = cfg.vethAddress as Address
const VUSD = cfg.vusdAddress as Address
const ETHERSCAN = 'https://sepolia.etherscan.io'

const transport: Transport = async (method, params) => {
	const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
	const json: any = await res.json()
	if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? JSON.stringify(json.error)}`)
	return json.result
}

const fetcher: Fetcher = async (url, headers) => {
	const res = await fetch(url, { headers })
	return { ok: res.ok, status: res.status, body: await res.text() }
}

const call = async <T>(to: Address, abi: any, functionName: string, args: unknown[] = []): Promise<T> => {
	const data = encodeFunctionData({ abi, functionName, args } as any)
	const result = (await transport('eth_call', [{ to, data }, 'latest'])) as Hex
	return decodeFunctionResult({ abi, functionName, data: result } as any) as T
}

function requireKey(): Hex {
	const pk = process.env.SECRET_CHALLENGE_PRIVATE_KEY
	if (!pk) {
		console.error(`${C.r}SECRET_CHALLENGE_PRIVATE_KEY is not set in cre/.env. Run: npm run challenge -- keygen${C.x}`)
		process.exit(1)
	}
	return pk as Hex
}

function requireRules() {
	const raw = process.env.SECRET_PROTECTION_RULES
	if (!raw) {
		console.error(`${C.r}SECRET_PROTECTION_RULES is not set in cre/.env${C.x}`)
		process.exit(1)
	}
	return parseRules(raw)
}

async function waitFor(hash: string): Promise<any> {
	for (let i = 0; i < 60; i++) {
		const receipt: any = await transport('eth_getTransactionReceipt', [hash])
		if (receipt) return receipt
		await new Promise((r) => setTimeout(r, 3000))
	}
	throw new Error(`no receipt for ${hash} after 3 minutes`)
}

async function sendTx(pk: Hex, to: Address, data: Hex, gas: bigint): Promise<string> {
	const account = privateKeyToAccount(pk)
	const nonce = Number(BigInt(String(await transport('eth_getTransactionCount', [account.address, 'pending']))))
	const gasPrice = BigInt(String(await transport('eth_gasPrice', [])))
	const signed = await account.signTransaction({ type: 'legacy', chainId: 11155111, to, data, gas, gasPrice, nonce, value: 0n })
	return (await transport('eth_sendRawTransaction', [signed])) as string
}

async function chainState() {
	const [open, start, end, price, users] = await Promise.all([
		call<boolean>(LENDING, LENDING_ABI, 'challengeOpen'),
		call<bigint>(LENDING, LENDING_ABI, 'scenarioStartTime'),
		call<bigint>(LENDING, LENDING_ABI, 'scenarioEndTime'),
		call<bigint>(LENDING, LENDING_ABI, 'vETHPrice'),
		call<bigint>(LENDING, [{ name: 'numUsers', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], 'numUsers'),
	])
	return { open, start, end, price, users }
}

function keygen() {
	const envPath = 'cre/.env'
	let env = ''
	try {
		env = readFileSync(envPath, 'utf8')
	} catch {
		env = ''
	}
	const existing = env.match(/^SECRET_CHALLENGE_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)?.[1]
	const pk = (existing ?? generatePrivateKey()) as Hex
	if (!existing) {
		env = env.replace(/^SECRET_CHALLENGE_PRIVATE_KEY=.*$/m, '')
		env += (env.endsWith('\n') || env === '' ? '' : '\n') + `SECRET_CHALLENGE_PRIVATE_KEY=${pk}\n`
		writeFileSync(envPath, env)
	}
	const address = privateKeyToAccount(pk).address
	console.log(`\n${C.b}CHALLENGE KEY${C.x} ${existing ? C.d + 'already in cre/.env' + C.x : C.g + 'written to cre/.env' + C.x}`)
	console.log(`  address   ${C.c}${address}${C.x}`)
	console.log(`  ${C.d}Fund it with a little Sepolia ETH for gas, then: npm run challenge -- join${C.x}\n`)
}

async function status() {
	const pk = requireKey()
	const rules = requireRules()
	const me = privateKeyToAccount(pk).address
	const s = await chainState()
	const gas = BigInt(String(await transport('eth_getBalance', [me, 'latest'])))

	console.log(`\n${C.b}LIQUIDATION PROTECTION CHALLENGE${C.x} ${C.d}ChallengeLending on Ethereum Sepolia${C.x}`)
	console.log(`${C.d}${'-'.repeat(76)}${C.x}`)
	console.log(`  contract     ${LENDING}`)
	console.log(`  registration ${s.open ? C.g + 'open' : C.r + 'closed'}${C.x}   participants ${s.users}`)
	console.log(`  scenario     ${s.start === 0n ? C.y + 'not started' : s.end === 0n ? C.g + 'running' : C.d + 'stopped'}${C.x}`)
	console.log(`  vETH price   ${fmtUnits(s.price)} vUSD`)
	console.log(`\n  our address  ${C.c}${me}${C.x}`)
	console.log(`  sepolia eth  ${(Number(gas) / 1e18).toFixed(5)}${gas === 0n ? `  ${C.y}fund this address before joining${C.x}` : ''}`)

	const result = await tick({ transport, fetcher, config: engineConfig(), privateKey: pk, rules, apiKey: process.env.SECRET_ROLLCALL_API_KEY, send: false })
	if (result.state === 'not-joined') {
		console.log(`  position     ${C.y}not joined${C.x}  ${C.d}npm run challenge -- join${C.x}\n`)
		return
	}
	console.log(`\n  collateral   ${fmtUnits(result.position.collateral)} vETH    debt ${fmtUnits(result.position.debt)} vUSD    hf ${C.b}${fmtHf(result.hf)}${C.x}`)
	console.log(`  wallet       ${fmtUnits(result.balances.veth)} vETH    ${fmtUnits(result.balances.vusd)} vUSD  ${C.d}(emergency capital)${C.x}`)
	console.log(`  governance   ${result.governance ? `honest quorum ${result.governance.honestQuorum}, ${result.governance.darkSigners} dark, ${result.governance.canReachQuorum ? 'reachable' : C.r + 'unreachable' + C.x}` : C.d + 'unavailable (' + result.governanceError + '), price only' + C.x}`)
	const p = result.plan!
	console.log(`\n  ${C.b}the workflow would${C.x}  ${p.action === 'HOLD' ? C.g : p.action === 'UNWIND' ? C.r : C.y}${p.action}${C.x}${p.deposit > 0n ? `  deposit ${fmtUnits(p.deposit)} vETH` : ''}${p.repay > 0n ? `  repay ${fmtUnits(p.repay)} vUSD` : ''}${p.action === 'PROTECT' || p.action === 'UNWIND' ? `  -> hf ${fmtHf(p.hfAfter)}` : ''}`)
	if ((p.action === 'PROTECT' || p.action === 'UNWIND') && !result.active) console.log(`  ${C.d}deposit and repay revert until the organisers call start(); nothing is sent${C.x}`)
	console.log()
}

async function join() {
	const pk = requireKey()
	const me = privateKeyToAccount(pk).address
	const s = await chainState()
	const gas = BigInt(String(await transport('eth_getBalance', [me, 'latest'])))
	if (gas === 0n) {
		console.error(`${C.r}${me} has no Sepolia ETH. Fund it first (any Sepolia faucet), then rerun.${C.x}`)
		process.exit(1)
	}
	if (!s.open) {
		console.error(`${C.r}registration is closed${C.x}`)
		process.exit(1)
	}
	const joined = await call<boolean>(LENDING, LENDING_ABI, 'isUser', [me])
	if (!joined) {
		console.log(`${C.d}join()...${C.x}`)
		const hash = await sendTx(pk, LENDING, encodeFunctionData({ abi: LENDING_ABI, functionName: 'join' }), 250_000n)
		const receipt = await waitFor(hash)
		if (receipt.status !== '0x1') throw new Error(`join reverted: ${ETHERSCAN}/tx/${hash}`)
		console.log(`${C.g}joined${C.x}  ${ETHERSCAN}/tx/${hash}`)
	} else console.log(`${C.d}already joined${C.x}`)

	// Approve both tokens once, now, so the enclave never has to spend a round trip on it mid-scenario.
	for (const [name, token] of [
		['vETH', VETH],
		['vUSD', VUSD],
	] as const) {
		const allowance = await call<bigint>(token, ERC20_ABI, 'allowance', [me, LENDING])
		if (allowance >= MAX_UINT256 / 2n) {
			console.log(`${C.d}${name} already approved${C.x}`)
			continue
		}
		const hash = await sendTx(pk, token, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [LENDING, MAX_UINT256] }), 80_000n)
		const receipt = await waitFor(hash)
		if (receipt.status !== '0x1') throw new Error(`${name} approve reverted: ${ETHERSCAN}/tx/${hash}`)
		console.log(`${C.g}${name} approved${C.x}  ${ETHERSCAN}/tx/${hash}`)
	}
	console.log(`\n${C.d}position: ${ETHERSCAN}/address/${me}${C.x}\n`)
	await status()
}

function engineConfig() {
	return { chainId: 11155111, lendingAddress: LENDING, vethAddress: VETH, vusdAddress: VUSD, rollcallApiUrl: process.env.ROLLCALL_API ?? cfg.rollcallApiUrl, market: cfg.market }
}

async function runTick(send: boolean) {
	const pk = requireKey()
	const rules = requireRules()
	console.log(`\n${C.b}TICK${C.x} ${send ? C.y + 'live, transactions will be sent' + C.x : C.d + 'dry run' + C.x}`)
	const result = await tick({ transport, fetcher, config: engineConfig(), privateKey: pk, rules, apiKey: process.env.SECRET_ROLLCALL_API_KEY, send, log: (l) => console.log(`  ${C.d}${l}${C.x}`) })
	console.log(`\n  state    ${C.b}${result.state}${C.x}`)
	if (result.plan) console.log(`  plan     ${result.plan.action}  deposit ${fmtUnits(result.plan.deposit)} vETH  repay ${fmtUnits(result.plan.repay)} vUSD  hf ${fmtHf(result.hf)} -> ${fmtHf(result.plan.hfAfter)}`)
	for (const h of result.txHashes) console.log(`  tx       ${ETHERSCAN}/tx/${h}`)
	console.log()
}

const cmd = process.argv[2] ?? 'status'
const main = async () => {
	if (cmd === 'keygen') return keygen()
	if (cmd === 'status') return status()
	if (cmd === 'join') return join()
	if (cmd === 'tick') return runTick(process.argv.includes('--send'))
	console.error(`unknown command ${cmd}. One of: keygen, status, join, tick [--send]`)
	process.exit(1)
}
main().catch((e) => {
	console.error(`${C.r}${e?.message ?? e}${C.x}`)
	process.exit(1)
})
