# weaverfi

**Location:** ~/Code/Misc/defi-tracker/onchain/weaverfi
**Language:** TypeScript
**License:** MIT
**Maintenance:** Last commit 2023-10-22 ("Added POOL token on Optimism"). **Project is dead** -- no activity in over 2 years.

## Purpose
Multi-chain DeFi portfolio tracker NPM package. Queries wallet balances across DeFi protocols on 8 EVM chains: Ethereum, BSC, Polygon, Fantom, Avalanche, Cronos, Optimism, Arbitrum. Supports ~60 protocols (Aave, Beefy, Curve, Uniswap/Sushiswap, Yearn, Compound, Cream, Venus, etc.).

npm package: `weaverfi` (v1.38.1).

## Architecture
```
src/
  index.ts              # Main export: WeaverFi object with per-chain functions
  types.ts              # Chain, Token, TokenType, TokenStatus type system
  chains.ts             # Chain definitions (8 EVM chains only)
  functions.ts          # Core EVM utilities (multicall, token queries, gas estimation)
  chain-functions.ts    # Per-chain query orchestration
  project-functions.ts  # Per-project balance query abstraction
  project-lib.ts        # Project registration
  prices.ts             # Token price fetching (CoinGecko, 1inch, Paraswap)
  ABIs.ts               # Common EVM ABIs
  projects/
    eth/                # ~12 Ethereum protocols
    bsc/                # ~10 BSC protocols
    poly/               # ~5 Polygon protocols
    avax/               # ~12 Avalanche protocols
    ftm/                # ~5 Fantom protocols
    op/                 # ~2 Optimism protocols
    arb/                # ~3 Arbitrum protocols
    cronos/             # ~2 Cronos protocols
```

## Concrete value for our decoder

**Near zero.** WeaverFi is EVM-only with no Sui support whatsoever.

The `Chain` type is literally: `'eth' | 'bsc' | 'poly' | 'ftm' | 'avax' | 'cronos' | 'op' | 'arb'`. All chain functions are ethers.js-based with EVM-specific patterns (multicall, ABI encoding, etc.).

The one mildly interesting pattern is the project registration architecture:
- Per-chain directories with per-protocol files
- Each protocol handler exports standardized balance query functions
- Central `project-lib.ts` registers protocols and dispatches queries

But this pattern is straightforward enough to reinvent and would need complete rethinking for Sui's object model anyway.

**Cannot import as npm dep** for Sui work. Dependencies are entirely EVM: ethers.js v5, ethereum-multicall.

## Integration sketch
Not worth integrating. If we wanted cross-chain abstraction, we'd design our own type system for Sui + EVM from scratch. The EVM-specific assumptions (contract ABI calls, multicall batching, ethers.js providers) are too deeply embedded to adapt.

## Gaps
- No Sui support at all
- EVM-only type system and infrastructure
- Dead project (2+ years no commits)
- ethers.js v5 (outdated; v6 is current)
- No transaction decoding -- only current balance reads

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 1/5 | EVM-only, completely incompatible with Sui |
| Architectural inspiration | 2/5 | Per-chain/per-protocol pattern is obvious but the type system doesn't translate |
| Domain fit | 1/5 | Zero Sui coverage |
| Maintenance health | 1/5 | Dead since October 2023 |
| **Overall** | **1/5** | **No value for Sui decoder. Skip.** |

## Top 3-5 files to read
- `/home/felix/Code/Misc/defi-tracker/onchain/weaverfi/src/types.ts` -- Type system for multi-chain DeFi (EVM-only, but shows the pattern)
- `/home/felix/Code/Misc/defi-tracker/onchain/weaverfi/src/index.ts` -- Main API surface, per-chain dispatch
- `/home/felix/Code/Misc/defi-tracker/onchain/weaverfi/src/project-functions.ts` -- Per-protocol query abstraction (architectural reference only)
