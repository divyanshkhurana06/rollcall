import { createHash } from 'node:crypto'

/**
 * HCS attestation archive.
 *
 * The moat is not the scan - anyone can recompute today's answer. It is the TIME SERIES.
 * "On 10 September this Safe's effective quorum was 2 and two signers had been dark for 300 days"
 * is worth little the day before an incident and a great deal the day after, to an insurer, a
 * post-mortem, or a DAO's counsel.
 *
 * So every report emits a compact, timestamped attestation to a Hedera Consensus Service topic.
 * We publish the DIGEST plus the headline metrics, never the full report: the archive stays cheap,
 * and consensus timestamps give an ordering nobody can retroactively forge.
 */

export interface Attestation {
  v: 1
  kind: 'rollcall.control-surface'
  target: string
  chain: string
  method: string
  digest: string
  at: number
  metrics: {
    threshold: number
    owners: number
    darkSigners: number
    liveSigners: number
    canReachThreshold: boolean
    effectiveQuorumMin: number
    effectiveQuorumMax: number
    dependentPairs: number
    txWindow: number
  }
  /** sha256 of the canonical attestation body - the thing to compare against a stored report. */
  bodyHash: string
}

export function buildAttestation(report: any): Attestation {
  const curve = report.inferred.quorumCurve
  const body: Omit<Attestation, 'bodyHash'> = {
    v: 1,
    kind: 'rollcall.control-surface',
    target: report.target.address,
    chain: report.target.chain,
    method: report.header.methodVersion,
    digest: report.header.inputDigest,
    at: Math.floor(Date.now() / 1000),
    metrics: {
      threshold: report.observed.threshold,
      owners: report.observed.owners.length,
      darkSigners: report.reachability.darkSigners,
      liveSigners: report.reachability.liveSigners,
      canReachThreshold: report.reachability.canStillReachThreshold,
      effectiveQuorumMin: Math.min(...curve.map((c: any) => c.effectiveQuorum)),
      effectiveQuorumMax: Math.max(...curve.map((c: any) => c.effectiveQuorum)),
      dependentPairs: report.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0).length,
      txWindow: report.header.txWindow.count,
    },
  }
  const bodyHash = '0x' + createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { ...body, bodyHash }
}

export interface Receipt {
  submitted: boolean
  topicId: string | null
  sequenceNumber: string | null
  consensusTimestamp: string | null
  explorer: string | null
  reason?: string
}

let clientPromise: Promise<any> | null = null

async function hederaClient() {
  const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, HEDERA_NETWORK } = process.env
  if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) return null
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Client, PrivateKey } = await import('@hashgraph/sdk')
      const c = (HEDERA_NETWORK ?? 'testnet') === 'mainnet' ? Client.forMainnet() : Client.forTestnet()
      c.setOperator(HEDERA_ACCOUNT_ID, PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY))
      return c
    })()
  }
  return clientPromise
}

export async function submitAttestation(a: Attestation): Promise<Receipt> {
  const topicId = process.env.HCS_TOPIC_ID ?? null
  const client = await hederaClient()
  if (!client || !topicId) {
    return { submitted: false, topicId, sequenceNumber: null, consensusTimestamp: null, explorer: null,
      reason: 'HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY / HCS_TOPIC_ID not configured' }
  }
  try {
    const { TopicMessageSubmitTransaction } = await import('@hashgraph/sdk')
    const tx = await new TopicMessageSubmitTransaction({ topicId, message: JSON.stringify(a) }).execute(client)
    const receipt = await tx.getReceipt(client)
    const net = process.env.HEDERA_NETWORK ?? 'testnet'
    return {
      submitted: true,
      topicId,
      sequenceNumber: receipt.topicSequenceNumber?.toString() ?? null,
      consensusTimestamp: null,
      explorer: `https://hashscan.io/${net}/topic/${topicId}`,
    }
  } catch (e: any) {
    return { submitted: false, topicId, sequenceNumber: null, consensusTimestamp: null, explorer: null, reason: e?.message ?? 'submit failed' }
  }
}

/** Read the archive back - this is the product, not the write path. */
export async function readArchive(target?: string, limit = 50) {
  const topicId = process.env.HCS_TOPIC_ID
  const net = process.env.HEDERA_NETWORK ?? 'testnet'
  if (!topicId) return { available: false, messages: [] as Attestation[], reason: 'HCS_TOPIC_ID not configured' }
  const base = net === 'mainnet' ? 'https://mainnet.mirrornode.hedera.com' : 'https://testnet.mirrornode.hedera.com'
  try {
    const res = await fetch(`${base}/api/v1/topics/${topicId}/messages?limit=${limit}&order=desc`)
    const body: any = await res.json()
    const messages: any[] = []
    for (const m of body.messages ?? []) {
      try {
        const decoded = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'))
        if (!target || decoded.target?.toLowerCase() === target.toLowerCase())
          messages.push({ ...decoded, consensusTimestamp: m.consensus_timestamp, sequenceNumber: m.sequence_number })
      } catch { /* not one of ours */ }
    }
    return { available: true, topicId, messages }
  } catch (e: any) {
    return { available: false, messages: [], reason: e?.message }
  }
}

/**
 * What changed since the previous attestation of the same target. The archive is a time series;
 * this is the first derivative. "Dark signers 1 -> 2 since 10 September" is the sentence the
 * archive exists to make provable.
 */
export type MetricDelta = { metric: string; from: number | boolean; to: number | boolean }
export interface AttestationDelta {
  target: string
  latestAt: number
  previousAt: number
  /** Seconds between the two attestations. */
  span: number
  changes: MetricDelta[]
}

export async function attestationDelta(target: string): Promise<AttestationDelta | null> {
  const archive = await readArchive(target, 50)
  const rows = (archive.messages as any[]).filter((m) => m?.metrics && typeof m.at === 'number').sort((a, b) => b.at - a.at)
  if (rows.length < 2) return null
  const [latest, previous] = rows
  const keys = ['threshold', 'owners', 'darkSigners', 'liveSigners', 'canReachThreshold', 'effectiveQuorumMin', 'effectiveQuorumMax', 'dependentPairs']
  const changes: MetricDelta[] = []
  for (const k of keys) {
    if (latest.metrics[k] !== previous.metrics[k]) changes.push({ metric: k, from: previous.metrics[k], to: latest.metrics[k] })
  }
  return { target, latestAt: latest.at, previousAt: previous.at, span: latest.at - previous.at, changes }
}
