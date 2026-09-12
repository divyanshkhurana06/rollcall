# Hedera Harness contribution

`doctor` verifies Hedera operator credentials against the network, instead of only checking that
the environment variables are set.

- Pull request: [hedera-dev/hedera-harness#53](https://github.com/hedera-dev/hedera-harness/pull/53)
- Video, before and after (3 min): [Google Drive](https://drive.google.com/file/d/1cqjV9rzSAkYKB_b_eQtC0rDgDpGZ_vvM/view?usp=sharing)
- Branch: `doctor-verify-hedera-credentials` on [the fork](https://github.com/divyanshkhurana06/hedera-harness/tree/doctor-verify-hedera-credentials)
- Patch: [`doctor-verify-hedera-credentials.patch`](./doctor-verify-hedera-credentials.patch)
- Evidence: [`before-after.txt`](./before-after.txt)

## Why

The harness builds Hedera apps, and `doctor` exists so that a broken setup costs two seconds rather
than the forty minutes to two hours a run takes. It already applies that argument to the agent CLI,
the package manager and the browser tiers.

It did not apply it to Hedera. `checkChainEnv` reported whether the operator variables were **set**,
and stopped there. Set is not the same as usable, and the gap is not hypothetical - every failure
below is one we hit while building Roll Call against Hedera testnet:

| Failure | Before | Cost |
|---|---|---|
| EVM address in the account id variable | passes | Both are "the address" in conversation. Fails at operator setup with an opaque parse error |
| Key curve does not match the account | passes | Surfaces as `INVALID_SIGNATURE` at the first transaction, with nothing pointing at the key format |
| Account exists on another network | passes | Accounts are per network. Fails as if the account were deleted |
| Balance below what the run funds | passes | Run dies mid-flight, after the agent budget is already spent |

A raw 64 hex key is valid for both curves, so it cannot be classified locally. Rather than guess,
`doctor` reports which `fromString*` the account actually needs.

## What changed

- `src/chainCredentials.ts` - the check. Key curve comes from the DER prefix, everything else from
  the mirror node. **No new dependencies.**
- `src/doctor.ts` - runs it after the existing presence check, and only when presence passes, so
  the original output is unchanged when the variables are missing.
- `test/chain-credentials.test.mjs` - 10 tests with a stubbed fetch, so the suite stays offline and
  deterministic.

## Design decisions worth stating

- **Offline is a warning, never a failure.** Losing network access is not a broken setup, and a
  preflight that fails closed on a flaky connection is one people learn to skip.
- **The key is never printed**, and a test asserts it never appears in any check output.
- **The balance threshold is `chainValidation.fundingHbar` plus fees**, not an arbitrary floor. The
  run declares what it will move to the ephemeral signer, so the check knows what "enough" means.
- **Presence reporting is preserved.** The existing two checks still appear with the same names, so
  nothing downstream that reads them by name breaks.

## Verification

```
npm run typecheck   clean
npm test            181/181 pass  (171 existing + 10 new)
```
