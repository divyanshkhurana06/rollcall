import 'dotenv/config'
import { Client, PrivateKey, AccountCreateTransaction, Hbar, AccountId } from '@hashgraph/sdk'

/**
 * Creates the account that receives x402 payments.
 *
 * This must be distinct from the agent's payer account: a TransferTransaction where payer and
 * payTo are the same account nets to zero, and the facilitator correctly rejects it as an amount
 * mismatch. In production these are obviously different parties; in a demo it is easy to miss.
 */
const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY } = process.env
const client = Client.forTestnet()
client.setOperator(HEDERA_ACCOUNT_ID!, PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY!))

const key = PrivateKey.generateECDSA()
const tx = await new AccountCreateTransaction()
  .setKeyWithoutAlias(key.publicKey)
  .setInitialBalance(new Hbar(20))
  .setAccountMemo('rollcall service treasury')
  .execute(client)

const receipt = await tx.getReceipt(client)
const id = receipt.accountId!.toString()

console.log(`\ntreasury account created: ${id}`)
console.log(`https://hashscan.io/testnet/account/${id}`)
console.log(`\nAdd to .env:\n`)
console.log(`  X402_PAY_TO=${id}`)
console.log(`  TREASURY_PRIVATE_KEY=${key.toStringDer()}\n`)
client.close()
