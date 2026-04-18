# solana-tx-parser-public

**Location:** ~/Code/Misc/onchain/solana-tx-parser-public
**Language:** TypeScript
**License:** LGPL-2.1
**Maintenance:** Maintained by deBridge; published to npm as `@debridge-finance/solana-transaction-parser` (v3.4.1). Audited by Halborn (whitebox pentest PDF included in repo). Active enough for mainstream use; not mega-high-velocity.

## Purpose
A library for decoding arbitrary Solana transactions into a structured list of named instructions with typed arguments and labeled account keys — given an Anchor IDL (or a custom parser) per program. Also parses transaction logs into per-instruction contexts and flattens inner (CPI) instructions.

## Architecture
- `src/parsers.ts` — `SolanaParser` class. Holds a `Map<programId, parser>`. Built-in parsers for SystemProgram, SPL Token, Associated Token, Compute Budget, SPL Token-2022. Given an Anchor IDL it derives a decoder via Anchor's Borsh layout.
- `src/helpers.ts` — `flattenTransactionResponse(tx)` produces a single ordered `TransactionInstruction[]` interleaving top-level ixs with their inner CPI ixs using `meta.innerInstructions`. `parseLogs(logMessages)` reconstructs the invoke/return stack from Solana's program logs and attaches each log line to the originating call.
- `src/decoders/` — hand-written decoders for native system/token programs (they have no IDL).
- `src/programs/` — token-22 extension-aware decoding helpers.
- `src/legacy.idl.converter.ts` — converts old Anchor 0.29-style IDLs to the newer format the parser expects.
- Entry point `src/index.ts` re-exports `SolanaParser`, `flattenTransactionResponse`, `parseLogs`, types.

## Concrete value for our decoder

- **What exactly it decodes:** *only* instructions targeting programIds registered on the parser. Native System/Token/ATA/Compute Budget/Token-2022 are baked in. Everything else requires you to register `{programId, idl}` (for Anchor programs) or a custom `(ix) => ParsedCustomInstruction` function. Unknown instructions come back as `{name: "unknown", programId, accounts, ...}`.
- **Inner instructions / CPIs:** yes, handled via `flattenTransactionResponse`. This is the critical feature for us: Whirlpool is routinely called from Jupiter aggregator routes, DLMM routers, Kamino autocompounders, etc. The flattener splices each `innerInstructions[i]` list in after its parent at position `i`, producing one flat array you can iterate once. It also preserves `callIndex` so you can cross-reference log lines parsed by `parseLogs`.
- **IDL format expected:** Anchor IDL (`Idl` from `@project-serum/anchor` / `@coral-xyz/anchor` ^0.31.1). Old format supported via the included legacy converter. The `@orca-so/whirlpools-sdk` ships its IDL as `dist/artifacts/whirlpool.json` in Anchor 0.32 format — compatible directly. Not a looser "shape-matching" parser — it really wants the Anchor Borsh layout with discriminators.
- **Versioned transactions:** supported; `parseTransactionAccounts` takes `loadedAddresses` from `meta` for LUT-resolved accounts.
- **What we skip by using it:** Helius Enhanced Transactions (paid). We get free, self-hosted decoding of Whirlpool (and any other Anchor program with a public IDL — e.g., Jupiter v6 publishes its IDL on GitHub) off of any plain `getTransaction(sig, {maxSupportedTransactionVersion:0})` response.

## Key files

- `src/parsers.ts` — `SolanaParser.parseTransaction(connection, signature, flatten?)` is the one-shot API.
- `src/helpers.ts` — `flattenTransactionResponse`, `parseLogs`, `compiledInstructionToInstruction`.
- `src/index.ts` — public surface.
- `README.md` — has the exact "init parser with IDL, call parseTransaction" code path we'll mirror.
- `tests/parseTransaction.test.ts` and `tests/parseDlnSrcTransaction.test.ts` — real tx fixtures; good reference for how parsed output looks on complex CPI-heavy txs.

## Integration sketch

In our decoder: on startup, construct one `SolanaParser` seeded with `[{programId: WHIRLPOOL_ID, idl: whirlpoolIdl}, {programId: JUPITER_V6_ID, idl: jupiterIdl}, ...]` plus any other programs we care about (Kamino, Meteora DLMM, Raydium CLMM). For each wallet signature, fetch with `connection.getTransaction(sig, {maxSupportedTransactionVersion:0})`, call `flattenTransactionResponse(tx)`, then map each instruction through `parser.parseInstruction(ix)`. Pair Whirlpool instructions with adjacent SPL-Token `transferChecked` ixs (which the parser also decodes) to extract actual token amounts, then classify into tax events. The `parseLogs` helper is optional — useful if we need Whirlpool's `PriceChange` events or error diagnostics for a given instruction, but for basic amount extraction the inner-instruction transfers are enough.

## Gaps

- Doesn't know about non-Anchor programs unless you write a custom parser (fine — we're Anchor-only for now).
- LGPL-2.1 — we're in a CLI context, so static linking is OK, but worth flagging if we ever want to ship a closed-source distribution. For Felix's personal/open use: non-issue.
- Doesn't do the USD pricing, classification, or persistence (obviously).
- Anchor dep is `^0.31.1` while Whirlpool is 0.32. Usually IDL parsing works across minor versions but we should pin and test.

## Rating

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Direct reuse | 5/5 | Drop-in npm package; single purpose we need. |
| Architectural inspiration | 4/5 | CPI flattening + log stack reconstruction are both patterns we'd otherwise have to invent. |
| Domain fit | 5/5 | Purpose-built for our exact use case. |
| Maintenance health | 4/5 | Actively maintained, audited, v3.x, but not as hot as first-party Orca. |
| **Overall** | **5/5** | Combined with the Whirlpool IDL, this replaces Helius Enhanced Transactions. |

## Top files to read

1. `src/parsers.ts`
2. `src/helpers.ts` (especially `flattenTransactionResponse` L87 and `parseLogs` L143)
3. `tests/parseDlnSrcTransaction.test.ts`
4. `README.md`
5. `src/legacy.idl.converter.ts` (if we hit IDL-format mismatches)
