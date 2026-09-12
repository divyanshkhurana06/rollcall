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
  Base             L1 Portal     $1.92B     2/2       2       0     0       0
  OP Mainnet       ETH Lockbox   $446M      2/2       2       0     0       0
  Mantle           L1 Portal     $409M      6/14      2       7     1       8
  World Chain      L1 Portal     $16M       5/8       4       1     2       1
  Zircuit          L1 Portal     $2M        4/11      1       2     5       1
  Metis            L1 Bridge     $1M        6/8       6       8     -6      1
  Lisk             L1 Portal     $1M        1/1       1       1     -1      0
```

**$4.82B across 47 contracts, 31 of them with a Safe in the authority path. $2.38B sits behind a
signer set with zero margin** - one lost key and that contract can never be upgraded again. **$430M
sits behind a Safe whose honest quorum is below its declared threshold**: Mantle declares 6 of 14,
resolves to an honest quorum of 2, and 7 of its 14 signers have shown no onchain signal in 180
days. Three chains show a negative margin, meaning that on the evidence searched the signers still
showing activity cannot reach threshold at all.

Value is read at the contract itself. OP Stack chains that moved their ETH into the shared
`ETHLockbox` show it there, not at the portal, which is why the lockbox is a target of its own.

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
                   x402 gate          HCS attestation          MCP server       CRE workflows
                  (metered by         (timestamped             (agents ask      (rules and keys
                   real work)          archive)                 pre-integration) stay in the enclave)
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
npm run agent -- 0x97cd... ethereum --asset=rcc                 # the same, settled in the HTS token
npm run agent:subscribe -- 10                                   # buy 10 report credits, get a bearer token
npm run agent:schedule -- 10 3600                               # credits paid by a Scheduled Transaction an hour from now
npm run agent:register -- https://rollcall-pi.vercel.app        # ERC-8004 identity on Hedera testnet and Sepolia
npm run setup:hts                                               # the RCC token with its fee schedule
npm run protect                                                 # liquidation protection, the five published scenarios
npm run challenge -- status                                     # the live challenge position on Sepolia
npm run challenge -- guard --send                               # the enclave engine on a loop from this machine
cd cre && cre workflow simulate ./liquidation-protection --target staging-settings -e .env --trigger-index 0
npm run cover                                                   # issue a cover note through ATS
```

