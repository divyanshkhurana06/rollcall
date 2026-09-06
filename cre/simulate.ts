import 'dotenv/config'

/**
 * Liquidation protection simulation.
 *
 * The challenge asks for a workflow that protects a virtual ETH-collateral / USDC-debt position
 * through simulated market movements. The CRE runtime executes the strategy in production; this
 * harness executes the SAME decision function over generated price paths so the strategy can be
 * judged on what it actually achieves:
 *
 *   1. did it avoid liquidation
 *   2. did it preserve the benefit of keeping the loan open, rather than panic closing
 *   3. did it use emergency capital efficiently
 *
 * A protection strategy that unwinds at the first wobble passes (1) and fails (2) and (3), which
 * is why all three are reported and none is reported alone.
 */

type Action = 'HOLD' | 'PARTIAL_REPAY' | 'ADD_COLLATERAL' | 'FULL_UNWIND'

interface Rules {
  liquidationThreshold: number
  interveneAtHealthFactor: number
  targetHealthFactor: number
  emergencyCapitalUsdc: number
  minHonestQuorum: number
  maxDarkSigners: number
}

interface Position { collateralEth: number; debtUsdc: number }
interface Governance { honestQuorum: number; darkSigners: number; canReachQuorum: boolean }

const hf = (p: Position, price: number, liq: number) =>
  p.debtUsdc === 0 ? Infinity : (p.collateralEth * price * liq) / p.debtUsdc

/** The identical decision logic the enclave runs. Kept in one shape so the sim cannot drift. */
export function decide(p: Position, price: number, gov: Governance, rules: Rules, capital: number) {
  const health = hf(p, price, rules.liquidationThreshold)

  if (gov.honestQuorum < rules.minHonestQuorum || gov.darkSigners > rules.maxDarkSigners || !gov.canReachQuorum) {
    return { action: 'FULL_UNWIND' as Action, sizeUsdc: p.debtUsdc, health, reason: 'control surface degraded' }
  }
  if (health <= rules.interveneAtHealthFactor) {
    const targetDebt = (p.collateralEth * price * rules.liquidationThreshold) / rules.targetHealthFactor
    const need = Math.max(0, p.debtUsdc - targetDebt)
    const size = Math.min(need, capital)
    return { action: 'PARTIAL_REPAY' as Action, sizeUsdc: size, health, reason: size < need ? 'capital exhausted' : 'below intervention point' }
  }
  return { action: 'HOLD' as Action, sizeUsdc: 0, health, reason: 'within tolerance' }
}

// --- price paths ------------------------------------------------------------------------------
function path(name: string, start: number, steps: number, seed: number): { name: string; prices: number[] } {
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const prices: number[] = [start]
  for (let i = 1; i < steps; i++) {
    const prev = prices[i - 1]
    let drift = 0
    if (name === 'crash') drift = -0.035
    else if (name === 'grind down') drift = -0.012
    else if (name === 'whipsaw') drift = i % 2 === 0 ? -0.03 : 0.028
    else if (name === 'recovery') drift = i < steps / 2 ? -0.03 : 0.03
    prices.push(Math.max(50, prev * (1 + drift + (rnd() - 0.5) * 0.02)))
  }
  return { name, prices }
}

const RULES: Rules = {
  liquidationThreshold: 0.825,
  interveneAtHealthFactor: 1.35,
  targetHealthFactor: 1.75,
  emergencyCapitalUsdc: 8_000,
  minHonestQuorum: 3,
  maxDarkSigners: 2,
}

const HEALTHY_GOV: Governance = { honestQuorum: 3, darkSigners: 1, canReachQuorum: true }

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

