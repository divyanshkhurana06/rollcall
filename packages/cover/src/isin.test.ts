import { isinCheckDigit, isValidIsin, coverIsin } from './isin.js'
// Published ISINs with known check digits, used as fixed test vectors.
const cases: [string, number][] = [
  ['US037833100', 5],   // Apple
  ['GB000263494', 6],   // BAE Systems
  ['AU0000XVGZA', 3],   // ISO 6166 reference example
]
let pass = 0
for (const [body, want] of cases) {
  const got = isinCheckDigit(body)
  console.log(`  ${body}${got}  expected check digit ${want}  ${got === want ? 'PASS' : 'FAIL'}`)
  if (got === want) pass++
}
const generated = coverIsin('0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5')
console.log(`\n  generated: ${generated}  valid=${isValidIsin(generated)}`)
console.log(`  ${pass}/${cases.length} known ISINs validated`)
