# ATS layout search

`deployBond` reverts on the deployed testnet factory (`0.0.6797955`) with `CONTRACT_REVERT_EXECUTED`,
before any validation. The struct layout changed several times across releases, so rather than guess,
every known layout was fetched from npm and simulated against the live contract.

## The three layouts

Fetched from the published artifacts of `@hashgraph/asset-tokenization-contracts`:

| Layout | Versions | Distinguishing feature |
|---|---|---|
| v1 | 1.15.x | `BondData` carries `couponDetails`; `SecurityData` starts with the two partition booleans |
| v7 | 2.0.0 through 7.0.0 | `BondData` carries `proceedRecipients`; `SecurityData` adds `erc20VotesActivated` near the end |
| v8 | 8.0.0 | `SecurityData` reorders again, moving `resolver` and `maxSupply` to the front |

Seven published versions collapse into **three distinct shapes**, which is the whole search space
from 1.15 to 8.0.

## What was tried

All three layouts, against both registered resolver configurations (`0x..01`, `0x..02`), at
configuration versions 0 and 1, with both a minimal `DEFAULT_ADMIN_ROLE` grant and the full role
set. **24 combinations. None accepted.**

`packages/cover/src/matrix.ts` reruns the search.

## What is established, not assumed

- The factory is genuinely ATS: `getAppliedRegulationData(uint8,uint8)` decodes correctly against
  the v8 ABI and returns real Reg S and Reg D data, so the contract and our encoding of that
  function agree.
- The resolver has two configurations registered, both at latest version 1, read live from
  `getConfigurations`.
- But `checkResolverProxyConfigurationRegistered` reverts on that same resolver, so the deployed
  ABI is only a partial match for any published package.
- The ISIN is valid: the factory validates the ISO 6166 check digit and reverts with
  `WrongISINChecksum` otherwise, which `isin.ts` handles and `isin.test.ts` verifies against
  published ISINs.

## The definitive test

Simulation tells you which layouts are rejected, not why. The bytecode settles it.

The factory at `0.0.6797955` is a transparent proxy. Its implementation is
`0x0d8076eafb5606a0ce5098bb0e37f0b8334f3f49`, whose dispatch table contains 37 function selectors,
recovered by scanning for `PUSH4` opcodes and resolved against public signature databases.

`getAppliedRegulationData(uint8,uint8)` is present, which is the control: the contract and our
reading of it agree.

Then the `deployBond` selector was computed from the published ABI of **every version on npm** and
matched against that table:

| Versions | deployBond selector | In the deployed bytecode |
|---|---|---|
| 2.0.0 - 7.0.0 | `0x25f9e60f` | no |
| 8.0.0 | `0x41c87f6b` | no |
| 1.14.x - 1.17.0 | no artifacts published | n/a |

**No published version's selector appears in the deployed factory.** The contract at
`0.0.6797955` runs a build that was never released to npm, either predating the published
artifacts or coming from an unreleased branch.

`packages/cover/src/selector-probe.ts` and `version-match.ts` reproduce this.

## What is left

This is not solvable by guessing, and the search is complete rather than abandoned. It needs one of:

- the current ATS testnet factory address, if `0.0.6797955` is stale
- the contracts version matching the deployed build
- or confirmation that a direct contract call is not a supported path and it must go through the
  SDK's transaction adapter, which is what Hedera's first question about wallet type points at

`issue.ts` is written and will run once the layout is known.
