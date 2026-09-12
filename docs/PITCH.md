# Live judging brief

Three minutes, then questions. The point is not to explain the system; it is to make one number
land and then survive the questions.

## The three minutes

**0:00** "Base's L1 Portal holds $1.86 billion. It can be upgraded by a 2-of-2 Safe. Margin zero:
one lost key and it can never be upgraded again. No timelock. And neither signer has ever sent a
transaction, so on every block explorer both look dead. Every number I just said was read from
chain state."

**0:30** "Every protocol has a pause button. Roll Call tells you whether anyone is still holding it."
Ask tab. Type "is the Base bridge safe to use?" and let it run: resolve, price, The Graph, x402 on
Hedera, answer. Then "open the full report": the path from the $1.86B to the two people, the
sentences, the grid.

**1:15** "This is not a score. Every number is tiered: observed, tested, or inferred. The independence
test is calibrated and the calibration is public." Point at the tier labels once. Move on.

**1:45** "It is a service agents pay for, in HBAR or in a token with a fee schedule the network
enforces." Report tab, *pay in RCC*. The 402, the settlement, the HCS receipt, on the page.

**2:15** "And it acts." The CRE simulator run: an enclave reads the live Sepolia position, decides
to top up 0.61 vETH, and would have unwound the loan if the market's own governance degraded. "No
price feed reports that."

**2:45** "Forty seven contracts, $4.8 billion. $2.4 billion behind zero margin. Mantle: six of fourteen declared, two really decide, seven dark." Stop.

## The questions

**Isn't this L2Beat?** L2Beat publishes who holds the keys, by hand, and it is excellent. Nobody
publishes whether those people still sign, whether they sign independently, or whether they are
awake. That comes from signature recovery over history, and it is what Roll Call adds. The README
says so in the second paragraph.

**How do I know the effective quorum is not made up?** It is a permutation test with a published
false positive rate: 0% family-wise at alpha 0.01, 100% power, on the calibration endpoint, which
you can run yourself. Every number in the report says which tier it belongs to.

**Dark just means they use a different wallet.** Yes, and the report says "no onchain signal from
this key" rather than "this person is gone". A dark key on a 2-of-2 is still a dark key on a 2-of-2:
if it is lost, the portal is frozen, and nobody can tell from outside.

**Why an enclave?** Publishing the health factor at which you deleverage tells an adversary where
to push the price. Publishing which protocols you distrust is a map of your exposure. Both stay in
the TEE; only the transaction leaves.

**Why Hedera for payments?** Sub-cent fees for sub-dollar reports, a facilitator that co-signs so
the agent never holds gas, native tokens with fee schedules the network enforces, and a consensus
service that gives every report a timestamp nobody can backdate.

**What is blocked?** ATS: the deployed testnet factory exposes no published version's deployBond
selector, proven by reading its dispatch table. The CRE simulator: it was the Bun version, found
and fixed on the last day; deployment access is pending. Both are written up, not hidden.

**Who is the user?** Anyone about to put money behind a protocol, and anyone who insures them.
Before you deposit, is the pause key held by someone awake?

**What would you do next?** Monitor continuously and alert on change, which the HCS archive and the
`since` diff already support. Then the same analysis for timelock proposers and DAO executors.
