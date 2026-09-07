import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { buildReport } from '../../../packages/core/src/report.js'
import { fetchSafe } from '../../../packages/core/src/extract/safeapi.js'
import { calibrate } from '../../../packages/core/src/validate.js'
import { loadLeaderboard } from '../../../packages/core/src/leaderboard.js'
import { loadProtocolScan } from '../../../packages/core/src/protocolScan.js'
import type { ChainKey } from '../../../packages/core/src/chain.js'
import { gate, quote, x402Config } from './x402.js'
import { buildAttestation, submitAttestation, readArchive } from './hcs.js'

const app = express()
app.use(cors())
app.use(express.json())

const cache = new Map<string, { at: number; report: any }>()
const TTL = 1000 * 60 * 10

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'rollcall', x402: { network: x402Config.network, asset: x402Config.asset, facilitator: x402Config.facilitator }, hcsTopic: process.env.HCS_TOPIC_ID ?? null }),
)

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
  if (x402Config.devBypass) console.log(`  ! X402_DEV_BYPASS=1 - payments not enforced`)
})
