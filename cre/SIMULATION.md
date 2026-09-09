# CRE simulation status

Both workflows compile to WASM through the CRE CLI. Local simulation then fails at engine creation,
and the failure is **not specific to confidential workflows or to this project**: it reproduces on
Chainlink's own unmodified scaffolds, including a plain non-TEE one.

## What succeeds

```
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  Binary hash: 437e8b9e1ae64c62e861ca8b880e99810f01acb2063cc6775725756472c3c2dd
  Config hash: 2d6a3a1213e8ac2c87f5fab80c743c7f530eca128ee8e417bcd96bbd601b08a8
```

The CLI authenticates, loads project settings, checks RPC connectivity, typechecks the TypeScript,
compiles to WASM, applies production limits, and produces binary and config hashes. Secrets resolve
correctly: removing `.env` changes the failure to a clean `environment variable ... not found`.

## Where it stops

```
Failed to create engine: failed to execute subscribe: error while executing at wasm backtrace:
    0:  0x9a097 - <unknown>!<wasm function 313>
    1:  0xdb47f - <unknown>!<wasm function 1231>
Caused by:
    wasm trap: wasm `unreachable` instruction executed
```

## What was ruled out

| Test | Result |
|---|---|
| Our confidential workflow, CLI v1.32.0, SDK 1.18.0 | traps |
| Same, SDK 1.19.1 (different binary hash) | traps |
| Same, CLI v1.26.0 (the version the docs recommend) | traps |
| TEE constraint `{ tee: 'nitro' }` with no region pin | traps |
| **Chainlink's own `cre init` confidential scaffold, unmodified** | **traps** |
| **A plain NON-TEE workflow (kv-store template), SDK 1.20.0** | **traps, same wasm offsets** |
| Any of the above with `--no-config` | traps |
| SDK 1.14.0, 1.16.0, 1.18.0, 1.19.1, 1.20.0 | **all trap** |
| Any of the above with `.env` removed | fails earlier and cleanly, at the secrets step |

The last two rows are the ones that matter. **A non-TEE workflow trapping at the same wasm offsets
means this is not about `handlerInTee`**, and `--no-config` ruling out config parsing means it is not
the workflow's inputs either. Identical offsets across workflows with different binary hashes points
at shared SDK bootstrap code rather than at anything user-written.

An earlier version of this document blamed confidential workflows specifically. That was wrong, and
testing a plain workflow is what corrected it.

Five SDK versions spanning 1.14.0 to 1.20.0 were tested on the same plain non-TEE workflow. All
five trap. The javy plugin is 1.7.0, which is the version the SDK itself pins, so it is not a
plugin mismatch either.

Environment: macOS arm64, Node v22.22.3, Bun 1.2.15, CRE CLI v1.32.0 and v1.26.0.

## What stands in its place

- `bun test` in each workflow: **25 tests**, covering both triggers and the report encoding, using
  the fake `TeeRuntime` pattern from the official template.
- `npm run protect` from the repo root: the same decision function over generated price paths,
  reporting whether it avoided liquidation, preserved the carry, and used emergency capital
  efficiently.
- Both workflows typecheck against the real `@chainlink/cre-sdk` and compile to WASM.

## To finish this

Ask in Chainlink's Discord (`#partner-chainlink`) whether `cre workflow simulate` is known to fail
at engine creation on macOS arm64. The reproduction is a two-line one: `cre init` any TypeScript
template, set its secret, simulate.
