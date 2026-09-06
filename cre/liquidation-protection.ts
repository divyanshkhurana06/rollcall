/**
 * Automated Liquidation Protection - a Chainlink CRE Confidential Workflow.
 *
 * THE HONEST FRAMING, BECAUSE IT MATTERS:
 *
 * The challenge asks for a workflow that protects a virtual ETH-collateral / USDC-debt position
 * through simulated market movements while keeping the protection rules private. That is the spec
 * and it is implemented here in full.
 *
 * What Roll Call adds is a second trigger that no liquidation protection currently considers.
 * Every existing system watches ONE variable: price. But a lending position can become unsafe for
 * a reason that never touches the price feed - the protocol holding your collateral loses quorum,
 * or its signer set turns out to be one party wearing several hats. If the people who can pause,
 * upgrade or seize that market are asleep or coordinated, the correct response is to de-risk the
 * position, and no health factor will ever tell you that.
 *
 * So the protection rule set is:
 *
 *   MARKET      health factor approaches the private liquidation threshold  -> deleverage
 *   GOVERNANCE  the market's control surface degrades past a private bound  -> de-risk regardless
 *                                                                              of how healthy the
 *                                                                              position looks
 *
 * WHY THE ENCLAVE IS LOAD BEARING, NOT DECORATIVE:
 *
 * A protection strategy is front-runnable in both directions. Publishing the health factor at which
 * you deleverage tells an adversary exactly where to push the price to force your hand, and how much
 * emergency capital you are holding tells them how far they can push before you run out. The
 * governance bounds are worse: they are a map of which protocols you have decided you do not trust.
 *
 * Inside the TEE:  thresholds, emergency capital, the position, the API credential, and every
 *                  intermediate calculation.
 * Leaving the TEE: an action enum, a size, and a commitment to the inputs that produced them.
 *
 * Run:  cre workflow simulate ./cre/liquidation-protection.ts
 */
import { cre, type Runtime } from '@chainlink/cre-sdk'

interface Config {
  consumerAddress: `0x${string}`
  chainSelector: string
  schedule: string
  /** Public and deliberately so: cadence is not sensitive, thresholds are. */
  market: string
}

type Action = 'HOLD' | 'PARTIAL_REPAY' | 'ADD_COLLATERAL' | 'FULL_UNWIND'

interface ProtectionRules {
  /** Liquidation threshold of the market, e.g. 0.825 for ETH on Aave v3. */
  liquidationThreshold: number
  /** Health factor at which we act. Private: this is the number an adversary wants. */
  interveneAtHealthFactor: number
  /** Health factor we restore to. Overshooting wastes the carry, undershooting invites a repeat. */
  targetHealthFactor: number
  /** Emergency capital available, in USDC. Private: this is how far we can be pushed. */
  emergencyCapitalUsdc: number
  /** Minimum honest quorum we require of the market's control surface. */
  minHonestQuorum: number
  /** Maximum signers allowed to be dark before we de-risk regardless of price. */
  maxDarkSigners: number
}

interface Position {
  collateralEth: number
  debtUsdc: number
  ethPriceUsd: number
}

const healthFactor = (p: Position, liqThreshold: number) =>
  p.debtUsdc === 0 ? Infinity : (p.collateralEth * p.ethPriceUsd * liqThreshold) / p.debtUsdc

