import { getAddress, parseAbi, type Hex } from 'viem'
import { client, windowedLogs, type ChainKey } from '../chain.js'
import { SLOTS, OWNABLE_ABI, TOPICS } from '../abi.js'
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

export type AuthorityKind = 'proxy-admin' | 'owner' | 'beacon' | 'implementation' | 'role'

/**
 * Delay accessors across the timelock implementations actually in use. A path that runs through a
 * timelock is a fundamentally different risk from one that does not, and the difference is the
 * number of hours between a malicious signature and the damage.
 */
const TIMELOCK_ABI = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function delay() view returns (uint256)',
  'function MINIMUM_DELAY() view returns (uint256)',
])

/** Roles worth naming. Everything else is reported by its raw id. */
const KNOWN_ROLES: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000000': 'DEFAULT_ADMIN_ROLE',
  '0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a': 'UPGRADER_ROLE',
  '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6': 'PAUSER_ROLE',
  '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a7': 'MINTER_ROLE',
}

export interface AuthorityHolder {
  kind: AuthorityKind
  address: `0x${string}`
  /** Set when the holder is itself a Safe, which is the case worth analysing. */
  isSafe: boolean
  threshold?: number
  owners?: number
  /** Named role when this holder came from AccessControl. */
  role?: string
  /** Seconds this holder must wait before its action takes effect, when it is a timelock. */
  delaySeconds?: number
  /** How many hops from the analysed contract. */
  hops: number
}

export interface TimeToHarm {
  /** Hours from a malicious signature to the change taking effect. */
  hours: number
  /** The path it travels, named. */
  path: string
  /** Set when a delay was read from a contract rather than assumed. */
  measured: boolean
  note: string
}

export interface ControlSurface {
  contract: `0x${string}`
  chain: ChainKey
  holders: AuthorityHolder[]
  /** The Safes that can change this contract. The population Roll Call actually cares about. */
  safes: `0x${string}`[]
  timeToHarm: TimeToHarm | null
  note: string
}

/** Read a timelock delay if this address is one. Returns null when it is not a timelock. */
async function readDelay(chain: ChainKey, address: `0x${string}`): Promise<number | null> {
  const c = client(chain)
  for (const fn of ['getMinDelay', 'delay', 'MINIMUM_DELAY'] as const) {
    try {
      const v = (await c.readContract({ address, abi: TIMELOCK_ABI, functionName: fn })) as bigint
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    } catch { /* not this flavour of timelock */ }
  }
  return null
}

/**
 * AccessControl role holders, discovered from RoleGranted and RoleRevoked events.
 *
 * This is what generalises the control graph past Ownable and EIP-1967. A protocol that grants an
 * UPGRADER_ROLE to a Safe has exactly the same exposure as one that names it proxy admin, and only
 * the event log says so.
 *
 * COVERAGE, STATED RATHER THAN IMPLIED: public RPCs cap eth_getLogs at 10k blocks, so a full role
 * history is ~40 sequential requests per contract and most grants happened at deployment years ago.
 * The default window is recent and will therefore miss historical grants. A contract reporting no
 * role holders has none IN THE WINDOW SEARCHED, which is not the same as having none. Indexed data
 * is the answer here, which is the same argument the subgraph exists to make.
 */
