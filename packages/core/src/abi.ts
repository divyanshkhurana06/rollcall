import { toEventSelector, toFunctionSelector } from 'viem'

/** Safe (Gnosis Safe) - the events and calldata we decode. */
export const SAFE = {
  ExecutionSuccess: 'ExecutionSuccess(bytes32,uint256)',
  ExecutionFailure: 'ExecutionFailure(bytes32,uint256)',
  AddedOwner: 'AddedOwner(address)',
  RemovedOwner: 'RemovedOwner(address)',
  ChangedThreshold: 'ChangedThreshold(uint256)',
  ApproveHash: 'ApproveHash(bytes32,address)',
  EnabledModule: 'EnabledModule(address)',
  DisabledModule: 'DisabledModule(address)',
} as const

/** Authority events that are standard-shaped across nearly every protocol ever written. */
export const AUTHORITY = {
  OwnershipTransferred: 'OwnershipTransferred(address,address)',
  RoleGranted: 'RoleGranted(bytes32,address,address)',
  RoleRevoked: 'RoleRevoked(bytes32,address,address)',
  RoleAdminChanged: 'RoleAdminChanged(bytes32,bytes32,bytes32)',
  AdminChanged: 'AdminChanged(address,address)',
  Upgraded: 'Upgraded(address)',
  BeaconUpgraded: 'BeaconUpgraded(address)',
  Paused: 'Paused(address)',
  Unpaused: 'Unpaused(address)',
} as const

export const topic0 = (sig: string) => toEventSelector(sig as `${string}(${string})`)

export const TOPICS = Object.fromEntries(
  [...Object.entries(SAFE), ...Object.entries(AUTHORITY)].map(([k, v]) => [k, topic0(v)]),
) as Record<keyof typeof SAFE | keyof typeof AUTHORITY, `0x${string}`>

export const EXEC_TRANSACTION_SIG =
  'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'
export const EXEC_TRANSACTION_SELECTOR = toFunctionSelector(EXEC_TRANSACTION_SIG)

/** EIP-1967 storage slots. These are facts about where power lives, readable with eth_getStorageAt. */
export const SLOTS = {
  // bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  // bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  // bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1)
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  // OpenZeppelin legacy (unstructured storage) admin slot
  ozLegacyAdmin: '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b',
} as const

export const SAFE_READ_ABI = [
  { type: 'function', name: 'getOwners', inputs: [], outputs: [{ type: 'address[]' }], stateMutability: 'view' },
  { type: 'function', name: 'getThreshold', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'nonce', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'VERSION', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
] as const

export const OWNABLE_ABI = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const
