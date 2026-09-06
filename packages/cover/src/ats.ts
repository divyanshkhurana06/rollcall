import { parseAbi } from 'viem'

/**
 * ATS factory ABIs.
 *
 * The Asset Tokenization Studio contracts deployed on Hedera testnet are an EARLIER release than
 * the current npm package: SecurityData reorders its fields, BondData carries couponDetails rather
 * than proceedRecipients, and BondDetailsData has no nominalValueDecimals. Encoding a v8 call
 * against the deployed v1 factory reverts immediately with no decodable reason.
 *
 * So we hold both shapes and detect which one the live factory speaks, rather than assuming.
 */

/** Deployed on Hedera testnet: factory 0.0.6797955, resolver 0.0.6797832. */
export const ATS = {
  factory: '0xc4028832d0b086e52a8771c39da08529fd3e0d3c',
  resolver: '0x2463a7603c43e99d5aefdca9fba752751caf7b56',
  factoryId: '0.0.6797955',
  resolverId: '0.0.6797832',
} as const

export const FACTORY_V1_ABI = parseAbi([
  'struct ResolverProxyConfiguration { bytes32 key; uint256 version; }',
  'struct Rbac { bytes32 role; address[] members; }',
  'struct ERC20MetadataInfo { string name; string symbol; string isin; uint8 decimals; }',
  'struct SecurityData { bool arePartitionsProtected; bool isMultiPartition; address resolver; ResolverProxyConfiguration resolverProxyConfiguration; Rbac[] rbacs; bool isControllable; bool isWhiteList; uint256 maxSupply; ERC20MetadataInfo erc20MetadataInfo; bool clearingActive; bool internalKycActivated; address[] externalPauses; address[] externalControlLists; address[] externalKycLists; address compliance; address identityRegistry; }',
  'struct BondDetailsData { bytes3 currency; uint256 nominalValue; uint256 startingDate; uint256 maturityDate; }',
  'struct CouponDetailsData { uint256 couponFrequency; uint256 couponRate; uint256 firstCouponDate; }',
  'struct BondData { SecurityData security; BondDetailsData bondDetails; CouponDetailsData couponDetails; }',
  'struct AdditionalSecurityData { bool countriesControlListType; string listOfCountries; string info; }',
  'struct FactoryRegulationData { uint8 regulationType; uint8 regulationSubType; AdditionalSecurityData additionalSecurityData; }',
  'function deployBond(BondData _bondData, FactoryRegulationData _factoryRegulationData) returns (address bondAddress_)',
  'event BondDeployed(address indexed deployer, address bondAddress, BondData bondData, FactoryRegulationData regulationData)',
])

export const FACTORY_V8_ABI = parseAbi([
  'struct ResolverProxyConfiguration { bytes32 key; uint256 version; }',
  'struct ERC20MetadataInfo { string name; string symbol; string isin; uint8 decimals; }',
  'struct Rbac { bytes32 role; address[] members; }',
  'struct SecurityData { address resolver; uint256 maxSupply; ResolverProxyConfiguration resolverProxyConfiguration; ERC20MetadataInfo erc20MetadataInfo; Rbac[] rbacs; address[] externalPauses; address[] externalControlLists; address[] externalKycLists; address compliance; address identityRegistry; bool arePartitionsProtected; bool isMultiPartition; bool isControllable; bool isWhiteList; bool clearingActive; bool internalKycActivated; bool erc20VotesActivated; }',
  'struct BondDetailsData { bytes3 currency; uint256 nominalValue; uint8 nominalValueDecimals; uint256 startingDate; uint256 maturityDate; }',
  'struct BondData { SecurityData security; BondDetailsData bondDetails; address[] proceedRecipients; bytes[] proceedRecipientsData; }',
  'struct AdditionalSecurityData { bool countriesControlListType; string listOfCountries; string info; }',
  'struct FactoryRegulationData { uint8 regulationType; uint8 regulationSubType; AdditionalSecurityData additionalSecurityData; }',
  'function deployBond(BondData _bondData, FactoryRegulationData _factoryRegulationData) returns (address bondAddress_)',
])

export const ROLES = {
  DEFAULT_ADMIN:     '0x0000000000000000000000000000000000000000000000000000000000000000',
  ISSUER:            '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f',
  CONTROLLER:        '0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e',
  CONTROL_LIST:      '0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d',
  KYC:               '0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc',
  KYC_MANAGER:       '0xec811504e835acf29535b5b62307b08000468f0c61ca6163ed6f17a03629b91e',
  PAUSER:            '0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f',
  CORPORATE_ACTION:  '0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd',
  MATURITY_REDEEMER: '0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523',
} as const
