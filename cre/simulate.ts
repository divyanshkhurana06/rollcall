import { config as loadEnv } from 'dotenv'
import { OFFICIAL_SCENARIOS, START, fmtHf, fmtUnits, worstCase } from './liquidation-protection/scenarios'
import { parseRules, type Governance } from './liquidation-protection/strategy'

/**
 * Liquidation protection, walked through the challenge's own scenarios.
 *
 * The CRE runtime executes the strategy inside the enclave; this harness executes the SAME decision
 * function (`strategy.ts`) over the five market scenarios published in the challenge README, against
 * a model of ChallengeLending that uses the contract's arithmetic: two-decimal units, calcHF,
 * liquidation at hf <= 100 with the partial liquidation formula, and the time-weighted debt behind
 * loanContinuityScore.
 *
 * The organisers control whether the liquidation check runs before or after workflows get to react
 * to a price update. Every number below is the worse of the two orderings.
 */

loadEnv({ path: 'cre/.env', quiet: true })

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const EXAMPLE = '{"triggerHf":112,"targetHf":125,"criticalHf":102,"maxDepositUnits":300,"maxRepayPct":20,"preferDeposit":true,"cooldownBlocks":10,"minHonestQuorum":2,"maxDarkSigners":2}'
const rules = parseRules(process.env.SECRET_PROTECTION_RULES ?? EXAMPLE)
const HEALTHY: Governance = { honestQuorum: 3, darkSigners: 0, canReachQuorum: true }

console.log(`\n${C.b}LIQUIDATION PROTECTION${C.x} ${C.d}the five published scenarios, worst ordering of price update and liquidation check${C.x}`)
console.log(`${C.d}${'-'.repeat(96)}${C.x}`)
console.log(`  position   ${fmtUnits(START.collateral)} vETH collateral / ${fmtUnits(START.debt)} vUSD debt, hf 1.11 at 2000.00, liquidated at hf <= 1.00`)
console.log(`  wallet     ${fmtUnits(START.walletVeth)} vETH + ${fmtUnits(START.walletVusd)} vUSD of emergency capital`)
console.log(`  rules      ${C.d}private. Loaded from cre/.env, never printed.${C.x}\n`)

console.log(`  ${'scenario'.padEnd(18)} ${'unprotected'.padEnd(20)} ${'protected'.padEnd(11)} ${'min hf'.padEnd(8)} ${'actions'.padEnd(8)} ${'vETH used'.padEnd(10)} ${'vUSD used'.padEnd(10)} loan open`)
console.log(`  ${C.d}${'-'.repeat(94)}${C.x}`)

for (const s of OFFICIAL_SCENARIOS) {
	const bare = worstCase(s.prices, null)
	const prot = worstCase(s.prices, rules, HEALTHY)
	const bareTxt = bare.survived ? `${C.g}survived${C.x}            ` : `${C.r}LIQUIDATED${C.x} ${C.d}hf ${fmtHf(bare.minHf)}${C.x}   `
	const protTxt = prot.survived ? `${C.g}survived${C.x}   ` : `${C.r}LIQUIDATED${C.x} `
	console.log(
		`  ${s.name.padEnd(18)} ${bareTxt} ${protTxt} ${fmtHf(prot.minHf).padEnd(8)} ${String(prot.interventions).padEnd(8)} ${fmtUnits(prot.vethUsed).padEnd(10)} ${fmtUnits(prot.vusdUsed).padEnd(10)} ${(prot.continuityBp / 100).toFixed(0)}%`,
	)
}

console.log(`\n  ${C.d}Every published path, including "safe volatility", liquidates the untouched position: at 1800.00 the`)
console.log(`  ${C.d}health factor is 1.0029, which the contract truncates to 100 and liquidates. The path is 2000 -> 1800.${C.x}`)

console.log(`\n${C.b}WHAT EACH INTERVENTION DID${C.x}`)
for (const s of OFFICIAL_SCENARIOS) {
	const prot = worstCase(s.prices, rules, HEALTHY)
	console.log(`  ${C.b}${s.name}${C.x}  ${C.d}${s.prices.join(' -> ')}   expected: ${s.expected}${C.x}`)
	for (const line of prot.log.filter((l) => !l.endsWith(' hold'))) console.log(`    ${C.d}${line}${C.x}`)
}

console.log(`\n${C.b}THE TRIGGER NOBODY ELSE HAS${C.x}`)
const flat = [2000, 2000, 2000, 2000]
const healthy = worstCase(flat, rules, HEALTHY)
const degraded = worstCase(flat, rules, { honestQuorum: 1, darkSigners: 4, canReachQuorum: false })
console.log(`  Price is flat at 2000.00 and the health factor never moves. Same position, both runs.`)
console.log(`    control surface healthy    -> ${healthy.vusdUsed === 0n ? C.g + 'loan stays open' + C.x : 'repaid'}, ${healthy.interventions} action(s), loan open ${(healthy.continuityBp / 100).toFixed(0)}%`)
console.log(`    control surface degraded   -> ${degraded.vusdUsed > 0n ? C.y + 'position unwound' + C.x : 'held'}, ${degraded.interventions} action(s), ${fmtUnits(degraded.vusdUsed)} vUSD repaid`)
console.log(`  ${C.d}Honest quorum fell to 1, four signers dark, quorum unreachable. No price feed reports that, and`)
console.log(`  ${C.d}every other liquidation protection would have held the position.${C.x}\n`)
