# v3-subgraph

**Location:** ~/Code/Misc/onchain/v3-subgraph
**Language:** AssemblyScript (subgraph mappings) + GraphQL SDL
**License:** GPL-3.0 (see LICENSE)
**Maintenance:** Actively maintained by Uniswap Labs (recent commits 2026). Multi-chain template covering Base among others.

## Purpose
The official Uniswap V3 subgraph source. Defines every entity exposed by the hosted subgraph we'd query instead of (or alongside) raw log decoding. We cloned it to see the full schema and event-handler logic so we know exactly what's queryable and how derived fields are computed.

## What it gives us
- `src/v3/schema.graphql` — complete entity list for the v3 subgraph:
  - **Core:** `Factory`, `Bundle` (ETH price USD), `Token`, `Pool`, `Tick`
  - **Per-tx events (immutable):** `Transaction`, `Mint`, `Burn`, `Swap`, `Collect`, `Flash`
  - **Time series:** `UniswapDayData`, `PoolDayData`, `PoolHourData`, `TokenDayData`, `TokenHourData`
  - Note: the v3-subgraph schema here does NOT include a `Position` entity — that lives in the separate "uniswap-v3-positions" subgraph (which the `uni-v3-position-tracker` references). This repo covers swap/mint/burn/collect flow; positions are a sibling subgraph.
- `src/v3-tokens/schema.graphql` — simpler per-token analytics.
- `abis/` — shipped JSON ABIs: `factory.json`, `pool.json`, `NonfungiblePositionManager.json`, `ERC20.json`, `ERC20NameBytes.json`, `ERC20SymbolBytes.json`. These we can use directly with viem.
- `config/` — per-network configuration (Base included), includes factory addresses and start blocks — useful bootstrap data for multi-chain.
- Mapping sources in `src/v3/` show exactly how `feesUSD`, `volumeUSD`, `tick`, `sqrtPrice` are computed from raw events — authoritative reference for subgraph-derived numbers.

## How we'd use it in our decoder
- Point our GraphQL client at the Base Uniswap V3 subgraph endpoint and query `Mint`, `Burn`, `Collect`, `Swap` filtered by `origin` (the EOA) or `owner` — this gives us pre-indexed tx-level position events without running our own indexer.
- Query `Token` for `decimals`, `symbol`, `derivedETH`, and `tokenDayData.priceUSD` for USD valuation at event time.
- Use shipped `abis/NonfungiblePositionManager.json` and `abis/pool.json` directly with viem — no need to compile v3-periphery.
- Fall back to this repo's mappings to verify how a field (e.g. `feesUSD`) is derived before trusting it for tax purposes.

## Key files
- `~/Code/Misc/onchain/v3-subgraph/src/v3/schema.graphql` — full GraphQL SDL (entity list above)
- `~/Code/Misc/onchain/v3-subgraph/abis/NonfungiblePositionManager.json` — NPM ABI JSON (drop straight into viem)
- `~/Code/Misc/onchain/v3-subgraph/abis/pool.json` — V3 Pool ABI (Swap, Mint, Burn, Collect, Initialize events)
- `~/Code/Misc/onchain/v3-subgraph/abis/factory.json` — Factory (PoolCreated event)
- `~/Code/Misc/onchain/v3-subgraph/config/` — per-network config (Base factory address, start block)
- `~/Code/Misc/onchain/v3-subgraph/src/v3/utils/pricing.ts` (AssemblyScript) — reference USD pricing logic

## Gaps
- No `Position` entity in this schema — we need the separate positions subgraph (or compute position state ourselves from Mint/Burn/Collect events + NPM `positions()` view).
- Hosted-subgraph rate limits and decentralized-network billing (GRT) are real; relying solely on the subgraph is risky.
- Per-event USD values are derived from whitelisted pool pricing which can be wrong for thin tokens — we should cross-check against a dedicated price oracle for tax valuation.
- Subgraph data lags the chain tip by ~1 block; fine for tax but not for live positions.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse (artifacts: ABIs, TS types, schemas) | 5/5 | ABIs + schema both ship; both directly usable. |
| Code pattern inspiration | 4/5 | Authoritative pricing/fee derivation in AssemblyScript. |
| Domain fit (Base chain specifically) | 5/5 | Base is a first-class network in `config/`. |
| Maintenance health | 5/5 | Actively maintained. |
| **Overall** | **5/5** | Biggest single source of free indexed data. |
