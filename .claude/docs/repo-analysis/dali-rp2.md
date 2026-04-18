# dali-rp2

**Location:** ~/Code/Misc/onchain/dali-rp2
**Language:** Python
**License:** Apache 2.0
**Maintenance:** Last commit 2025-11-17 (README badge). Core development has slowed.

## Purpose
Data loader and pair converter framework for RP2. Loads transaction data from exchange APIs/CSV files via plugins, resolves prices, and outputs ODS files consumable by the RP2 tax engine.

## Architecture
- **Entry point:** `dali_main.py::_dali_main_internal()` reads an INI config file, dynamically loads input plugins and pair converter plugins, runs them in parallel, resolves transactions, generates ODS output
- **Plugin dispatch:** INI section names are fully-qualified Python module paths (e.g., `dali.plugin.input.csv.coinbase`). `import_module(section_name)` loads the module, looks for `InputPlugin` or `PairConverterPlugin` class, validates constructor parameters against INI config values
- **Input plugin interface:** `abstract_input_plugin.py::AbstractInputPlugin` -- `load(country) -> List[AbstractTransaction]` is the sole required method. Plugins also get caching for free via `cache_key()`
- **Pair converter plugins:** `abstract_pair_converter_plugin.py` -- resolve historical prices via CCXT, Coinbase, or CSV. Optimized with a `TransactionManifest` that batches price lookups
- **Transaction types:** `in_transaction.py`, `out_transaction.py`, `intra_transaction.py` -- mirror RP2's three-type model
- **Transaction hints:** INI `[transaction_hints]` section allows manual overrides: `<tx_hash> = <direction>:<type>:<notes>`
- **Input plugins are external packages:** The `plugin/input/` directory is empty (just `__init__.py`). Actual exchange plugins (Coinbase, Kraken, Binance, etc.) are separate pip-installable packages that conform to the `AbstractInputPlugin` interface
- **Built-in pair converters:** CCXT variants (Kraken, Binance, Coinbase Pro), exchangerate.host, fiat-from-CSV

## What to steal / reuse
- **INI-based plugin dispatch** in `src/dali/dali_main.py` lines 99-156: section names as module paths, `import_module()` loading, constructor signature validation. Clean pattern for a TypeScript equivalent using dynamic imports
- **Transaction hint system** in `src/dali/dali_main.py` lines 320-364: `<hash> = in:interest:Aave interest` -- manual override mechanism for transactions the decoder can't classify automatically
- **Plugin caching pattern** in `src/dali/abstract_input_plugin.py` lines 39-59: `cache_key()` + `load_from_cache()` / `save_to_cache()` -- avoids re-fetching exchange data during development
- **ThreadPool parallel loading** in `src/dali/dali_main.py` line 167: `pool.map(_input_plugin_helper, input_plugin_args_list)` -- simple parallel plugin execution

## What to learn from (architectural inspiration)
- **Module-path-as-plugin-ID:** Using fully-qualified module names as INI section keys means the plugin registry is implicit -- no central registry file to maintain. In TypeScript, this maps to dynamic `import()` with convention-based paths
- **Separation of data loading from tax calculation:** DaLI handles all the messy exchange/chain parsing, RP2 handles all the tax math. Clean boundary
- **Transaction manifest for price batching:** `TransactionManifest` collects all (asset, timestamp) pairs before hitting price APIs, enabling batch optimization
- **Configuration-driven plugin instantiation:** Constructor parameters are type-checked against the plugin's constructor signature at load time

## Gaps for our use case
- **No on-chain decoders:** All input plugins parse exchange CSV/API exports. No Ethereum event log parsing, no Solana instruction decoding, no Sui Move events
- **No DeFi protocol support:** No handlers for Uniswap, Orca, Aave, Aerodrome, etc.
- **Empty plugin directory:** Actual exchange plugins must be installed separately, making evaluation harder
- **Python-specific dispatch:** The `import_module()` pattern works well in Python but TypeScript equivalent needs different approach (e.g., barrel exports, dynamic import map)
- **No German jurisdiction:** Country plugins in the companion RP2 repo don't include Germany

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Code reusability | 2/5 | Python-specific dispatch; plugins are external packages |
| Architectural inspiration | 4/5 | Plugin dispatch, transaction hints, price batching patterns are excellent |
| Domain fit | 1/5 | Exchange-only, no on-chain DeFi support |
| Maintenance health | 2/5 | Development has slowed significantly |
| **Overall** | **2/5** | **Good plugin architecture reference, poor domain fit** |

## Top 3 files to read
1. `src/dali/dali_main.py` -- Plugin loading/dispatch via import_module(), transaction hint validation, parallel execution
2. `src/dali/abstract_input_plugin.py` -- Plugin interface: load(), cache_key(), the contract each plugin must implement
3. `src/dali/transaction_resolver.py` -- Transaction resolution pipeline: how raw plugin output gets normalized
