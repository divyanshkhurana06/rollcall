import 'dotenv/config'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ATS, FACTORY_V1_ABI, FACTORY_V7_ABI, FACTORY_V8_ABI, ROLES } from './ats.js'
import { coverIsin } from './isin.js'

/**
 * Find the layout the deployed factory actually speaks.
 *
 * The ATS contracts changed their deployBond struct three times, and the deployed testnet factory
 * predates the current package. Rather than guess, every known layout is simulated against the live
 * contract and whichever it accepts is the answer.
 */
const pub = createPublicClient({ transport: http(process.env.HEDERA_RPC ?? 'https://testnet.hashio.io/api') })
const account = privateKeyToAccount(process.env.HEDERA_PRIVATE_KEY as `0x${string}`)
const now = Math.floor(Date.now() / 1000)
const isin = coverIsin('0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5')
const reg = { regulationType: 1, regulationSubType: 0, additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info: 'probe' } }

const meta = { name: 'Roll Call Cover', symbol: 'RCCOV', isin, decimals: 2 }
const dates = { startingDate: BigInt(now + 600), maturityDate: BigInt(now + 600 + 31_536_000) }
const zero = '0x0000000000000000000000000000000000000000' as const

function rbacs(minimal: boolean) {
  return minimal
    ? [{ role: ROLES.DEFAULT_ADMIN as `0x${string}`, members: [account.address] }]
    : Object.values(ROLES).map((r) => ({ role: r as `0x${string}`, members: [account.address] }))
}

function build(layout: 'v1' | 'v7' | 'v8', cfg: string, ver: bigint, minimal: boolean) {
  const common = {
    resolver: ATS.resolver as `0x${string}`,
    resolverProxyConfiguration: { key: cfg as `0x${string}`, version: ver },
    rbacs: rbacs(minimal),
    maxSupply: 1_000_000n,
    erc20MetadataInfo: meta,
    externalPauses: [], externalControlLists: [], externalKycLists: [],
    compliance: zero, identityRegistry: zero,
    arePartitionsProtected: false, isMultiPartition: false,
    isControllable: true, isWhiteList: false, clearingActive: false, internalKycActivated: false,
  }
  if (layout === 'v1') {
    return [{
      security: common,
      bondDetails: { currency: '0x555344', nominalValue: 10_000n, ...dates },
      couponDetails: { couponFrequency: 7_776_000n, couponRate: 500n, firstCouponDate: BigInt(now + 600 + 7_776_000) },
    }, reg]
  }
  return [{
    security: { ...common, erc20VotesActivated: false },
    bondDetails: { currency: '0x555344', nominalValue: 10_000n, nominalValueDecimals: 2, ...dates },
    proceedRecipients: [], proceedRecipientsData: [],
  }, reg]
}

const LAYOUTS = [
  { name: 'v1 (1.15.x)', key: 'v1' as const, abi: FACTORY_V1_ABI },
  { name: 'v7 (2.0-7.0)', key: 'v7' as const, abi: FACTORY_V7_ABI },
  { name: 'v8 (8.0.0)', key: 'v8' as const, abi: FACTORY_V8_ABI },
]
const CFGS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000000000000000000000000000002',
]

let found = false
for (const l of LAYOUTS) {
  for (const cfg of CFGS) {
    for (const ver of [0n, 1n]) {
      for (const minimal of [true, false]) {
        try {
          const r = await pub.simulateContract({
            address: ATS.factory as `0x${string}`, abi: l.abi as any, functionName: 'deployBond',
            args: build(l.key, cfg, ver, minimal) as any, account, gas: 15_000_000n,
          })
          console.log(`ACCEPTED  layout=${l.name} cfg=..${cfg.slice(-2)} ver=${ver} rbac=${minimal ? 'minimal' : 'full'} -> ${r.result}`)
          found = true
        } catch { /* keep scanning */ }
      }
    }
  }
}
if (!found) console.log('no layout accepted by the deployed factory')
