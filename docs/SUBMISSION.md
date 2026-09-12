# Submission text

Paste-ready for the ETHGlobal form. Category: Security. Partners: Hedera, Chainlink, The Graph.

## One line

Every protocol has a pause button. Roll Call tells you whether anyone is still holding it.

## Description

Every protocol has a pause button, an upgrade path, a multisig. Almost none can tell you whether
anyone is still holding it. Roll Call derives that from onchain history instead of reading the
claim.

Paste a protocol contract. Roll Call resolves the Safe above it, recovers which owners actually
signed each transaction from the execTransaction calldata, tests whether those signers act
independently or as one party, dates every signer's last onchain signal, and reads what the
contract holds. Out comes the number that matters: the honest quorum, which is how many independent,
awake parties are really required to move the money, against the threshold the protocol declares.

Base's L1 Portal holds $1.86B. It can be upgraded by a 2-of-2 whose margin is zero, with no
timelock, and neither signer has ever sent a transaction, so both look dormant on every block
explorer. Every number in that sentence was read from chain state. Across 47 protocol contracts
worth $4.82B, $2.38B sits behind a signer set with zero margin, and $431M sits behind a Safe whose
honest quorum is below what it declares: Mantle says 6 of 14, resolves to 2, and 7 of its signers
have shown no onchain signal in 180 days.

Every number carries its tier: observed (read from chain), tested (a calibrated permutation test
with a published false positive rate), or inferred (the effective quorum curve). Nothing is a made
up score. The calibration endpoint is public so the metrics can be checked, not trusted.

Ask it a question. "Is the Base bridge safe to use?" and an agent resolves the contract to its keys,
prices the report, reads what money sits behind those keys through The Graph, pays for the report
over x402 on Hedera with its own wallet, and answers in plain English from the numbers, with every
step on screen. Every report also comes back as sentences, one per number, tier named.

It is a service agents can pay for. Reports are priced by the work they take and settled over x402
on Hedera in HBAR or in an HTS token with a real fee schedule; prepaid credits and Scheduled
Transaction renewals cover the runtimes that cannot sign. Every delivered report is attested to
HCS, and that archive is what makes "two of these signers had already been dark for 300 days" a
provable statement later. Roll Call is registered as an ERC-8004 agent on Hedera and Sepolia and
publishes a discovery manifest.

Two Chainlink CRE Confidential Workflows turn the measurement into action inside an enclave: one
watches a private list of protocols and reports breaches, the other defends a live lending position
in the official liquidation protection challenge on Sepolia, with a trigger no other protection has:
if the market's own control surface degrades, it de-risks regardless of the price. Both run end to
end in the CRE simulator against the live contract.

The Graph carries the population: a subgraph of Safe executions and approvals, and a registry of 84
verified Messari standardized deployments across 12 networks queried with one query string, each
answer stamped with its provenance.

## Links

- Live: https://rollcall-pi.vercel.app
- Repo: https://github.com/divyanshkhurana06/rollcall
- Hedera Harness PR: https://github.com/hedera-dev/hedera-harness/pull/53
- Harness before/after video (3 min): https://drive.google.com/file/d/1cqjV9rzSAkYKB_b_eQtC0rDgDpGZ_vvM/view?usp=sharing

## How it's made

The load-bearing primitive is signature recovery. A Safe's execTransaction calldata carries a packed
signature blob; Roll Call splits it by v-type (contract signature, approved hash, eth_sign, EIP-712),
recovers each signer against the transaction's safeTxHash, and reconstructs who approved what,
including nonce-zero signers that no explorer shows. Validated at 100% on every recoverable
transaction in the test set.

Independence is a permutation test: for each pair of owners, the observed co-signing count against a
null that preserves the threshold (Efraimidis-Spirakis weighted sampling), with a co-submission
artifact filter, and an empirical p-value with +1 smoothing. The alpha grid is clipped to what the
sample can resolve. Calibration is run against synthetic signer sets and published: 0% family-wise
false positives at alpha 0.01, 100% power.

Liveness is a binary search on eth_getTransactionCount over block history, with an explicit
indeterminate state when the search hits a provider limit, never a silent "never signed". Authority
resolution walks EIP-1967 slots, Ownable, and AccessControl role grants, and time to harm comes from
timelock delays.

Hedera: x402 v2 with strict PaymentRequirements through the Blocky402 facilitator, two settlement
assets (HBAR and RCC, an HTS token with a 2% fractional fee schedule), a bearer credit store bought
over x402, renewals by Scheduled Transaction verified on the mirror node, HCS attestations that
double as the shared signal cache, and ERC-8004 registration. The Hedera Harness got a PR: doctor
now verifies operator credentials against the network.

Chainlink: two Confidential Workflows on the TypeScript SDK. The liquidation workflow is written in
the challenge contract's own integers, walked through the five published scenarios under both
orderings of price update and liquidation check, with one engine that runs inside the enclave, from
a laptop, and against an in-memory model of the contract in tests. The simulator blocker turned out
to be the Bun version the SDK bundles with, isolated by reinstalling the old one and reproducing the
trap.

The Graph: a Safe subgraph in Studio, the Messari standardized deployments probed into a registry
with per-deployment provenance, and an MCP server so agents can ask the same questions.

Hosted on Vercel, web and API on one domain. Everything is testnet.
