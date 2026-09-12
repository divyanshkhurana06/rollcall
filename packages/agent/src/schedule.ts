import 'dotenv/config'
import { AccountId, Client, Hbar, PrivateKey, ScheduleCreateTransaction, Timestamp, TransferTransaction } from '@hashgraph/sdk'

/**
 * Recurring credits with a Hedera Scheduled Transaction.
 *
 * The agent signs next period's payment now and lets the network execute it at expiry. Nothing
 * moves until then; the API watches the schedule on the mirror node and tops up the token the
 * moment the transfer executes. That is a renewal the agent cannot forget and the service cannot
 * fake: the money moves on the network's clock, not on either party's.
 *
 *   npm run agent:schedule -- 10 120     # 10 credits, executes in 120 seconds
 */

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', x: '\x1b[0m' }
const API = process.env.ROLLCALL_API ?? 'http://localhost:8787'
const credits = Math.max(1, Number(process.argv[2] ?? 10))
const delaySeconds = Math.max(30, Number(process.argv[3] ?? 120))
const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY } = process.env
if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) {
  console.error(`${C.r}HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set${C.x}`)
  process.exit(1)
}

console.log(`\n${C.b}ROLL CALL AGENT${C.x} ${C.d}scheduling ${credits} credit(s) to be paid in ${delaySeconds}s${C.x}`)

// 1. The price, from the same 402 an immediate purchase would get.
const quote = await fetch(`${API}/subscribe?credits=${credits}`, { method: 'POST' })
if (quote.status !== 402) {
  console.error(`${C.r}expected 402, got ${quote.status}${C.x}`)
  process.exit(1)
}
const body: any = await quote.json()
const req = body.accepts[0]
console.log(`  price      ${req.amount} tinybar  ${C.d}(${body.extra?.hbar} HBAR) to ${req.payTo}${C.x}`)

// 2. The scheduled transfer. Signed now, executed by the network at expiry.
const client = Client.forTestnet()
const key = PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY)
client.setOperator(HEDERA_ACCOUNT_ID, key)
const payer = AccountId.fromString(HEDERA_ACCOUNT_ID)
const payTo = AccountId.fromString(req.payTo)
const amount = Hbar.fromTinybars(req.amount)
const expiry = Timestamp.fromDate(new Date(Date.now() + delaySeconds * 1000))

const inner = new TransferTransaction().addHbarTransfer(payer, amount.negated()).addHbarTransfer(payTo, amount)
const scheduled = await new ScheduleCreateTransaction()
  .setScheduledTransaction(inner)
  .setScheduleMemo(`rollcall renewal ${credits} credits`)
  .setExpirationTime(expiry)
  .setWaitForExpiry(true)
  .setPayerAccountId(payer)
  .execute(client)
const receipt = await scheduled.getReceipt(client)
const scheduleId = receipt.scheduleId!.toString()
console.log(`${C.g}scheduled${C.x}  ${C.c}${scheduleId}${C.x}  ${C.d}executes at ${expiry.toDate().toISOString()}${C.x}`)
console.log(`  ${C.d}https://hashscan.io/testnet/schedule/${scheduleId}${C.x}`)

// 3. Tell the API. It issues a token with zero credits and tops it up when the mirror node shows execution.
const reg = await fetch(`${API}/renewals`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scheduleId, credits, payer: HEDERA_ACCOUNT_ID }),
})
const r: any = await reg.json()
if (reg.status !== 200) {
  console.error(`${C.r}api rejected the renewal: ${JSON.stringify(r).slice(0, 300)}${C.x}`)
  process.exit(1)
}
console.log(`\n${C.b}TOKEN${C.x}  ${r.credits} credit(s) now, ${credits} more when the schedule executes`)
console.log(`  ${C.c}${r.token}${C.x}`)
console.log(`\n${C.d}Check: GET ${API}/renewals/${scheduleId}${C.x}\n`)
client.close()
