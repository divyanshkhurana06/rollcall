# Method

Roll Call makes claims about who controls a protocol. This document states exactly what each claim
means, what would falsify it, and how accurate the instrument is. Anyone should be able to reproduce
every number here from the report header.

---

## 1. The tier system

A score with no stated null hypothesis is a made-up number. Every value Roll Call prints belongs to
exactly one of three tiers, and they are never mixed. A reader who trusts only tier 1 still gets a
useful report.

| Tier | Meaning | Falsifiable by |
|---|---|---|
| **Observed** | Read directly from chain state or event logs | Reading the chain |
| **Tested** | A statistic with a stated null and an empirical p-value | Re-running the test |
| **Inferred** | Depends on a parameter we chose | Choosing a different parameter |

Tier 3 is always reported as a function of its parameter, never as a constant.

---

## 2. Approver recovery

### The problem

A Safe transaction is executed by one address paying gas. It is approved by N owners whose
signatures are packed into the `signatures` argument of `execTransaction`. Those approvers emit no
event and never appear as `tx.from`. Every block explorer therefore shows them as inactive, no
matter how often they sign.

### The method

The `ExecutionSuccess` event carries the Safe transaction hash, which is precisely the digest the
owners signed. Taking it from the event rather than reconstructing the EIP-712 struct means no
historical nonce is required.

The blob is read as 65-byte words. Per Safe's `checkNSignatures`:

| `v` | Flow | Attribution |
|---|---|---|
| `0` | EIP-1271 contract signature | owner address packed into `r` |
| `1` | Pre-approved hash | owner address packed into `r` |
| `> 30` | `eth_sign` | `ecrecover` over the personal-sign digest with `v - 4` |
| else | EIP-712 | `ecrecover` over the digest directly |

Words that cannot be attributed are counted in `unresolved` and reported. They are never dropped
silently.

`execTransaction` is frequently nested inside relayers, modules and multisend wrappers, so the
selector is located anywhere in the calldata rather than assumed to be the outer call.

### Validation

Recovered approvers are compared against Safe Transaction Service confirmation records, which are
an independent derivation of the same fact.

```
transactions compared                12
exact approver-set match             12 / 12
per-signer agreement             100.0%   (36 signer-slots)
unresolved signature words            0
```

Reproduce: `npm run validate -- <safe-address>`

---

## 3. Liveness

### Two signals

**Last outgoing transaction.** The account nonce is monotonic, so the lowest block at which
`eth_getTransactionCount` equals its current value is the block containing the last outgoing
transaction. Found by binary search over block height in roughly `log2(head)` archive reads. No
indexer required.

**Last observed approval.** From recovered signature blobs and confirmation records. This catches
the case the first signal misses entirely: an owner who signs offchain every week while their nonce
sits frozen at zero.

Neither signal alone is sufficient. A signer with `nonce 0` who signed yesterday is invisible to
signal 1; a signer who transacts daily but never signs for this Safe is invisible to signal 2.

### What is claimed

> "No observed signature or transaction in 304 days across 1 chain (Ethereum)."

Not "this key is lost". Absence of an observed signature is not proof of anything except absence of
an observed signature. The search space is named in every statement so the claim is bounded.

### Indeterminate

If a lookup fails, the signer is marked `indeterminate` and counted as **neither live nor dark**.
Reporting "no signal ever" because our own request was rate-limited would be a false claim, and one
false claim discredits every true one in the report.

### Reachability

Given a dark threshold `D` (default 180 days), the report states whether the signers still showing
activity can meet the Safe's threshold, and the margin before they cannot. Indeterminate signers are
counted optimistically toward reachability and excluded from the dark count.

---

## 4. Co-signing independence

### The null hypothesis

> Each signer independently decides whether to approve transaction `t`, at their own marginal
> participation rate, subject to the constraint that exactly `k` signers approve each transaction.

The threshold constraint is not a detail. In a 3-of-3 Safe with three active signers, everyone
co-signs everything by construction. That is structure, not collusion, and a naive correlation
would rank a 3-of-3 as maximally dependent.

### The test

A permutation test. Each permutation redraws which signers fill each transaction's slots, sampling
without replacement weighted by each signer's marginal rate (Efraimidis-Spirakis keys). This
preserves both the per-transaction signer count and, approximately, each column marginal, so
structural co-occurrence cancels out of the null.

The statistic is the pairwise co-occurrence rate. The empirical p-value is

```
p = (#{permutations with co-occurrence >= observed} + 1) / (permutations + 1)
```

The `+1` smoothing is deliberate: an empirical p-value can never honestly be reported as exactly
zero, because a finite number of draws cannot rule out anything with certainty.

### Resolution limit

`N` permutations cannot resolve a p-value below `1 / (N + 1)`. Reporting power or significance at a
finer alpha produces a structural zero that looks like a failure of the test but is an artifact of
how many draws were taken. The alpha grid is therefore clipped to what the permutation count can
resolve, and the limit is reported.

