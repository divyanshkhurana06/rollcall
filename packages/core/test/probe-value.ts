import 'dotenv/config'
import { resolveControlSurface } from '../src/extract/authority.js'
import { valueAtRisk, ethPrice } from '../src/extract/value.js'

const TARGETS: [string, string][] = [
  ['Optimism Portal',   '0xbEb5Fc579115071764c7423A4f12eDde41f106Ed'],
  ['Base Portal',       '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e'],
  ['Arbitrum Bridge',   '0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a'],
  ['Blast Bridge',      '0x697402166Fbf2F22E970df8a2limitless'.slice(0,42)],
  ['zkSync Era Diamond','0x32400084C286CF3E17e7B677ea9583e60a000324'],
  ['Polygon PoS Bridge','0xA0c68C638235ee32657e8f720a23ceC1bFc77C77'],
  ['Mode Portal',       '0x8B34b14c7c7123459Cf3076b8Cb929BE7d2C9EdC'],
  ['Zora Portal',       '0x1a0ad011913A150f69f6A19DF447A0CfD9551054'],
]

const price = await ethPrice()
console.log(`ETH $${price.toFixed(0)}\n`)
for (const [name, addr] of TARGETS) {
  try {
    const [cs, v] = await Promise.all([resolveControlSurface('ethereum', addr), valueAtRisk('ethereum', addr, price)])
    const usd = v.totalUsd >= 1e9 ? `$${(v.totalUsd/1e9).toFixed(1)}B` : v.totalUsd >= 1e6 ? `$${(v.totalUsd/1e6).toFixed(0)}M` : `$${v.totalUsd.toFixed(0)}`
    console.log(`${name.padEnd(20)} ${usd.padEnd(9)} ${cs.safes.length ? `SAFE ${cs.safes[0]}` : 'no safe'}`)
  } catch (e: any) { console.log(`${name.padEnd(20)} error ${String(e.message).slice(0,40)}`) }
}
