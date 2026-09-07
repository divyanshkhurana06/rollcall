# Chainlink CRE Confidential Workflows

Two workflows. Both put the sensitive half of the decision inside an AWS Nitro enclave and let only
a verdict cross back to the DON for consensus.

```bash
cre login                                              # once, interactive
cd cre
cre workflow simulate control-surface-watch  --target staging
cre workflow simulate liquidation-protection --target staging
```

Tests run without auth or network:

```bash
cd cre/liquidation-protection && bun test    # 14 pass
cd cre/control-surface-watch  && bun test    # 11 pass
```

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

Protects a virtual ETH-collateral / USDC-debt position through market movement, with private rules.
That is the challenge spec, implemented in full: it avoids liquidation, repays the minimum that
restores the target rather than closing the position, and never spends more emergency capital than
it has.

**What Roll Call adds is a second trigger no liquidation protection has.** Every existing system
watches one variable: price. But a position becomes unsafe for reasons that never touch a price
feed. If the market's control surface loses quorum, or its signers turn out to be one party wearing
several hats, the people who can pause, upgrade or seize that market are not who you thought, and
the correct response is to de-risk no matter how healthy the health factor looks.

```
MARKET      health factor approaches the private intervention point   -> deleverage
GOVERNANCE  the control surface degrades past a private bound         -> de-risk regardless
```

Four of the fourteen tests exist only to prove the second trigger fires on a position that is
perfectly healthy by every market measure.

### Why the enclave is load bearing, not decorative

A protection strategy is front-runnable in both directions. Publishing the health factor at which
you deleverage tells an adversary where to push the price to force your hand. Publishing your
emergency capital tells them how far they can push before you run out. The governance bounds are
worse: they are a map of which protocols you have decided you do not trust.

What crosses to the DON is an action code, a size, and a commitment. Not the thresholds, not the
position, and deliberately not the reason - because the reason names which rule fired.

`LiquidationProtectionConsumer.sol` contains no health factor, no thresholds, no capital balance and
no rule identifier. An observer learns that a position was defended and by how much, which the
transfer would have told them anyway.

## Strategy evidence

`npm run protect` (from the repo root) runs the same decision function over generated price paths,
so the strategy can be judged on what it achieves rather than on whether it compiles:

```
path          unprotected    protected    actions  capital used  equity kept
crash         LIQUIDATED     LIQUIDATED   2        $8000         $0
grind down    LIQUIDATED     open         2        $8000         $5167
whipsaw       survived       open         1        $6686         $12354
recovery      LIQUIDATED     open         2        $8000         $14595
```

The crash path still liquidates. $8,000 of emergency capital cannot rescue $18,000 of debt against a
sustained collapse, and reporting four out of four would have meant tuning the parameters until the
number looked good.
