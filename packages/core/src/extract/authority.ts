import { getAddress, type Hex } from 'viem'
import { client, type ChainKey } from '../chain.js'
import { SLOTS, OWNABLE_ABI } from '../abi.js'
import { fetchSafe } from './safeapi.js'

/**
 * Who controls a contract.
 *
 * This is the half of Roll Call that turns it from "analyse this Safe" into "analyse this
 * protocol". A user does not know their protocol's guardian multisig by address - they know the
 * protocol. So: start from a contract people have heard of, walk its authority, and find the
 * control surface at the end of it.
 *
 * Authority is expressed through the same handful of patterns in nearly every contract ever
 * deployed, which is exactly why one extractor covers all of them:
 *
 *   EIP-1967 admin slot      the address that can swap the implementation under you
 *   Ownable owner()          the classic single point of control
 *   AccessControl            role holders, discovered from RoleGranted events
 *
 * Each of those can resolve to an EOA, a timelock, or a Safe. When it resolves to a Safe, that
 * Safe is the thing Roll Call measures - and the protocol's money is what is behind it.
 */

export type AuthorityKind = 'proxy-admin' | 'owner' | 'beacon' | 'implementation'

export interface AuthorityHolder {
  kind: AuthorityKind
  address: `0x${string}`
  /** Set when the holder is itself a Safe, which is the case worth analysing. */
  isSafe: boolean
  threshold?: number
  owners?: number
}

export interface ControlSurface {
  contract: `0x${string}`
  chain: ChainKey
  holders: AuthorityHolder[]
  /** The Safes that can change this contract. The population Roll Call actually cares about. */
  safes: `0x${string}`[]
  note: string
}

const ZERO = '0x0000000000000000000000000000000000000000'

const addrFromSlot = (word: Hex): `0x${string}` | null => {
  const a = '0x' + word.slice(-40)
  return a.toLowerCase() === ZERO ? null : getAddress(a as Hex)
}

async function readSlot(chain: ChainKey, address: `0x${string}`, slot: string) {
  try {
    const v = await client(chain).getStorageAt({ address, slot: slot as Hex })
    return v ? addrFromSlot(v) : null
  } catch { return null }
}

async function readOwner(chain: ChainKey, address: `0x${string}`) {
  try {
    const o = (await client(chain).readContract({ address, abi: OWNABLE_ABI, functionName: 'owner' })) as `0x${string}`
    return o && o.toLowerCase() !== ZERO ? getAddress(o) : null
  } catch { return null }
}

/**
 * Resolve a contract's control surface.
 *
 * Follows one hop through a proxy admin: an admin is very often itself an Ownable owned by the
 * Safe that really holds the power, and stopping at the admin would name a contract rather than
 * the people.
 */
export async function resolveControlSurface(
  chain: ChainKey,
  contract: string,
  opts: { followDepth?: number } = {},
): Promise<ControlSurface> {
  const address = getAddress(contract as Hex)
  const depth = opts.followDepth ?? 2
  const holders: AuthorityHolder[] = []
  const seen = new Set<string>([address.toLowerCase()])

  const consider = async (candidate: `0x${string}` | null, kind: AuthorityKind, hops: number) => {
    if (!candidate || seen.has(candidate.toLowerCase())) return
    seen.add(candidate.toLowerCase())

    const safe = await fetchSafe(chain, candidate)
    holders.push({
      kind,
      address: candidate,
      isSafe: Boolean(safe),
      threshold: safe?.threshold,
      owners: safe?.owners.length,
    })

    // A timelock or proxy admin is a contract, not a party. Keep walking until we reach people.
    if (!safe && hops < depth) {
      await consider(await readOwner(chain, candidate), 'owner', hops + 1)
    }
  }

  await consider(await readSlot(chain, address, SLOTS.admin), 'proxy-admin', 0)
  await consider(await readSlot(chain, address, SLOTS.ozLegacyAdmin), 'proxy-admin', 0)
  await consider(await readOwner(chain, address), 'owner', 0)

  const impl = await readSlot(chain, address, SLOTS.implementation)
  if (impl) holders.push({ kind: 'implementation', address: impl, isSafe: false })

  const safes = holders.filter((h) => h.isSafe).map((h) => h.address)

  return {
    contract: address,
    chain,
    holders,
    safes,
    note: safes.length
      ? `${safes.length} Safe(s) can change this contract.`
      : holders.length
        ? 'Authority resolves to contracts or EOAs, not a Safe, so there is no signer set to measure.'
        : 'No EIP-1967 admin slot and no owner(). Authority may live in AccessControl roles or be immutable.',
  }
}
