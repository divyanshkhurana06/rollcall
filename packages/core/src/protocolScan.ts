import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PROTOCOLS, type ProtocolTarget } from './protocols.js'
import { resolveControlSurface } from './extract/authority.js'
import { valueAtRisk, ethPrice } from './extract/value.js'
import { buildReport } from './report.js'
import type { ChainKey } from './chain.js'

/**
 * The protocol scan.
 *
 * For each protocol: read what it holds, resolve who can change it, and if that resolves to a
 * Safe, measure the Safe. The output answers the question a user actually arrives with - "is the
 * thing holding my money controlled by as many people as it claims" - against protocols they have
 * heard of, with a dollar figure attached.
 *
 * Protocols whose authority resolves to a timelock, a DAO or an EOA are kept in the output rather
 * than dropped. "No Safe to measure" is a finding too, and hiding it would make the ranking look
 * more damning than the evidence supports.
 */

export interface ProtocolRow {
  protocol: string
  role: string
  address: string
  category: string
  source: string
  /** What the contract itself holds, read from chain state. A floor, not a valuation. */
  valueUsd: number
  nativeEth: number
  /** The Safe that can change it, when there is one. */
  safe: string | null
  authorityPath: string
  /** Hours from a malicious signature to the change landing. Zero means the next block. */
  timeToHarmHours: number | null
  timeToHarmMeasured: boolean | null
  threshold: number | null
  owners: number | null
  honestQuorum: number | null
  gap: number | null
  robust: boolean | null
  darkSigners: number | null
  liveSigners: number | null
  marginToFrozen: number | null
  canStillReachThreshold: boolean | null
  dependentPairs: number | null
  invisibleSigners: number | null
  txWindow: number | null
  digest: string | null
  status: 'measured' | 'no-safe' | 'unreadable'
}

export interface ProtocolScan {
  generatedAt: number
  methodVersion: string
  ethPriceUsd: number
  scanned: number
  measured: number
  totalValueUsd: number
  valueBehindWeakQuorum: number
  valueOneKeyFromFrozen: number
  /** Value guarded by a Safe with no timelock between it and the contract. */
  valueWithNoDelay: number
  rows: ProtocolRow[]
  assumptions: string[]
}

const CACHE = 'data/protocol-scan.json'

