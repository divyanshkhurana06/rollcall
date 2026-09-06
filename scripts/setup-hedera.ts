/**
 * One-time Hedera setup.
 *
 * Creates the HCS topic that Roll Call writes attestations to, then prints the line to add to .env.
 * Idempotent in the sense that it never touches an existing topic - if HCS_TOPIC_ID is already set
 * it verifies the topic is reachable and exits.
 *
 *   npx tsx scripts/setup-hedera.ts
 */
import 'dotenv/config'

const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, HEDERA_NETWORK = 'testnet', HCS_TOPIC_ID } = process.env
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY) {
  console.error(`${C.r}HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must be set in .env${C.x}`)
  console.error(`${C.d}Create a testnet account at https://portal.hedera.com and copy the ECDSA key.${C.x}`)
  process.exit(1)
}

const mirror = HEDERA_NETWORK === 'mainnet'
  ? 'https://mainnet.mirrornode.hedera.com'
  : 'https://testnet.mirrornode.hedera.com'

if (HCS_TOPIC_ID) {
  const res = await fetch(`${mirror}/api/v1/topics/${HCS_TOPIC_ID}/messages?limit=1`)
  if (res.ok) {
    const body: any = await res.json()
    console.log(`${C.g}topic ${HCS_TOPIC_ID} is reachable${C.x}  ${C.d}(${body.messages?.length ?? 0} message(s) visible)${C.x}`)
    console.log(`${C.d}https://hashscan.io/${HEDERA_NETWORK}/topic/${HCS_TOPIC_ID}${C.x}`)
    process.exit(0)
  }
  console.log(`${C.y}HCS_TOPIC_ID is set but not reachable on ${HEDERA_NETWORK}. Creating a new one.${C.x}`)
}

const { Client, PrivateKey, TopicCreateTransaction } = await import('@hashgraph/sdk')
const client = HEDERA_NETWORK === 'mainnet' ? Client.forMainnet() : Client.forTestnet()
client.setOperator(HEDERA_ACCOUNT_ID, PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY))

console.log(`${C.d}creating topic on ${HEDERA_NETWORK}...${C.x}`)
const tx = await new TopicCreateTransaction()
  .setTopicMemo('rollcall.control-surface attestations v1')
  .execute(client)
const receipt = await tx.getReceipt(client)
const topicId = receipt.topicId!.toString()

console.log(`\n${C.g}${C.b}topic created: ${topicId}${C.x}`)
console.log(`${C.d}https://hashscan.io/${HEDERA_NETWORK}/topic/${topicId}${C.x}`)
console.log(`\nAdd to .env:\n\n  ${C.b}HCS_TOPIC_ID=${topicId}${C.x}\n`)
client.close()
