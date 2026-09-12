import type { Request, Response } from 'express'
import { resolveTarget } from '../../../packages/core/src/resolve.js'
import { fetchSafe } from '../../../packages/core/src/extract/safeapi.js'
import { accountExposure } from '../../../packages/core/src/exposure.js'
import { loadProtocolScan } from '../../../packages/core/src/protocolScan.js'
import { narrative } from '../../../packages/core/src/narrative.js'
import type { ChainKey } from '../../../packages/core/src/chain.js'
import { payFor } from '../../../packages/agent/src/x402client.js'
import { quote } from './x402.js'

/**
 * Ask Roll Call a question, and watch it earn the answer.
 *
 * The agent behind this box does what an agent would: works out which protocol you mean, resolves
 * the contract to the keys above it, prices the report, reads what money sits behind those keys
 * through The Graph, pays for the report over x402 with its own wallet, and only then answers.
 * Every step streams to the page as it happens. With an ANTHROPIC_API_KEY the last step is a
 * model answering from the report's numbers and tiers; without one it is the report in sentences.
 * Either way the answer is grounded in a report that was paid for and attested to HCS.
 */

type Send = (event: string, data: unknown) => void

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${n.toFixed(0)}`)

function findTarget(question: string, chain: ChainKey) {
  const addr = question.match(/0x[0-9a-fA-F]{40}/)?.[0]
  if (addr) return { address: addr, label: addr, protocol: null as any }
  const rows: any[] = loadProtocolScan()?.rows ?? []
  const q = question.toLowerCase()
  const hits = rows
    .filter((r) => q.includes(String(r.protocol).toLowerCase()))
    .sort((a, b) => String(b.protocol).length - String(a.protocol).length || (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
  if (hits.length) return { address: hits[0].address, label: `${hits[0].protocol} ${hits[0].role}`, protocol: hits[0] }
  return null
}

function scanSummary() {
  const scan = loadProtocolScan()
  const rows: any[] = (scan?.rows ?? []).filter((r) => r.status === 'measured').sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
  return {
    generatedAt: scan?.generatedAt,
    totalValueUsd: scan?.totalValueUsd,
    valueOneKeyFromFrozen: scan?.valueOneKeyFromFrozen,
    valueBehindWeakQuorum: scan?.valueBehindWeakQuorum,
    rows: rows.slice(0, 20).map((r) => ({ protocol: r.protocol, role: r.role, valueUsd: r.valueUsd, declared: `${r.threshold} of ${r.owners}`, honestQuorum: r.honestQuorum, darkSigners: r.darkSigners, marginToFrozen: r.marginToFrozen, timeToHarmHours: r.timeToHarmHours, canStillReachThreshold: r.canStillReachThreshold })),
  }
}

async function answerWithModel(question: string, facts: unknown, send: Send): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: key })
  const system = [
    'You are Roll Call, a governance security analyst for protocol multisigs. Answer the user in plain English in at most 130 words.',
    'Use ONLY the facts provided. Every number you cite must appear in the facts. Name the tier when it matters: observed (read from chain), tested (p-value), inferred (effective quorum).',
    '"Dark" means no onchain signal from that key in the window searched, not that the person is gone. Never invent addresses, dates or amounts. If the facts cannot answer, say what they can.',
    'Do not use markdown headings. Short sentences. End with one sentence on what the reader should do with this.',
  ].join(' ')
  const stream = client.messages.stream({
    model: process.env.ASK_MODEL ?? 'claude-sonnet-5',
    max_tokens: 450,
    system,
    messages: [{ role: 'user', content: `Question: ${question}\n\nFacts (JSON):\n${JSON.stringify(facts)}` }],
  })
  let text = ''
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      text += ev.delta.text
      send('token', ev.delta.text)
    }
  }
  return text
}

export async function ask(req: Request, res: Response, api: string) {
  const question = String(req.query.q ?? '').trim().slice(0, 400)
  const chain = (String(req.query.chain ?? 'ethereum') as ChainKey)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send: Send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const end = () => res.end()

  try {
    if (!question) {
      send('error', 'ask something, like "is the Base bridge safe to use?"')
      return end()
    }
    const target = findTarget(question, chain)

    // No specific protocol: answer across the scan, no payment needed.
    if (!target) {
      send('step', { name: 'scan', text: 'no single protocol named; reading the protocol scan' })
      const facts = { mode: 'scan', scan: scanSummary() }
      send('step', { name: 'scan', text: `${facts.scan.rows.length} measured protocols, ${usd(facts.scan.totalValueUsd ?? 0)} read from chain state`, done: true })
      const text = await answerWithModel(question, facts, send)
      if (!text) {
        const top = facts.scan.rows.slice(0, 5).map((r) => `${r.protocol} ${r.role}: ${usd(r.valueUsd)}, declared ${r.declared}, honest quorum ${r.honestQuorum}, ${r.darkSigners} dark, margin ${r.marginToFrozen}${r.timeToHarmHours === 0 ? ', no timelock' : ''}`)
        send('answer', `Across ${facts.scan.rows.length} measured protocol contracts, ${usd(facts.scan.totalValueUsd ?? 0)} was read from chain state. ${usd(facts.scan.valueOneKeyFromFrozen ?? 0)} sits behind a signer set with zero margin. The largest: ${top.join('; ')}. Name a protocol to have the agent pay for its full report.`)
      }
      send('done', { mode: 'scan' })
      return end()
    }

    // 1. resolve
    send('step', { name: 'resolve', text: `working out what ${target.label} is` })
    const resolution: any = await resolveTarget(chain, target.address)
    if (!resolution.safe) {
      send('step', { name: 'resolve', text: resolution.message ?? 'nothing to measure', done: true })
      send('answer', `${target.label} resolves to ${resolution.kind?.replace(/-/g, ' ') ?? 'something Roll Call cannot measure'}. ${resolution.message ?? ''} ${resolution.hint ?? ''}`.trim())
      send('done', { mode: 'dead-end', resolution })
      return end()
    }
    send('step', { name: 'resolve', text: `${resolution.kind.replace(/-/g, ' ')}: the keys are Safe ${resolution.safe.slice(0, 10)}…${resolution.via ? ` via ${resolution.via}` : ''}`, done: true, safe: resolution.safe })

    // 2. price
    send('step', { name: 'quote', text: 'pricing the report by the work it takes' })
    const safe = await fetchSafe(chain, resolution.safe)
    if (!safe) throw new Error('not a readable Safe')
    const q = quote({ signers: safe.owners.length, txs: Math.min(safe.nonce, 100), chains: 1, permutations: 2000 })
    send('step', { name: 'quote', text: `${safe.threshold} of ${safe.owners.length}, ${safe.nonce} transactions on record: ${q.hbar} HBAR`, done: true, quote: q })

    // 3. exposure through The Graph
    send('step', { name: 'graph', text: 'reading what money sits behind these keys, one standardized query across the registry' })
    const exposure = await accountExposure(resolution.safe).catch(() => null)
    send('step', { name: 'graph', text: exposure ? `${exposure.queriedProtocols} standardized deployments answered, ${exposure.protocolsWithExposure} with open positions` : 'gateway not configured', done: true })

    // 4. pay
    send('step', { name: 'pay', text: 'paying for the report over x402 on Hedera with the agent wallet' })
    const accountId = process.env.HEDERA_ACCOUNT_ID
    const privateKey = process.env.HEDERA_PRIVATE_KEY
    if (!accountId || !privateKey) throw new Error('the agent wallet is not configured on this host')
    const paid = await payFor({ api, path: `/report/${chain}/${resolution.safe}?max=100&perms=2000`, accountId, privateKey, asset: String(req.query.asset ?? 'hbar') })
    if (paid.status !== 200) throw new Error(paid.body?.error ?? `payment failed (${paid.status})`)
    const b = paid.body
    send('step', {
      name: 'pay',
      text: `settled ${b.settlement?.asset === '0.0.0' ? `${b.settlement.hbar} HBAR` : `${b.settlement?.amount} units of ${b.settlement?.asset}`} through the facilitator, attested to HCS as sequence ${b.receipt?.sequenceNumber ?? '?'}`,
      done: true,
      settlement: b.settlement,
      receipt: b.receipt,
    })

    // 5. answer
    const r = b.report
    const curve: { effectiveQuorum: number }[] = r.inferred.quorumCurve
    const facts = {
      mode: 'report',
      target: target.label,
      protocol: target.protocol ? { protocol: target.protocol.protocol, role: target.protocol.role, valueUsd: target.protocol.valueUsd, authorityPath: target.protocol.authorityPath, timeToHarmHours: target.protocol.timeToHarmHours } : null,
      safe: resolution.safe,
      declared: { threshold: r.observed.threshold, owners: r.observed.owners.length, version: r.observed.version, executionsAnalysed: r.observed.executionsAnalysed },
      inferred: { honestQuorum: Math.min(...curve.map((c) => c.effectiveQuorum)), verdict: r.inferred.robustness?.verdict },
      tested: { dependentPairs: r.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0).length, pairsTested: r.tested.independence.length },
      observed: { darkSigners: r.reachability.darkSigners, liveSigners: r.reachability.liveSigners, darkAfterDays: r.reachability.darkAfterDays, canStillReachThreshold: r.reachability.canStillReachThreshold, marginToFrozen: r.reachability.marginToFrozen, indeterminate: r.reachability.indeterminateSigners },
      signers: (r.liveness ?? []).map((l: any) => ({ signer: l.signer, daysSinceAnySignal: l.daysSinceAnySignal, indeterminate: l.indeterminate })),
      exposure: exposure ? { queriedProtocols: exposure.queriedProtocols, protocolsWithExposure: exposure.protocolsWithExposure, openPositions: exposure.openPositions, exposedProtocolTvlUsd: exposure.exposedProtocolTvlUsd } : null,
      since: b.since,
      narrative: b.narrative,
      paidWith: b.settlement,
      attestation: b.receipt,
    }
    send('facts', facts)
    const text = await answerWithModel(question, facts, send)
    if (!text) send('answer', [b.narrative?.headline, ...(b.narrative?.sentences ?? [])].filter(Boolean).join(' '))
    send('done', { mode: 'report', safe: resolution.safe, report: r, narrative: b.narrative, since: b.since, settlement: b.settlement, receipt: b.receipt })
    end()
  } catch (e: any) {
    send('error', e?.message ?? 'ask failed')
    end()
  }
}
