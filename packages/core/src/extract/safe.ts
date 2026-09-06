import { decodeFunctionData, parseAbi, type Hex, getAddress } from 'viem'
import { client, windowedLogs, type ChainKey } from '../chain.js'
import { TOPICS, EXEC_TRANSACTION_SELECTOR, EXEC_TRANSACTION_SIG, SAFE_READ_ABI } from '../abi.js'
import { recoverSafeSigners, type RecoveredSigner } from './signatures.js'

const execAbi = parseAbi([`function ${EXEC_TRANSACTION_SIG}`])

export interface SafeExecution {
  safeTxHash: Hex
  txHash: Hex
  blockNumber: bigint
  timestamp: number
  /** Who paid gas. Note this is NOT the set of approvers - that is the whole point. */
  executor: `0x${string}`
  approvers: RecoveredSigner[]
  unresolved: number
  target: `0x${string}`
  value: bigint
}

export interface SafeState {
  address: `0x${string}`
  chain: ChainKey
  owners: `0x${string}`[]
  threshold: number
  version: string | null
  nonce: number
}

export async function readSafeState(chain: ChainKey, address: `0x${string}`): Promise<SafeState | null> {
  const c = client(chain)
  try {
    const [owners, threshold, nonce] = await Promise.all([
      c.readContract({ address, abi: SAFE_READ_ABI, functionName: 'getOwners' }) as Promise<`0x${string}`[]>,
      c.readContract({ address, abi: SAFE_READ_ABI, functionName: 'getThreshold' }) as Promise<bigint>,
      c.readContract({ address, abi: SAFE_READ_ABI, functionName: 'nonce' }) as Promise<bigint>,
    ])
    let version: string | null = null
    try {
      version = (await c.readContract({ address, abi: SAFE_READ_ABI, functionName: 'VERSION' })) as string
    } catch { /* older deployments omit VERSION */ }
    return { address: getAddress(address), chain, owners: owners.map(getAddress), threshold: Number(threshold), version, nonce: Number(nonce) }
  } catch {
    return null
  }
}

/**
 * Fetch executions and recover the approver set for each.
 *
 * The pairing of (safeTxHash from the event) with (signature blob from the calldata) is what
 * lets us attribute approvals without reconstructing historical EIP-712 nonces.
 */
export async function fetchExecutions(
  chain: ChainKey,
  safe: SafeState,
  opts: { lookbackBlocks?: bigint; max?: number } = {},
): Promise<SafeExecution[]> {
  const c = client(chain)
  const head = await c.getBlockNumber()
  const lookback = opts.lookbackBlocks ?? 2_600_000n // ~1 year on Ethereum
  const from = head > lookback ? head - lookback : 0n

  const logs = await windowedLogs(
    chain,
    { address: safe.address, topics: [[TOPICS.ExecutionSuccess, TOPICS.ExecutionFailure]], fromBlock: from, toBlock: head },
    { max: opts.max ?? 120 },
  )

  const out: SafeExecution[] = []
  for (const log of logs) {
    try {
      // ExecutionSuccess(bytes32 txHash, uint256 payment) - both non-indexed in Safe >= 1.3.
      const safeTxHash = (log.topics.length > 1 ? log.topics[1] : ('0x' + log.data.slice(2, 66))) as Hex
      const tx = await c.getTransaction({ hash: log.transactionHash })
      const block = await c.getBlock({ blockNumber: log.blockNumber })

      const calldata = locateExecCalldata(tx.input)
      if (!calldata) continue

      const { args } = decodeFunctionData({ abi: execAbi, data: calldata })
      const target = args[0] as `0x${string}`
      const value = args[1] as bigint
      const signatures = args[9] as Hex

      const rec = await recoverSafeSigners(safeTxHash, signatures, safe.threshold)
      out.push({
        safeTxHash,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        timestamp: Number(block.timestamp),
        executor: getAddress(tx.from),
        approvers: rec.signers,
        unresolved: rec.unresolved,
        target: getAddress(target),
        value,
      })
    } catch { /* one bad execution never invalidates the batch */ }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * execTransaction is often not the outer call - Safes get driven through relayers, modules and
 * multisend wrappers. Find the selector wherever it sits so nested executions still count.
 */
function locateExecCalldata(input: Hex): Hex | null {
  if (input.startsWith(EXEC_TRANSACTION_SELECTOR)) return input
  const idx = input.indexOf(EXEC_TRANSACTION_SELECTOR.slice(2))
  if (idx < 0) return null
  if ((idx - 2) % 2 !== 0) return null
  return ('0x' + input.slice(idx)) as Hex
}

/** Ownership churn: when the signer set and threshold actually changed. */
export async function fetchOwnerHistory(chain: ChainKey, safe: SafeState, lookbackBlocks = 2_600_000n) {
  const c = client(chain)
  const head = await c.getBlockNumber()
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n
  const logs = await windowedLogs(
    chain,
    { address: safe.address, topics: [[TOPICS.AddedOwner, TOPICS.RemovedOwner, TOPICS.ChangedThreshold]], fromBlock: from, toBlock: head },
    { max: 200 },
  )
  return logs.map((l: any) => ({
    kind: l.topics[0] === TOPICS.AddedOwner ? 'added' : l.topics[0] === TOPICS.RemovedOwner ? 'removed' : 'threshold',
    blockNumber: l.blockNumber,
    txHash: l.transactionHash,
    data: l.data,
  }))
}
