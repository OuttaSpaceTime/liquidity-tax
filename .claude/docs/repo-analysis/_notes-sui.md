# Sui Decoder Notes

## Difficulty Assessment

- **Sui structured events are genuinely easier than raw EVM log decoding.** Sui's `showEvents: true` returns pre-parsed JSON with typed fields. No ABI decoding, no topic hashing, no manual hex parsing. This is a real advantage.

- **No prior-art tax decoder exists for Turbos, Navi, or Suilend.** Every protocol handler must be built from scratch. No Sui equivalent of solana-tx-parser-public or ethereum-etl with DeFi protocol awareness.

- **Canonical Sui ingest path: wallet address -> `suix_queryTransactionBlocks` (by sender) -> for each tx, `sui_getTransactionBlock` with `showEvents: true` -> filter events by known protocol package IDs -> parse `parsedJson` payloads using event type definitions.**

- **sui-events-indexer collapses the type generation and scaffolding work** but NOT the semantic interpretation work. Run it against Turbos/Navi/Suilend package IDs to auto-generate TypeScript event types and a Prisma schema skeleton. Saves perhaps half a day across all three protocols.

- **sui-tx-explainer does NOT collapse meaningful work.** It's a shallow generic explainer that doesn't decode protocol-specific events or Move call arguments.

- **The haSUI liquid staking loop (deposit haSUI -> borrow SUI -> stake to haSUI -> deposit again) is the hardest semantic challenge.** No SDK models this pattern. Must be detected by analyzing sequential events within a single ProgrammableTransaction block -- look for interleaved DepositEvent + BorrowEvent + haSUI stake calls in the same tx digest.

- **Suilend has the best event documentation** via its Move source. 9 event types with clear field definitions. Navi's Move source is NOT in our repos -- event schemas must be discovered via bytecode disassembly (sui-events-indexer) or by inspecting actual transactions.

- **One-day spike estimate: realistic for one protocol (Turbos, since we already analyzed the SDK), tight for two, not realistic for all three plus haSUI loops.** More realistic: 1 day Turbos, 1 day Navi basic (deposit/borrow/repay), 0.5 day Suilend basic, 0.5 day haSUI loop detection = 3 days minimum for production quality.

- **Alternative fast path for Navi: `getUserRewardHistory()` in navi-sdk hits Navi's HTTP API.** If this API returns sufficient historical data, it could shortcut the reward claim decoding. But it's centralized and may not cover all action types we need.

## Summary Verdict

Sui is **slightly easier than EVM for the low-level mechanics** (structured events vs. ABI-encoded logs) but **harder at the ecosystem level** (zero prior art, fewer tools, smaller community). Net assessment: **roughly equal difficulty to EVM**, with the work shifted from "parsing bytes" to "discovering and interpreting protocol-specific event semantics from scratch."
