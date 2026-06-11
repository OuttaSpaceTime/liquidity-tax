# Sui event-type discovery — Turbos, Navi, Suilend (U0 spike, [1C.1])

Date: 2026-06-11. **This document is canonical for Sui event names, counts, and
package IDs** — it supersedes the inferred/estimated event lists in
`.claude/docs/repo-analysis/*` and the draft issues in planning doc 03.

Generated TypeScript interfaces: `src/types/turbos-events.ts`,
`src/types/navi-events.ts`, `src/types/suilend-events.ts`.

## Method

Mirrors `onchain/sui-events-indexer`'s bootstrap pipeline (the tool itself was
not run; its approach was reimplemented against current RPC):

1. `sui_getObject(packageId, { showContent: true })` → disassembled bytecode →
   regex `event::emit<T>` per module (eventExtractor.ts pattern).
2. `sui_getNormalizedMoveModulesByPackage(packageId)` → struct field names +
   Move types for every emitted event.
3. `suix_queryEvents` sampling (`MoveModule` and `MoveEventType` filters)
   against mainnet to confirm **defining package IDs** in real `SuiEvent.type`
   strings and the actual `parsedJson` rendering. All sampled txs are foreign
   (other users') — own wallet history was not yet ingested (`raw_txs` empty
   at spike time). Suilend definitions additionally verified against published
   Move source in `onchain/suilend/contracts/`.

## Key mechanics (apply to all three protocols)

### Defining-ID semantics (critical for matching)

Sui type identity uses the package version where the struct was **first
defined**. After upgrades, `SuiEvent.type` keeps the *original* address for v1
events and carries *later version* addresses for events added in upgrades. The
same tx can mix both — observed on a single Turbos collect tx:

```
0x91bfbc…(v1)::position_manager::DecreaseLiquidityEvent
0xa5a0c2…(current)::pool::CollectEventV2
```

Consequences:

- **Match events by full type string against the defining ID** (constants in
  the generated files), never against "the" package ID.
- **Query events with the *current* package ID** — `MoveModule` filters on the
  original package return nothing for recent emissions (confirmed: Suilend
  `MoveModule(original, reserve)` → 0 results; `MoveModule(current,
  lending_market)` → full stream).
- For the planned per-wallet ingest ([1C.2]: `suix_queryTransactionBlocks` by
  `FromAddress` → `sui_getTransactionBlock({ showEvents: true })`), filtering
  happens client-side on `event.type`, so only defining IDs matter there.

### parsedJson rendering rules (what the interfaces model)

| Move type | parsedJson |
|---|---|
| `u64` / `u128` / `u256` | decimal **string** |
| `u8` / `u16` / `u32` | **number** |
| `bool` | boolean |
| `address`, `0x2::object::ID` | `"0x…"` string |
| `0x1::string::String`, `0x1::ascii::String` | plain string (Navi coin types have **no `0x` prefix**) |
| `0x1::type_name::TypeName` | `{ name: string }` (**no `0x` prefix** on name) |
| Turbos `i32::I32` | `{ bits: number }` — two's-complement u32; decode `bits >= 2**31 ? bits - 2**32 : bits` |
| Suilend `decimal::Decimal` | `{ value: string }` — 1e18 fixed-point (WAD) |
| `vector<T>` | `T[]` |

## Turbos CLMM

| | Package ID |
|---|---|
| v1 / original (defining ID for most events) | `0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1` |
| current published (defining ID for V2/NFT events; use for queries) | `0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64` |

39 distinct module-qualified event structs across both versions (v1: 22,
current: 34, overlap 17). The repo-analysis estimate of "~10–15" was low.
Tax-relevant set (17 typed in `turbos-events.ts`):

