/**
 * The report, in sentences.
 *
 * A grid of tiered numbers is correct and unreadable. This turns the same numbers into the four or
 * five sentences a person would say out loud, in the order they matter: what the keys control, how
 * many of them really decide, whether they are awake, how fast harm arrives, and what would freeze it.
 * Every sentence maps to one number in the report, and it says which tier that number belongs to
 * when the tier is not obvious.
 */

export interface NarrativeContext {
  /** From the protocol scan, when the target was a protocol contract that resolved to this Safe. */
  protocol?: { protocol: string; role: string; valueUsd: number; authorityPath?: string; timeToHarmHours?: number | null; timeToHarmMeasured?: boolean } | null
}

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`)
const plural = (n: number, s: string, p = `${s}s`) => `${n} ${n === 1 ? s : p}`

export function narrative(report: any, ctx: NarrativeContext = {}): { headline: string; sentences: string[]; verdict: 'critical' | 'warning' | 'sound' } {
  const o = report.observed
  const R = report.reachability
  const curve: { effectiveQuorum: number }[] = report.inferred?.quorumCurve ?? []
  const honest = curve.length ? Math.min(...curve.map((c) => c.effectiveQuorum)) : o.threshold
  const dep = (report.tested?.independence ?? []).filter((p: any) => p.pValue < 0.01 && p.excess > 0).length
  const p = ctx.protocol
  const sentences: string[] = []

  // 1. What the keys control.
  if (p) {
    sentences.push(
      `${p.protocol}'s ${p.role} holds ${usd(p.valueUsd)}. It can be changed by a ${o.threshold}-of-${o.owners.length} Safe${p.authorityPath ? ` (${p.authorityPath.replace(/->/g, '→')})` : ''}.`,
    )
  } else {
    sentences.push(`This is a ${o.threshold}-of-${o.owners.length} Safe with ${plural(o.nonce, 'transaction')} on record; ${o.executionsAnalysed} were analysed.`)
  }

  // 2. How many really decide (inferred), and whether they are independent (tested).
  if (honest < o.threshold) {
    sentences.push(
      `Inferred: only ${plural(honest, 'independent party', 'independent parties')} ${honest === 1 ? 'is' : 'are'} really required, not ${o.threshold}. ${dep > 0 ? `${plural(dep, 'pair')} of signers co-sign far more than chance allows (p < 0.01).` : 'The declared threshold overstates who decides.'}`,
    )
  } else if (dep > 0) {
    sentences.push(`Tested: ${plural(dep, 'pair')} of signers co-sign more than chance allows, though the honest quorum still matches the declared ${o.threshold}.`)
  } else {
    sentences.push(`Tested: the signers act independently as far as ${o.executionsAnalysed} transactions can show, and the honest quorum matches the declared ${o.threshold}.`)
  }

  // 3. Are they awake (observed).
  if (R.darkSigners > 0) {
    const names = (R.darkList ?? []).slice(0, 3).map((a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(', ')
    sentences.push(
      `Observed: ${plural(R.darkSigners, 'signer')} ${R.darkSigners === 1 ? 'has' : 'have'} shown no onchain signal in ${R.darkAfterDays}+ days${names ? ` (${names})` : ''}. ${R.canStillReachThreshold ? `The remaining ${R.liveSigners} can still reach the threshold` : `The remaining ${R.liveSigners} cannot reach the threshold of ${o.threshold}: this control surface is frozen on the evidence searched`}.`,
    )
  } else if (R.indeterminateSigners > 0) {
    sentences.push(`Observed: all signers are live where the search could see; ${plural(R.indeterminateSigners, 'signer')} could not be classified because a provider limit was hit, and the report says so rather than guessing.`)
  } else {
    sentences.push(`Observed: all ${o.owners.length} signers have signed or transacted within ${R.darkAfterDays} days.`)
  }

  // 4. The margin: how many more can be lost before nothing can happen.
  if (R.marginToFrozen <= 0 && R.canStillReachThreshold) {
    sentences.push(`Margin to frozen is zero: losing any one more key means the threshold can never be met again, and no one can pause, upgrade or recover.`)
  } else if (R.marginToFrozen > 0) {
    sentences.push(`${plural(R.marginToFrozen, 'more key')} could go dark before the threshold becomes unreachable.`)
  }

  // 5. How fast harm arrives.
  if (p && p.timeToHarmHours !== undefined && p.timeToHarmHours !== null) {
    sentences.push(
      p.timeToHarmHours === 0
        ? `There is no timelock: a valid signature set takes effect in the next block.`
        : `A timelock of ${p.timeToHarmHours} hours stands between a signature and its effect${p.timeToHarmMeasured ? '' : ' (declared, not measured)'}.`,
    )
  }

  const critical = !R.canStillReachThreshold || (p && R.marginToFrozen <= 0 && p.timeToHarmHours === 0) || honest === 1
  const warning = R.darkSigners > 0 || honest < o.threshold || R.marginToFrozen <= 0 || dep > 0
  const verdict = critical ? 'critical' : warning ? 'warning' : 'sound'

  const headline = p
    ? `${usd(p.valueUsd)} moved by ${honest === o.threshold ? `${o.threshold} signers` : `${honest} of a declared ${o.threshold}`}, ${R.darkSigners > 0 ? `${R.darkSigners} dark` : 'all awake'}, margin ${R.marginToFrozen}${p.timeToHarmHours === 0 ? ', no timelock' : ''}`
    : `${o.threshold}-of-${o.owners.length}, honest quorum ${honest}, ${R.darkSigners > 0 ? `${R.darkSigners} dark` : 'all awake'}, margin ${R.marginToFrozen}`

  return { headline, sentences, verdict }
}
