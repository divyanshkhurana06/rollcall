import { recoverAddress, hashMessage, type Hex, getAddress, slice, size } from 'viem'

/**
 * Safe signature-blob decoding.
 *
 * This is the load-bearing primitive of Roll Call.
 *
 * A Safe transaction is executed by ONE address paying gas, but approved by N owners whose
 * signatures are packed into the `signatures` calldata argument of execTransaction. Those
 * owners never appear as `tx.from`, never emit an event, and therefore look completely
 * inactive to every block explorer in existence.
 *
 * Recovering them is what makes per-signer liveness and independence measurable at all.
 *
 * Encoding (see Safe's `checkNSignatures`): the blob is a concatenation of 65-byte words.
 *   v == 0  -> EIP-1271 contract signature. The owner is packed into `r`.
 *   v == 1  -> pre-approved hash (owner called approveHash earlier). Owner packed into `r`.
 *   v > 30  -> eth_sign flow. Recover over the personal_sign digest with v-4.
 *   else    -> plain EIP-712 signature. Recover over the Safe tx hash directly.
 */

export type SignatureKind = 'eip712' | 'eth_sign' | 'approved_hash' | 'contract'

export interface RecoveredSigner {
  signer: `0x${string}`
  kind: SignatureKind
  /** Index of this signature within the blob (Safe requires ascending owner order). */
  position: number
}

export interface RecoveryResult {
  signers: RecoveredSigner[]
  /** Signature words we could not attribute - reported, never silently dropped. */
  unresolved: number
  words: number
}

const WORD = 65

/** Split a packed signature blob into 65-byte words. Trailing bytes are EIP-1271 dynamic data. */
export function splitSignatureBlob(blob: Hex, expected: number): Hex[] {
  const out: Hex[] = []
  const total = size(blob)
  const max = expected > 0 ? Math.min(expected, Math.floor(total / WORD)) : Math.floor(total / WORD)
  for (let i = 0; i < max; i++) out.push(slice(blob, i * WORD, (i + 1) * WORD))
  return out
}

/**
 * Recover the set of owner addresses that approved `safeTxHash`.
 *
 * @param safeTxHash The hash emitted in ExecutionSuccess/ExecutionFailure - i.e. exactly the
 *                   digest the owners signed. Taking it from the event rather than recomputing
 *                   the EIP-712 struct avoids needing the historical nonce.
 * @param threshold  Number of signature words to read. Safe reads exactly `threshold` words.
 */
export async function recoverSafeSigners(
  safeTxHash: Hex,
  signatureBlob: Hex,
  threshold: number,
): Promise<RecoveryResult> {
  const words = splitSignatureBlob(signatureBlob, threshold)
  const signers: RecoveredSigner[] = []
  let unresolved = 0

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const r = slice(w, 0, 32)
    const s = slice(w, 32, 64)
    const v = Number(BigInt(slice(w, 64, 65)))

    try {
      if (v === 0) {
        // EIP-1271 contract signature: owner address is left-padded into r.
        signers.push({ signer: addrFromWord(r), kind: 'contract', position: i })
      } else if (v === 1) {
        // Pre-approved hash: the owner called approveHash() in an earlier transaction.
        signers.push({ signer: addrFromWord(r), kind: 'approved_hash', position: i })
      } else if (v > 30) {
        const signer = await recoverAddress({
          hash: hashMessage({ raw: safeTxHash }),
          signature: packSig(r, s, v - 4),
        })
        signers.push({ signer: getAddress(signer), kind: 'eth_sign', position: i })
      } else {
        const signer = await recoverAddress({ hash: safeTxHash, signature: packSig(r, s, v) })
        signers.push({ signer: getAddress(signer), kind: 'eip712', position: i })
      }
    } catch {
      unresolved++
    }
  }

  return { signers, unresolved, words: words.length }
}

function addrFromWord(word: Hex): `0x${string}` {
  return getAddress(('0x' + word.slice(-40)) as Hex)
}

function packSig(r: Hex, s: Hex, v: number): Hex {
  return (r + s.slice(2) + v.toString(16).padStart(2, '0')) as Hex
}
