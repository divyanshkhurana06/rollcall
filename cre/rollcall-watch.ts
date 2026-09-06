/**
 * Roll Call - control-surface watch as a Chainlink CRE Confidential Workflow.
 *
 * WHY THIS PART IS CONFIDENTIAL, AND NOT DECORATIVELY SO:
 *
 * A watchlist is an exposure map. If you can see which protocols an institution monitors, and at
 * what thresholds it de-risks, you know where its money is and what would make it move. That is
 * front-runnable, and it is exactly the information a monitoring service must hold.
 *
 * So the sensitive parts execute inside the TEE:
 *   - the watchlist (which protocols, and whose exposure they represent)
 *   - the per-subscriber trigger thresholds
 *   - the Roll Call API credential
 *   - the raw report, including per-signer liveness
 *
 * What leaves the enclave is only a boolean breach and a commitment to the report digest. The
 * onchain consumer learns THAT a control surface degraded past someone's tolerance, never whose
 * tolerance it was or what the underlying numbers are.
 *
 * Run:  cre workflow simulate ./cre/rollcall-watch.ts
 */
import { cre, type Runtime } from '@chainlink/cre-sdk'

interface Config {
  /** Public: where the breach flag is delivered. */
  consumerAddress: `0x${string}`
  chainSelector: string
  /** Public: how often we look. Cadence is not sensitive; the watchlist is. */
  schedule: string
}

interface WatchEntry {
  chain: string
  safe: string
  /** Breach if fewer than this many signers still show activity. */
  minLiveSigners: number
  /** Breach if effective quorum drops below this. */
  minEffectiveQuorum: number
  /** Breach if the margin before the Safe can no longer act falls to this or below. */
  minMarginToFrozen: number
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENTIAL: runs inside the TEE. Inputs, intermediate values and the raw
// report never leave the enclave.
// ─────────────────────────────────────────────────────────────────────────────
const evaluateWatchlist = async (runtime: Runtime<Config>): Promise<{ breached: boolean; count: number; digest: string }> => {
  // Secrets are fetched INSIDE the enclave - the host never observes them.
  const apiKey = await runtime.getSecret('ROLLCALL_API_KEY')
  const watchlistRaw = await runtime.getSecret('ROLLCALL_WATCHLIST')
  const watchlist: WatchEntry[] = JSON.parse(watchlistRaw)

  let breaches = 0
  const digests: string[] = []

  for (const entry of watchlist) {
    const res = await runtime.fetch({
      url: `${process.env.ROLLCALL_API}/report/${entry.chain}/${entry.safe}?max=200`,
      method: 'GET',
      headers: { 'X-PAYMENT': apiKey },
    })
    const body = JSON.parse(res.body)
    const r = body.report

    const liveSigners: number = r.reachability.liveSigners
    const margin: number = r.reachability.marginToFrozen
    const effectiveQuorum: number = Math.min(
      ...r.inferred.quorumCurve.map((c: { effectiveQuorum: number }) => c.effectiveQuorum),
    )

    // Threshold comparison happens in here. The thresholds themselves never leave.
    const breached =
      liveSigners < entry.minLiveSigners ||
      effectiveQuorum < entry.minEffectiveQuorum ||
      margin <= entry.minMarginToFrozen

    if (breached) breaches++
    digests.push(r.header.inputDigest)
  }

  // Only the aggregate crosses the enclave boundary, plus a commitment that lets a subscriber
  // prove later which reports this decision was made from - without revealing them now.
  return {
    breached: breaches > 0,
    count: breaches,
    digest: commit(digests),
  }
}

/** Order-independent commitment over the report digests this decision was based on. */
function commit(digests: string[]): string {
  const sorted = [...digests].sort()
  return cre.utils.keccak256(cre.utils.toBytes(sorted.join('|')))
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: consensus + onchain delivery. Only the breach flag and the commitment.
// ─────────────────────────────────────────────────────────────────────────────
const onSchedule = async (runtime: Runtime<Config>) => {
  const verdict = await runtime.handlerInTee(evaluateWatchlist)

  if (!verdict.breached) {
    runtime.log('no watchlist breach this cycle')
    return
  }

  const evm = cre.getClient(runtime.config.chainSelector)
  await evm.writeReport({
    address: runtime.config.consumerAddress,
    abi: 'function reportBreach(uint256 count, bytes32 commitment)',
    args: [verdict.count, verdict.digest],
  })

  runtime.log(`delivered breach flag: ${verdict.count} watched control surface(s) degraded`)
}

export const initWorkflow = (config: Config) => [
  cre.handler(cre.scheduler.cron({ schedule: config.schedule }), onSchedule),
]