- `pool::MintEvent` *(v1)* + `position_manager::IncreaseLiquidityEvent` *(v1)* — emitted together on add-liquidity (confirmed tx `Dns61fpzYCKWvJ1dchKdjW6AhLCp2x3F2tzS7ynQTQMQ`). MintEvent has owner/ticks; IncreaseLiquidityEvent only pool+amounts.
- `pool::BurnEvent` *(v1)* + `position_manager::DecreaseLiquidityEvent` *(v1)* — remove-liquidity.
- `pool::SwapEvent` *(v1)* — swaps; multi-hop routes emit one per pool.
- Fee collection: historical txs emit `pool::CollectEvent` + `position_manager::CollectEvent` *(both v1)*; current txs emit `pool::CollectEventV2` *(current pkg, adds `owner`)*.
- Reward collection: historical `pool::CollectRewardEvent` + `position_manager::CollectRewardEvent` *(v1)*; current `pool::CollectRewardEventV2` *(current pkg, adds `owner` and `reward_type`)*. **A decoder must handle both generations — the owner's 2023–2024 positions will have v1 events.**
- Position lifecycle / `positionId`: `position_manager::MintNftEvent` / `BurnNftEvent` *(current pkg)* carry `{nft_address, position_id, pool_id}`; v1 era only has `position_nft::MintNFTEvent` `{object_id, creator, name}` (no pool/position link — v1 position open must link via the tx's object changes instead).
- `pool_factory::PoolCreatedEvent` *(v1)* — pool → fee/tick-spacing registry.

Not typed (admin/ops, no tax relevance): pool reward-manager admin events,
`pool_factory` role events, `partner::*`, `pool_fetcher::FetchTicksResultEvent`,
`pool::UpgradeEvent`, `pool::TogglePoolStatusEvent`,
`pool::CollectProtocolFeeEvent` (typed but protocol-fee sweep only),
`position_nft` display events.

Unconfirmed defining IDs (never observed live; assumed current pkg):
`pool::MigratePositionEvent`, `position_manager::BurnPositionEvent`.

## Suilend

| | Package ID |
|---|---|
| original (defining ID for 12/13 events) | `0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf` |
| current published, v20 (use for queries) | `0x3d4353f3bd3565329655e6b77bc2abfd31e558b86662ebd078ae453d416bc10f` |
| main lending market object | `0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1` |

**All 13 events from the plan enumerated and confirmed** (done-criterion met):
`MintEvent`, `RedeemEvent`, `DepositEvent`, `WithdrawEvent`, `BorrowEvent`,
`RepayEvent`, `ForgiveEvent`, `LiquidateEvent`, `ClaimRewardEvent` (module
`lending_market`); `ObligationDataEvent` (module `obligation`);
`InterestUpdateEvent`, `ReserveAssetDataEvent`, `ClaimStakingRewardsEvent`
(module `reserve`). Struct fields match the Move source in
`onchain/suilend/contracts/` exactly.

- 12/13 carry the **original** package as defining ID (sampled live).
- `ClaimStakingRewardsEvent` was added in an intermediate upgrade: it is *not*
  in the original package's bytecode, and `MoveEventType` probes at both the
  original and v20 addresses found no emissions. Defining ID therefore
  unconfirmed → suffix-match `::reserve::ClaimStakingRewardsEvent`. It is
  protocol-level (staker module compounding into the SUI reserve), not
  user-addressed — no TaxEvent impact.
- ctoken caveat: `Deposit/WithdrawEvent` amounts are **ctokens**;
  `Mint/RedeemEvent` carry both ctoken and underlying amounts; the same-tx
  `ReserveAssetDataEvent` provides the exchange rate + USD price for
  conversion.

## Navi

Navi's Move source is unpublished; everything below is bytecode-derived +
live-sampled. Defining IDs are scattered across at least five historical
package versions:

| Module(s) | Defining package ID | Confirmed by live sample |
|---|---|---|
| `lending`, `pool` (and `storage`) | `0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca` | yes (Deposit/Withdraw/Borrow/Repay, PoolDeposit/PoolWithdraw) |
| `logic` | `0x834a86970ae93a73faf4fff16ae40bdb72b91c47be585fff19a2af60a19ddca3` | yes (StateUpdated) |
| `incentive_v2` | `0xe66f07e2a8d9cf793da1e0bca98ff312b3ffba57228d97cf23a0613fddf31b65` | yes (RewardsClaimed) |
| `incentive_v3` | `0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f` | yes (RewardClaimed) |
| `flash_loan` | `0x06007a2d0ddd3ef4844c6d19c83f71475d6d3ac2d139188d6b62c052e6965edd` | yes (FlashLoan/FlashRepay) |
| latest version observed (for queries / normalized modules) | `0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0` | — |
| storage object (stable, good tx filter) | `0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe` | — |

The current package version changes with upgrades — resolve at runtime via
`getConfig({env:'prod'}).package` from `@naviprotocol/lending` if a
`MoveModule` query filter is ever needed.

43 emitted event structs in the latest package; 14 typed in `navi-events.ts`.
Tax-relevant core (`lending` module): `DepositEvent`, `WithdrawEvent`,
`BorrowEvent`, `RepayEvent`, `LiquidationEvent`, `DepositOnBehalfOfEvent`,
`RepayOnBehalfOfEvent` — note these carry only `{reserve: u8 assetId, sender,
amount}`; the **assetId → coin type mapping needs the pool registry**
(`getPools()` from `@naviprotocol/lending`, or the same-tx `pool::PoolDeposit`
/`PoolWithdraw` events which carry the coin-type string). Rewards:
`incentive_v2::RewardsClaimed` (legacy, no coin type — resolve via funds-pool
object) and `incentive_v3::RewardClaimed` (carries coin type). `FlashLoan`/
`FlashRepay` → flag `flash_loan`, not a borrow. `logic::StateUpdated` is
emitted with every action (supply/borrow balances + indexes) — the raw
material for interest reconstruction if ever needed.

The plan's expected `ClaimRewardEvent` / `InterestUpdateEvent` /
`ReserveAssetDataEvent` names **do not exist on Navi** — the real names are
`RewardsClaimed`/`RewardClaimed` and `StateUpdated`.

Unconfirmed defining IDs (no live emission found; suffix-match via
`NAVI_EVENT_TYPE_SUFFIXES`): `lending::LiquidationEvent`,
`lending::DepositOnBehalfOfEvent`, `lending::RepayOnBehalfOfEvent`. Probes at
the five known version addresses all missed; liquidations are rare enough that
the most-recent-N window may simply not contain one. Pin down with a real
fixture in [1C.4]/[1C.6].

## Question (a): does the Navi SDK deprecation block historical event decoding?

**No.** Decoding never goes through an SDK: events are immutable on-chain data
fetched via plain RPC (`sui_getTransactionBlock { showEvents: true }` /
`suix_queryEvents`) and parsed from `parsedJson` with the interfaces generated
here. The deprecation of `navi-sdk` only affects *tooling*, and the
replacement `@naviprotocol/lending` covers both remaining needs:
assetId → coinType pool registry (`getPools()`) and the
`getUserClaimedRewardHistory()` HTTP cross-check for reward coverage. One real
risk remains: Navi package **upgrades add new defining IDs over time** — the
handler should suffix-match module+event name after an allowlist miss and flag
unknown prefixes instead of dropping them.

## Question (b): which events identify the haSUI loop?

The leveraged loop (deposit haSUI → borrow SUI → stake SUI → re-deposit haSUI)
is visible inside a **single tx digest** as a repeating event cycle:

| Step | Event(s) | Defining package |
|---|---|---|
| 1. deposit haSUI | `lending::DepositEvent` (reserve = haSUI assetId 6 — verify via registry) + `pool::PoolDeposit` (pool = `…::hasui::HASUI`) | Navi `0xd899cf…` |
| 2. borrow SUI | `lending::BorrowEvent` (reserve = SUI assetId 0) + `pool::PoolWithdraw` (pool = `…::sui::SUI`) | Navi `0xd899cf…` |
| 3. stake SUI → haSUI | `staking::UserStaked` `{owner, sui_amount, st_amount, validator}` | Haedal `0xbde4ba4c…` (= haSUI coin package) |
| 4. re-deposit | back to step 1 with `amount ≈ st_amount` | |

Detection rule for [1C.4]: within one digest, ≥1 occurrence of
(DepositEvent[haSUI] → BorrowEvent[SUI] → HaedalUserStaked) ordered by event
sequence ⇒ tag all constituent TaxEvents `looping_pattern`; loop depth = cycle
count. Unwind direction uses `staking::UserInstantUnstaked` (instant, fee) or
`UserNormalUnstaked` + later `UserClaimed` (delayed ticket), paired with
`lending::RepayEvent` + `lending::WithdrawEvent`. Haedal current staking
package (call targets, not event types):
`0x19e6ea7f5ced4f090e20da794cc80349a03e638940ddb95155a4e301f5f4967c`; event
defining ID is the coin package. All four user-facing Haedal staking events
are typed in `navi-events.ts`.

## Provenance of confirmation samples (all foreign txs, public mainnet data)

- Turbos swap: `67eaPfSAHQxqMX9uc86KavSNp65774yxJsED2Y6nWWup`; add-liquidity (MintEvent + IncreaseLiquidityEvent + MintNftEvent): `Dns61fpzYCKWvJ1dchKdjW6AhLCp2x3F2tzS7ynQTQMQ`; v1-era collect-reward: `C1xs7ogiQVYSHqzm45HTVRioJPiaUJejbkxV6mseyUeG`.
- Suilend deposit/mint era-2024: `7cCGFWMfHdkTJgG2xCLMjm547SnDVSVAmbFEN3GGDJQH`; redeem + liquidate 2026: `8Kk8xsRt26rb7gU5ptbsRtc2woPK1USFv4daHZQ1e1YJ`.
- Navi haSUI flash-loan + PoolDeposit: `8XFjM84fF7aaGgU4bnxW6iSWcbA5pdyD8ydqYKzf64k7`; incentive_v3 RewardClaimed: `FE7S8h1SHBEki6M6JeZYtekDK5Lu9smEvZmfS6Tfb3JJ`.
- Haedal unstake: `4D5d8MEvnsE1ye2Q8wBtEvU9n6ayA6bvgDi49iz9rW6o`.

## Spike verdict & follow-ups

**GO for Phase 1C.** Event discovery worked end-to-end over plain RPC; no
blocker found. Follow-ups for the handler issues:

1. [1C.3] Turbos: handle both v1 and V2 collect-event generations; v1 position
   open lacks an NFT-link event — use tx object changes for `positionId`.
2. [1C.4] Navi: resolve assetId → coinType via pool registry; pin
   `LiquidationEvent` defining ID with a real fixture; cross-check rewards via
   `getUserClaimedRewardHistory`.
3. [1C.5] Suilend: implement ctoken → underlying conversion via same-tx
   `ReserveAssetDataEvent`.
4. Generic safety net: after allowlist miss, suffix-match `::module::Name` for
   the known sets before routing to `unclassified` (new defining IDs appear on
   every protocol upgrade).