**Hosted:** [rollcall-pi.vercel.app](https://rollcall-pi.vercel.app) serves the web and the API from
one domain (`/api/...`, `/.well-known/x402`). The Ask tab takes a question in plain English ("is the
Base bridge safe to use?") and an agent resolves the protocol to its keys, prices the report, reads
exposure through The Graph, pays for the report over x402 on Hedera with its own wallet, and answers
from the numbers, every step streamed as it happens. Every report also comes back in sentences, one
per number, with its tier named. A visitor who presses Analyse never meets a paywall:
the service pays for the report with its own testnet wallet, through the facilitator, and the page
shows the 402 offers, the settlement transaction and the HCS receipt as a receipt, not an error. An
agent that has bought credits pastes its token and pays its own way; the *settle in RCC* button shows
the same flow in the HTS token. The Enclave tab reads the live
Chainlink challenge position on Sepolia and walks the five published scenarios. `vercel.json` is the whole deployment; `Dockerfile` and
`render.yaml` are there for anyone who prefers a container. One honest caveat about the hosted copy:
it is serverless, so credit tokens and renewal registrations live in the memory of the instance
that created them (plus whatever `ROLLCALL_TOKENS` seeds). Reports, payments, attestations and the
signal are unaffected, because their state is on Hedera. A local `npm run api` persists everything
to `data/`.

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

**The registry.** `data/standardized-registry.json` is every Messari standardized deployment on the
decentralized network that answered the schema-level query when
`packages/core/test/probe-standardized.ts` last ran: **84 verified deployments across 12 networks**,
51 lending and 33 DEX, each with the block it had indexed at verification. A report queries the 27
largest lending deployments with one query string, and every answer carries its provenance
(`deployment`, `indexedBlock`) so an agent can tell fresh data from stale. Adding a protocol is a
data change; the query code never moves. `GET /graph/registry` serves it.

### Hedera - `apps/api/src/x402.ts`, `apps/api/src/hcs.ts`, `apps/api/src/renewals.ts`

Live at [rollcall-pi.vercel.app/api](https://rollcall-pi.vercel.app/api/health), settled through the
Blocky402 facilitator on `hedera:testnet`.

**x402, metered by work.** Independence testing is quadratic in signers, so price follows the job:

```
price = base + perPair·C(n,2) + perTx·min(txs, cap) + perChain·chains
```

A 3-of-5 with 40 transactions and a 12-of-20 with 900 are not the same product. `GET /quote` is free
and returns the full breakdown, so an agent can decide before paying.

**Two ways to settle.** Every 402 carries two offers: HBAR, and **RCC**, an HTS token
(`0.0.10498870`) whose fee schedule the network assesses on every transfer: a 2% fractional fee to
a collector account, on top, paid by the sender. The client picks; the API checks the accepted offer
against its own byte for byte before it verifies, so nobody pays the cheaper asset and claims the
other. `npm run agent -- <safe> ethereum --asset=rcc` is a real token settlement end to end:
[this one](https://hashscan.io/testnet/transaction/0.0.7162784-1789210131-728434226) moved 162 units
to the sales account and the network assessed 3 units to the fee collector from the payer, exactly
as the schedule says.

**Prepaid credits.** `POST /subscribe?credits=N` is x402-gated and returns a bearer token. It exists
for the runtimes that cannot sign a Hedera transfer per request: the Chainlink workflows run inside
an enclave with no Hedera key, and a cron should not carry one. The key that pays stays with the
buyer; the token is what the enclave holds. An unknown or exhausted token is not an error, it falls
through to the 402 so the caller can pay per request instead.

**Renewals by Scheduled Transaction.** `npm run agent:schedule -- 10 3600` signs next period's
payment now and lets the network execute it at expiry. The API registers the schedule
(`POST /renewals`), watches it on the mirror node, checks the executed transfer against the price,
and tops the token up exactly once. The money moves on the network's clock, not on either party's.

**HCS: the archive is the cache.** Every delivered report emits a timestamped attestation to topic
`0.0.10392885`. That makes *"on 10 September two of these signers had already been dark for 300
days"* provable after an incident rather than asserted. It also makes the archive the shared cache
behind `GET /signal`, which serves an enclave the latest attestation in a few hundred milliseconds
and refreshes it in the background, so a workflow with a ten second budget never waits on a minute
of computation. `since` on every report is the archive's first derivative: what moved since the
previous attestation of the same target.

**Discovery and identity.** `GET /.well-known/x402` lists every resource, how it is priced, which
network settles it, where the audit trail lives and how to buy credits. Roll Call is registered as an
ERC-8004 agent on Hedera testnet (agent `114`) and on Sepolia (agent `10244`, indexed by the Agent0
subgraphs so the identity reads back through The Graph); both registrations are in the manifest.

**Harness.** Building this against testnet surfaced four setups that pass `doctor` and then fail
forty minutes into a run: an EVM address in the account id variable, a key on the wrong curve, an
account that only exists on mainnet, and a balance below what the run funds.
[hedera-dev/hedera-harness#53](https://github.com/hedera-dev/hedera-harness/pull/53) makes `doctor`
verify operator credentials against the mirror node instead of checking that the variables are set.
Ten tests, no new dependencies, the key is never printed. Write-up and before/after evidence in
[`docs/harness-contribution/`](docs/harness-contribution/README.md).

### Chainlink - `cre/control-surface-watch/`, `cre/liquidation-protection/`

Two confidential workflows.

**Control surface watch.** A watchlist is an exposure map. Knowing which protocols an institution
watches, and at what thresholds it de-risks, tells you where its money is and what would make it
move. So the watchlist, thresholds and raw reports execute inside `handlerInTee`; what leaves is a
breach flag and a commitment to the report digests.

**Automated liquidation protection.** Entered in the official challenge against `ChallengeLending`
on Ethereum Sepolia (`0x88574e7C...31ba1`). The strategy is written in the contract's own integers,
because at 1800.00 the starting position has a health factor of 1.0029, which the contract truncates
to 100 and liquidates. Every published scenario, including "safe volatility", liquidates the
untouched position. `npm run protect` walks all five through a model of the contract under both
orderings of price update and liquidation check, and reports the worse one:

```
  scenario           unprotected          protected   min hf   actions  vETH used  vUSD used  loan open
  gradual decline    LIQUIDATED hf 0.88   survived    1.09     3        2.24       0.00       100%
  sudden crash       LIQUIDATED hf 0.82   survived    1.06     3        2.74       0.00       100%
  temporary wick     LIQUIDATED hf 0.91   survived    1.09     2        1.42       0.00       100%
  two-stage decline  LIQUIDATED hf 0.86   survived    1.07     3        2.48       0.00       100%
  safe volatility    LIQUIDATED hf 0.98   survived    1.11     2        1.24       0.00       100%
```

Collateral is spent before debt, because `loanContinuityScore` is computed on chain from
time-weighted debt and a deposit keeps the loan open. The loan stays 100% open in every scenario.

What Roll Call adds is a second trigger no liquidation protection has: every existing system watches
one variable, price. But a position becomes unsafe for reasons that never touch a price feed. If the
market's control surface loses quorum, or its signers turn out to be one party, the correct response
is to unwind regardless of how healthy the position looks. Five of the thirty-seven tests exist only
to prove that trigger fires on a perfectly healthy position.

`engine.ts` is one `tick()` with the transport injected, so the code that runs in the enclave is the
code that runs from a laptop (`npm run challenge -- tick`) and the code the tests drive against an
in-memory model of the contract that decodes every signed transaction. The signing key, the rules,
the cooldown, the governance bounds and the Roll Call credential are CRE secrets; the credential is
a prepaid credit token so the enclave never holds a Hedera key.

Both workflows run end to end in the CRE simulator against the live Sepolia contract; the transcript
is in [`cre/SIMULATION-RUN.txt`](cre/SIMULATION-RUN.txt). For three days they did not, and every
workflow including Chainlink's own scaffolds trapped at engine creation. The cause was the Bun
version the SDK bundles with, isolated by reinstalling the old one and reproducing the trap on
demand: [`cre/SIMULATION.md`](cre/SIMULATION.md). The enclave reads a governance signal the API keeps
warm (`/signal`), because its HTTP budget is ten seconds and a report takes a minute.

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
