import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner, PrivateKey } from '@x402/hedera'

/**
 * A paying client for the Roll Call API.
 *
 * This is the whole point of metering by work rather than per request: an agent can discover the
 * price, decide whether the job is worth it, pay, and read the answer, with no API key, no account
 * and no prior relationship with the service.
 *
 * Flow, exactly as x402 v2 specifies it:
 *   1. request the resource with no payment    -> 402 carrying `accepts[0]`
 *   2. sign a TransferTransaction for that requirement (facilitator co-signs as fee payer)
 *   3. repeat the request with X-PAYMENT       -> server verifies, settles, and serves
 */

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', x: '\x1b[0m' }

const API = process.env.ROLLCALL_API ?? 'http://localhost:8787'
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const target = args[0] ?? '0x97cd81555F18d612C02FC4468118C48adD9f1245'
const chain = args[1] ?? 'ethereum'
/** --asset=hbar (default) or --asset=<symbol|tokenId> to settle in an HTS token the API offers. */
const wantAsset = (process.argv.find((a) => a.startsWith('--asset=')) ?? '--asset=hbar').split('=')[1].toLowerCase()
const resource = `/report/${chain}/${target}?max=100&perms=2000`

const accountId = process.env.HEDERA_ACCOUNT_ID
const privateKey = process.env.HEDERA_PRIVATE_KEY
if (!accountId || !privateKey) {
  console.error(`${C.r}HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set${C.x}`)
  process.exit(1)
}

console.log(`\n${C.b}ROLL CALL AGENT${C.x} ${C.d}paying for a report over x402${C.x}`)
console.log(`${C.d}${'-'.repeat(72)}${C.x}`)
console.log(`resource   ${C.c}${resource}${C.x}`)
console.log(`payer      ${accountId}\n`)

// ---- 1. discover the price -------------------------------------------------------------------
const unpaid = await fetch(`${API}${resource}`)
if (unpaid.status !== 402) {
  console.error(`${C.r}expected 402, got ${unpaid.status}. Is the gate disabled (X402_DEV_BYPASS=1)?${C.x}`)
  process.exit(1)
}
const challenge: any = await unpaid.json()
const offers: any[] = challenge.accepts
const req =
  wantAsset === 'hbar'
    ? offers[0]
    : offers.find((o) => o.asset.toLowerCase() === wantAsset || challenge.extra?.hts?.symbol?.toLowerCase() === wantAsset && o.asset === challenge.extra.hts.asset)
if (!req) {
  console.error(`${C.r}the API does not offer settlement in ${wantAsset}. Offered: ${offers.map((o) => o.asset).join(', ')}${C.x}`)
  process.exit(1)
}

console.log(`${C.b}402 payment required${C.x}  ${C.d}${offers.length} way(s) to pay: ${offers.map((o) => o.asset).join(', ')}${C.x}`)
if (req.asset === '0.0.0') console.log(`  amount     ${req.amount} tinybar  ${C.d}(${challenge.extra?.hbar} HBAR)${C.x}`)
else console.log(`  amount     ${req.amount} units of ${req.asset}  ${C.d}(${challenge.extra?.hts?.symbol ?? 'token'}, ${challenge.extra?.hts?.note ?? ''})${C.x}`)
console.log(`  network    ${req.network}`)
console.log(`  payTo      ${req.payTo}`)
console.log(`  feePayer   ${req.extra?.feePayer}  ${C.d}(facilitator co-signs)${C.x}`)
if (challenge.extra?.breakdown) {
  console.log(`  ${C.d}priced by work:${C.x}`)
  for (const [k, v] of Object.entries(challenge.extra.breakdown)) console.log(`    ${C.d}${k.padEnd(10)} ${v}${C.x}`)
  const u = challenge.extra.units
  console.log(`    ${C.d}${u.pairs} signer pairs, ${u.txs} transactions, ${u.chains} chain(s)${C.x}`)
}

// ---- 2. sign the transfer --------------------------------------------------------------------
console.log(`\n${C.d}signing TransferTransaction...${C.x}`)
const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
  network: 'hedera:testnet',
})
const scheme = new ExactHederaScheme(signer)
const signed = await scheme.createPaymentPayload(2, req)

const paymentPayload = {
  x402Version: 2,
  scheme: 'exact',
  network: req.network,
  accepted: req,
  payload: signed.payload,
}
const header = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
console.log(`${C.g}signed${C.x} ${C.d}(${header.length} byte header)${C.x}`)

// ---- 3. pay and read -------------------------------------------------------------------------
console.log(`${C.d}resending with X-PAYMENT...${C.x}\n`)
const started = Date.now()
const paid = await fetch(`${API}${resource}`, { headers: { 'X-PAYMENT': header } })
const body: any = await paid.json()

if (paid.status !== 200) {
  console.error(`${C.r}payment rejected (${paid.status})${C.x}`)
  console.error(JSON.stringify(body, null, 2).slice(0, 900))
  process.exit(1)
}

const s = body.settlement
console.log(`${C.g}${C.b}PAID AND SERVED${C.x} ${C.d}in ${((Date.now() - started) / 1000).toFixed(1)}s${C.x}`)
console.log(`  settled    ${s.asset === '0.0.0' ? `${s.hbar} HBAR` : `${s.amount} units of ${s.asset}`} on ${s.network}  ${C.d}(${s.mode})${C.x}`)
if (s.payer) console.log(`  payer      ${s.payer}`)
if (s.transaction) console.log(`  tx         ${C.c}${s.transaction}${C.x}`)
if (s.explorer) console.log(`  explorer   ${C.d}${s.explorer}${C.x}`)

const r = body.report
console.log(`\n${C.b}THE ANSWER THE AGENT PAID FOR${C.x}`)
console.log(`  declared threshold   ${r.observed.threshold} of ${r.observed.owners.length}`)
const eq = Math.min(...r.inferred.quorumCurve.map((c: any) => c.effectiveQuorum))
console.log(`  effective quorum     ${eq}  ${C.d}(${r.inferred.robustness.verdict})${C.x}`)
console.log(`  signers dark         ${r.reachability.darkSigners} of ${r.reachability.owners}`)
console.log(`  can reach quorum     ${r.reachability.canStillReachThreshold ? C.g + 'yes' : C.r + 'no'}${C.x}`)

mkdirSync('data', { recursive: true })
writeFileSync('data/last-report.json', JSON.stringify(body, null, 2))

if (body.receipt?.submitted) {
  console.log(`\n${C.b}ATTESTED TO HCS${C.x}`)
  console.log(`  topic      ${body.receipt.topicId}  seq ${body.receipt.sequenceNumber}`)
  console.log(`  ${C.d}${body.receipt.explorer}${C.x}`)
}
console.log()
