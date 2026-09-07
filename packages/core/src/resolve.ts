import { getAddress, type Hex } from 'viem'
import { client, type ChainKey, CHAINS } from './chain.js'
import { fetchSafe } from './extract/safeapi.js'
import { resolveControlSurface } from './extract/authority.js'

/**
 * Work out what someone just pasted, and what to do about it.
 *
 * "Not a readable Safe" is technically true and useless. Almost everything a person pastes falls
 * into one of four cases, and three of them have a better answer than an error:
 *
 *   an EOA                 there is no signer set here; say so plainly
 *   a Safe                 analyse it
 *   a contract with a Safe above it   analyse THAT Safe - this is the interesting case, and it is
 *                                     the whole protocol-first thesis applied to arbitrary input
 *   a Safe on another chain           name the chain rather than making them guess
 */

export type ResolutionKind = 'safe' | 'controlled-contract' | 'contract' | 'eoa' | 'empty'

export interface Resolution {
  input: string
  chain: ChainKey
  kind: ResolutionKind
  /** The Safe to analyse, when there is one. */
  safe: string | null
  /** How we got from the input to that Safe. */
  via: string | null
  /** Other chains where this address is a Safe, so a wrong-chain paste is recoverable. */
  alsoOn: ChainKey[]
  message: string
  hint?: string
}

const SEARCH: ChainKey[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'gnosis']

export async function resolveTarget(chain: ChainKey, input: string): Promise<Resolution> {
  let address: `0x${string}`
  try { address = getAddress(input.trim() as Hex) } catch {
    return {
      input, chain, kind: 'empty', safe: null, via: null, alsoOn: [],
      message: 'That is not a valid address.',
      hint: 'Paste a 42 character address starting with 0x.',
    }
  }

  const base = { input: address, chain, alsoOn: [] as ChainKey[] }

  // 1. Is it a Safe right here?
  const safe = await fetchSafe(chain, address)
  if (safe) {
    return { ...base, kind: 'safe', safe: address, via: null,
      message: `Safe with a ${safe.threshold} of ${safe.owners.length} threshold.` }
  }

  // 2. Does it have code at all?
  let hasCode = false
  try {
    const code = await client(chain).getCode({ address })
    hasCode = Boolean(code && code !== '0x')
  } catch { /* treated as unknown below */ }

  // 3. A contract: the interesting case. Find who can change it.
  if (hasCode) {
    const surface = await resolveControlSurface(chain, address, { includeRoles: false })
    if (surface.safes.length) {
      const holder = surface.holders.find((h) => h.isSafe)!
      return {
        ...base, kind: 'controlled-contract', safe: surface.safes[0],
        via: surface.holders.map((h) => h.kind).join(' -> '),
        message: `A contract, not a Safe. It is controlled by a Safe, which is the thing worth measuring.`,
        hint: `Reached through ${holder.kind}${holder.role ? ` (${holder.role})` : ''}. Analysing that Safe instead.`,
      }
    }
    return {
      ...base, kind: 'contract', safe: null, via: surface.holders.map((h) => h.kind).join(' -> ') || null,
      message: 'A contract, but no Safe in its authority path.',
      hint: surface.holders.length
        ? `Authority resolves through ${surface.holders.map((h) => h.kind).join(' -> ')}, so it ends at a timelock, a DAO or an EOA rather than a signer set.`
        : 'No EIP-1967 admin slot and no owner(), so authority may be immutable or held somewhere this does not reach.',
    }
  }

  // 4. No code. Before calling it an EOA, check whether it is a Safe on a chain they did not pick.
  const elsewhere: ChainKey[] = []
  await Promise.all(
    SEARCH.filter((c) => c !== chain).map(async (c) => {
      if (await fetchSafe(c, address)) elsewhere.push(c)
    }),
  )
  if (elsewhere.length) {
    return {
      ...base, kind: 'safe', safe: address, via: null, alsoOn: elsewhere,
      message: `Not a Safe on ${CHAINS[chain].label}, but it is one on ${elsewhere.map((c) => CHAINS[c].label).join(' and ')}.`,
      hint: 'Switch the chain selector and analyse again.',
    }
  }

  return {
    ...base, kind: 'eoa', safe: null, via: null,
    message: 'This is a regular wallet, not a multisig.',
    hint: 'Roll Call measures signer sets, so there is nothing here to measure. Paste a Safe, or paste a protocol contract and it will find the Safe that controls it.',
  }
}
