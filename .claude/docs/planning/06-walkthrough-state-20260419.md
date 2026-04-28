# Walkthrough State — 2026-04-19

**Purpose.** Checkpoint the /walkthrough session so the next session can continue without re-deriving decisions.

---

## What was done this session

1. **Read all planning docs** (01 critique, 02 claims verification, 03 initial issues, 04 research findings).
2. **Resolved 9 open questions** via `AskUserQuestion` — see "Locked decisions" below.
3. **Walked Phase 0 and Phase 1A** of the issue list interactively:
   - Schema design (7 tables in 3 layers: raw, decoded, overrides+joins)
   - `TaxEvent` type + `(type, subtype)` matrix mechanism (generic `T` narrows `subtype`)
   - Handler interface + 3-phase dispatch (address → rules → aggregation)
   - Phase 1A overview (6 issues → revised to 9 after critique)
4. **Live decisions added mid-walkthrough:**
   - Drizzle ORM chosen over raw SQL / Prisma — reason: agent-assisted development benefits from typed schema + autocomplete more than minimalism gains. Memory saved at `memory/feedback_agent_friendly_tooling.md`.
   - `@aave/client` (viem-native) replaces the planned `aave-utilities` (ethers v5). Removes doc 01 gap #5 from scope.
   - Flash loans postponed → dedicated `[F.1]` future issue.
5. **Drafted** `05-issues-draft-20260419.md` with 10 issues.
6. **Ran critic + reference-miner agents in parallel** against the draft.
7. **Applied all critic findings**, expanded to 13 issues, added reference-pattern citations per issue.
8. **Filed all 13 issues on GitHub** (`OuttaSpaceTime/liquidity-tax`).

---

## Locked decisions (canonical record)

| Decision | Value |
|---|---|
| Repo location | Sibling `liquidity-tax/` (this dir) |
| Sui spike timing | Task 1 of Phase 1C |
| Wallet set | All historical, tagged active/archived |
| Test-first | Per-handler, ≥3 hand-labeled real txs; failing test run committed first |
| Solana stack | Web3.js v2 + `@orca-so/whirlpools` v7 |
| Handler registration | Explicit in `src/decoders/index.ts` |
| Position ID | `{chain}:{protocol}:{id}` |
| Gas fees | Separate Koinly rows, emitted at ingest time by chain adapter |
| Flash loans | Out of scope → `[F.1]` |
| Secrets | `.env` + dotenv, `.env.example` checked in |
| DB/ORM | `better-sqlite3` + `drizzle-orm` + `drizzle-kit`; schema in TS |
| `raw_txs → events` | No `CASCADE` |
| Aerodrome scope | LP + gauge bundled in `[1A.4]` |
| Aave SDK | `@aave/client` (viem-native) |
| Koinly label `lp_fee`/`lp_reward` | `reward` |
| `UniV3LikeBase` extraction | Upfront in `[1A.3]` |
| `lend_interest:accrued` synthesis | Skipped in MVP |
| Gas-row style | Separate rows, never attached to main row Fee column (guarded at export) |
| Decode idempotency | `decodeAndPersist(tx)` wipes+reinserts per tx; byte-identical across runs |
| Duplicate-emission key | `(chain, tx_hash, log_index, emission_seq, type, subtype)` 6-tuple |
| Deterministic order | Final events sorted by `(tx_hash, log_index, emission_seq, handler_id)` |

---

## GitHub issues filed

