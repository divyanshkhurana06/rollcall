import 'dotenv/config'
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { ATS, FACTORY_V1_ABI, FACTORY_V8_ABI, ROLES } from './ats.js'
import { coverIsin } from './isin.js'

/**
 * Roll Call Cover Note - a tokenised instrument issued through the Hedera Asset Tokenization
 * Studio.
 *
 * WHY THIS IS PART OF THE PRODUCT AND NOT A BOLT ON:
 *
 * Roll Call measures a risk. Measuring a risk is half a product; somebody has to bear it. The
 * cover note closes the loop, and every leg maps onto something ATS already does properly:
 *
 *   the report        ->  written into the instrument's own regulation data, so the cover is
 *                         bound to one specific, timestamped assessment and cannot later be
 *                         argued to have been written against different facts
 *   the premium       ->  the bond's coupon schedule
 *   who may hold it   ->  whitelist plus internal KYC, ERC-3643 style
 *   a breach          ->  detected by the CRE confidential workflow, settled by the controller
 *   the term          ->  maturity
 *
 * ATS is driven through its deployed contracts rather than its SDK, which the prize allows: the
 * SDK's wallet layer targets Metamask, WalletConnect and custody providers, none of which exist
 * inside a headless issuer.
 */

const RPC = process.env.HEDERA_RPC ?? 'https://testnet.hashio.io/api'
const CONFIG_VERSION = 1n
const C = { g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', c: '\x1b[36m', r: '\x1b[31m', y: '\x1b[33m', x: '\x1b[0m' }

const pk = (process.env.HEDERA_PRIVATE_KEY ?? '') as `0x${string}`
if (!pk) { console.error('HEDERA_PRIVATE_KEY not set'); process.exit(1) }
const account = privateKeyToAccount(pk)

const chain = { id: 296, name: 'Hedera Testnet', nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const pub = createPublicClient({ chain: chain as any, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: chain as any, transport: http(RPC) })

// ---- the assessment this cover is written against ------------------------------------------
const reportPath = process.argv[2] ?? 'data/last-report.json'
let digest = '', target = '', threshold = 0, owners = 0, honest = 0, dark = 0
try {
  const raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  const rep = raw.report ?? raw
  digest = rep.header.inputDigest
  target = rep.target.address
  threshold = rep.observed.threshold
  owners = rep.observed.owners.length
  honest = Math.min(...rep.inferred.quorumCurve.map((c: any) => c.effectiveQuorum))
  dark = rep.reachability.darkSigners
} catch {
  console.error(`${C.r}no report at ${reportPath}${C.x}. Run: npm run agent`)
  process.exit(1)
}

const now = Math.floor(Date.now() / 1000)
const starting = BigInt(now + 180)
const maturity = BigInt(now + 180 + 365 * 24 * 3600)
const firstCoupon = BigInt(now + 180 + 90 * 24 * 3600)

/**
 * Premium follows the measured risk. A cover note over a control surface whose honest quorum is
 * below its declared threshold, or whose signers have gone quiet, is not the same product as one
 * over a healthy Safe, and should not be priced as though it were.
 */
const gap = Math.max(0, threshold - honest)
const couponRateBps = BigInt(150 + gap * 250 + dark * 100)

const isin = coverIsin(target)
const info = JSON.stringify({
  product: 'rollcall.cover-note.v1',
  target, declaredThreshold: threshold, owners, honestQuorum: honest, darkSigners: dark,
  reportDigest: digest,
  hcsTopic: process.env.HCS_TOPIC_ID ?? null,
  premiumBps: Number(couponRateBps),
  underwrittenAt: now,
})

const security = {
  arePartitionsProtected: false,
  isMultiPartition: false,
  resolver: ATS.resolver as `0x${string}`,
  resolverProxyConfiguration: { key: '0x0000000000000000000000000000000000000000000000000000000000000002' as `0x${string}`, version: CONFIG_VERSION },
  rbacs: Object.values(ROLES).map((role) => ({ role: role as `0x${string}`, members: [account.address] })),
  isControllable: true,       // a breach must be settleable by the issuer
  isWhiteList: true,          // cover is not bearer paper
  maxSupply: 1_000_000n,
  erc20MetadataInfo: { name: `Roll Call Cover ${target.slice(0, 8)}`, symbol: 'RCCOV', isin, decimals: 2 },
  clearingActive: false,
  internalKycActivated: true,
  externalPauses: [] as `0x${string}`[],
  externalControlLists: [] as `0x${string}`[],
  externalKycLists: [] as `0x${string}`[],
  compliance: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  identityRegistry: '0x0000000000000000000000000000000000000000' as `0x${string}`,
}

const v1Args = [
  {
    security,
    bondDetails: { currency: '0x555344' as `0x${string}`, nominalValue: 10_000n, startingDate: starting, maturityDate: maturity },
    couponDetails: { couponFrequency: 90n * 24n * 3600n, couponRate: couponRateBps, firstCouponDate: firstCoupon },
  },
  { regulationType: 1, regulationSubType: 0, additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info } },
]

const v8Args = [
  {
    security: {
      resolver: security.resolver, maxSupply: security.maxSupply,
      resolverProxyConfiguration: security.resolverProxyConfiguration,
      erc20MetadataInfo: security.erc20MetadataInfo, rbacs: security.rbacs,
      externalPauses: [], externalControlLists: [], externalKycLists: [],
      compliance: security.compliance, identityRegistry: security.identityRegistry,
      arePartitionsProtected: false, isMultiPartition: false, isControllable: true,
      isWhiteList: true, clearingActive: false, internalKycActivated: true, erc20VotesActivated: false,
    },
    bondDetails: { currency: '0x555344' as `0x${string}`, nominalValue: 10_000n, nominalValueDecimals: 2, startingDate: starting, maturityDate: maturity },
    proceedRecipients: [], proceedRecipientsData: [],
  },
  { regulationType: 1, regulationSubType: 0, additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info } },
]

console.log(`\n${C.b}ROLL CALL COVER NOTE${C.x} ${C.d}Hedera Asset Tokenization Studio${C.x}`)
console.log(`${C.d}${'-'.repeat(76)}${C.x}`)
console.log(`  underwritten against  ${target}`)
console.log(`  declared / honest     ${threshold} of ${owners}  ->  honest quorum ${honest}   (${dark} signer(s) dark)`)
console.log(`  report digest         ${digest}`)
console.log(`  premium               ${couponRateBps} bps  ${C.d}(150 base + ${gap * 250} quorum gap + ${dark * 100} dark signers)${C.x}`)
console.log(`  isin                  ${isin}`)
console.log(`  issuer                ${account.address}`)
console.log(`  ATS factory           ${ATS.factory}  (${ATS.factoryId})`)
console.log(`  compliance            whitelist + internal KYC, controllable, quarterly coupon, 1y maturity\n`)

/** Try each known factory shape and keep whichever the live contract actually accepts. */
const attempts = [
  { label: 'ATS v1 layout', abi: FACTORY_V1_ABI, args: v1Args },
  { label: 'ATS v8 layout', abi: FACTORY_V8_ABI, args: v8Args },
]

let ok: { hash: `0x${string}`; label: string } | null = null
for (const a of attempts) {
  process.stdout.write(`${C.d}  simulating ${a.label}... ${C.x}`)
  try {
    await pub.simulateContract({ address: ATS.factory as `0x${string}`, abi: a.abi as any, functionName: 'deployBond', args: a.args as any, account, gas: 15_000_000n })
    console.log(`${C.g}accepted${C.x}`)
    const hash = await wallet.writeContract({ address: ATS.factory as `0x${string}`, abi: a.abi as any, functionName: 'deployBond', args: a.args as any, gas: 15_000_000n })
    ok = { hash, label: a.label }
    break
  } catch (e: any) {
    console.log(`${C.y}rejected${C.x} ${C.d}${String(e?.shortMessage ?? e?.message).split('\n')[0].slice(0, 70)}${C.x}`)
  }
}

if (!ok) {
  console.error(`\n${C.r}${C.b}ISSUANCE FAILED${C.x} - no known ATS factory layout was accepted by ${ATS.factoryId}.`)
  process.exit(1)
}

console.log(`\n  tx ${C.c}${ok.hash}${C.x}`)
const receipt = await pub.waitForTransactionReceipt({ hash: ok.hash })
console.log(`  status ${receipt.status}  gas ${receipt.gasUsed}`)

// A reverted transaction is not an issuance. Reporting one as success would be exactly the kind
// of claim this project exists to argue against.
if (receipt.status !== 'success') {
  console.error(`\n${C.r}${C.b}ISSUANCE FAILED${C.x} - the transaction reverted, no instrument exists.`)
  console.error(`  ${C.d}https://hashscan.io/testnet/transaction/${ok.hash}${C.x}\n`)
  process.exit(1)
}

const created = receipt.logs.map((l) => l.address.toLowerCase())
  .find((a) => a !== ATS.factory.toLowerCase() && a !== ATS.resolver.toLowerCase()) ?? null

console.log(`\n${C.g}${C.b}COVER NOTE ISSUED${C.x}  ${C.d}via ${ok.label}${C.x}`)
console.log(`  address    ${C.c}${created}${C.x}`)
console.log(`  hashscan   ${C.d}https://hashscan.io/testnet/contract/${created}${C.x}`)
console.log(`  tx         ${C.d}https://hashscan.io/testnet/transaction/${ok.hash}${C.x}\n`)

mkdirSync('data', { recursive: true })
writeFileSync('data/cover-note.json', JSON.stringify({
  address: created, txHash: ok.hash, layout: ok.label, issuer: account.address,
  factory: ATS.factory, factoryId: ATS.factoryId, isin,
  target, reportDigest: digest, declaredThreshold: threshold, owners, honestQuorum: honest,
  darkSigners: dark, premiumBps: Number(couponRateBps),
  startingDate: Number(starting), maturityDate: Number(maturity), firstCouponDate: Number(firstCoupon),
}, null, 2))
console.log(`${C.d}written to data/cover-note.json${C.x}\n`)
