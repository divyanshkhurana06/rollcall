# CRE simulation

Both workflows run end to end in `cre workflow simulate`. For three days they did not, and the
reason turned out to be the version of Bun on this machine, not the workflows and not the CRE CLI.

```bash
cd cre
cre workflow simulate ./liquidation-protection --target staging-settings -e .env --trigger-index 0
cre workflow simulate ./control-surface-watch  --target staging-settings -e .env --trigger-index 0
```

The transcript of a real run, including the enclave banner, every HTTP capability call the enclave
made, the user logs and the result, is in [`SIMULATION-RUN.txt`](SIMULATION-RUN.txt).

## The root cause

The CRE TypeScript SDK compiles a workflow by bundling it with whatever `bun` is on `PATH`, then
compiling the bundle to WASM. With **Bun 1.2.15** the resulting binary compiles, hashes, and then
traps the moment the engine registers the trigger:

```
Failed to create engine: failed to execute subscribe: error while executing at wasm backtrace:
    0:  0x9a097 - <unknown>!<wasm function 313>
    1:  0xdb47f - <unknown>!<wasm function 1231>
Caused by:
    wasm trap: wasm `unreachable` instruction executed
```

With **Bun 1.4.2** the same workflow, CLI, SDK and config run to completion.

That attribution is tested, not inferred. After the upgrade, Bun 1.2.15 was installed again into an
isolated directory and put first on `PATH` for a single run:

| `bun` on PATH | CLI | SDK | Result |
|---|---|---|---|
| 1.2.15 (isolated install) | 1.32.0 | 1.19.1 | traps at `subscribe`, identical backtrace |
| 1.4.2 | 1.32.0 | 1.19.1 | `Workflow execution finished successfully` |

Everything else that was tried during the three days is below, and all of it was a red herring:
five SDK versions, two CLI versions, Chainlink's own unmodified confidential scaffold, a plain
non-TEE workflow, `--no-config`, removing the TEE constraint. They all failed the same way because
they all went through the same Bun.

Two smaller findings from the same investigation:

- The `--target` flag wants the full settings key. `--target staging-settings` resolves;
  `--target staging` reports `target not found` on this CLI version.
- The simulator enforces production limits, and the plain HTTP capability has a **10 second**
  timeout. A Roll Call report takes 30 to 60 seconds to compute. That is why the workflows read
  `/signal`, which the API keeps warm and refreshes in the background, instead of `/report`.
  Inside `handlerInTee` the plain HTTP capability is already confidential; the separate
  confidential HTTP capability is for DON-mode runtimes and does not accept a `TeeRuntime`.

## What the run shows

For `liquidation-protection`, the enclave fetches the signing key and the rules from the Vault DON
secrets, reads `ChallengeLending` on Sepolia (nine `eth_call`s and one `eth_getLogs` for the
cooldown), fetches the governance signal, and decides:

```
[USER LOG] price=200000 hf=111 action=PROTECT deposit=61 repay=0
[USER LOG] scenario not active, no transaction sent
Workflow Simulation Result:
"{"state":"not-active","hf":"111","price":"200000","deposit":"61","repay":"0","txHashes":[]}"
```

That is the position the workflow joined, read live, and the proactive 0.61 vETH top-up the
strategy makes at the opening price. `deposit` reverts until the organisers call `start()`, so
nothing is sent yet; once the scenario is live the same tick signs and broadcasts.

## What was ruled out, for the record

| Test | Result |
|---|---|
| Our confidential workflow, CLI v1.32.0, SDK 1.18.0 | traps |
| Same, SDK 1.19.1 (different binary hash) | traps |
| Same, CLI v1.26.0 (the version the docs recommend) | traps |
| TEE constraint `{ tee: 'nitro' }` with no region pin | traps |
| Chainlink's own `cre init` confidential scaffold, unmodified | traps |
| A plain NON-TEE workflow (kv-store template), SDK 1.20.0 | traps, same wasm offsets |
| Any of the above with `--no-config` | traps |
| SDK 1.14.0, 1.16.0, 1.18.0, 1.19.1, 1.20.0 | all trap |
| **Any of the above with Bun 1.4.2 on PATH** | **runs** |

Environment: macOS arm64, Node v22.22.3, CRE CLI v1.32.0, javy plugin 1.7.0.

## Evidence the tests were not the only thing running

- `bun test` in each workflow: **50 tests** (39 + 11). The liquidation tests drive the real
  `tick()` against an in-memory model of `ChallengeLending` that decodes every signed transaction.
- `npm run protect` from the repo root: the same decision function over the five scenarios the
  challenge publishes, under both orderings of price update and liquidation check.
- `npm run challenge -- status`: the engine against the live Sepolia contract, dry run.
- `cre workflow simulate`: the workflow itself, in the CRE engine, against the live contract.

## Deployment

The Confidential Workflows deploy access form was submitted on 9 September. With access,
`cre workflow deploy ./liquidation-protection --target staging-settings` puts the workflow on the
network so it can defend the position during the organisers' scenario run.
