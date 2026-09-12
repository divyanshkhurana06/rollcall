import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { buildReport } from '../../../packages/core/src/report.js'
import { fetchSafe } from '../../../packages/core/src/extract/safeapi.js'
import { calibrate } from '../../../packages/core/src/validate.js'
import { loadLeaderboard } from '../../../packages/core/src/leaderboard.js'
import { loadProtocolScan } from '../../../packages/core/src/protocolScan.js'
import { resolveTarget } from '../../../packages/core/src/resolve.js'
import { REGISTRY, STANDARDIZED, EXPOSURE_QUERY } from '../../../packages/core/src/exposure.js'
import type { ChainKey } from '../../../packages/core/src/chain.js'
import { gate, quote, x402Config } from './x402.js'
import { describe, issue } from './subscriptions.js'
import { register as registerRenewal, check as checkRenewal, list as listRenewals, pendingFor } from './renewals.js'
import { payFor } from '../../../packages/agent/src/x402client.js'
import { challengeSnapshot, jsonSafe } from './challenge.js'
import { narrative } from '../../../packages/core/src/narrative.js'
import { ask } from './ask.js'
import { existsSync, readFileSync } from 'node:fs'

/** ERC-8004 registrations, written by `npm run agent:register`. Absent until then. */
function agentIdentity() {
  try {
    return existsSync('data/agent-identity.json') ? JSON.parse(readFileSync('data/agent-identity.json', 'utf8')) : null
  } catch {
    return null
  }
}
import { buildAttestation, submitAttestation, readArchive, attestationDelta, recentAttestations } from './hcs.js'

const app = express()
app.use(cors())
app.use(express.json())

const cache = new Map<string, { at: number; report: any }>()
const TTL = 1000 * 60 * 10

app.get('/health', (_req, res) =>
  res.json({
    ok: true, service: 'rollcall',
    x402: { network: x402Config.network, asset: x402Config.asset, facilitator: x402Config.facilitator, payTo: x402Config.payTo || null },
    hcsTopic: process.env.HCS_TOPIC_ID ?? null,
    discovery: '/.well-known/x402',
  }),
)

/**
 * Free: how an agent finds this service without a human reading docs.
 *
 * Every paid resource, how it is priced, which network settles it, where the audit trail lives,
 * and how to buy credits for a runtime that cannot sign. The manifest is what a directory would
 * index.
 */
