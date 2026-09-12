import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Probe every Messari standardized deployment on the decentralized network and keep the ones that
 * answer the schema-level query Roll Call relies on. The output is a registry: one schema family,
 * many verified deployments, each with the block it was indexed to when verified.
 */
const gateway = process.env.GRAPH_GATEWAY ?? 'https://gateway.thegraph.com/api'
const key = process.env.GRAPH_API_KEY ?? ''
const candidates = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { key: string; protocol: string; network: string; schema: string; schemaVersion: string; subgraphId: string }[]

const QUERY = `{ _meta { block { number } deployment hasIndexingErrors } protocols(first: 1) { id name slug schemaVersion totalValueLockedUSD } }`

async function probe(c: (typeof candidates)[number]) {
  try {
    const res = await fetch(`${gateway}/${key}/subgraphs/id/${c.subgraphId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: QUERY }),
      signal: AbortSignal.timeout(20_000),
    })
    const body: any = await res.json()
    if (!res.ok || body.errors || !body.data?._meta) return { ...c, ok: false, reason: body.errors?.[0]?.message?.slice(0, 80) ?? `http ${res.status}` }
    const p = body.data.protocols?.[0]
    return { ...c, ok: true, block: body.data._meta.block.number, deployment: body.data._meta.deployment, indexingErrors: body.data._meta.hasIndexingErrors, name: p?.name, schemaVersion: p?.schemaVersion ?? c.schemaVersion, tvlUsd: p ? Number(p.totalValueLockedUSD) : null }
  } catch (e: any) {
    return { ...c, ok: false, reason: e?.message?.slice(0, 80) ?? 'error' }
  }
}

const results: any[] = []
const queue = [...candidates]
await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) results.push(await probe(queue.shift()!)) }))
const ok = results.filter((r) => r.ok && !r.indexingErrors)
console.log(`${ok.length} of ${candidates.length} deployments answer the standardized query`)
for (const r of results.filter((x) => !x.ok).slice(0, 8)) console.log('  skip', r.key, r.reason)
writeFileSync(process.argv[3], JSON.stringify({ verifiedAt: Math.floor(Date.now() / 1000), query: QUERY, deployments: ok.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0)) }, null, 2))
