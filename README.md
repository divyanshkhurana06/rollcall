# Roll Call

**Who can take everything, how fast, and are they still awake?**

> Base's L1 Portal holds **$1.86B**. It can be upgraded by a 2-of-2 Safe whose margin is **zero** -
> one lost key and it can never be upgraded again. There is no timelock, so a signature takes effect
> in the next block. Neither signer has ever sent a transaction, so both look dormant on every block
> explorer.
>
> Every number in that paragraph was read from chain state. None of it appears on an explorer.

Every protocol has a pause button, an upgrade path, a multisig. Almost none can tell you whether
anyone is still holding it. Roll Call derives that from onchain history instead of reading the claim.

It catches two failure modes, both of which have destroyed real money:

- **Capture** - the 5-of-9 is not five parties. Some signers always decide together, and the honest
  quorum is smaller than the declared one.
- **Abandonment** - the keys that could pause an exploit are dark. The protocol has an emergency
  brake nobody is holding.

## See it in a minute

```bash
npm install
npm run scan:protocols   # who controls the protocols, and what they hold
npm run api              # in one terminal
npm run web              # in another, then open http://localhost:5173
```

No API keys needed for any of that. Paste a protocol contract into the box and it will find the
Safe above it; paste a wallet and it will tell you there is nothing to measure.

---

## The thing that makes this possible

A Safe transaction is executed by **one** address paying gas, but approved by **N** owners whose
signatures are packed into the `signatures` argument of `execTransaction`. Those owners emit no
event, never appear as `tx.from`, and look completely inactive to every block explorer in existence.

Roll Call recovers them from the signature blob.

```
v == 0   contract signature   owner packed into r
v == 1   pre-approved hash    owner packed into r
v  > 30  eth_sign             ecrecover over the personal_sign digest, v-4
else     EIP-712              ecrecover over the Safe tx hash directly
```

The digest comes from the `ExecutionSuccess` event, so historical EIP-712 nonces never need
reconstructing. On a live 3-of-8 Safe this is measured, not asserted:

```
per-signer agreement vs Safe's own records   100.0%   (36 signer-slots)
exact approver-set match                     12/12
unresolved signature words                   0
```

**Three of the approvers on that Safe have `nonce 0`.** They have never sent a transaction. Etherscan
shows them as dormant. They approved transactions this week, and the address that paid the gas is not
even an owner.

### What the recovery does not cover

Liveness searches the chains named in each report header, which defaults to Ethereum alone - not
"every chain". Approver recovery covers a recent block window rather than a Safe's whole history,
because public RPCs cap log queries at 10,000 blocks. Both limits are printed in the report rather
than left implied.

---

## Where this sits against existing tools

Multisig security analysis is not a new category, and neither is publishing who controls a protocol.

- **L2Beat** documents the permissions of every L2 it tracks: who can upgrade, the multisig
  thresholds, the security council structure. For Base and OP Mainnet it already states the
  governance multisigs and their thresholds. That research is careful and hand-curated.
- **yAudit's Multisig Security Checker** already does Safe introspection, threshold analysis and
  signing-speed heuristics.
- **Safe Watcher and OpenZeppelin Defender** alert on activity in a multisig you operate.

So Roll Call is not the first thing to look at a multisig, and it is not the first thing to publish
who controls a bridge. Any claim that nobody knows who holds these keys would be false.

What those tools publish is **structure**: who the signers are, what the threshold is, how
governance is wired. What none of them publish is whether those signers are **still there**, and
that is the gap Roll Call is built for.

- **Participation, not activity.** "Has this address sent transactions" is answerable from any
  explorer and gives the wrong answer, because multisig signers approve offchain and their nonce
  never moves. "Has this address approved anything" is answerable only from the signature blob.
  We have not found another tool that recovers it.
- **Derived, not curated.** L2Beat's permissions are researched by people and written into config.
  Roll Call reads authority off the chain, so it runs against a contract nobody has documented.
- **Evidence over scores.** There is no composite "collusion distance". Dependence is reported as a
  permutation p-value with the raw counts beside it, and the test's false-positive rate is published.

Narrowly: the contribution is **liveness and independence measured from recovered approvals**, over
a population discovered automatically. Not the category, and not the idea of documenting control.

## Every number belongs to a tier

