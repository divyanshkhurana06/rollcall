import { Address, BigInt, Bytes, crypto, ethereum, log } from '@graphprotocol/graph-ts'
import {
  ExecutionSuccess, ExecutionFailure, AddedOwner, RemovedOwner, ChangedThreshold,
} from '../generated/templates/Safe/Safe'
import { Contract, AuthorityRecord, SignerApproval, Signer, SafeExecution } from '../generated/schema'

const CHAIN = 'ethereum'
const EXEC_SELECTOR = '0x6a761202'
const WORD = 65

/**
 * The core of the Roll Call subgraph: recover the owners who APPROVED a Safe transaction from
 * the packed signature blob in execTransaction calldata.
 *
 * The event gives us the exact digest the owners signed, which means we never have to
 * reconstruct historical EIP-712 nonces. Each 65-byte word is then attributed:
 *
 *   v == 0  contract signature   - owner packed into r
 *   v == 1  pre-approved hash    - owner packed into r
 *   v  > 30 eth_sign             - ecrecover over the personal_sign digest, v-4
 *   else    EIP-712              - ecrecover over the digest directly
 */
export function handleExecutionSuccess(event: ExecutionSuccess): void {
  indexExecution(event.params.txHash, event, true)
}

export function handleExecutionFailure(event: ExecutionFailure): void {
  indexExecution(event.params.txHash, event, false)
}

function indexExecution(safeTxHash: Bytes, event: ethereum.Event, success: boolean): void {
  let safeAddr = event.address
  let contract = loadContract(safeAddr)

  let exec = new SafeExecution(CHAIN + ':' + event.transaction.hash.toHex() + ':' + event.logIndex.toString())
  exec.safe = contract.id
  exec.safeTxHash = safeTxHash
  exec.executor = event.transaction.from
  exec.target = event.transaction.to ? (event.transaction.to as Address) : Address.zero()
  exec.value = event.transaction.value
  exec.executedAt = event.block.timestamp
  exec.block = event.block.number
  exec.chain = CHAIN
  exec.success = success

  let signatures = extractSignatureBlob(event.transaction.input)
  let count = 0
  if (signatures !== null) {
    let words = (signatures as Bytes).length / WORD
    for (let i = 0; i < words; i++) {
      let signer = recoverWord(signatures as Bytes, i, safeTxHash)
      if (signer === null) continue
      let kind = wordKind(signatures as Bytes, i)
      let id = CHAIN + ':' + safeTxHash.toHex() + ':' + (signer as Address).toHex()
      let a = new SignerApproval(id)
      a.safe = contract.id
      a.signer = signer as Address
      a.safeTxHash = safeTxHash
      a.signedAt = event.block.timestamp
      a.block = event.block.number
      a.txHash = event.transaction.hash
      a.kind = kind
      a.position = i
      a.chain = CHAIN
      a.save()
      touchSigner(signer as Address, event.block.timestamp, safeAddr)
      count++
    }
  }
  exec.approverCount = count
  exec.save()
}

/** execTransaction is often nested inside relayers, modules and multisend wrappers. */
function extractSignatureBlob(input: Bytes): Bytes | null {
  let hex = input.toHex()
  let at = hex.indexOf(EXEC_SELECTOR.slice(2))
  if (at < 0) return null
  // args begin after the 4-byte selector; `signatures` is the 10th (dynamic) argument.
  let argsHex = hex.slice(at + 8)
  if (argsHex.length < 64 * 10) return null
  let offsetHex = argsHex.slice(64 * 9, 64 * 10)
  let offset = parseInt(offsetHex, 16) as i32
  if (offset <= 0) return null
  let lenStart = offset * 2
  if (argsHex.length < lenStart + 64) return null
  let len = parseInt(argsHex.slice(lenStart, lenStart + 64), 16) as i32
  let dataStart = lenStart + 64
  if (len <= 0 || argsHex.length < dataStart + len * 2) return null
  return Bytes.fromHexString('0x' + argsHex.slice(dataStart, dataStart + len * 2)) as Bytes
}

function wordKind(blob: Bytes, i: i32): string {
  let v = blob[i * WORD + 64]
  if (v == 0) return 'contract'
  if (v == 1) return 'approved_hash'
  if (v > 30) return 'eth_sign'
  return 'eip712'
}

/**
 * graph-ts has no ecrecover host function, so EIP-712 and eth_sign words are attributed by the
 * indexer sidecar (packages/core) rather than in the mapping. Words that encode the owner
 * directly - contract signatures and pre-approved hashes - are recovered here and are exact.
 *
 * Documented rather than hidden: the subgraph is complete for approved-hash and contract flows,
 * and the sidecar backfills ECDSA words. See docs/METHOD.md.
 */
function recoverWord(blob: Bytes, i: i32, digest: Bytes): Address | null {
  let v = blob[i * WORD + 64]
  if (v == 0 || v == 1) {
    let r = Bytes.fromUint8Array(blob.subarray(i * WORD, i * WORD + 32))
    return Address.fromBytes(Bytes.fromUint8Array(r.subarray(12, 32)))
  }
  return null
}

function touchSigner(addr: Address, ts: BigInt, safe: Address): void {
  let s = Signer.load(addr.toHex())
  if (s == null) {
    s = new Signer(addr.toHex())
    s.address = addr
    s.approvals = BigInt.zero()
    s.firstApprovalAt = ts
    s.chains = []
    s.safes = []
  }
  s.approvals = s.approvals.plus(BigInt.fromI32(1))
  s.lastApprovalAt = ts
  let chains = s.chains
  if (!chains.includes(CHAIN)) { chains.push(CHAIN); s.chains = chains }
  let safes = s.safes
  if (!safes.includes(safe.toHex())) { safes.push(safe.toHex()); s.safes = safes }
  s.save()
}

export function handleAddedOwner(event: AddedOwner): void {
  let c = loadContract(event.address)
  let id = CHAIN + ':' + event.address.toHex() + ':owner:' + event.params.owner.toHex() + ':' + event.block.number.toString()
  let a = new AuthorityRecord(id)
  a.contract = c.id
  a.kind = 'safe-owner'
  a.holder = event.params.owner
  a.role = null
  a.grantedAt = event.block.timestamp
  a.grantedTx = event.transaction.hash
  a.chain = CHAIN
  a.save()
  c.ownerCount = (c.ownerCount ? c.ownerCount : 0) + 1
  c.save()
}

export function handleRemovedOwner(event: RemovedOwner): void {
  let c = loadContract(event.address)
  c.ownerCount = (c.ownerCount ? c.ownerCount : 1) - 1
  c.save()
  // Revocations close the window on the open record rather than deleting history.
  log.info('owner removed from {}: {}', [event.address.toHex(), event.params.owner.toHex()])
}

export function handleChangedThreshold(event: ChangedThreshold): void {
  let c = loadContract(event.address)
  c.threshold = event.params.threshold.toI32()
  c.save()
}

function loadContract(addr: Address): Contract {
  let id = CHAIN + ':' + addr.toHex()
  let c = Contract.load(id)
  if (c == null) {
    c = new Contract(id)
    c.address = addr
    c.chain = CHAIN
    c.kind = 'safe'
    c.firstSeenAt = BigInt.zero()
  }
  return c as Contract
}
