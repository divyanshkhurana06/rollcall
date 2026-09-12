/**
 * The protocol registry.
 *
 * Roll Call started by finding Safes and asking what they were. That is backwards: nobody knows
 * their protocol's guardian multisig by address, they know the protocol. So the population starts
 * from contracts people have heard of, holding money you can read off the chain, and the control
 * surface is discovered rather than assumed.
 *
 * OP Stack L1 addresses come from Optimism's own superchain-registry, so they are verifiable
 * rather than curated by us. Everything else is a widely published mainnet address, and every one
 * is re-verified at scan time: it must have code, its authority must resolve, and its balance is
 * read live. Anything that fails verification is dropped rather than reported.
 */

export interface ProtocolTarget {
  /** Name a judge, or a user, would recognise. */
  protocol: string
  /** What this contract is, so "who controls it" means something concrete. */
  role: string
  address: `0x${string}`
  category: 'bridge' | 'lending' | 'staking' | 'dex' | 'infrastructure'
  /** Where the address came from, because a curated list is only as good as its provenance. */
  source: string
}

const SUPERCHAIN = 'ethereum-optimism/superchain-registry'

export const PROTOCOLS: ProtocolTarget[] = [
  // ---- OP Stack L1 portals: each holds the bridged funds of an entire chain ----
  { protocol: 'Base',        role: 'L1 Portal', address: '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e', category: 'bridge', source: 'base.org docs' },
  { protocol: 'OP Mainnet',  role: 'L1 Portal', address: '0xbEb5Fc579115071764c7423A4f12eDde41f106Ed', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Unichain',    role: 'L1 Portal', address: '0x0bd48f6B86a26D3a217d0Fa6FfE2B491B956A7a2', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'World Chain', role: 'L1 Portal', address: '0xd5ec14a83B7d95BE1E2Ac12523e2dEE12Cbeea6C', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Zora',        role: 'L1 Portal', address: '0x1a0ad011913A150f69f6A19DF447A0CfD9551054', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Mode',        role: 'L1 Portal', address: '0x8B34b14c7c7123459Cf3076b8Cb929BE097d0C07', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Ink',         role: 'L1 Portal', address: '0x5d66C1782664115999C47c9fA5cd031f495D3e4F', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Soneium',     role: 'L1 Portal', address: '0x88e529A6ccd302c948689Cd5156C83D4614FAE92', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Lisk',        role: 'L1 Portal', address: '0x26dB93F8b8b4f7016240af62F7730979d353f9A7', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Fraxtal',     role: 'L1 Portal', address: '0x36cb65c1967A0Fb0EEE11569C51C2f2aA1Ca6f6D', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Redstone',    role: 'L1 Portal', address: '0xC7bCb0e8839a28A1cFadd1CF716de9016CdA51ae', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'BOB',         role: 'L1 Portal', address: '0x8AdeE124447435fE03e3CD24dF3f4cAE32E65a3E', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Metal L2',    role: 'L1 Portal', address: '0x3F37aBdE2C6b5B2ed6F8045787Df1ED1E3753956', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Shape',       role: 'L1 Portal', address: '0xEB06fFa16011B5628BaB98E29776361c83741dd3', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Cyber',       role: 'L1 Portal', address: '0x1d59bc9fcE6B8E2B1bf86D4777289FFd83D24C99', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Swan Chain',  role: 'L1 Portal', address: '0xBa50434BC5fCC07406b1baD9AC72a4CDf776db15', category: 'bridge', source: SUPERCHAIN },

  // ---- L1 standard bridges: the token side of the same chains ----
  { protocol: 'Base',        role: 'L1 Standard Bridge', address: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', category: 'bridge', source: 'base.org docs' },
  { protocol: 'OP Mainnet',  role: 'L1 Standard Bridge', address: '0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Unichain',    role: 'L1 Standard Bridge', address: '0x81014F44b0a345033bB2b3B21C7a1A308B35fEeA', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'World Chain', role: 'L1 Standard Bridge', address: '0x470458C91978D2d929704489Ad730DC3E3001113', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Zora',        role: 'L1 Standard Bridge', address: '0x3e2Ea9B92B7E48A52296fD261dc26fd995284631', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Mode',        role: 'L1 Standard Bridge', address: '0x735aDBbE72226BD52e818E7181953f42E3b0FF21', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Ink',         role: 'L1 Standard Bridge', address: '0x88FF1e5b602916615391F55854588EFcBB7663f0', category: 'bridge', source: SUPERCHAIN },
  { protocol: 'Soneium',     role: 'L1 Standard Bridge', address: '0xeb9bf100225c214Efc3E7C651ebbaDcF85177607', category: 'bridge', source: SUPERCHAIN },

  // ---- other major infrastructure ----
  { protocol: 'Arbitrum One', role: 'Bridge',            address: '0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a', category: 'bridge', source: 'arbitrum docs' },
  { protocol: 'Polygon PoS',  role: 'ERC20 Bridge',      address: '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77', category: 'bridge', source: 'polygon docs' },
  { protocol: 'zkSync Era',   role: 'Diamond Proxy',     address: '0x32400084C286CF3E17e7B677ea9583e60a000324', category: 'bridge', source: 'zksync docs' },
  { protocol: 'Lido',         role: 'Withdrawal Queue',  address: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1', category: 'staking', source: 'lido docs' },
  { protocol: 'Aave v3',      role: 'Pool',              address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', category: 'lending', source: 'aave docs' },
  { protocol: 'Compound v3',  role: 'USDC Comet',        address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', category: 'lending', source: 'compound docs' },
  { protocol: 'Uniswap v3',   role: 'Factory',           address: '0x1F98431c8aD98523631AE4a59f267346ea31F984', category: 'dex', source: 'uniswap docs' },

  // ---- Added from L2Beat's discovery output: the same addresses L2Beat's own pages resolve ----
  { protocol: 'Blast', role: 'L1 Portal', address: '0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Mantle', role: 'L1 Portal', address: '0xc54cb22944F2bE476E02dECfCD7e3E7d3e15A8Fb', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Mint', role: 'L1 Portal', address: '0x59625d1FE0Eeb8114a4d13c863978F39b3471781', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Swell', role: 'L1 Portal', address: '0x758E0EE66102816F5C3Ec9ECc1188860fbb87812', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Zircuit', role: 'L1 Portal', address: '0x17bfAfA932d2e23Bd9B909Fd5B4D2e2a27043fb1', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Kroma', role: 'L1 Bridge', address: '0x827962404D7104202C5aaa6b929115C8211d9596', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Metis', role: 'L1 Bridge', address: '0x3980c9ed79d2c191A89E02Fa3529C60eD6e9c04b', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Linea', role: 'Rollup', address: '0xd19d4B5d358258f05D7B411E21A1460D11B0876F', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Linea', role: 'Token Bridge', address: '0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Scroll', role: 'Rollup', address: '0xa13BAF47339d63B743e7Da8741db5456DAc1E556', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Scroll', role: 'L1 ETH Gateway', address: '0x7F2b8C31F88B6006c382775eea88297Ec1e3E905', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Starknet', role: 'Core', address: '0xc662c410C0ECf747543f5bA90660f6ABeBD9C8c4', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Starknet', role: 'ETH Bridge', address: '0xae0Ee0A63A2cE6BaeEFFE56e7714FB4EFE48D419', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'Arbitrum One', role: 'Inbox', address: '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
  { protocol: 'zkSync Era', role: 'L1 ERC20 Bridge', address: '0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },

  { protocol: 'OP Mainnet', role: 'ETH Lockbox', address: '0x322b47Ff1FA8D5611F761e3E275C45B71b294D43', category: 'bridge', source: 'l2beat/l2beat config (discovered.json)' },
]
