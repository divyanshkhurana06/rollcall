# Cover note (Hedera Asset Tokenization Studio)

Roll Call measures a risk. Measuring a risk is half a product; somebody has to bear it. The cover
note is the instrument that closes the loop, and every leg maps onto something ATS already does:

| Roll Call | ATS |
|---|---|
| the report | written into the instrument's regulation data, binding cover to one timestamped assessment |
| the premium | the bond's coupon schedule, priced from the measured quorum gap and dark signers |
| who may hold it | whitelist plus internal KYC, ERC-3643 style |
| a breach | detected by the CRE confidential workflow, settled by the controller role |
| the term | maturity |

```bash
npm run agent    # produces data/last-report.json
npm run cover    # issues the cover note against it
```

## Current status: blocked on a version mismatch

The ATS contracts deployed on Hedera testnet at the addresses published in the SDK README
(factory `0.0.6797955`, resolver `0.0.6797832`) are an **earlier release** than any package we can
reconstruct, and `deployBond` reverts before validation.

What we established, rather than assumed:

- The factory is genuinely ATS: `getAppliedRegulationData(uint8,uint8)` decodes correctly against
  our ABI and returns real Reg S / Reg D data, so the contract and our encoding of that function agree.
- The resolver has two registered configurations, `0x..01` and `0x..02`, both at latest version 1,
  read live from `getConfigurations`.
- But `checkResolverProxyConfigurationRegistered` reverts on the same resolver, so the deployed ABI
  is only a partial match for the current package.
- Between contracts v1.15.2 and v8.0.0 the layout changed substantially: `SecurityData` reorders its
  fields and `BondData` carries `couponDetails` rather than `proceedRecipients`, so a v8-encoded call
  cannot succeed against a v1 factory and vice versa.
- We hold both layouts in `ats.ts` and try each against the live contract. We also scanned 16
  combinations of layout, configuration id, configuration version and role set. None were accepted.

`isin.ts` is worth keeping either way: the factory validates the ISO 6166 check digit and reverts
with `WrongISINChecksum`, so each cover note carries a real, deterministic identifier derived from
the Safe it covers. Verified against published ISINs in `isin.test.ts`.

**To unblock:** the current ATS testnet factory address, or the contracts package version matching
the deployed one. Both are a question for Hedera's Discord rather than something to brute force
through twelve package versions.