app.get('/.well-known/x402', (_req, res) => {
  const topic = process.env.HCS_TOPIC_ID ?? null
  const perReport = quote({ signers: 8, txs: 150, chains: 1, permutations: 10_000 })
  res.json({
    x402Version: 2,
    service: 'rollcall',
    description: 'Control surface reports for protocol multisigs: honest quorum, dark signers, time to harm, value at risk. Every number tiered as observed, tested or inferred.',
    network: x402Config.network,
    asset: x402Config.asset,
    payTo: x402Config.payTo || null,
    facilitator: x402Config.facilitator,
    pricing: {
      model: 'metered by work',
      formula: 'base + perPair * C(signers, 2) + perTx * min(txs, 500) + perChain * chains',
      ratesHbar: { base: x402Config.base, perPair: x402Config.perPair, perTx: x402Config.perTx, perChain: x402Config.perChain },
      exampleHbar: { '8 signers, 150 txs, 1 chain': perReport.hbar },
    },
    resources: [
      { method: 'GET', path: '/quote/{chain}/{address}', paid: false, description: 'exact price for a report, with the breakdown' },
      { method: 'GET', path: '/report/{chain}/{address}', paid: true, pay: ['X-PAYMENT (x402 exact, per request)', 'Authorization: Bearer <token> (prepaid credit)'], description: 'the report. Attested to HCS on delivery.' },
      { method: 'GET', path: '/signal/{chain}/{address}', paid: true, pay: ['X-PAYMENT', 'Authorization: Bearer <token>'], description: 'the governance signal from the cached report, or pending while it computes. Built for ten second budgets.' },
      { method: 'POST', path: '/subscribe?credits={n}', paid: true, pay: ['X-PAYMENT'], description: 'buy n report credits, get a bearer token. For runtimes that cannot sign, such as an enclave.' },
      { method: 'GET', path: '/subscription', paid: false, description: 'credits left on a bearer token' },
      { method: 'GET', path: '/ask?q=', paid: false, description: 'ask a question in plain English; an agent resolves the protocol, reads exposure through The Graph, pays for the report over x402 and answers. Server-sent events.' },
      { method: 'POST', path: '/demo/agent?chain=&target=&asset=', paid: false, description: 'the service pays itself for a report with its own wallet, so a paid request can be watched from a browser. Rate limited.' },
      { method: 'POST', path: '/renewals', paid: false, description: 'register a Hedera Scheduled Transaction that pays for credits at expiry; credited when the mirror node shows it executed' },
      { method: 'GET', path: '/resolve/{chain}/{address}', paid: false, description: 'what was pasted: an EOA, a Safe, or a contract and the Safe above it' },
      { method: 'GET', path: '/protocols', paid: false, description: 'the protocol scan: who controls them and what they hold' },
      { method: 'GET', path: '/leaderboard', paid: false, description: 'declared vs effective quorum across a population of Safes' },
      { method: 'GET', path: '/archive?target={address}', paid: false, description: 'the HCS attestation history for a target' },
      { method: 'GET', path: '/changes', paid: false, description: 'the archive as a feed: recent attestations across every target with what changed since the previous one' },
      { method: 'GET', path: '/method/calibration', paid: false, description: 'false positive rate and power of the independence test' },
      { method: 'GET', path: '/challenge', paid: false, description: 'the Chainlink liquidation challenge: live Sepolia position, the five published scenarios, what the workflow would do now' },
      { method: 'GET', path: '/graph/registry', paid: false, description: 'the standardized subgraph registry the exposure query runs across, with the block each was verified at' },
    ],
    audit: topic ? { hcsTopic: topic, explorer: `https://hashscan.io/${process.env.HEDERA_NETWORK ?? 'testnet'}/topic/${topic}` } : null,
    identity: (() => {
      const id = agentIdentity()
      if (!id) return null
      return {
        standard: 'ERC-8004',
        registry: id.registry,
        registrations: id.registrations,
        indexedBy: { agent0Subgraph: 'https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/' },
      }
    })(),
    agents: { mcp: { transport: 'stdio', command: 'npm run mcp', tools: ['who_controls', 'signer_liveness', 'independence_test', 'effective_quorum', 'method_calibration'] } },
    source: 'https://github.com/divyanshkhurana06/rollcall',
  })
})

/**
 * Free: work out what was pasted.
 *
 * Paste a protocol contract and this finds the Safe above it, which is the protocol-first thesis
 * applied to whatever someone happens to type.
 */
app.get('/resolve/:chain/:address', async (req, res) => {
  try {
    res.json(await resolveTarget(req.params.chain as ChainKey, req.params.address))
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'could not resolve' })
  }
})

/** Free: what would this cost, and why. Agents call this before deciding to pay. */
app.get('/quote/:chain/:address', async (req, res) => {
  const chain = req.params.chain as ChainKey
  const safe = await fetchSafe(chain, req.params.address)
  if (!safe) return res.status(404).json({ error: 'not a readable Safe on this chain' })
  const chains = String(req.query.chains ?? chain).split(',').length
  const q = quote({ signers: safe.owners.length, txs: Math.min(safe.nonce, 250), chains, permutations: 10_000 })
  res.json({
    target: safe.address, chain,
    shape: { owners: safe.owners.length, threshold: safe.threshold, knownTransactions: safe.nonce },
    quote: q,
    note: 'Priced by work, not per request. Independence testing is quadratic in signers.',
  })
})

/** Free: the calibration numbers. Published so the metrics can be checked, not trusted. */
app.get('/method/calibration', (_req, res) => res.json(calibrate({ trials: 20, permutations: 800 })))

/**
 * Free: the protocol scan.
 *
 * The question a user arrives with is not "what is 0x93a7" but "is the thing holding my money
 * controlled by as many people as it claims". This answers that against protocols they have heard
 * of, with the value read from chain state.
 */
