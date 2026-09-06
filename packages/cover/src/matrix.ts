import 'dotenv/config'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ATS, FACTORY_V1_ABI, FACTORY_V8_ABI, ROLES } from './ats.js'
import { coverIsin } from './isin.js'

const pub = createPublicClient({ transport: http(process.env.HEDERA_RPC ?? 'https://testnet.hashio.io/api') })
const account = privateKeyToAccount(process.env.HEDERA_PRIVATE_KEY as `0x${string}`)
const now = Math.floor(Date.now() / 1000)
const isin = coverIsin('0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5')
const reg = { regulationType: 1, regulationSubType: 0, additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info: 'probe' } }

function sec(cfg: string, ver: bigint, minimalRbac: boolean) {
  const rbacs = minimalRbac
    ? [{ role: ROLES.DEFAULT_ADMIN as `0x${string}`, members: [account.address] }]
    : Object.values(ROLES).map((r) => ({ role: r as `0x${string}`, members: [account.address] }))
  return {
    arePartitionsProtected: false, isMultiPartition: false, resolver: ATS.resolver as `0x${string}`,
    resolverProxyConfiguration: { key: cfg as `0x${string}`, version: ver },
    rbacs, isControllable: true, isWhiteList: false, maxSupply: 1000000n,
    erc20MetadataInfo: { name: 'Roll Call Cover', symbol: 'RCCOV', isin, decimals: 2 },
    clearingActive: false, internalKycActivated: false,
    externalPauses: [], externalControlLists: [], externalKycLists: [],
    compliance: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    identityRegistry: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  }
}

const CFGS = ['0x0000000000000000000000000000000000000000000000000000000000000001','0x0000000000000000000000000000000000000000000000000000000000000002']
let found = false
for (const cfg of CFGS) for (const ver of [0n, 1n]) for (const minimal of [true, false]) {
  const s = sec(cfg, ver, minimal)
  const v1 = [{ security: s, bondDetails: { currency: '0x555344', nominalValue: 10000n, startingDate: BigInt(now+300), maturityDate: BigInt(now+300+31536000) }, couponDetails: { couponFrequency: 7776000n, couponRate: 500n, firstCouponDate: BigInt(now+300+7776000) } }, reg]
  const v8 = [{ security: { resolver: s.resolver, maxSupply: s.maxSupply, resolverProxyConfiguration: s.resolverProxyConfiguration, erc20MetadataInfo: s.erc20MetadataInfo, rbacs: s.rbacs, externalPauses: [], externalControlLists: [], externalKycLists: [], compliance: s.compliance, identityRegistry: s.identityRegistry, arePartitionsProtected: false, isMultiPartition: false, isControllable: true, isWhiteList: false, clearingActive: false, internalKycActivated: false, erc20VotesActivated: false }, bondDetails: { currency: '0x555344', nominalValue: 10000n, nominalValueDecimals: 2, startingDate: BigInt(now+300), maturityDate: BigInt(now+300+31536000) }, proceedRecipients: [], proceedRecipientsData: [] }, reg]
  for (const [label, abi, args] of [['v1', FACTORY_V1_ABI, v1], ['v8', FACTORY_V8_ABI, v8]] as const) {
    try {
      const r = await pub.simulateContract({ address: ATS.factory as `0x${string}`, abi: abi as any, functionName: 'deployBond', args: args as any, account, gas: 15_000_000n })
      console.log(`ACCEPTED  layout=${label} cfg=${cfg.slice(-2)} ver=${ver} rbac=${minimal?'minimal':'full'} -> ${r.result}`)
      found = true
    } catch { /* keep scanning */ }
  }
}
if (!found) console.log('no combination accepted')