A score with no stated null hypothesis is a made-up number. So each claim is tiered, and the tiers
are never mixed - a reader who trusts only the first tier still gets a useful report.

| Tier | Meaning |
|---|---|
| **OBSERVED** | Read directly from chain state or event logs. A fact. |
| **TESTED** | A statistic with a stated null and an empirical p-value. |
| **INFERRED** | Depends on a parameter we chose. Always reported as a function of it. |

### Observed - liveness

Two independent signals, because either alone misleads:

1. **Last outgoing transaction**, found by binary-searching `eth_getTransactionCount` over block
   height. The nonce is monotonic, so the block where it last increased is the block of the last
   gas-paying transaction. ~25 archive reads per address, no indexer required.
2. **Last observed approval**, from recovered signature blobs. This catches the opposite case - an
   owner who signs offchain every week while their nonce sits frozen.

We never claim a key is lost. The report says *"no observed signature in 304 days across 1 chain
(Ethereum)"* and names the search space. **A lookup that fails is marked `indeterminate` and counted
as neither live nor dark** - reporting "no signal ever" because our own request timed out would be a
false claim, and one false claim discredits every true one.

### Tested - independence

The null: *each signer independently approves at their own marginal rate, subject to the threshold
constraint.* That constraint matters. In a 3-of-3 with three active signers everyone co-signs
everything by construction - structure, not collusion. The permutation preserves **both** each
signer's marginal rate **and** the per-transaction signer count, so structural co-occurrence cancels
out of the null.

We report an empirical p-value with `+1` smoothing, because an empirical p-value can never honestly
be reported as exactly zero.

A **co-submission artifact filter** discards confirmations recorded within 5s of execution.
Signatures are routinely gathered offchain and posted together, which registers as perfect timing
coupling. Without this filter the timing test fires on almost every Safe; with it, one real finding
survived on our test Safe and four false ones vanished.

### Inferred - effective quorum

The number most likely to become a fabrication, so it is never reported as a constant.

> A **lower bound** on the independent decision units required to reach threshold, where signers
> merge into one unit if their co-signing dependence is significant at α.

Published as a curve:

```
α = 0.05     7 independent units  ->  effective quorum 2 of 3
α = 0.01     7 independent units  ->  effective quorum 2 of 3
α = 0.001    7 independent units  ->  effective quorum 2 of 3
α = 0.0005   7 independent units  ->  effective quorum 2 of 3
verdict: robust - holds across the whole tested range
```

Stable across three orders of magnitude is a finding. Collapsing only at loose α is a flag.

---

## The instrument is calibrated

Anyone can invent a score. Almost nobody characterises its error rate.

**Negative controls** - synthetic signers drawn under the null. Any flag is a false positive by
construction. **Positive controls** - two keys that always decide together.

| α | Family-wise FPR | Detection power |
|---|---|---|
| 0.05 | 7.5% | 100% |
| 0.01 | **0.0%** | 100% |
| 0.001 | **0.0%** | 100% |

*40 trials, 120 transactions, synthetic 3-of-6, 1200 permutations. Reproduce with `npm run validate`.*

This is what turns "we made a score" into "we built a measurement instrument and published its
error rate."

---

## Protocols you have heard of

Roll Call starts from a contract people recognise, reads what it holds straight from chain state,
resolves who can change it, and measures whether that signer set is as large as it claims.

```
  protocol         role          value      declared  honest  dark  margin  hidden
  Base             L1 Portal     $1.87B     2/2       2       0     0       0
  World Chain      L1 Portal     $16M       5/8       4       1     2       1
  BOB              L1 Portal     $1M        4/6       2       2     0       0
  Lisk             L1 Portal     $1M        1/1       1       1     -1      1
  Swan Chain       L1 Portal     $93K       3/4       3       4     -3      0
```

**$3.82B across 31 contracts. $1.88B of it sits behind a signer set with zero margin** - one lost
key and that contract can never be upgraded again. Two chains show a negative margin, meaning that
on the evidence searched the signers still showing activity cannot reach threshold at all.

OP Stack addresses come from Optimism's own `superchain-registry`, so they are verifiable rather
than curated here. Every address is re-verified at scan time: it must have code, its authority must
resolve, and its balance is read live.

```bash
npm run scan:protocols
```

