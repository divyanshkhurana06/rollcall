import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { buildReport } from '../../../packages/core/src/report.js'
import { fetchSafe } from '../../../packages/core/src/extract/safeapi.js'
import { calibrate } from '../../../packages/core/src/validate.js'
import { loadLeaderboard } from '../../../packages/core/src/leaderboard.js'
import { loadProtocolScan } from '../../../packages/core/src/protocolScan.js'
import { resolveTarget } from '../../../packages/core/src/resolve.js'
import type { ChainKey } from '../../../packages/core/src/chain.js'
import { gate, quote, x402Config } from './x402.js'
import { describe, issue } from './subscriptions.js'
import { buildAttestation, submitAttestation, readArchive } from './hcs.js'

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
      { method: 'GET', path: '/resolve/{chain}/{address}', paid: false, description: 'what was pasted: an EOA, a Safe, or a contract and the Safe above it' },
      { method: 'GET', path: '/protocols', paid: false, description: 'the protocol scan: who controls them and what they hold' },
      { method: 'GET', path: '/leaderboard', paid: false, description: 'declared vs effective quorum across a population of Safes' },
      { method: 'GET', path: '/archive?target={address}', paid: false, description: 'the HCS attestation history for a target' },
      { method: 'GET', path: '/method/calibration', paid: false, description: 'false positive rate and power of the independence test' },
    ],
    audit: topic ? { hcsTopic: topic, explorer: `https://hashscan.io/${process.env.HEDERA_NETWORK ?? 'testnet'}/topic/${topic}` } : null,
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
app.get('/archive', async (req, res) => res.json(await readArchive(req.query.target as string | undefined)))

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

/** Free: what a token has left. */
app.get('/subscription', (req, res) => {
  const auth = req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return res.status(400).json({ error: 'Authorization: Bearer <token> required' })
  const d = describe(auth.slice(7).trim())
  if (!d) return res.status(404).json({ error: 'unknown token' })
  res.json(d)
})

/**
 * Paid: the governance signal, kept warm.
 *
 * An enclave has a ten second HTTP budget and a report takes a minute to compute, so the signal is
 * served from the cache and refreshed in the background. A caller that arrives before the first
 * computation finishes gets `pending`, which the workflows treat as no signal rather than as a
 * breach. Each fresh computation is attested to HCS exactly like a delivered report.
 */
const inflight = new Map<string, Promise<void>>()
const SIGNAL_MAX = 100
const SIGNAL_PERMS = 2000

app.get(
  '/signal/:chain/:address',
  gate(() => ({ signers: 8, txs: SIGNAL_MAX, chains: 1, permutations: SIGNAL_PERMS })),
  async (req, res) => {
    const chain = req.params.chain as ChainKey
    const address = req.params.address
    const key = `${chain}:${address}:${chain}:${SIGNAL_MAX}:${SIGNAL_PERMS}`
    const hit = cache.get(key)
    const fresh = hit && Date.now() - hit.at < TTL ? hit : null

    if (!fresh) {
      if (!inflight.has(key)) {
        const job = buildReport(address, { chain, livenessChains: [chain], maxTxs: SIGNAL_MAX, permutations: SIGNAL_PERMS })
          .then(async (report) => {
            cache.set(key, { at: Date.now(), report })
            await submitAttestation(buildAttestation(report)).catch(() => null)
          })
          .catch(() => null)
          .finally(() => inflight.delete(key))
        inflight.set(key, job)
      }
      return res.status(202).json({ ready: false, pending: true, target: address, chain, settlement: (req as any).settlement })
    }

    const r = fresh.report
    const curve = r.inferred.quorumCurve as { effectiveQuorum: number }[]
    res.json({
      ready: true,
      target: r.target.address,
      chain: r.target.chain,
      computedAt: Math.floor(fresh.at / 1000),
      digest: r.header.inputDigest,
      threshold: r.observed.threshold,
      owners: r.observed.owners.length,
      honestQuorum: Math.min(...curve.map((c) => c.effectiveQuorum)),
      effectiveQuorumMax: Math.max(...curve.map((c) => c.effectiveQuorum)),
      darkSigners: r.reachability.darkSigners,
      liveSigners: r.reachability.liveSigners,
      canReachQuorum: r.reachability.canStillReachThreshold,
      dependentPairs: r.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0).length,
      txWindow: r.header.txWindow.count,
      settlement: (req as any).settlement,
    })
  },
)

/** Paid: the report. */
app.get(
  '/report/:chain/:address',
  gate((req) => ({
    signers: 8,
    txs: Number((req.query.max as string) ?? 250),
    chains: String(req.query.chains ?? req.params.chain).split(',').length,
    permutations: Number((req.query.perms as string) ?? 10_000),
  })),
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

      res.json({
        report: JSON.parse(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? String(v) : v))),
        settlement: (req as any).settlement,
        quote: (req as any).quote,
        attestation,
        receipt,
      })
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? 'report failed' })
    }
  },
)

const port = Number(process.env.PORT ?? 8787)
app.listen(port, () => {
  console.log(`roll call api  http://localhost:${port}`)
  console.log(`  GET /quote/:chain/:address       free - priced by work`)
  console.log(`  GET /report/:chain/:address      x402 gated (${x402Config.network})`)
  console.log(`  GET /method/calibration          free - FPR + power`)
  console.log(`  GET /archive?target=0x...          free - HCS attestation history`)
  console.log(`  GET /signal/:chain/:address      x402 gated - the governance signal, kept warm for enclaves`)
  console.log(`  POST /subscribe?credits=N        x402 gated - prepaid credits as a bearer token`)
  console.log(`  GET /.well-known/x402            free - discovery manifest`)
  if (x402Config.devBypass) console.log(`  ! X402_DEV_BYPASS=1 - payments not enforced`)
})