app.get('/protocols', (_req, res) => {
  const scan = loadProtocolScan()
  if (!scan) return res.status(404).json({ error: 'no protocol scan cached yet - run: npm run scan:protocols' })
  res.json(scan)
})

/**
 * Free: the leaderboard.
 *
 * Served from a cached scan rather than computed per request. Ranking a population means running
 * the full pipeline per Safe, which is minutes of work, so it is a batch job (`npm run scan`) and
 * the response carries `generatedAt` so nobody mistakes it for live.
 */
app.get('/leaderboard', (_req, res) => {
  const lb = loadLeaderboard()
  if (!lb) return res.status(404).json({ error: 'no scan cached yet - run: npm run scan' })
  res.json(lb)
})

/** Free: the attestation archive. The scan is commodity; the time series is not. */
app.get('/archive', async (req, res) => {
  const target = req.query.target as string | undefined
  const archive = await readArchive(target)
  res.json(target ? { ...archive, since: await attestationDelta(target).catch(() => null) } : archive)
})

/** Free: the archive as a feed. Recent attestations across every target, with what changed since the previous one. */
app.get('/changes', async (_req, res) => {
  const feed = await recentAttestations(40).catch(() => ({ available: false, topicId: null, recent: [] }))
  const rows: any[] = loadProtocolScan()?.rows ?? []
  const label = (safe: string) => {
    const hit = rows.filter((r) => r.safe && r.safe.toLowerCase() === safe.toLowerCase()).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))[0]
    return hit ? `${hit.protocol} ${hit.role}` : null
  }
  res.json({ ...feed, recent: feed.recent.map((r: any) => ({ ...r, label: label(r.target) })) })
})

/** Free: the registry of standardized deployments the exposure query runs across, with provenance. */
app.get('/graph/registry', (_req, res) => {
  const families = new Map<string, number>()
  for (const d of REGISTRY.deployments) families.set(d.family, (families.get(d.family) ?? 0) + 1)
  res.json({
    verifiedAt: REGISTRY.verifiedAt,
    families: Object.fromEntries(families),
    networks: [...new Set(REGISTRY.deployments.map((d) => d.network))],
    queriedPerReport: STANDARDIZED.length,
    query: EXPOSURE_QUERY.trim(),
    deployments: REGISTRY.deployments,
  })
})

/**
 * Paid: prepaid credits.
 *
 * Priced at the report cap, so a credit is never worth less than the work it buys. Bearer tokens
 * are not accepted here: credits are bought with a signature, not with other credits.
 */
app.post(
  '/subscribe',
  gate((req) => ({ signers: 8, txs: 150, chains: 1, permutations: 10_000, count: Math.min(100, Math.max(1, Number(req.query.credits ?? 10))) }), { allowToken: false }),
  (req, res) => {
    const settlement = (req as any).settlement
    const credits = (req as any).quote.units.count as number
    const s = issue(credits, { payer: settlement?.payer, transaction: settlement?.transaction })
    res.json({
      token: s.token,
      credits: s.credits,
      settlement,
      use: 'Authorization: Bearer <token> on GET /report/{chain}/{address}',
    })
  },
)

/**
 * Renewals paid by Hedera Scheduled Transactions.
 *
 * Free to register: the API issues nothing until the mirror node shows the scheduled transfer
 * executed and the amount matches the price for that many credits. GET checks and credits.
 */
app.post('/renewals', (req, res) => {
  const { scheduleId, credits, payer, token } = req.body ?? {}
  if (!scheduleId || !credits) return res.status(400).json({ error: 'scheduleId and credits required' })
  const n = Math.min(100, Math.max(1, Number(credits)))
  const q = quote({ signers: 8, txs: 150, chains: 1, permutations: 10_000, count: n })
  const r = registerRenewal({ scheduleId: String(scheduleId), credits: n, expectedTinybar: q.amount, payTo: x402Config.payTo, payer, token })
  res.json({ ...r, credits: describe(r.token)?.credits ?? 0, pendingCredits: r.status === 'pending' ? r.credits : 0, check: `/renewals/${r.scheduleId}` })
})

