/**
 * ISIN check digit (ISO 6166).
 *
 * The ATS factory validates both length and checksum and reverts with WrongISINChecksum, so a
 * placeholder like "US0000000000" is rejected on chain. Each cover note therefore gets a real,
 * deterministic identifier derived from the Safe it was written against.
 */
export function isinCheckDigit(body11: string): number {
  const expanded = body11
    .toUpperCase()
    .split('')
    .map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join('')

  let sum = 0
  // Double every second digit counting from the right.
  for (let i = expanded.length - 1, pos = 0; i >= 0; i--, pos++) {
    let d = Number(expanded[i])
    if (pos % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

/** Deterministic, checksum-valid ISIN for a cover note over a given Safe. */
export function coverIsin(target: string, prefix = 'US'): string {
  const hex = target.replace(/^0x/, '').toUpperCase()
  const body = (prefix + hex.replace(/[^0-9A-Z]/g, '')).slice(0, 11).padEnd(11, '0')
  return body + String(isinCheckDigit(body))
}

export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false
  return isinCheckDigit(isin.slice(0, 11)) === Number(isin[11])
}
