import 'dotenv/config'
import { AccountId, Client, PrivateKey, TokenId, TokenUpdateTransaction, TransferTransaction } from '@hashgraph/sdk'

/**
 * Moves the RCC treasury to the collector account and funds the agent, so that when the agent pays
 * the API it is not the treasury paying, and the network assesses the fee schedule for real.
 * Treasury and fee collector accounts are exempt from custom fees; the paying agent is not.
 */
const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, X402_HTS_ASSET, X402_HTS_PAY_TO, HTS_COLLECTOR_PRIVATE_KEY } = process.env as Record<string, string>
const client = Client.forTestnet()
const operatorKey = PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY)
client.setOperator(HEDERA_ACCOUNT_ID, operatorKey)
const collectorKey = PrivateKey.fromStringDer(HTS_COLLECTOR_PRIVATE_KEY)
const token = TokenId.fromString(X402_HTS_ASSET)
const collector = AccountId.fromString(X402_HTS_PAY_TO)
const operator = AccountId.fromString(HEDERA_ACCOUNT_ID)

const update = await (await new TokenUpdateTransaction().setTokenId(token).setTreasuryAccountId(collector).freezeWith(client).sign(collectorKey)).execute(client)
await update.getReceipt(client)
console.log(`treasury moved to ${collector}`)

// The new treasury funds the agent. Treasury transfers are fee-exempt, as they should be.
const fund = await (await new TransferTransaction()
  .addTokenTransfer(token, collector, -50_000_00)
  .addTokenTransfer(token, operator, 50_000_00)
  .freezeWith(client)
  .sign(collectorKey)).execute(client)
await fund.getReceipt(client)
console.log(`agent ${operator} funded with 50,000.00 RCC`)

// And the proof: the agent pays the treasury, and the network assesses the fee.
const pay = await (await new TransferTransaction()
  .addTokenTransfer(token, operator, -10_00)
  .addTokenTransfer(token, collector, 10_00)
  .execute(client)).getRecord(client)
console.log(`agent -> treasury 10.00 RCC  tx ${pay.transactionId}  assessed custom fees: ${pay.assessedCustomFees.length}`)
for (const f of pay.assessedCustomFees) console.log(`  fee ${f.amount?.toString()} units of ${f.tokenId?.toString()} to ${f.feeCollectorAccountId?.toString()}`)
console.log(`https://hashscan.io/testnet/transaction/${pay.transactionId}`)
client.close()