app.get('/renewals', (_req, res) => res.json({ renewals: listRenewals().map((r) => ({ ...r, token: r.token.slice(0, 7) + '...' })) }))

app.get('/renewals/:scheduleId', async (req, res) => {
  const r = await checkRenewal(req.params.scheduleId).catch(() => null)
  if (!r) return res.status(404).json({ error: 'unknown schedule' })
  res.json({ ...r, token: r.token.slice(0, 7) + '...', creditsNow: describe(r.token)?.credits ?? 0, explorer: `https://hashscan.io/${process.env.HEDERA_NETWORK ?? 'testnet'}/schedule/${r.scheduleId}` })
})

/** Free: what a token has left. */
app.get('/subscription', (req, res) => {
  const auth = req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return res.status(400).json({ error: 'Authorization: Bearer <token> required' })
  const d = describe(auth.slice(7).trim())
  if (!d) return res.status(404).json({ error: 'unknown token' })
  res.json(d)
})

/**
 * Paid: the governance signal.
 *
 * An enclave has a ten second HTTP budget and a report takes a minute to compute, so the signal is
 * never computed on the request path. It is served from the most recent HCS attestation of the
 * target, which every instance of this API can read in a few hundred milliseconds, and which is
 * refreshed by computing a fresh report in the background when the latest one is older than
 * SIGNAL_MAX_AGE. A caller that arrives before any attestation exists gets `pending`, which the
 * workflows treat as no signal rather than as a breach. The audit trail is the cache.
 */
const inflight = new Map<string, Promise<void>>()
const SIGNAL_MAX = 100
const SIGNAL_PERMS = 2000
const SIGNAL_MAX_AGE = Number(process.env.SIGNAL_MAX_AGE_SECONDS ?? 6 * 3600)

function refreshSignal(chain: ChainKey, address: string) {
  const key = `${chain}:${address}:${chain}:${SIGNAL_MAX}:${SIGNAL_PERMS}`
  if (inflight.has(key)) return inflight.get(key)!
  const job = buildReport(address, { chain, livenessChains: [chain], maxTxs: SIGNAL_MAX, permutations: SIGNAL_PERMS })
    .then(async (report) => {
      cache.set(key, { at: Date.now(), report })
      await submitAttestation(buildAttestation(report)).catch(() => null)
    })
    .catch(() => null)
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  // On Vercel, keep the instance alive until the background computation lands.
  if (process.env.VERCEL) import('@vercel/functions').then((m) => m.waitUntil(job)).catch(() => null)
  return job
}

app.get(
  '/signal/:chain/:address',
  gate(async (req) => {
    const shape = await safeShape(req.params.chain as ChainKey, req.params.address)
    return { signers: shape.owners, txs: Math.min(shape.nonce, SIGNAL_MAX), chains: 1, permutations: SIGNAL_PERMS }
  }),
  async (req, res) => {
    const chain = req.params.chain as ChainKey
    const address = req.params.address
    const now = Math.floor(Date.now() / 1000)

    const archive = await readArchive(address, 20).catch(() => ({ available: false, messages: [] as any[] }))
    const latest = (archive.messages as any[])
      .filter((m) => m?.metrics && typeof m.at === 'number' && (!m.chain || m.chain === chain))
      .sort((a, b) => b.at - a.at)[0]

    if (!latest || now - latest.at > SIGNAL_MAX_AGE) refreshSignal(chain, address)

    if (!latest) {
      return res.status(202).json({ ready: false, pending: true, target: address, chain, settlement: (req as any).settlement })
    }

    const m = latest.metrics
    res.json({
      ready: true,
      target: latest.target,
      chain: latest.chain ?? chain,
      computedAt: latest.at,
      ageSeconds: now - latest.at,
      refreshing: inflight.has(`${chain}:${address}:${chain}:${SIGNAL_MAX}:${SIGNAL_PERMS}`),
      source: `HCS attestation ${latest.sequenceNumber} on topic ${(archive as any).topicId ?? process.env.HCS_TOPIC_ID}`,
      digest: latest.digest,
      threshold: m.threshold,
      owners: m.owners,
      honestQuorum: m.effectiveQuorumMin,
      effectiveQuorumMax: m.effectiveQuorumMax,
      darkSigners: m.darkSigners,
      liveSigners: m.liveSigners,
      canReachQuorum: m.canReachThreshold,
      dependentPairs: m.dependentPairs,
      txWindow: m.txWindow,
      since: await attestationDelta(address).catch(() => null),
      settlement: (req as any).settlement,
    })
  },
)

