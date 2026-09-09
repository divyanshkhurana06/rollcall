import 'dotenv/config'
import { createPublicClient, http } from 'viem'

/** Resolve the factory's dispatch table against public signature databases. */
const pub = createPublicClient({ transport: http(process.env.HEDERA_RPC ?? 'https://testnet.hashio.io/api') })
const IMPL = '0x0d8076eafb5606a0ce5098bb0e37f0b8334f3f49' as const

const code = await pub.getCode({ address: IMPL })
const hex = (code ?? '').slice(2)
const sels = new Set<string>()
for (let i = 0; i + 10 <= hex.length; i += 2) {
  if (hex.slice(i, i + 2) === '63') sels.add('0x' + hex.slice(i + 2, i + 10))
}
const list = [...sels].filter((s) => s !== '0xffffffff')
console.log(`${list.length} selectors to resolve\n`)

for (const sel of list) {
  let name = ''
  try {
    const r = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`)
    const b: any = await r.json()
    name = b?.result?.function?.[sel]?.[0]?.name ?? ''
  } catch { /* fall through */ }
  if (!name) {
    try {
      const r = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`)
      const b: any = await r.json()
      name = b?.results?.[0]?.text_signature ?? ''
    } catch { /* unknown */ }
  }
  if (name) console.log(`  ${sel}  ${name.slice(0, 150)}`)
  else console.log(`  ${sel}  (unknown)`)
}