| # | Title | Labels |
|---|---|---|
| [#1](https://github.com/OuttaSpaceTime/liquidity-tax/issues/1) | `[0.1]` Repo scaffolding + Drizzle SQLite schema + config | `phase-0`, `infra` |
| [#2](https://github.com/OuttaSpaceTime/liquidity-tax/issues/2) | `[0.2]` Canonical `TaxEvent` type + (type, subtype) matrix | `phase-0`, `schema`, `decoder-core` |
| [#3](https://github.com/OuttaSpaceTime/liquidity-tax/issues/3) | `[0.3]` `Handler` interface + `DecoderRegistry` + 3-phase dispatch | `phase-0`, `decoder-core`, `infra` |
| [#4](https://github.com/OuttaSpaceTime/liquidity-tax/issues/4) | `[1A.0]` Base tx dump + fixture capture (before handlers) | `phase-1a-base`, `test-fixtures` |
| [#5](https://github.com/OuttaSpaceTime/liquidity-tax/issues/5) | `[1A.1]` Base ingest adapter (viem) + gas event emission | `phase-1a-base`, `infra` |
| [#6](https://github.com/OuttaSpaceTime/liquidity-tax/issues/6) | `[1A.2]` Koinly CSV exporter | `phase-1a-base`, `export` |
| [#7](https://github.com/OuttaSpaceTime/liquidity-tax/issues/7) | `[1A.3]` Uniswap V3 handler (Base) + UniV3LikeBase extraction | `phase-1a-base`, `handler` |
| [#8](https://github.com/OuttaSpaceTime/liquidity-tax/issues/8) | `[1A.4]` Aerodrome handler (Base, LP + gauge bundled) | `phase-1a-base`, `handler` |
| [#9](https://github.com/OuttaSpaceTime/liquidity-tax/issues/9) | `[1A.5]` Aave V3 handler (Base, viem-native) | `phase-1a-base`, `handler` |
| [#10](https://github.com/OuttaSpaceTime/liquidity-tax/issues/10) | `[1A.6]` Base end-to-end smoke + Koinly sandbox import | `phase-1a-base`, `test-fixtures`, `export` |
| [#11](https://github.com/OuttaSpaceTime/liquidity-tax/issues/11) | `[1A.7]` Self-transfer detection + transfer_links population | `phase-1a-base`, `decoder-core` |
| [#12](https://github.com/OuttaSpaceTime/liquidity-tax/issues/12) | `[1A.8]` CoinGecko price fetcher + prices table writer | `phase-1a-base`, `infra` |
| [#13](https://github.com/OuttaSpaceTime/liquidity-tax/issues/13) | `[F.1]` (Future) Revisit flash loan decoding | `future`, `handler`, `risk` |

**Recommended execution order:** #1 → #2 → #3 → #5 → #4 → #7 → #8 → #9 → #11 → #12 → #6 → #10. (Ingest before fixture capture; handlers before end-to-end; exporter last after prices + self-transfer land.)

---

## Still to do — next session pickup

### Issues not yet filed
- **Phase 1B (Solana) — 5 issues:** `[1B.0]` ADR Web3.js v2, `[1B.1]` Helius ingest, `[1B.2]` Position lifecycle tracker, `[1B.3]` Orca Whirlpool handler, `[1B.4]` Solana golden fixtures.
- **Phase 1C (Sui) — 6 issues:** `[1C.1]` Sui event spike, `[1C.2]` Sui ingest, `[1C.3]` Turbos, `[1C.4]` Navi + haSUI loop, `[1C.5]` Suilend, `[1C.6]` Sui golden fixtures.
- **Phase 1D (Polish) — 4 issues:** `[1D.1]` price cache Sui/Solana assets, `[1D.2]` cross-chain linker (handles bridges — supersedes dropped `[F.2]`), `[1D.3]` Ink/Inquirer TUI, `[1D.4]` unified fixtures + Koinly sandbox full validation.

### Open inline TODOs on filed issues (decide during PR, non-blocking)
- `[1A.4]` edge case: non-gauge AERO receipts (airdrop, OTC swap) — default `transfer:receive` unless another handler claims; revisit if fixture shows wrong output.

### Known gaps the critic flagged but we intentionally deferred
- Cross-chain bridge decoding (Wormhole Base↔Solana) — handled by `[1D.2]` in a future batch.
- Multi-wallet grouping beyond same-chain self-transfer — covered for Phase 1A by `[1A.7]`; cross-chain case in `[1D.2]`.

---

## Next-session start prompt template

> Continue the liquidity-tax issue walkthrough. Read `.claude/docs/planning/06-walkthrough-state-20260419.md` for context. Phase 0 + Phase 1A issues are filed (#1–#13). Walk me through Phase 1B next — same pattern: explain each issue, answer open questions, critic+reference agents, file on GH.

Open questions likely to surface in Phase 1B walkthrough:
- Helius paid-tier threshold — do we hit it during backfill?
- Position lifecycle tracker: shared across Uni V3 / Whirlpool / Turbos, or per-chain?
- Orca `@orca-so/whirlpools` v7 API coverage — does `fetchPositionsForOwner` + `harvestPosition` cover historical decoding, or do we still need raw IDL parsing?

---

## Files produced this session

- `.claude/docs/planning/05-issues-draft-20260419.md` — revised draft (v2) with all critic fixes + reference citations
- `.claude/docs/planning/06-walkthrough-state-20260419.md` — this file
- `memory/feedback_agent_friendly_tooling.md` + `memory/MEMORY.md` index entry
- Edits to `.claude/docs/planning/03-accounts-and-initial-issues-20260418.md`: `[1A.5]` updated to `@aave/client`; `[0.1]` updated to Drizzle stack