### What this measures

Statistical dependence. **Not identity.** Two independent people who always agree produce exactly
the same signal as one person holding two keys. This is stated next to every result, because the
difference between those two situations is not recoverable from onchain data and never will be.

---

## 5. Timing dependence

Independent people in different timezones, reading a proposal on their own schedule, produce
broadly independent approval latencies.

**Null:** approval times are exchangeable across transactions. The null distribution is built by
pairing each signer's approval with a different transaction's approval by the other signer, which
destroys any real coupling while preserving each signer's own latency distribution.

### The co-submission artifact filter

Signatures are routinely collected offchain and posted together at execution time. The service then
records identical submission timestamps for several owners, which reads as perfect timing coupling
but is purely an artifact of how the record was written.

Confirmations recorded within 5 seconds of execution are therefore treated as undated rather than
simultaneous. Without this filter the timing test fires on nearly every Safe. On our reference
3-of-8 it removed four findings and left the one supported by co-signing evidence.

### Caveat

Two people on the same video call also sign seconds apart. Tight timing is consistent with one
operator **and** with coordinated humans. This is an indicator, not an identification.

---

## 6. Effective quorum

### Definition

> A **lower bound** on the number of independent decision units required to reach the declared
> threshold, where two signers are placed in the same unit if their co-signing dependence is
> significant at level alpha.

Units are formed by union-find over pairs with `p < alpha` **and positive excess** - signers who
co-sign *less* often than chance are not one party. The bound then assumes the worst case for
decentralisation: the largest units cooperate first.

### Why it is a curve

The answer depends on alpha, so publishing a single number would be unfalsifiable. The report gives
the whole grid:

```
alpha = 0.05     7 independent units  ->  effective quorum 2 of 3
alpha = 0.01     7 independent units  ->  effective quorum 2 of 3
alpha = 0.005    7 independent units  ->  effective quorum 2 of 3
alpha = 0.001    7 independent units  ->  effective quorum 2 of 3
alpha = 0.0005   7 independent units  ->  effective quorum 2 of 3
verdict: robust
```

Stable across three orders of magnitude is a finding. Collapsing only at loose alpha is a flag, and
the report labels it `alpha-sensitive` rather than presenting it as a conclusion.

---

## 7. Calibration

An instrument nobody has characterised the error rate of is not a measurement.

**Negative controls** - synthetic signers drawn under the null: independent, same marginals, same
threshold. Any pair flagged is a false positive by construction.

**Positive controls** - one decision duplicated across two keys that are always present together or
absent together. Detection rate is the statistical power.

| alpha | Family-wise FPR | Detection power |
|---|---|---|
| 0.05 | 5.0 - 7.5% | 100% |
| 0.01 | **0.0%** | 100% |
| 0.001 | **0.0%** | 100% |

*40 trials, 120 transactions, synthetic 3-of-6, 1200 permutations. Family-wise FPR is the chance
that **any** pair in a Safe is falsely flagged, which is the number that matters when reading a
report about one Safe.*

Reproduce: `npm run validate`

---

## 8. Reproducibility

Every report carries a header sufficient to regenerate it:

```
method version    1.0.0
input digest      0x14563c42ea8472cd16720e92b63b35a6
seed              42
permutations      4000 independence, 2000 timing
window            200 executed transactions
sources           safe-transaction-service, rpc-archive-nonce, rpc-state
```

The RNG is a deterministic mulberry32 seeded from the header, so identical inputs produce identical
p-values. The input digest is a SHA-256 over the Safe's owner set, threshold, and the ordered set of
transaction hashes with their approver sets, so any change in the underlying data changes the digest.

---

## 9. Known limitations

1. Transactions executed outside the Safe Transaction Service are absent from the participation
   matrix. Coverage is reported, not assumed.
2. Liveness is bounded by the chains named in the header. A signer active on an unsearched chain
   reads as dark here.
3. Module-executed transactions bypass owner signatures entirely and are out of scope for
   independence testing.
4. Timing dependence cannot distinguish one operator from two people in the same meeting.
5. Independence testing needs history. Fewer than roughly 8 transactions gives a permutation
   distribution too coarse to resolve anything, and the test returns nothing rather than guessing.
6. **Nothing here identifies a person.** Every claim is about the statistical behaviour of keys.

---

## 10. Reading a report responsibly

- Findings ship with the transactions they were computed from. Check the arithmetic.
- An `alpha-sensitive` effective quorum is a prompt to look closer, not a conclusion.
- A dark signer is a question for the team, not an accusation. The most common explanation is that
  nobody has asked them to sign.
- A high co-signing rate with a small transaction count is weak evidence regardless of its p-value.
  Look at `both / n` before reacting to the p-value.