function run(prices: number[], gov: Governance, protect: boolean) {
  let pos: Position = { collateralEth: 10, debtUsdc: 18_000 }
  let capital = RULES.emergencyCapitalUsdc
  let interventions = 0
  let liquidated = false
  let closedAt: number | null = null

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i]
    const health = hf(pos, price, RULES.liquidationThreshold)
    if (health < 1) { liquidated = true; break }
    if (!protect || closedAt !== null) continue

    const d = decide(pos, price, gov, RULES, capital)
    if (d.action === 'PARTIAL_REPAY' && d.sizeUsdc > 0) {
      pos = { ...pos, debtUsdc: pos.debtUsdc - d.sizeUsdc }
      capital -= d.sizeUsdc
      interventions++
    } else if (d.action === 'FULL_UNWIND') {
      closedAt = i
      interventions++
      break
    }
  }

  const finalPrice = prices[Math.min(prices.length - 1, closedAt ?? prices.length - 1)]
  const equity = liquidated ? 0 : pos.collateralEth * finalPrice - pos.debtUsdc
  return { liquidated, interventions, capitalUsed: RULES.emergencyCapitalUsdc - capital, equity, stillOpen: closedAt === null && !liquidated }
}

console.log(`\n${C.b}LIQUIDATION PROTECTION${C.x} ${C.d}Chainlink CRE Confidential Workflow, simulated${C.x}`)
console.log(`${C.d}${'-'.repeat(84)}${C.x}`)
console.log(`  position   10 ETH collateral / 18,000 USDC debt, liq threshold ${RULES.liquidationThreshold}`)
console.log(`  rules      intervene at HF ${RULES.interveneAtHealthFactor}, restore to ${RULES.targetHealthFactor}, ${RULES.emergencyCapitalUsdc.toLocaleString()} USDC emergency capital`)
console.log(`  ${C.d}all of the above lives inside the enclave. Only an action and a size leave it.${C.x}\n`)

console.log(`  ${'path'.padEnd(13)} ${'unprotected'.padEnd(14)} ${'protected'.padEnd(14)} ${'actions'.padEnd(8)} ${'capital used'.padEnd(13)} equity kept`)
console.log(`  ${C.d}${'-'.repeat(82)}${C.x}`)

for (const name of ['crash', 'grind down', 'whipsaw', 'recovery']) {
  const { prices } = path(name, 2400, 40, 7)
  const bare = run(prices, HEALTHY_GOV, false)
  const prot = run(prices, HEALTHY_GOV, true)
  const bareTxt = bare.liquidated ? `${C.r}LIQUIDATED${C.x}   ` : `${C.g}survived${C.x}     `
  const protTxt = prot.liquidated ? `${C.r}LIQUIDATED${C.x}   ` : prot.stillOpen ? `${C.g}open${C.x}         ` : `${C.y}unwound${C.x}      `
  console.log(`  ${name.padEnd(13)} ${bareTxt} ${protTxt} ${String(prot.interventions).padEnd(8)} ${('$' + prot.capitalUsed.toFixed(0)).padEnd(13)} $${prot.equity.toFixed(0)}`)
}

// --- the governance trigger -------------------------------------------------------------------
console.log(`\n${C.b}THE TRIGGER NOBODY ELSE HAS${C.x}`)
const flat = Array.from({ length: 40 }, () => 2400)
const healthy = run(flat, HEALTHY_GOV, true)
const degraded = run(flat, { honestQuorum: 1, darkSigners: 4, canReachQuorum: false }, true)
console.log(`  Price is flat at $2,400 and the health factor never moves. Same position, both runs.`)
console.log(`    control surface healthy    -> ${healthy.stillOpen ? C.g + 'position stays open' + C.x : 'closed'}, ${healthy.interventions} action(s)`)
console.log(`    control surface degraded   -> ${degraded.stillOpen ? 'stays open' : C.y + 'position unwound' + C.x}, ${degraded.interventions} action(s)`)
console.log(`  ${C.d}Honest quorum fell to 1, four signers dark, quorum unreachable. No price feed on earth`)
console.log(`  ${C.d}reports that, and every other liquidation protection would have held the position.${C.x}\n`)
