import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { issue, describe, topUp } from './subscriptions.js'

/**
 * Renewals: credits paid for by a Hedera Scheduled Transaction.
 *
 * The agent creates the schedule and registers it here with the token it wants credited. Until
 * the mirror node shows the schedule executed, the renewal is pending and the token has whatever
 * credits it had. Once executed, the transfer is checked against the price and the token is topped
 * up exactly once. The network's clock decides when the money moves.
 */

export interface Renewal {
  scheduleId: string
  token: string
  credits: number
  expectedTinybar: string
  payTo: string
  payer?: string
  createdAt: number
  executedAt?: number
  creditedAt?: number
  transaction?: string
  status: 'pending' | 'credited' | 'expired' | 'mismatch'
}

const FILE = process.env.RENEWALS_FILE ?? (process.env.VERCEL ? '/tmp/renewals.json' : 'data/renewals.json')
const store = new Map<string, Renewal>()
try {
  if (existsSync(FILE)) for (const r of JSON.parse(readFileSync(FILE, 'utf8')) as Renewal[]) store.set(r.scheduleId, r)
} catch {
  /* start empty */
}
function persist() {
  try {
    mkdirSync(FILE.slice(0, FILE.lastIndexOf('/')) || '.', { recursive: true })
    writeFileSync(FILE, JSON.stringify([...store.values()], null, 2))
  } catch {
    /* memory only */
  }
}

const mirror = () => ((process.env.HEDERA_NETWORK ?? 'testnet') === 'mainnet' ? 'https://mainnet.mirrornode.hedera.com' : 'https://testnet.mirrornode.hedera.com')

export function register(input: { scheduleId: string; credits: number; expectedTinybar: string; payTo: string; payer?: string; token?: string }): Renewal {
  const existing = store.get(input.scheduleId)
  if (existing) return existing
  const token = input.token && describe(input.token) ? input.token : issue(0, { payer: input.payer }).token
  const r: Renewal = { scheduleId: input.scheduleId, token, credits: input.credits, expectedTinybar: input.expectedTinybar, payTo: input.payTo, payer: input.payer, createdAt: Math.floor(Date.now() / 1000), status: 'pending' }
  store.set(r.scheduleId, r)
  persist()
  return r
}

/** Reads the schedule from the mirror node and credits the token if it executed. Idempotent. */
export async function check(scheduleId: string): Promise<Renewal | null> {
  const r = store.get(scheduleId)
  if (!r) return null
  if (r.status !== 'pending') return r
  const res = await fetch(`${mirror()}/api/v1/schedules/${scheduleId}`)
  if (!res.ok) return r
  const s: any = await res.json()
  if (!s.executed_timestamp) {
    if (s.deleted || (s.expiration_time && Number(s.expiration_time) < Date.now() / 1000 - 600 && !s.wait_for_expiry)) {
      r.status = 'expired'
      persist()
    }
    return r
  }
  // Executed. Verify the scheduled transfer actually paid the treasury what the price was.
  const txRes = await fetch(`${mirror()}/api/v1/transactions?timestamp=${s.executed_timestamp}&limit=5`)
  const txs: any = txRes.ok ? await txRes.json() : { transactions: [] }
  const paid = (txs.transactions ?? [])
    .flatMap((t: any) => (t.transfers ?? []).map((x: any) => ({ ...x, id: t.transaction_id, result: t.result })))
    .filter((x: any) => x.account === r.payTo && x.amount > 0 && x.result === 'SUCCESS')
    .reduce((a: number, x: any) => a + Number(x.amount), 0)
  r.executedAt = Math.floor(Number(s.executed_timestamp))
  r.transaction = (txs.transactions ?? []).find((t: any) => t.scheduled)?.transaction_id ?? (txs.transactions ?? [])[0]?.transaction_id
  if (paid >= Number(r.expectedTinybar)) {
    topUp(r.token, r.credits)
    r.status = 'credited'
    r.creditedAt = Math.floor(Date.now() / 1000)
  } else {
    r.status = 'mismatch'
  }
  persist()
  return r
}

export function list(): Renewal[] {
  return [...store.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function pendingFor(token: string): Renewal[] {
  return [...store.values()].filter((r) => r.token === token && r.status === 'pending')
}
