# Solana Kit (Web3.js v2)

**Location:** /home/felix/Code/Misc/defi-tracker/onchain/kit  
**Repository:** `anza-xyz/kit` (GitHub)  
**Language:** TypeScript  
**License:** MIT  
**Maintenance:** Very active. Official Anza SDK (successor to @solana/web3.js v1.x). v6.8.0 at snapshot. Comprehensive test coverage. Enforced tree-shaking via build-time checks. Published to npm under `@solana/kit` and subpackages.

## Purpose

Solana Kit is the **official JavaScript SDK for building Solana applications**. It is the v2.x line of what was previously called `@solana/web3.js`, renamed to reflect a complete architectural redesign. The library targets Node.js, web (browser), and React Native environments.

Key differentiator from v1: **tree-shakable, functional (zero-class), composable, zero-dependency**. Total library size is 57.5 KB (minified) vs. 81 KB for v1 — smaller even when you use every feature. Most apps using even a single Kit function see 70–80% bundle size reduction compared to v1.

## Architecture

### Monorepo Structure (57 packages orchestrated by Turborepo)

**Core building blocks:**
- `@solana/errors` — foundational error system (SolanaError class + numeric codes).
- `@solana/codecs-core`, `@solana/codecs-numbers`, `@solana/codecs-strings`, `@solana/codecs-data-structures` — composable encoder/decoder primitives.
- `@solana/addresses`, `@solana/keys` — nominal-type wrappers around branded strings.

**RPC layer** (modules starting with `rpc-`):
- `@solana/rpc` — main entry point; composes subpackages.
- `@solana/rpc-api` — Solana JSON RPC method signatures and types.
- `@solana/rpc-spec-types`, `@solana/rpc-spec` — JSON RPC specification layer.
- `@solana/rpc-transport-http` — HTTP transport (default; easily wrapped/customized).
- `@solana/rpc-subscriptions*` — WebSocket subscriptions (separate from RPC).

**Transaction and account handling:**
- `@solana/transaction-messages` — immutable builder API for transaction messages (no signing yet).
- `@solana/transactions` — compiling, signing, serializing transactions to wire format.
- `@solana/accounts` — fetching and decoding on-chain accounts.
- `@solana/transaction-confirmation` — commitment-aware confirmation polling.

**Top-level facade:**
- `@solana/kit` — re-exports ~20 core packages + adds convenience helpers like `sendAndConfirmTransaction`, `airdrop`, `fetchAddressesForLookupTables`.

### Design Principles

1. **Functional, not OOP.** No classes except `SolanaError`. Methods are pure functions. Eliminates dual-package hazard and enables tree-shaking class methods you don't use.