// ---------------------------------------------------------------------------------------------
// CONFIDENTIAL. Everything below runs inside the enclave.
// ---------------------------------------------------------------------------------------------
const decideProtection = async (
  runtime: Runtime<Config>,
): Promise<{ action: Action; sizeUsdc: number; reason: string; commitment: string }> => {
  const rules: ProtectionRules = JSON.parse(await runtime.getSecret('PROTECTION_RULES'))
  const apiKey = await runtime.getSecret('ROLLCALL_API_KEY')

  // --- market leg -----------------------------------------------------------------------------
  const priceRes = await runtime.fetch({ url: `${process.env.PRICE_FEED}/eth-usd`, method: 'GET' })
  const ethPriceUsd = Number(JSON.parse(priceRes.body).price)

  const posRes = await runtime.fetch({ url: `${process.env.POSITION_API}/position`, method: 'GET' })
  const raw = JSON.parse(posRes.body)
  const position: Position = {
    collateralEth: Number(raw.collateralEth),
    debtUsdc: Number(raw.debtUsdc),
    ethPriceUsd,
  }

  const hf = healthFactor(position, rules.liquidationThreshold)

  // --- governance leg: the part nobody else does ----------------------------------------------
  const rcRes = await runtime.fetch({
    url: `${process.env.ROLLCALL_API}/report/ethereum/${runtime.config.market}?max=150`,
    method: 'GET',
    headers: { 'X-PAYMENT': apiKey },
  })
  const report = JSON.parse(rcRes.body).report
  const honestQuorum = Math.min(
    ...report.inferred.quorumCurve.map((c: { effectiveQuorum: number }) => c.effectiveQuorum),
  )
  const darkSigners: number = report.reachability.darkSigners
  const canReachQuorum: boolean = report.reachability.canStillReachThreshold

  const governanceBreach =
    honestQuorum < rules.minHonestQuorum ||
    darkSigners > rules.maxDarkSigners ||
    !canReachQuorum

  // --- decide ----------------------------------------------------------------------------------
  let action: Action = 'HOLD'
  let sizeUsdc = 0
  let reason = 'within tolerance'

  if (governanceBreach) {
    // A market that cannot be paused, or whose quorum is smaller than it claims, is not a market
    // to hold leverage in. Price says nothing about this and never will.
    action = 'FULL_UNWIND'
    sizeUsdc = position.debtUsdc
    reason = 'control surface degraded'
  } else if (hf <= rules.interveneAtHealthFactor) {
    // Repay the minimum that restores the target. Closing the whole position would forfeit the
    // carry the loan exists to earn, which the challenge explicitly asks us to preserve.
    const targetDebt = (position.collateralEth * ethPriceUsd * rules.liquidationThreshold) / rules.targetHealthFactor
    const repayNeeded = Math.max(0, position.debtUsdc - targetDebt)

    if (repayNeeded <= rules.emergencyCapitalUsdc) {
      action = 'PARTIAL_REPAY'
      sizeUsdc = Math.ceil(repayNeeded)
      reason = 'health factor below intervention point'
    } else {
      // Emergency capital cannot restore the target. Spend what we have rather than nothing:
      // every dollar repaid moves the liquidation price further away.
      action = 'PARTIAL_REPAY'
      sizeUsdc = Math.floor(rules.emergencyCapitalUsdc)
      reason = 'emergency capital exhausted, partial protection applied'
    }
  }

  // A commitment lets us prove afterwards which inputs drove the decision, without revealing them
  // now. The Roll Call digest is already a commitment to one timestamped assessment.
  const commitment = cre.utils.keccak256(
    cre.utils.toBytes([report.header.inputDigest, hf.toFixed(6), String(ethPriceUsd), action, String(sizeUsdc)].join('|')),
  )

  return { action, sizeUsdc, reason, commitment }
}

// ---------------------------------------------------------------------------------------------
// PUBLIC. Consensus and onchain delivery: an action, a size, and a commitment. Nothing else.
// ---------------------------------------------------------------------------------------------
const ACTION_CODE: Record<Action, number> = { HOLD: 0, PARTIAL_REPAY: 1, ADD_COLLATERAL: 2, FULL_UNWIND: 3 }

const onSchedule = async (runtime: Runtime<Config>) => {
  const decision = await runtime.handlerInTee(decideProtection)

  if (decision.action === 'HOLD') {
    runtime.log('position within tolerance, no action')
    return
  }

  const evm = cre.getClient(runtime.config.chainSelector)
  await evm.writeReport({
    address: runtime.config.consumerAddress,
    abi: 'function protect(uint8 action, uint256 sizeUsdc, bytes32 commitment)',
    args: [ACTION_CODE[decision.action], decision.sizeUsdc, decision.commitment],
  })

  // The reason is logged, never written on chain: it would leak which rule fired.
  runtime.log(`action ${decision.action} size ${decision.sizeUsdc} (${decision.reason})`)
}

export const initWorkflow = (config: Config) => [
  cre.handler(cre.scheduler.cron({ schedule: config.schedule }), onSchedule),
]
