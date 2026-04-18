# Architectural notes from rotki

Observations that should influence our tax decoder design.

1. **Single `history_events` table with `entry_type` discriminator (good).** All events -- EVM, Solana, off-chain -- share one table. Extension tables (`chain_events_info`, `eth_staking_events_info`) add chain-specific fields via FK. This avoids N separate event tables. We should do the same in SQLite.

2. **`group_identifier` + `sequence_index` for tx grouping (good).** A Uniswap LP add produces 3+ events in one tx. Grouping by tx hash + chain ID, then ordering by sequence index, keeps multi-event operations queryable. Our schema needs this -- it replaces "one row per trade" with "one group per operation."

3. **Type x Subtype matrix instead of a single enum (good).** `HistoryEventType` (20 values) x `HistoryEventSubType` (40+ values) gives ~800 possible combinations but they validate only ~150 legal pairs. This is more expressive than a flat enum and lets tax rules pattern-match on type alone (e.g., all `TRADE` types are taxable events).

4. **Decoder registry with three phases (good).** Address-specific rules fire first (cheap, O(1) lookup), then generic rules iterate all logs, then post-decoding rules aggregate (e.g., collapsing multi-hop router swaps). Our handler pipeline should have the same phases.

5. **Protocol inheritance for forks (good).** Aerodrome = 51-line subclass of Velodrome (569 lines). This is how we should handle protocol forks -- base class does the real work, fork class just configures addresses and constants.

6. **Haltefrist is a setting, not hardcoded (good).** `taxfree_after_period` is a user-configurable integer (seconds). Germany = `YEAR_IN_SECONDS`, other jurisdictions can set different values or `None` to disable. We should parameterize this too, not hardcode 365 days.

7. **Cost basis uses a priority heap with strategy pattern (good).** `BaseCostBasisMethod` has a `processing_iterator()` that yields acquisitions in method-specific order. FIFO increments priority, LIFO decrements. Clean and extensible. Our TS implementation should use the same abstraction.

8. **`counterparty` as a string, not an enum (debatable).** Protocol identifiers like `"uniswap-v3"` are plain strings validated only at decode time. This makes the system extensible but loses compile-time safety. For our TypeScript project, we should use a string union type (`type Counterparty = 'uniswap-v3' | 'aerodrome' | ...`) for the best of both worlds.

9. **No Sui, minimal Solana DeFi (bad for us, instructive).** Rotki's Solana support covers only swaps (Jupiter) and staking (Jito). Zero LP position tracking. Zero Sui. This confirms we cannot shortcut by forking -- our value-add is exactly the non-EVM coverage rotki lacks.

10. **Gevent/greenlet concurrency model (bad for us).** Rotki uses cooperative multitasking via gevent throughout. This is deeply embedded and not something we'd want in a TypeScript CLI. Confirms the "learn, don't fork" approach.
