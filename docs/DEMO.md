# Demo commands

Every scene is one command against live testnets. Nothing is mocked; run them in this order and
the later ones are faster because the earlier ones warmed the caches.

```bash
# the hosted stack: web and API on one domain
open https://rollcall-pi.vercel.app
curl -s https://rollcall-pi.vercel.app/.well-known/x402 | jq '.identity, .resources | length'

# 0. from the hosted page alone: Ask tab, type "is the Base bridge safe to use?", watch the five steps
#    then Report tab, "pay in RCC", then Enclave tab

# 1. the protocol scan: who controls the protocols, and what they hold
npm run scan:protocols

# 2. one Safe, in the terminal, every number tiered
npm run report -- 0xBb4716A4A47342aAd4f162ebc34AF8414360Cdc5

# 3. an agent pays for a report over x402 on Hedera, in HBAR, then in the HTS token
npm run agent
npm run agent -- 0x97cd81555F18d612C02FC4468118C48adD9f1245 ethereum --asset=rcc

# 4. prepaid credits, and a renewal the network executes on its own clock
npm run agent:subscribe -- 5
npm run agent:schedule -- 5 90
curl -s http://localhost:8787/renewals/<scheduleId>

# 5. the archive: what changed since the last attestation
curl -s "http://localhost:8787/archive?target=0x97cd81555F18d612C02FC4468118C48adD9f1245" | jq .since

# 6. the enclave: the liquidation workflow in the CRE simulator, against the live Sepolia position
cd cre && cre workflow simulate ./liquidation-protection --target staging-settings -e .env --trigger-index 0 && cd ..

# 7. the five published scenarios, and the trigger nobody else has
npm run protect

# 8. the live challenge position
npm run challenge -- status

# 9. the harness: doctor before and after, one script
bash docs/harness-contribution/demo.sh
```

Expected shapes: scene 3 prints `PAID AND SERVED`, a transaction id, and an HCS sequence number.
Scene 6 ends with `Workflow execution finished successfully` and a JSON result with `hf`, `deposit`
and `repay`. Scene 7 prints five `survived` rows against five `LIQUIDATED` rows.
