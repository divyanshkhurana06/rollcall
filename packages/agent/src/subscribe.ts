import 'dotenv/config'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner, PrivateKey } from '@x402/hedera'

/**
 * Buy prepaid report credits over x402, once, and get a bearer token.
 *
 * This is for the runtimes that cannot sign a Hedera transfer per request: the Chainlink CRE
 * workflows run inside an enclave with no Hedera key, and a cron should not carry one either. The
 * key that pays stays here; the token is what the enclave holds.
 *
 *   npm run agent:subscribe -- 20      # twenty report credits
 */

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', x: '\x1b[0m' }

const API = process.env.ROLLCALL_API ?? 'http://localhost:8787'
const credits = Math.max(1, Number(process.argv[2] ?? 10))
const resource = `/subscribe?credits=${credits}`

const accountId = process.env.HEDERA_ACCOUNT_ID
const privateKey = process.env.HEDERA_PRIVATE_KEY
if (!accountId || !privateKey) {
  console.error(`${C.r}HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set${C.x}`)
  process.exit(1)
}

console.log(`\n${C.b}ROLL CALL AGENT${C.x} ${C.d}buying ${credits} report credit(s) over x402${C.x}`)
console.log(`${C.d}${'-'.repeat(72)}${C.x}`)

const unpaid = await fetch(`${API}${resource}`, { method: 'POST' })
if (unpaid.status !== 402) {
  console.error(`${C.r}expected 402, got ${unpaid.status}${C.x}`)
  process.exit(1)
}
const challenge: any = await unpaid.json()
const req = challenge.accepts[0]
console.log(`${C.b}402 payment required${C.x}`)
console.log(`  amount     ${req.amount} tinybar  ${C.d}(${challenge.extra?.hbar} HBAR for ${credits} credits)${C.x}`)
console.log(`  payTo      ${req.payTo}   feePayer ${req.extra?.feePayer}`)

const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: 'hedera:testnet' })
const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, req)
const header = Buffer.from(
  JSON.stringify({ x402Version: 2, scheme: 'exact', network: req.network, accepted: req, payload: signed.payload }),
).toString('base64')

const paid = await fetch(`${API}${resource}`, { method: 'POST', headers: { 'X-PAYMENT': header } })
const body: any = await paid.json()
if (paid.status !== 200) {
  console.error(`${C.r}payment rejected (${paid.status})${C.x}`)
  console.error(JSON.stringify(body, null, 2).slice(0, 900))
  process.exit(1)
}

const s = body.settlement
console.log(`\n${C.g}${C.b}PAID${C.x}  ${s.hbar} HBAR on ${s.network}  ${C.d}(${s.mode})${C.x}`)
if (s.transaction) console.log(`  tx         ${C.c}${s.transaction}${C.x}`)
if (s.explorer) console.log(`  explorer   ${C.d}${s.explorer}${C.x}`)
console.log(`\n${C.b}TOKEN${C.x}  ${body.credits} credit(s)`)
console.log(`  ${C.c}${body.token}${C.x}`)
console.log(`\n${C.d}Use it as  Authorization: Bearer <token>  on GET /report/...`)
console.log(`For the CRE workflows, put this line in cre/.env:${C.x}`)
console.log(`  SECRET_ROLLCALL_API_KEY=${body.token}\n`)
