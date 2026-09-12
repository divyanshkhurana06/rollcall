import 'dotenv/config'
import {
  AccountCreateTransaction, AccountId, Client, CustomFractionalFee, Hbar, PrivateKey,
  TokenAssociateTransaction, TokenCreateTransaction, TokenSupplyType, TokenType, TransferTransaction,
} from '@hashgraph/sdk'

/**
 * Settlement in an HTS token with a custom fee schedule.
 *
 * Roll Call Credit (RCC) is a fungible HTS token that the API accepts alongside HBAR. Its fee
 * schedule carries a 2% fractional fee to the service treasury, assessed by the network on every
 * transfer, so the settlement path exercises HTS custom fees rather than merely moving a token.
 *
 *   npm run setup:hts
 *
 * Creates the treasury account that collects RCC, the token, the association, and funds the agent
 * with an initial balance. Prints the .env lines to add.
 */

const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY } = process.env
if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) throw new Error('HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set')

const client = Client.forTestnet()
const operatorKey = PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY)
client.setOperator(HEDERA_ACCOUNT_ID, operatorKey)

// 1. The account that receives RCC payments and collects the custom fee.
const collectorKey = PrivateKey.generateECDSA()
const created = await (await new AccountCreateTransaction()
  .setKeyWithoutAlias(collectorKey.publicKey)
  .setInitialBalance(new Hbar(5))
  .setMaxAutomaticTokenAssociations(10)
  .setAccountMemo('rollcall rcc treasury')
  .execute(client)).getReceipt(client)
const collector = created.accountId!
console.log(`collector account  ${collector}  https://hashscan.io/testnet/account/${collector}`)

// 2. The token, with a fee schedule the network enforces on every transfer.
const fee = new CustomFractionalFee()
  .setNumerator(2)
  .setDenominator(100)
  .setMin(0)
  .setFeeCollectorAccountId(collector)
  .setAssessmentMethod(false) // fee comes out of the transferred amount

const tokenCreate = await new TokenCreateTransaction()
  .setTokenName('Roll Call Credit')
  .setTokenSymbol('RCC')
  .setTokenType(TokenType.FungibleCommon)
  .setDecimals(2)
  .setInitialSupply(1_000_000_00) // 1,000,000.00 RCC
  .setSupplyType(TokenSupplyType.Infinite)
  .setTreasuryAccountId(AccountId.fromString(HEDERA_ACCOUNT_ID))
  .setAdminKey(operatorKey.publicKey)
  .setSupplyKey(operatorKey.publicKey)
  .setFeeScheduleKey(operatorKey.publicKey)
  .setCustomFees([fee])
  .setTokenMemo('Roll Call report credit. 2% fractional fee to the service treasury on every transfer.')
  .freezeWith(client)
  .sign(collectorKey) // the fee collector must sign to accept the role
const tokenReceipt = await (await tokenCreate.execute(client)).getReceipt(client)
const tokenId = tokenReceipt.tokenId!
console.log(`token              ${tokenId}  https://hashscan.io/testnet/token/${tokenId}`)

// 3. Prove the fee schedule with one transfer: 100.00 RCC from the treasury to the collector.
const transfer = await (await new TransferTransaction()
  .addTokenTransfer(tokenId, AccountId.fromString(HEDERA_ACCOUNT_ID), -100_00)
  .addTokenTransfer(tokenId, collector, 100_00)
  .execute(client)).getRecord(client)
console.log(`first transfer     ${transfer.transactionId}  assessed custom fees: ${transfer.assessedCustomFees.length}`)

console.log(`\nAdd to .env:\n`)
console.log(`  X402_HTS_ASSET=${tokenId}`)
console.log(`  X402_HTS_PAY_TO=${collector}`)
console.log(`  X402_HTS_DECIMALS=2`)
console.log(`  X402_HTS_PER_HBAR=10`)
console.log(`  HTS_COLLECTOR_PRIVATE_KEY=${collectorKey.toStringDer()}\n`)
client.close()