export async function scanProtocols(opts: {
  chain?: ChainKey
  targets?: ProtocolTarget[]
  maxTxs?: number
  permutations?: number
  onProgress?: (msg: string) => void
} = {}): Promise<ProtocolScan> {
  const chain = opts.chain ?? 'ethereum'
  const targets = opts.targets ?? PROTOCOLS
  const log = opts.onProgress ?? (() => {})
  const price = await ethPrice()
  log(`ETH at $${price.toFixed(0)}`)

  const rows: ProtocolRow[] = []
  // A Safe often guards several contracts; measure it once and reuse.
  const reportCache = new Map<string, any>()

  for (const t of targets) {
    try {
      const [surface, value] = await Promise.all([
        // Roles are skipped in the population scan: 40 sequential log requests per contract
        // over a public RPC would take hours and still only cover a recent window.
        resolveControlSurface(chain, t.address, { includeRoles: false }),
        valueAtRisk(chain, t.address, price),
      ])

      const base = {
        protocol: t.protocol, role: t.role, address: t.address, category: t.category, source: t.source,
        valueUsd: value.totalUsd, nativeEth: value.nativeEth,
        authorityPath: surface.holders.map((h) => h.kind).join(' -> ') || 'none',
        timeToHarmHours: surface.timeToHarm?.hours ?? null,
        timeToHarmMeasured: surface.timeToHarm?.measured ?? null,
      }

      const safe = surface.safes[0] ?? null
      if (!safe) {
        rows.push({
          ...base, safe: null, threshold: null, owners: null, honestQuorum: null, gap: null,
          robust: null, darkSigners: null, liveSigners: null, marginToFrozen: null,
          canStillReachThreshold: null, dependentPairs: null, invisibleSigners: null,
          txWindow: null, digest: null, status: 'no-safe',
        })
        log(`${t.protocol} ${t.role}: no Safe (${base.authorityPath})`)
        continue
      }

      let r = reportCache.get(safe.toLowerCase())
      if (!r) {
        log(`${t.protocol} ${t.role}: measuring ${safe}`)
        r = await buildReport(safe, {
          chain, livenessChains: [chain],
          maxTxs: opts.maxTxs ?? 120, permutations: opts.permutations ?? 2500,
          proveParticipation: false,
        })
        reportCache.set(safe.toLowerCase(), r)
      }

      const curve = r.inferred.quorumCurve
      const honest = Math.min(...curve.map((c: any) => c.effectiveQuorum))

      rows.push({
        ...base,
        safe,
        threshold: r.observed.threshold,
        owners: r.observed.owners.length,
        honestQuorum: honest,
        gap: r.observed.threshold - honest,
        robust: r.inferred.robustness.stable,
        darkSigners: r.reachability.darkSigners,
        liveSigners: r.reachability.liveSigners,
        marginToFrozen: r.reachability.marginToFrozen,
        canStillReachThreshold: r.reachability.canStillReachThreshold,
        dependentPairs: r.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0).length,
        invisibleSigners: r.liveness.filter((l: any) => l.nonce === 0 && l.daysSinceAnySignal !== null).length,
        txWindow: r.header.txWindow.count,
        digest: r.header.inputDigest,
        status: 'measured',
      })
    } catch (e) {
      rows.push({
        protocol: t.protocol, role: t.role, address: t.address, category: t.category, source: t.source,
        valueUsd: 0, nativeEth: 0, safe: null, authorityPath: 'unreadable',
        timeToHarmHours: null, timeToHarmMeasured: null,
        threshold: null, owners: null, honestQuorum: null, gap: null, robust: null,
        darkSigners: null, liveSigners: null, marginToFrozen: null, canStillReachThreshold: null,
        dependentPairs: null, invisibleSigners: null, txWindow: null, digest: null, status: 'unreadable',
      })
      log(`${t.protocol} ${t.role}: unreadable`)
    }
  }

  // Ranked by consequence: money first, because a weak signer set over an empty contract is trivia.
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'measured' ? -1 : 1
    return b.valueUsd - a.valueUsd
  })

  const measured = rows.filter((r) => r.status === 'measured')
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    methodVersion: '1.0.0',
    ethPriceUsd: price,
    scanned: rows.length,
    measured: measured.length,
    totalValueUsd: rows.reduce((s, r) => s + r.valueUsd, 0),
    valueBehindWeakQuorum: measured.filter((r) => (r.gap ?? 0) > 0).reduce((s, r) => s + r.valueUsd, 0),
    valueOneKeyFromFrozen: measured.filter((r) => (r.marginToFrozen ?? 99) <= 0).reduce((s, r) => s + r.valueUsd, 0),
    valueWithNoDelay: measured.filter((r) => r.timeToHarmHours === 0).reduce((s, r) => s + r.valueUsd, 0),
    rows,
    assumptions: [
      'Value is the contract balance in native ETH plus five major assets, read from chain state. It is a floor, not a valuation.',
      'Authority is followed two hops, so a Safe behind a ProxyAdmin is found but a Safe behind a governance timelock and a DAO vote may not be.',
      'AccessControl role holders are not scanned in the population pass, only in a single contract report. A contract shown with no Safe may still grant a privileged role to one.',
      'A protocol with no Safe is reported, not hidden. Authority resolving to a timelock or DAO is a different governance model, not a weaker one.',
    ],
  }
}

export function saveProtocolScan(s: ProtocolScan, path = CACHE) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(s, null, 2))
}

export function loadProtocolScan(path = CACHE): ProtocolScan | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