**What this does not claim.** A signer with no observed activity may still hold their key and simply
not have been asked to sign. Value is the contract's own balance in ETH plus five major assets, so
it is a floor rather than a valuation. Authority is followed two hops, so a Safe behind a governance
timelock and a DAO vote may not be found. Protocols whose authority resolves to a timelock or a DAO
are reported separately rather than hidden - that is a different governance model, not a weaker one.

## The leaderboard

A single report answers "is this Safe what it claims to be". It cannot answer the question users
actually arrive with, which is "which of the things I depend on is worst". That needs a population.

Safes are discovered from `ExecutionSuccess` logs rather than a curated list, filtered to those with
enough signers and history for the statistics to mean anything, then ranked by consequence: can it
still act at all, how far the honest quorum is from the declared one, how close it is to frozen, how
many signers have gone quiet.

```
  safe                     decl  eff  gap  dark  margin  dep  invis
  0x93a79764...0435D1      3/8   1    2    1     4       2    0
  0x3dDFe4EA...1aC716      3/4   2    1    0     1       1    2
  0x44AF8Df1...360ECe      3/4   2    1    0     1       1    3
  0xe338204e...5cb6Fa      2/10  1    1    1     7       2    0
```

16 live Safes in that scan. Two have an honest quorum below their declared threshold that
holds at every significance level tested; four more only at looser levels, and those are marked `?`
because they are a prompt to look closer rather than a conclusion.

```bash
npm run scan        # refresh the population scan, writes data/leaderboard.json
```

## Architecture

```
                  Safe Transaction Service ─┐
                  execTransaction calldata ─┼─-> approver recovery ─┐
                  eth_getTransactionCount ──┘                      │
                                                                   ▼
                            permutation test ── timing test ── quorum curve
                                                                   │
                                    tiered report (observed/tested/inferred)
                                                                   │
                        ┌──────────────────┬───────────────────────┼─────────────────┐
                        ▼                  ▼                       ▼                 ▼
                   x402 gate          HCS attestation          MCP server       CRE workflow
                  (metered by         (timestamped             (agents ask      (watchlist stays
                   real work)          archive)                 pre-integration) in the enclave)
                        │                                            │
                        └──────────────── web interface ─────────────┘
                                     report + leaderboard
```

Full statistical method, including null hypotheses, the artifact filters and the calibration design:
[`docs/METHOD.md`](docs/METHOD.md).

## Running it

```bash
npm install
cp .env.example .env

npm run scan:protocols                                          # protocols, their value, who controls them
npm run report -- 0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5   # one Safe, in the terminal
npm run validate -- 0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5 # recovery agreement + calibration
npm run scan                                                    # population scan for the leaderboard
npm run api                                                     # x402-gated API on :8787
npm run web                                                     # interface on :5173
npm run mcp                                                     # MCP server on stdio
npm run agent                                                   # pay for a report over x402, for real
npm run protect                                                 # liquidation protection simulation
npm run cover                                                   # issue a cover note through ATS
```

No API keys are required to run the core. Everything above works against public endpoints.

To enable the HCS attestation archive, put a Hedera testnet account in `.env` and run:

```bash
npm run setup:hedera
```

It creates the topic and prints the `HCS_TOPIC_ID` line to add. Until then the report says
`not submitted - not configured` rather than pretending an attestation was written.

---

## Sponsor integrations

Each one serves the same primitive - *a claim about authority, with its evidence and its error bars.*

### The Graph - `subgraph/`, `packages/core/src/graph.ts`, `packages/mcp/`

**The subgraph is deployed** to Subgraph Studio and indexing mainnet:
`https://api.studio.thegraph.com/query/1758792/rollcall/v0.0.2`

**Composability.** Authority is expressed through the same handful of events in nearly every
contract ever deployed - `OwnershipTransferred`, `RoleGranted`/`RoleRevoked`, EIP-1967
`AdminChanged`/`Upgraded`, Safe's `AddedOwner`/`ChangedThreshold`. Nobody has given that pattern a
shared schema, so every tool that wants to answer *"who can change this contract"* writes a bespoke
integration per protocol. `subgraph/schema.graphql` is that shared shape. **Adding a protocol costs
zero new query code** - one datasource entry.

