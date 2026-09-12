import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Prepaid report credits, bought once over x402 and spent by bearer token.
 *
 * An agent that can sign a Hedera transfer pays per request. An agent that cannot, because it is
 * running inside an enclave with no Hedera key, or because it is a cron that should not carry one,
 * buys N credits up front and presents the token. The token is the credential the enclave holds;
 * the key that paid for it never leaves the buyer.
 *
 * Stored as a flat file so a restart does not strand paid credits. The file is a list of
 * credentials and is gitignored.
 */

export interface Subscription {
  token: string
  credits: number
  issued: number
  issuedAt: number
  payer?: string
  transaction?: string
  lastUsedAt?: number
}

// Serverless hosts have a read-only project directory, so the file lives in /tmp there and credits
// bought on one instance can be re-seeded from ROLLCALL_TOKENS ("token:credits,token:credits").
const FILE = process.env.SUBSCRIPTIONS_FILE ?? (process.env.VERCEL ? '/tmp/subscriptions.json' : 'data/subscriptions.json')
const store = new Map<string, Subscription>()

try {
  if (existsSync(FILE)) for (const s of JSON.parse(readFileSync(FILE, 'utf8')) as Subscription[]) store.set(s.token, s)
} catch {
  /* start empty rather than refuse to start */
}
for (const entry of (process.env.ROLLCALL_TOKENS ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
  const [token, credits] = entry.split(':')
  if (token && !store.has(token)) store.set(token, { token, credits: Number(credits ?? 0), issued: Number(credits ?? 0), issuedAt: 0 })
}

function persist() {
  try {
    mkdirSync(FILE.slice(0, FILE.lastIndexOf('/')) || '.', { recursive: true })
    writeFileSync(FILE, JSON.stringify([...store.values()], null, 2))
  } catch {
    /* in-memory only; the seed covers restarts */
  }
}

export function issue(credits: number, meta: { payer?: string; transaction?: string }): Subscription {
  const s: Subscription = {
    token: `rc_${randomBytes(24).toString('hex')}`,
    credits,
    issued: credits,
    issuedAt: Math.floor(Date.now() / 1000),
    ...meta,
  }
  store.set(s.token, s)
  persist()
  return s
}

/** Spends one credit. Null for an unknown or exhausted token, so the caller can fall back to x402. */
export function consume(token: string): Subscription | null {
  const s = store.get(token)
  if (!s || s.credits <= 0) return null
  s.credits -= 1
  s.lastUsedAt = Math.floor(Date.now() / 1000)
  persist()
  return s
}

export function describe(token: string) {
  const s = store.get(token)
  return s ? { credits: s.credits, issued: s.issued, issuedAt: s.issuedAt, lastUsedAt: s.lastUsedAt ?? null } : null
}

export const redact = (token: string) => `${token.slice(0, 7)}...${token.slice(-4)}`

/** Adds credits to an existing token. Used when a scheduled renewal executes. */
export function topUp(token: string, credits: number): Subscription | null {
  const s = store.get(token)
  if (!s) return null
  s.credits += credits
  s.issued += credits
  persist()
  return s
}