/**
 * The demo agent, behind a button.
 *
 * Runs the same x402 client `npm run agent` runs, server side, with the service's own testnet
 * wallet, against this API's own paid endpoint. It exists so a judge can watch a real paid request
 * from the web page without a terminal. One at a time, with a cooldown, because it spends testnet
 * funds on every click.
 */
let demoInFlight = 0
const DEMO_MAX_CONCURRENT = 4
app.post('/demo/agent', async (req, res) => {
  const accountId = process.env.HEDERA_ACCOUNT_ID
  const privateKey = process.env.HEDERA_PRIVATE_KEY
  if (!accountId || !privateKey) return res.status(503).json({ error: 'the service wallet is not configured on this host' })
  if (demoInFlight >= DEMO_MAX_CONCURRENT) return res.status(429).json({ error: 'the service wallet is paying for several reports right now. Try again in a few seconds.', retryAfter: 8 })
  const chain = String(req.query.chain ?? 'ethereum')
  const target = String(req.query.target ?? '0x97cd81555F18d612C02FC4468118C48adD9f1245')
  const asset = String(req.query.asset ?? 'hbar')
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) return res.status(400).json({ error: 'target must be a 0x address' })
  // Call ourselves over HTTP, the way any agent would. Behind the Vercel rewrite that is /api.
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http'
  const host = req.headers.host ?? `localhost:${process.env.PORT ?? 8787}`
  const api = process.env.ROLLCALL_SELF_URL ?? (process.env.VERCEL ? `${proto}://${host}/api` : `http://${host}`)
  demoInFlight += 1
  try {
    const result = await payFor({ api, path: `/report/${chain}/${target}?max=100&perms=2000`, accountId, privateKey, asset })
    const b = result.body ?? {}
    res.status(result.status === 200 ? 200 : 502).json({
      agent: accountId,
      offers: result.offers,
      accepted: result.accepted,
      priced: result.extra?.breakdown ? { breakdown: result.extra.breakdown, units: result.extra.units, hbar: result.extra.hbar } : null,
      headerBytes: result.headerBytes,
      ms: result.ms,
      settlement: b.settlement ?? null,
      receipt: b.receipt ?? null,
      since: b.since ?? null,
      narrative: b.narrative ?? null,
      context: b.context ?? null,
      report: b.report ?? null,
      error: b.error ?? (result.status !== 200 ? `status ${result.status}` : undefined),
    })
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? 'demo agent failed' })
  } finally {
    demoInFlight -= 1
  }
})

/** The protocol scan row whose Safe is this address, so a report can say what the keys control. */
function protocolContextFor(safe: string) {
  const scan = loadProtocolScan()
  const rows: any[] = scan?.rows ?? []
  const hit = rows.filter((r) => r.safe && r.safe.toLowerCase() === safe.toLowerCase()).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))[0]
  return hit ? { protocol: hit.protocol, role: hit.role, valueUsd: hit.valueUsd, authorityPath: hit.authorityPath, timeToHarmHours: hit.timeToHarmHours, timeToHarmMeasured: hit.timeToHarmMeasured } : null
}

/** Free: the Chainlink challenge, live. Position on Sepolia, the five scenarios, what the workflow would do. */
let challengeCache: { at: number; body: any } | null = null
app.get('/challenge', async (_req, res) => {
  try {
    if (challengeCache && Date.now() - challengeCache.at < 30_000) return res.json(challengeCache.body)
    const body = jsonSafe(await challengeSnapshot())
    challengeCache = { at: Date.now(), body }
    res.json(body)
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? 'challenge read failed' })
  }
})

