import type { Request, Response, NextFunction } from 'express'

/**
 * x402 v2 payment gate, settled on Hedera testnet through the Blocky402 facilitator.
 *
 * Roll Call is metered by WORK, not by request. A 3-of-5 Safe with 40 transactions and a 12-of-20
 * with 900 are not the same product, and charging them the same price is how metered APIs end up
 * subsidising their heaviest users. Price is quoted from the declared shape of the job:
 *
 *     price = base + perPair * C(n,2) + perTx * min(txs, cap) + perChain * chains
 *
 * The pairwise term is the honest one: independence testing is quadratic in signers, and the
 * permutation loop dominates everything else we do.
 *
 * Wire format follows x402 v2 as the facilitator implements it:
 *   - amounts are integer tinybars (1 HBAR = 100,000,000 tinybar)
 *   - `extra.feePayer` must match the facilitator's advertised Hedera fee payer
 *   - the resource server verifies AND settles, so a client cannot present a payload it never paid
 */

const CFG = {
  facilitator: process.env.X402_FACILITATOR ?? 'https://api.testnet.blocky402.com',
  network: process.env.X402_NETWORK ?? 'hedera:testnet',
  asset: process.env.X402_ASSET ?? '0.0.0',
  payTo: process.env.X402_PAY_TO ?? '',
  base: Number(process.env.X402_BASE ?? 0.02),
  perPair: Number(process.env.X402_PER_PAIR ?? 0.004),
  perTx: Number(process.env.X402_PER_TX ?? 0.0002),
  perChain: Number(process.env.X402_PER_CHAIN ?? 0.01),
  devBypass: process.env.X402_DEV_BYPASS === '1',
}

export const TINYBAR = 100_000_000

export interface Quote {
  /** Integer tinybars, as the wire format requires. */
  amount: string
  /** Same number in HBAR, for humans. */
  hbar: string
  asset: string
  network: string
  breakdown: Record<string, string>
  units: { pairs: number; txs: number; chains: number; permutations: number }
}

export function quote(input: { signers: number; txs: number; chains: number; permutations: number }): Quote {
  const pairs = (input.signers * (input.signers - 1)) / 2
  const txs = Math.min(input.txs, 500)
  const parts = {
    base: CFG.base,
    pairwise: pairs * CFG.perPair,
    history: txs * CFG.perTx,
    chains: input.chains * CFG.perChain,
  }
  const hbar = Object.values(parts).reduce((a, b) => a + b, 0)
  return {
    amount: String(Math.round(hbar * TINYBAR)),
    hbar: hbar.toFixed(6),
    asset: CFG.asset,
    network: CFG.network,
    breakdown: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.toFixed(6)])),
    units: { pairs, txs, chains: input.chains, permutations: input.permutations },
  }
}

let feePayerCache: { at: number; value: string | null } = { at: 0, value: null }

/** The fee payer is read from the facilitator rather than hardcoded, per the v2 handshake. */
export async function facilitatorFeePayer(): Promise<string | null> {
  if (feePayerCache.value && Date.now() - feePayerCache.at < 5 * 60_000) return feePayerCache.value
  try {
    const res = await fetch(`${CFG.facilitator}/supported`)
    const body: any = await res.json()
    const kind = (body.kinds ?? []).find((k: any) => k.network === CFG.network)
    const value = kind?.extra?.feePayer ?? body.signers?.['hedera:*']?.[0] ?? null
    feePayerCache = { at: Date.now(), value }
    return value
  } catch {
    return null
  }
}

/**
 * Strict x402 v2 PaymentRequirements: scheme, network, asset, amount, payTo, maxTimeoutSeconds,
 * extra. Nothing else. Human-facing context (what the resource is, how the price was derived)
 * travels in the 402 envelope instead, because anything added here changes the object the client
 * signs over.
 */
export async function paymentRequirements(q: Quote) {
  return {
    scheme: 'exact',
    network: q.network,
    asset: q.asset,
    amount: q.amount,
    payTo: CFG.payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer: await facilitatorFeePayer() },
  }
}

/** The 402 body an agent needs in order to pay without a human reading docs. */
export async function paymentRequiredBody(q: Quote, resource: string) {
  return {
    x402Version: 2,
    error: 'payment required',
    accepts: [await paymentRequirements(q)],
    extra: {
      resource,
      description: 'Roll Call control surface report',
      mimeType: 'application/json',
      breakdown: q.breakdown,
      units: q.units,
      hbar: q.hbar,
      facilitator: CFG.facilitator,
    },
  }
}

export interface Settlement {
  paid: boolean
  mode: 'facilitator' | 'dev-bypass'
  payer?: string
  transaction?: string
  network: string
  amount: string
  hbar: string
  asset: string
  explorer?: string
  verifiedAt: number
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${CFG.facilitator}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as any }
}

/**
 * Verify then settle. Both happen server side: a client that only verified has not paid, and
 * accepting a verified-but-unsettled payload would make the whole gate decorative.
 */
export async function verifyAndSettle(header: string, q: Quote): Promise<Settlement | { error: string }> {
  let paymentPayload: any
  try {
    paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return { error: 'X-PAYMENT header is not base64 encoded JSON' }
  }

  const reqs = paymentPayload.accepted ?? (await paymentRequirements(q))
  const envelope = { x402Version: 2, paymentPayload, paymentRequirements: reqs }

  const verified = await post('/verify', envelope)
  if (!verified.ok || !(verified.body.isValid ?? verified.body.valid)) {
    return { error: verified.body.invalidMessage ?? verified.body.invalidReason ?? 'verification failed' }
  }

  const settled = await post('/settle', envelope)
  if (!settled.ok || settled.body.success === false) {
    return { error: settled.body.errorMessage ?? settled.body.errorReason ?? 'settlement failed' }
  }

  const tx = settled.body.transaction ?? settled.body.txHash
  return {
    paid: true,
    mode: 'facilitator',
    payer: verified.body.payer,
    transaction: tx,
    network: q.network,
    amount: q.amount,
    hbar: q.hbar,
    asset: q.asset,
    explorer: tx ? `https://hashscan.io/testnet/transaction/${tx}` : undefined,
    verifiedAt: Math.floor(Date.now() / 1000),
  }
}

export function gate(estimator: (req: Request) => { signers: number; txs: number; chains: number; permutations: number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const q = quote(estimator(req))
    ;(req as any).quote = q
    const resource = req.originalUrl

    const header = req.header('X-PAYMENT')
    if (!header) {
      res.setHeader('X-Payment-Amount', q.amount)
      res.setHeader('X-Payment-Network', q.network)
      return res.status(402).json(await paymentRequiredBody(q, resource))
    }

    const result = await verifyAndSettle(header, q)
    if ('error' in result) {
      if (CFG.devBypass) {
        ;(req as any).settlement = {
          paid: true, mode: 'dev-bypass', network: q.network,
          amount: q.amount, hbar: q.hbar, asset: q.asset, verifiedAt: Math.floor(Date.now() / 1000),
        }
        return next()
      }
      return res.status(402).json({ ...(await paymentRequiredBody(q, resource)), error: result.error })
    }

    res.setHeader('X-Payment-Response', Buffer.from(JSON.stringify(result)).toString('base64'))
    ;(req as any).settlement = result
    next()
  }
}

export const x402Config = CFG
