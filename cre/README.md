# Chainlink CRE Confidential Workflows

Two workflows. Both put the sensitive half of a decision inside an AWS Nitro enclave and let only
the consequence out: a breach count for one, a signed transaction for the other.

```bash
cd cre
cre workflow build ./control-surface-watch  --target staging -e .env   # compiles to WASM
cre workflow build ./liquidation-protection --target staging -e .env   # compiles to WASM

cd liquidation-protection && bun test    # 37 pass
cd control-surface-watch  && bun test    # 11 pass
```

Tests run without auth or network. `cre workflow simulate` does not run on this machine for any
workflow, including Chainlink's own scaffolds; the reproduction is in [`SIMULATION.md`](SIMULATION.md).

## control-surface-watch

Watches a private list of protocols and reports how many have degraded.

A watchlist is an exposure map. Knowing which protocols an institution monitors, and at what
thresholds it de-risks, tells you where its money is and what would make it move. That is precisely
what node operators would otherwise see, which is why the watchlist, the thresholds, the API
credential and the reports all stay in the enclave.

What crosses: a breach count, the number watched, and an order-independent commitment to the report
digests. A subscriber can prove afterwards which assessments drove an alert without publishing them
at the time.

## liquidation-protection

Entered in the [Automated Liquidation Protection Challenge](https://github.com/solangegueiros/cf-liquidation-protection-challenge)
against the official `ChallengeLending` contract on Ethereum Sepolia.

| | |
|---|---|
| contract | `0x88574e7Cc0027afd04951daa09B64d4441931ba1` |
| position on `join()` | 5.00 vETH collateral, 7000.00 vUSD debt, health factor 1.11 at 2000.00 |
| emergency capital | 5.00 vETH and 7000.00 vUSD minted to the wallet |
| liquidation | `checkAllHF` at health factor <= 1.00, partial, with a 5% penalty |
| scoring | protection 40, loan continuity 20, capital efficiency 15, confidentiality 15, discipline 10 |

### In the contract's own integers

`strategy.ts` does every calculation in the contract's arithmetic: two-decimal units, `calcHF`,
ceiling division for the collateral that reaches a target. The reason is one number. At 1800.00
the starting position has a health factor of 1.0029, which the contract truncates to 100 and
liquidates. A strategy that reasons in floats calls that position safe. **Every published scenario,
including "safe volatility", liquidates the untouched position** for exactly this reason, and the
harness proves it rather than asserting it.

The contract's stored health factor is only refreshed inside `calcHF`, so after a price update it
is stale. The workflow recomputes from collateral, debt and the live price every tick.

### The strategy

```
MARKET      health factor reaches the private trigger                  -> restore to the private target
GOVERNANCE  the market's control surface degrades past a private bound -> unwind regardless
```

- **Deposit first.** Adding collateral keeps the loan open; repaying shrinks it. `loanContinuityScore`
  is computed on chain from time-weighted debt, so the default spends vETH before vUSD. The priority
  is a private rule and can be flipped.
- **Restore to a target, not to safety.** The gap between trigger and target is the hysteresis. Each
  action buys enough headroom that the next scenario step cannot cross 1.00 before the cron fires.
- **Cooldown, statelessly.** The tick reads its own recent `Deposit` and `Repay` events from the
  chain. A non-critical action inside the cooldown is skipped; a critical one is not.
- **Fail safe on the governance leg, fail open on the cooldown.** A Roll Call report that cannot be
  fetched is no signal, never a breach. A cooldown lookup that fails does not stop a protection.

What Roll Call adds is the second trigger. Every existing protection watches one variable: price.
But a position becomes unsafe for reasons that never touch a price feed. If the market's control
surface loses quorum, or its signers turn out to be one party wearing several hats, the people who
can pause, upgrade or seize that market are not who you thought, and the correct response is to
de-risk however healthy the health factor looks. Five of the thirty-seven tests exist only to prove
this trigger fires on a position that is perfectly healthy by every market measure.

### The five published scenarios

`npm run protect` from the repo root walks the scenarios from the challenge README through a model
of the contract, under **both** orderings of price update and liquidation check, and reports the
worse one:

```
scenario           unprotected          protected   min hf   actions  vETH used  vUSD used  loan open
gradual decline    LIQUIDATED hf 0.88   survived    1.09     3        2.24       0.00       100%
sudden crash       LIQUIDATED hf 0.82   survived    1.06     3        2.74       0.00       100%
temporary wick     LIQUIDATED hf 0.91   survived    1.09     2        1.42       0.00       100%
two-stage decline  LIQUIDATED hf 0.86   survived    1.07     3        2.48       0.00       100%
safe volatility    LIQUIDATED hf 0.98   survived    1.11     2        1.24       0.00       100%
```

The health factor never reaches 1.00 under either ordering, so the result does not depend on the
workflow winning a race against the liquidation check. The loan stays 100% open in every scenario,
and no vUSD is spent.

### One engine, three transports

`engine.ts` is a single `tick()` with the RPC transport injected. The same function runs:

- inside the enclave, over the CRE HTTP capability (`workflow.ts`)
- from a laptop, over `fetch` (`npm run challenge -- tick`)
- in the tests, against an in-memory model of the contract that decodes the signed transactions
  and checks what was sent, in what order, to which address

The execution path that will defend the position during the organisers' run is the one exercised
offline. Not a copy of it.

### What stays inside

The signing key, every threshold and cap, the action priority, the cooldown, the governance bounds,
the Roll Call credential, the report, and which rule fired. The rules are one JSON secret:

```
SECRET_PROTECTION_RULES={"triggerHf":...,"targetHf":...,"criticalHf":...,"maxDepositUnits":...,
                         "maxRepayPct":...,"preferDeposit":...,"cooldownBlocks":...,
                         "minHonestQuorum":...,"maxDarkSigners":...}
```

What leaves is a signed transaction. An observer sees that the position was defended and by how
much, which the chain would have told them anyway. The log carries the action and the amounts, never
a rule or a reason.

The Roll Call credential is a prepaid credit token, bought once over x402 with
`npm run agent:subscribe`. The enclave holds a credential; the Hedera key that paid for it never
leaves the buyer.

### Entering the challenge

```bash
npm run challenge -- keygen     # a dedicated Sepolia key. Fund the printed address with a little Sepolia ETH.
npm run challenge -- status     # chain state, our position, and exactly what the workflow would do now
npm run challenge -- join       # join(), then approve vETH and vUSD once, so the enclave never has to
npm run challenge -- tick       # one cron iteration of the enclave code path, dry run. Add --send to transact.
```

`deposit` and `repay` revert until the organisers call `start()`, so before that `status` shows the
plan and sends nothing.

`rollcallApiUrl` in both `config.staging.json` files must be reachable from the enclave. It is set
to the URL `npm run tunnel` printed at the time of writing; a tunnel URL changes every run, so put
the current one (or the hosted API from `render.yaml`) there before deploying.

To deploy the workflow itself: `cre workflow deploy ./liquidation-protection --target staging` once
Confidential Workflows access is provisioned for the organisation. The build already succeeds; only
the simulator is blocked.