/**
 * Ask a question; watch the agent earn the answer. Server-sent events: step, facts, token, answer, done.
 */
let askInFlight = 0
app.get('/ask', async (req, res) => {
  if (askInFlight >= 3) return res.status(429).json({ error: 'three questions are already being answered. Try again in a minute.' })
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http'
  const host = req.headers.host ?? `localhost:${process.env.PORT ?? 8787}`
  const api = process.env.ROLLCALL_SELF_URL ?? (process.env.VERCEL ? `${proto}://${host}/api` : `http://${host}`)
  askInFlight += 1
  try {
    await ask(req, res, api)
  } finally {
    askInFlight -= 1
  }
})

/** Paid: the report. */
/** The shape of the job, from the Safe itself, so the gate prices what /quote priced. */
const shapeCache = new Map<string, { at: number; owners: number; nonce: number }>()
async function safeShape(chain: ChainKey, address: string) {
  const key = `${chain}:${address.toLowerCase()}`
  const hit = shapeCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit
  const safe = await fetchSafe(chain, address).catch(() => null)
  const shape = { at: Date.now(), owners: safe?.owners.length ?? 8, nonce: safe?.nonce ?? 250 }
  shapeCache.set(key, shape)
  return shape
}

app.get(
  '/report/:chain/:address',
  gate(async (req) => {
    const shape = await safeShape(req.params.chain as ChainKey, req.params.address)
    const max = Number((req.query.max as string) ?? 250)
    return {
      signers: shape.owners,
      txs: Math.min(shape.nonce, max),
      chains: String(req.query.chains ?? req.params.chain).split(',').length,
      permutations: Number((req.query.perms as string) ?? 10_000),
    }
  }),
  async (req, res) => {
    const chain = req.params.chain as ChainKey
    const address = req.params.address
    const chains = String(req.query.chains ?? chain).split(',') as ChainKey[]
    const key = `${chain}:${address}:${chains.join(',')}:${req.query.max}:${req.query.perms}`

    try {
      const hit = cache.get(key)
      let report = hit && Date.now() - hit.at < TTL ? hit.report : null
      if (!report) {
        report = await buildReport(address, {
          chain,
          livenessChains: chains,
          maxTxs: Number((req.query.max as string) ?? 250),
          permutations: Number((req.query.perms as string) ?? 10_000),
        })
        cache.set(key, { at: Date.now(), report })
      }

      const attestation = buildAttestation(report)
      const receipt = await submitAttestation(attestation)
      // Compared before this delivery is counted, so "since" always means since the previous one.
      const since = await attestationDelta(address).catch(() => null)

      const safeReport = JSON.parse(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
      const context = protocolContextFor(address)
      res.json({
        report: safeReport,
        context,
        narrative: narrative(safeReport, { protocol: context }),
        settlement: (req as any).settlement,
        quote: (req as any).quote,
        attestation,
        receipt,
        since,
      })
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? 'report failed' })
    }
  },
)

export default app

// On Vercel the app is imported by api/[...path].ts and served as a function; locally it listens.
const port = Number(process.env.PORT ?? 8787)
if (!process.env.VERCEL) app.listen(port, () => {
  console.log(`roll call api  http://localhost:${port}`)
  console.log(`  GET /quote/:chain/:address       free - priced by work`)
  console.log(`  GET /report/:chain/:address      x402 gated (${x402Config.network})`)
  console.log(`  GET /method/calibration          free - FPR + power`)
  console.log(`  GET /archive?target=0x...          free - HCS attestation history`)
  console.log(`  GET /signal/:chain/:address      x402 gated - the governance signal, kept warm for enclaves`)
  console.log(`  POST /subscribe?credits=N        x402 gated - prepaid credits as a bearer token`)
  console.log(`  POST /renewals                   free - credits paid by a Scheduled Transaction, credited on execution`)
  console.log(`  GET /.well-known/x402            free - discovery manifest`)
  if (x402Config.devBypass) console.log(`  ! X402_DEV_BYPASS=1 - payments not enforced`)
})