export async function roleHolders(
  chain: ChainKey,
  address: `0x${string}`,
  lookbackBlocks = 60_000n,
): Promise<{ role: string; holder: `0x${string}` }[]> {
  const head = await client(chain).getBlockNumber()
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n
  const logs = await windowedLogs(
    chain,
    { address, topics: [[TOPICS.RoleGranted, TOPICS.RoleRevoked]], fromBlock: from, toBlock: head },
    { max: 300 },
  )

  // Later events win, so a revoked role does not linger as a false positive.
  const held = new Map<string, { role: string; holder: `0x${string}` }>()
  for (const l of logs) {
    if (l.topics.length < 3) continue
    const role = l.topics[1]!
    const holder = getAddress(('0x' + l.topics[2]!.slice(-40)) as Hex)
    const key = `${role}:${holder.toLowerCase()}`
    if (l.topics[0] === TOPICS.RoleGranted) held.set(key, { role: KNOWN_ROLES[role] ?? role, holder })
    else held.delete(key)
  }
  return [...held.values()]
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
  opts: { followDepth?: number; includeRoles?: boolean } = {},
): Promise<ControlSurface> {
  const address = getAddress(contract as Hex)
  const depth = opts.followDepth ?? 2
  const holders: AuthorityHolder[] = []
  const seen = new Set<string>([address.toLowerCase()])

  const consider = async (candidate: `0x${string}` | null, kind: AuthorityKind, hops: number, role?: string) => {
    if (!candidate || seen.has(candidate.toLowerCase())) return
    seen.add(candidate.toLowerCase())

    const [safe, delaySeconds] = await Promise.all([
      fetchSafe(chain, candidate),
      readDelay(chain, candidate),
    ])

    holders.push({
      kind, address: candidate, hops, role,
      isSafe: Boolean(safe),
      threshold: safe?.threshold,
      owners: safe?.owners.length,
      delaySeconds: delaySeconds ?? undefined,
    })

    // A timelock or proxy admin is a contract, not a party. Keep walking until we reach people.
    if (!safe && hops < depth) {
      await consider(await readOwner(chain, candidate), 'owner', hops + 1)
    }
  }

  await consider(await readSlot(chain, address, SLOTS.admin), 'proxy-admin', 0)
  await consider(await readSlot(chain, address, SLOTS.ozLegacyAdmin), 'proxy-admin', 0)
  await consider(await readOwner(chain, address), 'owner', 0)

  // AccessControl: the pattern Ownable and EIP-1967 miss entirely.
  if (opts.includeRoles !== false) {
    try {
      for (const { role, holder } of await roleHolders(chain, address)) {
        await consider(holder, 'role', 0, role)
      }
    } catch { /* no role events in the window, or the contract has none */ }
  }

  const impl = await readSlot(chain, address, SLOTS.implementation)
  if (impl) holders.push({ kind: 'implementation', address: impl, isSafe: false, hops: 0 })

  const safes = holders.filter((h) => h.isSafe).map((h) => h.address)

  return {
    contract: address,
    chain,
    holders,
    safes,
    timeToHarm: computeTimeToHarm(holders, safes),
    note: safes.length
      ? `${safes.length} Safe(s) can change this contract.`
      : holders.length
        ? 'Authority resolves to contracts or EOAs, not a Safe, so there is no signer set to measure.'
        : 'No EIP-1967 admin slot, no owner(), and no AccessControl grants in the window. Authority may be immutable or held elsewhere.',
  }
}

/**
 * Time to harm.
 *
 * Not "can someone do damage" but "how long between a malicious signature and the damage landing".
 * A Safe wired straight to a proxy admin can act in one block. The same Safe behind a timelock
 * cannot act for as long as that timelock says, and that delay is the window in which anyone
 * watching can react.
 *
 * The delay is READ from the timelock rather than assumed. When no timelock is in the path, this
 * reports immediate and says so, rather than inventing a number.
 */
export function computeTimeToHarm(holders: AuthorityHolder[], safes: string[]): TimeToHarm | null {
  if (!safes.length) return null

  // Shortest path wins: an attacker takes the fastest route, not the most guarded one.
  const paths = holders.filter((h) => h.isSafe)
  let best: { hours: number; path: string; measured: boolean } | null = null

  for (const safeHolder of paths) {
    // Delays on the way from this Safe to the contract.
    const delays = holders
      .filter((h) => h.delaySeconds && h.hops <= safeHolder.hops)
      .map((h) => h.delaySeconds!)
    const seconds = delays.length ? Math.min(...delays) : 0
    const label = [safeHolder.role ? `${safeHolder.kind}(${safeHolder.role})` : safeHolder.kind]
      .concat(delays.length ? ['timelock'] : [])
      .concat(['contract'])
      .join(' -> ')
    const candidate = { hours: seconds / 3600, path: `Safe -> ${label}`, measured: delays.length > 0 }
    if (!best || candidate.hours < best.hours) best = candidate
  }

  if (!best) return null
  return {
    ...best,
    note: best.measured
      ? `Shortest path runs through a timelock whose delay was read on chain. That delay is the reaction window.`
      : `No timelock found in the shortest path, so a signature takes effect in the next block. There is no reaction window.`,
  }
}
