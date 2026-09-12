import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner, PrivateKey } from '@x402/hedera'

/**
 * The x402 client, as a function: discover the price, pick an offer, sign, pay, read the answer.
 * `npm run agent` is this with a terminal; `POST /demo/agent` is this behind a button.
 */

export interface PayOptions {
  api: string
  path: string
  method?: 'GET' | 'POST'
  accountId: string
  privateKey: string
  /** 'hbar' (default), an HTS token id, or a symbol the 402 advertises. */
  asset?: string
  network?: 'hedera:testnet' | 'hedera:mainnet'
}

export interface PayResult {
  resource: string
  offers: { asset: string; amount: string; payTo: string; network: string }[]
  accepted: { asset: string; amount: string; payTo: string; network: string }
  extra: any
  headerBytes: number
  status: number
  ms: number
  body: any
}

export function pickOffer(challenge: any, want = 'hbar') {
  const offers: any[] = challenge.accepts ?? []
  const w = want.toLowerCase()
  if (w === 'hbar' || w === '0.0.0') return offers.find((o) => o.asset === '0.0.0') ?? offers[0]
  const bySymbol = challenge.extra?.hts?.symbol?.toLowerCase() === w ? challenge.extra.hts.asset : null
  return offers.find((o) => o.asset.toLowerCase() === w || (bySymbol && o.asset === bySymbol)) ?? null
}

export async function payFor(opts: PayOptions): Promise<PayResult> {
  const method = opts.method ?? 'GET'
  const url = `${opts.api}${opts.path}`
  const unpaid = await fetch(url, { method })
  if (unpaid.status !== 402) throw new Error(`expected 402 from ${opts.path}, got ${unpaid.status}`)
  const challenge: any = await unpaid.json()
  const req = pickOffer(challenge, opts.asset)
  if (!req) throw new Error(`no offer in ${opts.asset}. Offered: ${(challenge.accepts ?? []).map((o: any) => o.asset).join(', ')}`)

  const signer = createClientHederaSigner(opts.accountId, PrivateKey.fromStringECDSA(opts.privateKey), { network: opts.network ?? 'hedera:testnet' })
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, req)
  const header = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: req.network, accepted: req, payload: signed.payload })).toString('base64')

  const started = Date.now()
  const paid = await fetch(url, { method, headers: { 'X-PAYMENT': header } })
  const body: any = await paid.json()
  return {
    resource: opts.path,
    offers: (challenge.accepts ?? []).map((o: any) => ({ asset: o.asset, amount: o.amount, payTo: o.payTo, network: o.network })),
    accepted: { asset: req.asset, amount: req.amount, payTo: req.payTo, network: req.network },
    extra: challenge.extra,
    headerBytes: header.length,
    status: paid.status,
    ms: Date.now() - started,
    body,
  }
}
