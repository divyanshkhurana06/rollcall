#!/usr/bin/env node
/**
 * Roll Call MCP server.
 *
 * Reusable infrastructure, not a wrapper around one app. Any agent about to integrate, allocate
 * to, or underwrite a protocol can ask the question no block explorer answers:
 *
 *     "Who can change this contract, how fast, and are those keys still warm?"
 *
 * Every tool returns its tier (observed / tested / inferred) and its caveats alongside the
 * numbers, so a model cannot accidentally present an inference as a fact.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildReport } from '../../core/src/report.js'
import { fetchSafe } from '../../core/src/extract/safeapi.js'
import { calibrate } from '../../core/src/validate.js'
import { sourceNote, subgraphConfigured } from '../../core/src/graph.js'
import { graphConfigured as gatewayConfigured, STANDARDIZED, REGISTRY, accountExposure } from '../../core/src/exposure.js'
import type { ChainKey } from '../../core/src/chain.js'

const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'gnosis']
const cache = new Map<string, { at: number; r: any }>()
const TTL = 10 * 60 * 1000

async function report(address: string, chain: ChainKey, chains: ChainKey[], max = 200, perms = 4000) {
  const key = `${chain}:${address}:${chains.join(',')}:${max}:${perms}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.r
  const r = await buildReport(address, { chain, livenessChains: chains, maxTxs: max, permutations: perms })
  cache.set(key, { at: Date.now(), r })
  return r
}

const addressArg = {
  type: 'object',
  properties: {
    address: { type: 'string', description: 'Contract or Safe address' },
    chain: { type: 'string', enum: CHAINS, default: 'ethereum' },
    livenessChains: { type: 'array', items: { type: 'string', enum: CHAINS },
      description: 'Chains to search for signer activity. Liveness claims are bounded by this list.' },
  },
  required: ['address'],
} as const

const TOOLS = [
  {
    name: 'who_controls',
    description:
      'Who can change this contract, how many of them are still active, and could they still reach quorum. ' +
      'Returns observed facts first, then tested statistics, then parameterised inferences - each labelled.',
    inputSchema: addressArg,
  },
  {
    name: 'signer_liveness',
    description:
      'Per-signer: days since any observed signature or transaction, across the chains searched. ' +
      'Catches signers who are invisible to block explorers because they only ever sign offchain (nonce 0).',
    inputSchema: addressArg,
  },
  {
    name: 'independence_test',
    description:
      'Permutation test for co-signing dependence between signers. Reports p-values against an explicit ' +
      'null that preserves each signer marginal rate and the per-transaction signer count. ' +
      'Measures statistical dependence, never identity.',
    inputSchema: addressArg,
  },
  {
    name: 'effective_quorum',
    description:
      'Lower bound on independent decision units needed to reach threshold, reported as a curve over the ' +
      'clustering parameter alpha. Never a single number - a single number here would be unfalsifiable.',
    inputSchema: addressArg,
  },
  {
    name: 'method_calibration',
    description:
      'False-positive rate on synthetic independent signers and detection power on synthetic dependent ones. ' +
      'Call this before trusting any independence result.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'protocol_exposure',
    description:
      'What money sits behind an address across DeFi, from The Graph: one standardized query sent to the ' +
      'largest Messari lending deployments, each answer stamped with the deployment hash and the block it had ' +
      'indexed. Use it to decide whether a control surface matters before spending a report on it.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: '0x address, any EVM chain' } }, required: ['address'] },
  },
  {
    name: 'standardized_registry',
    description:
      'The registry of Messari standardized subgraph deployments Roll Call has verified on the decentralized ' +
      'network: schema family, network, subgraph id, and the block each answered at. Filter by family or network. ' +
      'This is how one query spans 84 deployments across 12 networks without per-protocol code.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['lending', 'dex-amm'], description: 'Schema family' },
        network: { type: 'string', description: 'e.g. ethereum, arbitrum, base' },
      },
    },
  },
] as const

const server = new Server({ name: 'rollcall', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a: any = req.params.arguments ?? {}
  const chain = (a.chain ?? 'ethereum') as ChainKey
  const chains = (a.livenessChains ?? [chain]) as ChainKey[]
  const out = async (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] })

  try {
    switch (req.params.name) {
      case 'protocol_exposure': {
        const address = String(a.address ?? '')
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return out({ error: 'address must be a 0x-prefixed 20-byte hex address' })
        const exposure = await accountExposure(address)
        if (!exposure) return out({ error: 'The Graph gateway is not configured (GRAPH_API_KEY)' })
        return out({
          ...exposure,
          provenance: exposure.detail.map((d) => ({ key: d.key, network: d.network, deployment: d.deployment, indexedBlock: d.indexedBlock })),
        })
      }
      case 'standardized_registry': {
        const family = a.family as string | undefined
        const network = a.network as string | undefined
        const deployments = REGISTRY.deployments.filter((d) => (!family || d.family === family) && (!network || d.network === network))
        return out({
          verifiedAt: REGISTRY.verifiedAt,
          total: REGISTRY.deployments.length,
          matching: deployments.length,
          queriedPerReport: STANDARDIZED.length,
          deployments: deployments.map((d) => ({ key: d.key, family: d.family, network: d.network, subgraphId: d.subgraphId, schemaVersion: d.schemaVersion, verifiedBlock: d.verifiedBlock, tvlUsd: d.tvlUsd })),
        })
      }
      case 'method_calibration':
        return out({
          tier: 'method',
          calibration: calibrate({ trials: 20, permutations: 800 }),
          reading: 'family-wise FPR is the chance ANY pair is falsely flagged in one Safe. Power is detection rate on two keys that always decide together.',
        })

      case 'who_controls': {
        const safe = await fetchSafe(chain, a.address)
        if (!safe) return out({ error: 'not a readable Safe on this chain', chain, address: a.address })
        const r = await report(a.address, chain, chains)
        const curve = r.inferred.quorumCurve
        return out({
          observed: {
            address: safe.address, chain, threshold: safe.threshold, owners: safe.owners.length,
            safeVersion: safe.version, transactionsAnalysed: r.header.txWindow.count,
            liveSigners: r.reachability.liveSigners, darkSigners: r.reachability.darkSigners,
            canStillReachThreshold: r.reachability.canStillReachThreshold,
            marginToFrozen: r.reachability.marginToFrozen,
          },
          tested: {
            dependentPairs: r.tested.independence.filter((p: any) => p.pValue < 0.01 && p.excess > 0)
              .map((p: any) => ({ a: p.a, b: p.b, pValue: p.pValue, observed: p.observed, expected: p.expected })),
          },
          inferred: {
            effectiveQuorum: { min: Math.min(...curve.map((c: any) => c.effectiveQuorum)), max: Math.max(...curve.map((c: any) => c.effectiveQuorum)) },
            robustness: r.inferred.robustness.verdict,
          },
          findings: r.findings.map((f: any) => ({ tier: f.tier, severity: f.severity, title: f.title, caveat: f.caveat })),
          method: { version: r.header.methodVersion, digest: r.header.inputDigest, seed: r.header.seed, source: sourceNote(chain), subgraphIndexed: subgraphConfigured(), standardizedDeployments: gatewayConfigured() ? STANDARDIZED.length : 0 },
          limitations: r.coverage.limitations,
        })
      }

      case 'signer_liveness': {
        const r = await report(a.address, chain, chains)
        return out({
          tier: 'observed',
          chainsSearched: r.header.chainsSearched,
          signers: r.liveness.map((l: any) => ({
            signer: l.signer, daysSinceAnySignal: l.daysSinceAnySignal, nonce: l.nonce,
            invisibleToExplorers: l.nonce === 0 && l.daysSinceAnySignal !== null,
            statement: l.statement,
          })),
          reachability: r.reachability,
          caveat: 'Absence of an observed signature is not proof a key is lost. A signer may hold their key and simply not have been asked to use it.',
        })
      }

      case 'independence_test': {
        const r = await report(a.address, chain, chains)
        return out({
          tier: 'tested',
          null: 'Each signer independently approves at their own marginal rate, subject to the threshold constraint. Permutation preserves both marginals and per-transaction signer count.',
          permutations: r.header.permutations.independence,
          seed: r.header.seed,
          pairs: r.tested.independence.slice(0, 20),
          timing: r.tested.timing.slice(0, 10),
          caveat: 'Measures statistical dependence, not identity. Two independent people who always agree produce the same signal as one person with two keys.',
        })
      }

      case 'effective_quorum': {
        const r = await report(a.address, chain, chains)
        return out({
          tier: 'inferred',
          declaredThreshold: r.observed.threshold,
          curve: r.inferred.quorumCurve.map((c: any) => ({ alpha: c.alpha, independentUnits: c.unitCount, effectiveQuorum: c.effectiveQuorum })),
          robustness: r.inferred.robustness,
          definition: 'Lower bound on the number of independent decision units required to reach threshold, where signers merge into one unit if their co-signing dependence is significant at alpha.',
          caveat: 'Parameterised, not a claim about who controls these keys. Reported as a curve because a single number would be unfalsifiable.',
        })
      }

      default:
        return out({ error: `unknown tool: ${req.params.name}` })
    }
  } catch (e: any) {
    return out({ error: e?.message ?? String(e) })
  }
})

await server.connect(new StdioServerTransport())
console.error('rollcall mcp server ready on stdio')
