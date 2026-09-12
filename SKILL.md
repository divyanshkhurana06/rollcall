---
name: rollcall
description: Ask who controls a protocol, whether those signers are independent and awake, and what money sits behind them. Uses The Graph for population and exposure, pays for reports over x402 on Hedera.
---

# Roll Call

Use this skill when a task involves the safety of money held by a protocol contract, a multisig, or
a DAO treasury: "is this protocol's pause key held by anyone awake", "how many independent parties
does it really take to upgrade this", "what changed on this Safe since last month".

## What it answers

| Question | Tool or endpoint | Tier |
|---|---|---|
| Who can change this contract, and could they still reach quorum | `who_controls` / `GET /report` | observed + inferred |
| Days since each signer last signed anything, on any searched chain | `signer_liveness` | observed |
| Do these signers act as one party | `independence_test` | tested, calibrated |
| How many independent parties are really required | `effective_quorum` | inferred, reported as a curve |
| Is the test trustworthy | `method_calibration` | published FPR and power |
| What money sits behind an address across DeFi | `protocol_exposure` | The Graph, standardized, with provenance |
| Which standardized deployments exist and how fresh they are | `standardized_registry` | The Graph |
| What changed since the last attestation | `GET /archive?target=` → `since` | HCS |

## How to run it

MCP over stdio, no keys needed for the core:

```bash
git clone https://github.com/divyanshkhurana06/rollcall && cd rollcall && npm install
npm run mcp
```

Claude Desktop / Cursor config:

```json
{ "mcpServers": { "rollcall": { "command": "npm", "args": ["run", "mcp"], "cwd": "/path/to/rollcall" } } }
```

Or HTTP, hosted: `https://rollcall-pi.vercel.app/api`. Start at `GET /.well-known/x402` for every
resource and its price. Free: `/resolve`, `/quote`, `/protocols`, `/leaderboard`, `/archive`,
`/graph/registry`, `/method/calibration`. Paid: `/report` and `/signal`, over x402 on Hedera testnet
(HBAR or the RCC token), or with a bearer credit token from `POST /subscribe`.

## How to reason with the answers

1. Resolve first. Paste a protocol contract, not a wallet: `/resolve/{chain}/{address}` finds the
   Safe above it. A wallet has nothing to measure.
2. Read the tier before the number. `observed` is chain state. `tested` has a p-value and a null
   hypothesis. `inferred` is the effective quorum curve, and it is a curve over alpha on purpose.
3. Dark does not mean gone. "No onchain signal from this key" is the claim. A dark key on a 2-of-2
   still freezes the contract if it is lost.
4. Exposure decides whether it matters. A dark 2-of-9 over an empty wallet is trivia. Call
   `protocol_exposure` before spending a report.
5. Provenance is not decoration. Every Graph answer carries `deployment` and `indexedBlock`; treat a
   stale block as a stale answer.

## Where the data comes from

- Safe Transaction Service and JSON-RPC for execTransaction calldata and nonces.
- The Graph: a Safe subgraph (executions, approvals, signer activity) and `data/standardized-registry.json`,
  84 Messari standardized deployments across 12 networks verified by `packages/core/test/probe-standardized.ts`.
- Hedera: x402 settlement, HCS attestations on topic `0.0.10392885`, ERC-8004 identity (agent 114).
