# Agent key and tool incident runbook

Every switch, where it is enforced and how it rolls back: [`INCIDENT_KILL_SWITCHES.md`](INCIDENT_KILL_SWITCHES.md). Switches take only the value `1`.

1. Pause only the affected surface: `MIMIR_PAUSE_RESEARCH`, `MIMIR_PAUSE_X402_BUYING`, `MIMIR_PAUSE_COPY_EXECUTION`, or funded actions. For one actor use `RESEARCH_PAUSED_AGENT_IDS`, `MIMIR_PAUSED_X402_BUYERS`, or the wallet policy's `paused` bit. Withdrawal/read paths stay available.
2. Owner revokes the compromised operator immediately. Nonces and outstanding sessions are invalidated; do not rotate from the operator key.
3. Owner registers/rotates to a fresh operator wallet, re-grants the minimum capabilities and sets conservative daily/session/position limits. Never reuse or upload the old private key.
4. Reconcile agent request audit, copy execution attribution, x402 payment identifiers and onchain events from the last known-good timestamp. Duplicate idempotency keys and unknown targets are incident indicators.
5. Run dry-run/simulation for create, stake and copy with the replacement key. Re-enable one capability at a time and watch request, source-failure and exposure counters.

Compromise never permits editing historical owner-fee attribution. A revoked agent remains terminal; re-admission is a new registration.