2. **Composable codecs.** Encoding/decoding is declarative: you compose primitive codecs (u32, u64, string, struct, array, discriminated union, etc.) into higher-level types. This is **not** hand-written Borsh (which Kit doesn't include). The Codama code generator (used by Whirlpool SDK and others) outputs Kit-compatible codecs.

3. **Lazy RPC composition.** RPC calls don't fire immediately. You call `.send()` on an `RpcPlan<T>` to materialize. This lets you compose, inspect, and customize RPC calls before execution. You can wrap the RPC instance in custom transports (e.g., rate-limiting, failover, batching, caching).

4. **Zero dependencies.** Modern runtimes are assumed: native Ed25519 crypto (WebCrypto API), `bigint`, `TypedArray`. No crypto polyfills, no bn.js.

5. **Platform-specific builds.** Artifacts for Node, Browser, React Native. Platform guards (`__NODEJS__`, `__BROWSER__`, `__REACTNATIVE__`) are set at build time and tree-shaken. No dead code shipped.

## Concrete Value for Tax Decoder

### 1. Historical Transaction Fetching

**Canonical path:**
```ts
const rpc = createSolanaRpc(rpcUrl);
const sigs = await rpc.getSignaturesForAddress(walletAddress, { limit: 1000 }).send();
// → readonly { signature: Signature, slot: Slot, blockTime: UnixTimestamp, err: TransactionError | null }[]

for (const { signature, blockTime } of sigs) {
  const tx = await rpc.getTransaction(signature, { 
    encoding: 'json',
    maxSupportedTransactionVersion: 0 
  }).send();
  // → tx includes meta.innerInstructions (CPIs), transaction.message.addressTableLookups (versioned tx)
}
```

**File:** `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/rpc-api/src/getSignaturesForAddress.ts:60-88`  
**File:** `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/rpc-api/src/getTransaction.ts:298-437`

**Details:**
- `getSignaturesForAddress` returns batch of 1–1000 signatures in reverse chronological order. Supports `before` cursor for pagination (call with last sig to continue).
- `before` / `until` sandwich pattern allows resumable iteration through full wallet history.
- `maxSupportedTransactionVersion: 0` tells the RPC "I can handle versioned transactions (with LUTs)." Omit if you only want legacy txs.
- Returns either `'json'` (flat instruction indices), `'jsonParsed'` (RPC-parsed SPL Token instructions), or `'base64'` (wire bytes if you want to decode yourself).

**Rate limits and pagination:** Not enforced by Kit. Public RPCs (Helius, Triton, etc.) rate-limit at 100–1000 req/sec. Plan for backoff + caching. Kit provides no built-in retry loop; it's on us. The example at `packages/kit/src/__tests__/rpc-custom-api-test.ts` shows wrapping the transport in a custom middleware for retry/throttling.

### 2. Versioned Transaction & Address Lookup Table (LUT) Resolution

**Versioned transactions encode dynamic account lists via LUTs.** When an instruction references account index 200, that index might resolve to a static account (in `message.accountKeys`) or to a dynamic account from a LUT (via `message.addressTableLookups[i].writableIndexes` or `.readonlyIndexes`).

Kit provides **first-class LUT support:**

**File:** `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/kit/src/fetch-lookup-tables.ts`  
**File:** `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/kit/src/decompile-transaction-message-fetching-lookup-tables.ts`

```ts
// One-call path to inflate a compiled (versioned) transaction message with real account addresses
const decompiled = await decompileTransactionMessageFetchingLookupTables(
  compiledMessage,
  rpc,
  { commitment: 'confirmed' }
);
// → now decompiled.instructions[i].accounts contains resolved Address[] (not indices)
```

**What we get:**
- `fetchAddressesForLookupTables(lookupTableAddresses, rpc)` — fetches raw LUT account data from the RPC and caches it in a Map.
- `decompileTransactionMessageFetchingLookupTables(compiledMessage, rpc)` — refills a compiled message with `addressesByLookupTableAddress` by calling the above.
- The decompiled message is now human-readable: instruction.accounts are Addresses, not indices.

**How we'll use it:** After fetching a versioned tx with `getTransaction(sig, { encoding: 'json', maxSupportedTransactionVersion: 0 })`, if `tx.message.addressTableLookups` is non-empty, call the above to resolve addresses before passing to `solana-tx-parser-public` (which expects flat, resolved instructions).

### 3. Instruction & Account Decoding (Codecs)

Kit's codec system is **not** a transaction parser. It's a composable encoding/decoding library. You build codecs from primitives:

**Example codec composition:**
```ts
import { getStructCodec, getU32Codec, getUtf8Codec, addCodecSizePrefix } from '@solana/codecs';

type MyInstruction = { name: string; amount: u32 };
const codec = getStructCodec([
  ['name', addCodecSizePrefix(getUtf8Codec(), getU32Codec())],
  ['amount', getU32Codec()],
]);
const bytes = codec.encode({ name: 'test', amount: 42 });
const decoded = codec.decode(bytes);
```

**File:** `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/codecs-core/src/index.ts`

**For tax decoding:** Kit does NOT generate codec from IDL automatically (that's Codama's job). But Codama (used by Whirlpool and Metaplex) **outputs Kit-compatible codecs**. So if we use `@orca-so/whirlpools-client` (Codama-generated), instruction data is decoded via `codec.decode(data)`. We don't roll our own.

**Pattern:** Codama-generated clients export instruction codecs. We reuse those codecs in our decoder rather than hand-writing Borsh layouts.

### 4. Transaction Parsing via solana-tx-parser-public

Kit itself is **not** a transaction parser. The parser is `@debridge-finance/solana-transaction-parser`, which integrates well with Kit:

- Parser accepts Kit-compatible RPC responses (with `meta.innerInstructions` for CPI flattening).
- Parser can load Anchor IDL-generated codecs (Whirlpool, Jupiter, etc.).
- We fetch transactions via Kit RPC, resolve LUTs via Kit's helper, then feed to the parser.

**Integration sketch:**
```ts
import { flattenTransactionResponse } from '@debridge-finance/solana-transaction-parser';

const rpc = createSolanaRpc(rpcUrl);
const tx = await rpc.getTransaction(sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }).send();

// If versioned, resolve LUTs first
let resolvedTx = tx;
if (tx.transaction.message.addressTableLookups?.length > 0) {
  const decompiled = await decompileTransactionMessageFetchingLookupTables(
    compileTransactionMessage(tx.transaction.message),
    rpc
  );
  // Re-bind to response shape
  resolvedTx = { ...tx, transaction: decompiled };
}

const flatInstructions = flattenTransactionResponse(resolvedTx);
// → one flat array of instructions, interleaving outer + CPI instructions
```

### 5. No Transaction Building for Read-Only Decoder

Kit includes `@solana/transaction-messages`, `@solana/transactions`, and `@solana/signers` for **building and signing** transactions. We **do not need these** for a read-only historical decoder:
- No transaction message construction.
- No signing.
- No confirmation loops.

Skip these packages entirely (they won't be imported). Kit is tree-shakable, so unused modules are eliminated.

## V1 → V2 Migration Cost

Our decoder repo may already depend on `@solana/web3.js@^1` or even inherit it transitively (e.g., via `solana-tx-parser-public`, which updated to v2).

**Breaking changes from v1 to v2:**

1. **Classes replaced with functions.** `Connection.getTransaction()` → `rpc.getTransaction().send()`.
2. **Codec system is entirely new.** v1 used Borsh (hand-written layouts); v2 uses composable codecs. No direct backward compatibility, but Codama codecs are v2-native.
3. **Type signatures are stricter.** v2 uses nominal types (branded strings) for Address, Signature, etc. Passing raw strings may fail type-checking.
4. **RPC responses are lazy.** Calling `rpc.getSlot()` returns an `RpcPlan<bigint>`, not `Promise<bigint>`. Must call `.send()` to fire.

**Our migration effort:**

- If we start fresh (greenfield CLI), use v2 from day one. No cost.
- If we port from existing v1 code: ~2–4 hours per RPC-using module to adapt function signatures and add `.send()` calls. Mechanical.
- Whirlpool already supplies v2-compatible SDK (`@orca-so/whirlpools` v7, which requires Kit @^5).

**Recommendation:** Use v2. It's the forward path, smaller bundles, and Whirlpool's new SDK targets it.

## Integration with @orca-so/whirlpools

The **new Whirlpool SDK** (`@orca-so/whirlpools` v7) requires `@solana/kit@^5` as a peer dependency and uses v2 types/codecs throughout:

- `fetchPositionsForOwner(rpc, owner)` expects a Kit Rpc instance and a Kit Address.
- `collectFeesQuote(...)` uses Kit's `@solana/rpc` for account fetching.
- Instruction builders output Kit-compatible `TransactionInstruction[]` objects.

**No conflict.** Both are v2, both tree-shakable. We import from `@orca-so/whirlpools` for convenience methods like `fetchPositionsForOwner`, but for historical tx decoding we use Kit's lower-level RPC + `solana-tx-parser-public`.

## Gaps & Limitations

1. **No built-in transaction parser.** Kit is the transport layer. Parsing (instruction decode, log reconstruction) is `solana-tx-parser-public`'s job. Kit provides the primitives (codecs, RPC fetch, LUT resolution).

2. **No retry/backoff loop.** Kit's transport is simple HTTP. Rate-limiting and retry are on us. The `packages/kit/src/__tests__/rpc-custom-api-test.ts` example shows composing a custom transport, but it's not baked in. We'll wrap the RPC in our own batching/caching layer early.

3. **No built-in signature pagination cursor handling.** `getSignaturesForAddress` accepts `before` but doesn't auto-iterate. We manage pagination state ourselves.

4. **LUT resolution requires extra RPC calls.** Each unique LUT address incurs a `getMultipleAccounts` call. We should cache the result for a given tx batch (e.g., all txs from a block).

5. **No performance guarantees on address-table-lookup deserialization.** If a single tx uses many LUTs, deserialization may be slow. Unlikely in practice for DEX txs, but worth profiling.

## Key Files to Know

### RPC & Transaction Fetching
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/rpc-api/src/getSignaturesForAddress.ts` — signature enumeration with pagination.
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/rpc-api/src/getTransaction.ts` — full transaction fetch with versioning + LUT support.
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/kit/src/fetch-lookup-tables.ts` — LUT account fetching.
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/kit/src/decompile-transaction-message-fetching-lookup-tables.ts` — LUT inflation for versioned txs.

### Codecs
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/codecs-core/src/codec.ts` — base Encoder/Decoder/Codec interface.
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/codecs-core/src/index.ts` — composable codec primitives (struct, array, etc.).

### Examples
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/examples/rpc-custom-api/src/example.ts` — wrapping RPC with custom transport (e.g., custom RPC methods, middleware).
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/examples/deserialize-transaction/` — parsing raw wire bytes.

### Project Documentation
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/CLAUDE.md` — developer guide (testing, error system, conventions).
- `/home/felix/Code/Misc/defi-tracker/onchain/kit/README.md` — high-level overview + tree-shaking stats.

## Patterns Worth Lifting

1. **Lazy RPC composition.** The RpcPlan pattern (call → get a plan → `.send()` to execute) is elegant for composing, caching, and wrapping RPC calls. We'll likely mirror this for our own high-level decoder functions.

2. **Codec composition.** Rather than hand-write Borsh, compose from primitives. If we ever decode programs without IDL, this pattern is the way.

3. **Nominal types for identities.** Kit uses branded strings (`type Address = string & Brand<'Address'>`). We should do the same for TxHash, PositionId, etc., to avoid swapping arguments.

4. **Error codes as numeric constants.** SolanaError system with codes in a central registry. We'll adopt this for our own errors.

## Verdict

| Dimension | Score | Notes |
|---|---|---|
| Direct reuse | 4/5 | RPC fetch functions, LUT helpers, codec composition. We use Kit as the data-fetching layer. Don't use transaction building. |
| Architectural inspiration | 5/5 | Lazy composition, nominal types, error system worth copying. |
| Domain fit | 5/5 | Essential for Solana apps, and our decoder is a Solana app. |
| Maintenance health | 5/5 | Official Anza SDK. Very active. Comprehensive tests, enforced tree-shaking, fast release cycle. |
| **Overall** | **5/5** | Non-negotiable for any Solana CLI. Use v2 (Kit), not v1 (web3.js). Pair with solana-tx-parser-public for instruction decode. |

## Top Files to Read (in order)

1. `/home/felix/Code/Misc/defi-tracker/onchain/kit/CLAUDE.md` — developer orientation.
2. `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/rpc-api/src/getSignaturesForAddress.ts` — wallet signature enumeration.
3. `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/rpc-api/src/getTransaction.ts` — tx fetch with versioning & LUT resolution.
4. `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/kit/src/fetch-lookup-tables.ts` — LUT fetching.
5. `/home/felix/Code/Misc/defi-tracker/onchain/kit/packages/codecs-core/src/codec.ts` — codec interface.
6. `/home/felix/Code/Misc/defi-tracker/onchain/kit/examples/rpc-custom-api/src/example.ts` — custom transport wrapping.
