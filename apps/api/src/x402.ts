import type { Request, Response, NextFunction } from 'express'

/**
 * x402 payment gate (Hedera settlement via the Blocky402 facilitator).
 *
 * Roll Call is metered by WORK, not by request. A 3-of-5 Safe with 40 transactions and a 12-of-20
 * with 900 are not the same product, and charging them the same price is how metered APIs end up
 * subsidising their heaviest users. Price is quoted from the declared shape of the job:
 *
 *     price = base + perSigner * C(n,2) + perTx * min(txs, cap) + perChain * chains
 *
 * The pairwise term is the honest one: independence testing is quadratic in signers, and the
 * permutation loop dominates everything else we do.
 */

export interface Quote {
  amount: string
  asset: string
  network: string
  breakdown: Record<string, string>
  units: { pairs: number; txs: number; chains: number; permutations: number }
}

const CFG = {
  network: process.env.X402_NETWORK ?? 'hedera-testnet',
  asset: process.env.X402_ASSET ?? 'HBAR',
  payTo: process.env.X402_PAY_TO ?? '0.0.0000',
  facilitator: process.env.X402_FACILITATOR ?? 'https://facilitator.blocky402.com',
  base: Number(process.env.X402_BASE ?? 0.02),
  perPair: Number(process.env.X402_PER_PAIR ?? 0.004),
  perTx: Number(process.env.X402_PER_TX ?? 0.0002),
  perChain: Number(process.env.X402_PER_CHAIN ?? 0.01),
  devBypass: process.env.X402_DEV_BYPASS === '1',
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
  const total = Object.values(parts).reduce((a, b) => a + b, 0)
  return {
    amount: total.toFixed(6),
    asset: CFG.asset,
    network: CFG.network,
    breakdown: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.toFixed(6)])),
    units: { pairs, txs, chains: input.chains, permutations: input.permutations },
  }
}

/** The 402 body an agent needs in order to pay without a human reading docs. */
export function paymentRequired(q: Quote, resource: string) {
  return {
    x402Version: 1,
    error: 'payment required',
    accepts: [
      {
        scheme: 'exact',
        network: q.network,
        maxAmountRequired: q.amount,
        asset: q.asset,
        payTo: CFG.payTo,
        resource,
        description: 'Roll Call control-surface report',
        mimeType: 'application/json',
        maxTimeoutSeconds: 120,
        extra: { breakdown: q.breakdown, units: q.units, facilitator: CFG.facilitator },
      },
    ],
  }
}

export interface Settlement {
  paid: boolean
  mode: 'facilitator' | 'dev-bypass'
  txId?: string
  amount: string
  asset: string
  network: string
  verifiedAt: number
}

/** Verify an X-PAYMENT header against the facilitator. */
export async function verifyPayment(header: string, q: Quote): Promise<Settlement | null> {
  try {
    const res = await fetch(`${CFG.facilitator}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader: header,
        paymentRequirements: {
          scheme: 'exact', network: q.network, maxAmountRequired: q.amount,
          asset: q.asset, payTo: CFG.payTo,
        },
      }),
    })
    if (!res.ok) return null
    const body: any = await res.json()
    if (!body.isValid && !body.valid) return null
    return {
      paid: true, mode: 'facilitator',
      txId: body.txId ?? body.transaction ?? body.payer,
      amount: q.amount, asset: q.asset, network: q.network,
      verifiedAt: Math.floor(Date.now() / 1000),
    }
  } catch {
    return null
  }
}

export function gate(estimator: (req: Request) => { signers: number; txs: number; chains: number; permutations: number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const q = quote(estimator(req))
    ;(req as any).quote = q

    const header = req.header('X-PAYMENT')
    if (!header) {
      res.setHeader('X-Payment-Amount', q.amount)
      res.setHeader('X-Payment-Asset', q.asset)
      res.setHeader('X-Payment-Network', q.network)
      return res.status(402).json(paymentRequired(q, req.originalUrl))
    }

    let settlement = await verifyPayment(header, q)
    if (!settlement && CFG.devBypass) {
      settlement = { paid: true, mode: 'dev-bypass', amount: q.amount, asset: q.asset, network: q.network, verifiedAt: Math.floor(Date.now() / 1000) }
    }
    if (!settlement) return res.status(402).json({ ...paymentRequired(q, req.originalUrl), error: 'payment verification failed' })

    ;(req as any).settlement = settlement
    next()
  }
}

export const x402Config = CFG