The `SignerApproval` entity is the one we could not find an equivalent of. It is the recovered approver set, which is
what makes cross-chain per-signer liveness a single query instead of a binary search per signer per
chain.

*Why indexed data is not optional here:* public RPCs cap `eth_getLogs` at 10,000 blocks. A year of
Ethereum is ~2.6M blocks, so one Safe costs ~260 sequential requests. We measured it, hit it, and
built around it.

**AI.** `packages/mcp/` exposes `who_controls`, `signer_liveness`, `independence_test`,
`effective_quorum` and `method_calibration`. Every tool returns its **tier and its caveats alongside
the numbers**, so a model cannot present an inference as a fact.

### Hedera - `apps/api/src/x402.ts`, `apps/api/src/hcs.ts`

**x402.** Metered by work, not per request. Independence testing is quadratic in signers, so price
follows the actual job:

```
price = base + perPair·C(n,2) + perTx·min(txs, cap) + perChain·chains
```

A 3-of-5 with 40 transactions and a 12-of-20 with 900 are not the same product. `GET /quote` is free
and returns the full breakdown, so an agent can decide before paying.

**HCS.** Anyone can recompute today's answer; nobody else has last year's. Each report emits a
timestamped attestation, so *"on 10 September two of these signers had already been dark for 300
days"* is provable after an incident rather than asserted. The archive is the asset.

### Chainlink - `cre/control-surface-watch/`, `cre/liquidation-protection/`

Two confidential workflows.

**Control surface watch.** A watchlist is an exposure map. Knowing which protocols an institution
watches, and at what thresholds it de-risks, tells you where its money is and what would make it
move. So the watchlist, thresholds and raw reports execute inside `handlerInTee`; what leaves is a
breach flag and a commitment to the report digests.

**Automated liquidation protection.** The challenge asks for a workflow that protects a virtual
ETH-collateral / USDC-debt position through simulated market movements with private rules. That is
implemented in full. What Roll Call adds is a second trigger no liquidation protection currently
has: every existing system watches one variable, price. But a position becomes unsafe for reasons
that never touch a price feed. If the market's control surface loses quorum, or its signers turn
out to be one party, the correct response is to de-risk regardless of how healthy the position
looks.

```
  path          unprotected    protected      actions  capital used  equity kept
  crash         LIQUIDATED     LIQUIDATED     2        $8000         $0
  grind down    LIQUIDATED     open           2        $8000         $5167
  whipsaw       survived       open           1        $6686         $12354
  recovery      LIQUIDATED     open           2        $8000         $14595
```

The crash path still liquidates. $8,000 of emergency capital cannot rescue $18,000 of debt against
a sustained collapse, and reporting 4 out of 4 would have meant tuning the parameters until the
number looked good.

`npm run protect` runs it. Both workflows deliver only an action, a size and a commitment on chain:
`LiquidationProtectionConsumer.sol` contains no health factor, no thresholds, no capital balance,
and no indication of which rule fired.

Both compile to WASM through the CRE CLI. Local simulation fails at engine creation, and it fails
the same way on Chainlink's own unmodified scaffolds including a plain non-TEE one, so it is not
this project. The full reproduction is in [`cre/SIMULATION.md`](cre/SIMULATION.md).

### Chainlink - watchlist detail

A watchlist is an exposure map. Knowing which protocols an institution watches, and at what
thresholds it de-risks, tells you where its money is and what would make it move. So the watchlist,
the thresholds and the raw reports execute inside `handlerInTee`; what leaves the enclave is a
breach flag and a commitment to the report digests. `RollCallConsumer.sol` deliberately contains no
protocol addresses, no signer addresses and no thresholds.

---

## What this does not do

- Transactions executed outside the Safe Transaction Service are absent from the participation matrix.
- Liveness is bounded by the chains in the report header. A signer active elsewhere reads as dark here.
- Module-executed transactions bypass owner signatures entirely and are out of scope for independence.
- Timing dependence cannot distinguish one operator from two people in the same meeting. It never will.
- **Nothing here identifies a person.** It measures whether signing behaviour is statistically
  independent. Two colleagues who always agree produce the same signal as one person with two keys,
  and the report says so next to every number.

Findings ship with their evidence so anyone - including the team being analysed - can check the
arithmetic by hand. That is the difference between a report people cite and one they dismiss.
