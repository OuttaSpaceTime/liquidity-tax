# 08 — Pipeline validation against the Blockpit flow (2026-06-12)

Cross-check of the decoded `events` table (full real-data run, 1500 raw txs →
2005 events / 763 txs) against the owner's existing Blockpit data, per the
explicit directive to "double check against existing transactions".

Generator: `scripts/validate-blockpit.ts` (run with
`bun scripts/validate-blockpit.ts`). The full machine-generated output is in
the appendix; this document is the interpretation.

## Two comparison sources, two roles

| | file (all READ-ONLY) | role |
|---|---|---|
| **A** | `liquidity-sheets/Transactions.csv` (raw Blockpit export, semicolon-separated, 2325 data rows, Jul 2025 – Apr 2026) | **coverage**: did each side see the other's txs? |
| **B** | `liquidity-sheets/tax-report-2025/04d-lp-positions/Transactions_with_lp_corrections.csv` (corrected pipeline output, 2011 rows) | **classification source of truth**: their corrected Label vs our `(type, subtype)` |

Source B contains 39 **synthetic** injected rows (Trx. ID `lp-<pos>-…`, LP
basis carry-forward / fee-at-close legs from `inject_lp_events.py`) with no
on-chain tx — counted as known-synthetic, never as missing coverage. The
correction pipeline also **removed** all 54 Sickle/NPM-related Base txs and
replaced them with those synthetic per-position rows, so our decoded Sickle
txs are expected to be absent from B (bucketed as removed-by-correction).

Join: Trx. ID (hash/digest) where present; `(timestamp ±2 min, asset, amount)`
heuristic otherwise (turned out to be moot: 0 in-scope rows lack a Trx. ID).
Blockpit aggregates flows per tx row while our handlers emit one event per
instruction, so amounts are compared on per-tx `(direction, asset)` group sums
and labels are paired greedily inside each matched group.

## Headline results

| metric | result |
|---|---|
| Coverage CSV→DB (sui) | **97.8%** (135/138 txs) |
| Coverage CSV→DB (solana) | 55.4% raw — **79.0%** after excluding 279 spam-airdrop txs Blockpit lists as Non-Taxable In (518/656); remaining gap = 132 unclassified non-Whirlpool txs (TUI backlog) |
| Coverage CSV→DB (base) | 25.9% raw — dominated by two known gaps (77 fee-only txs not enumerated by ingest; 158 unclassified, mostly aerodrome non-Slipstream / vfat automation txs) |
| Coverage DB→CSV | base **100%**, solana **99.4%**, sui 88.8% (all 17 missing sui txs explained: 10 Suilend deposit/claim txs Blockpit simply never recorded + 7 gas-only txs Blockpit drops) |
| Classification vs B (paired legs) | 643/1165 in expected set; **of the 522 disagreements, 422 are provably *their* uncorrected residual labels and 100 are deliberate-but-wrong or policy differences — 0 confirmed bugs on our side** (verdict table below) |
| Amounts (sample of 50 groups) | **47/50 within 0.5%**; mean rel. diff 3.6% driven by 3 explained outliers |
| Amounts (all 1237 matched groups) | 87.9% within 0.5%; all mismatch categories explained (proxy-custody gross-vs-net, rent refunds, zap groups — below) |
| Gas fees | **119/119 txs agree within 0.5%** (100%) |

## 1. Known-out-of-scope rows (excluded, counted separately)

From source A: Bitvavo/CEX 83, Ethereum 44, Polygon 2, Manual 2, Cetus 1 tx.
"MAD Finance"/"AMMD" never appear as identifiable markers in our ingested Sui
raw JSON; the out-of-scope marker list in the script carries 5 additional
unidentified Sui DEX package ids for manual attribution, none of which matched
ingested txs that lacked events (i.e. they don't distort coverage).

## 2. Coverage, source A (both directions)

### CSV → DB misses, fully bucketed

| chain | bucket | txs | assessment |
|---|---|---|---|
| solana | unclassified in DB, CSV says spam airdrop (all rows `Non-Taxable In`) | 279 | **non-gap** — dust/scam airdrops we deliberately leave unclassified |
| base | unclassified (no handler matched) | 158 | **real gap** — labels Deposit×124/Trade×24: mostly vfat automation + non-Slipstream Aerodrome txs; goes to the TUI backlog |
| solana | unclassified (no handler matched) | 132 | **real gap** — non-Whirlpool programs (Jupiter-routed swaps, Hylo, SOL staking); TUI backlog |
| base | not ingested (missing from raw_txs) | 89 | **ingest gap** — 77 are fee-only rows (approvals etc. with no token transfer; Alchemy `getAssetTransfers` enumeration can't see them) → lose only the gas deduction; 12 others to check |
| base/solana | ingested, decoder skipped (no events) | 15 | mostly failed txs / 0-value; spot-checked OK |
| sui | unclassified | 3 | NFT mint + 2 misc; TUI backlog |
| solana | not ingested | 1 | single tx, predates Helius retention window — re-ingest manually |

### DB → CSV (did Blockpit see what we decoded?)

base 90/90, solana 518/521 (3 outside CSV date range), sui 135/152:
10 Suilend txs (lend_supply:deposit / lend_reward:claim) **missing from
Blockpit entirely** — our pipeline sees real txs the old flow never recorded —
plus 7 gas-only txs Blockpit drops by design.

## 3. Classification vs source B (the corrected CSV) — disagreement table with verdicts

Mechanics: 689 of 1084 in-scope corrected txs matched DB events → 1165 paired
legs. Agreement = their corrected label ∈ expected set for our
`(type, subtype, direction)` (mapping `EXPECTED_LABELS_CORRECTED` in the
script, derived from their own pipeline's documented conventions: LP and
lending flows → Non-Taxable In/Out, fees/claims → Reward, swaps → Trade).

Key discriminator (computed automatically): for every disagreeing leg we check
whether B's label is **identical to the raw export's label** for the same
(tx, direction, asset). If yes, their correction pipeline never touched the
leg — it is a *residual* Blockpit misclassification that survived into B, not
a deliberate correction that contradicts us. 422/522 disagreements are
residual; 100 are deliberate.

| # | their corrected label | our (type:subtype) | legs | residual/deliberate | verdict |
|---|---|---|---|---|---|
| 1 | Withdrawal | lp_deposit:add_liquidity (out) | 177 | 177/0 | **ours right.** Their cleanup relabels LP txs only when a position-NFT placeholder (OWP/AERO-CL-POS) appears in the tx (`01-cleanup/DOC.md` priority 3); increase-liquidity on an *existing* position has no NFT leg, so the raw label survived. Their own convention — Non-Taxable Out, applied 133× elsewhere — matches us. |
| 2 | Withdrawal / Deposit | swap:trade (out/in) | 201 | 201/0 | **ours right.** Blockpit fallback pattern (unpaired swap → Withdrawal+Deposit row pair). Their 04b fixed only what the 2025 filing needed; verified `3RX6p382…` (14.04.2026): B rows byte-identical to raw export. |
| 3 | Non-Taxable In | lp_fee:collect (in) | 65 | 0/65 | **ours right, with on-chain proof.** Their group-level LP_REMOVE relabel marks *every* incoming row of a remove-liquidity tx Non-Taxable In — including pure fee income. Example `4YSXDohL…`: their Non-Taxable In USDC row = 10.614386 — exactly our `lp_fee:collect` raw amount (10614386, 6 dp); the principal came back 100% in SOL. Their own designs agree fees are taxable (04c harvest → Reward agrees with us 130×; 04d injects Reward rows on Base). Both spot-checked examples are 2026 rows (post-filing), but **some may fall in tax-year 2025 → quantify in the §22 engine diff (follow-up F1)**. |
| 4 | Deposit | lp_fee:collect (in) | 36 | 36/0 | **ours right.** Uncorrected residuals (mostly Hylo EUSX/USX and 2026-period collects their report never needed to fix). |
| 5 | Non-Taxable In/Out | swap:trade (in/out) | 30 | 0/30 | **ours right for zaps; 6 legs are a policy question.** Hybrid zap txs (comments AddLiquidityAndStake/AddLiquidityAndDeposit): their whole-group relabel flattens the internal swap, contradicting their *own* hybrid-split policy (03-apply-corrections: hybrid = one Trade + Non-Taxable LP legs). The Sui `Stake`/`SwapAndStake` cases (SUI↔vSUI/sSUI LST conversion) are a genuine policy fork — LST conversion as disposal vs non-taxable staking. Default German treatment: token-for-token conversion = disposal (ours), but **needs Felix's explicit sign-off (follow-up F2, ties into the haSUI-loop tax-policy doc)**. |
| 6 | Deposit | lend_supply:withdraw (in) | 4 | 4/0 | **ours right** — residual raw labels on Navi withdrawals; their own convention is Non-Taxable In (applied 3× elsewhere). |
| 7 | Non-Taxable In | lp_reward:gauge_claim (in) | 4 | 0/4 | **ours right.** Direct AERO gauge emission claims = taxable reward income; their rows carry `Fallback` comments (Blockpit failed to decode the claim) and the group relabel marked them non-taxable. Their own 04d treats position rewards as Reward. |
| 8 | Deposit | lp_withdraw:remove_liquidity (in) | 3 | 3/0 | **ours right** — same NFT-heuristic miss as #1, withdraw side. |
| 9 | Withdrawal | lp_deposit:open_position (out) | 1 | 1/0 | ours right — residual on a hybrid SwapAndUnstake tx. |
| 10 | Reward | lend_supply:withdraw (in) | 1 | 0/1 | **ours right on the split, theirs overstates income.** `WithdrawAndClaim` combined row: their single Reward row includes returned principal; we split principal (lend_supply:withdraw) from claim (lend_reward:claim). |

Net: **no case where on-chain evidence shows the corrected CSV right and our
decode wrong.** Where the two genuinely diverge (rows #3, #5, #7, #10) the
corrected CSV's group-level relabeling is the cruder model and our
per-instruction split is the one their own later pipeline stages emulate.

The default assumption ("corrected CSV is right, ours is a bug") was rebutted
by evidence in every bucket — primarily *because* the residual/deliberate
discriminator shows 81% of disagreements were never corrected at all, and the
deliberate remainder traces to documented heuristic limits of their cleanup
(NFT-token trigger, group-level relabel).

## 4. Amount agreement

- Deterministic sample of 50 matched groups: **47/50 within 0.5%** tolerance
  (covers decimal-comma parsing + rounding; parser handles `1.234,56`,
  `1,234.56`, plain-dot and plain-comma).
- All 1237 matched groups: 1087 within 0.5%; the 150 mismatches fall into
  explained categories:
  - **proxy-custody gross-vs-net** (Sickle/zap txs, Base; also Sui zap routes):
    Blockpit records only the EOA-visible flow (often dust/refunds), we decode
    the full proxy/pool flow — e.g. `0x3e145b…` out ETH csv 7.255 vs events
    14.503 (send + lp leg of the same custody chain, double-counted in the
    *group sum*, not in the events themselves).
  - **Solana rent refunds**: Blockpit folds position-account rent (~0.01 SOL)
    into the row amount; we model only the actual fee/liquidity flow
    (e.g. `2YcsHWjd…` csv 0.0104 SOL vs events 0.0000297).
  - **zap multi-type groups**: several event types share one (dir, asset) sum;
    not directly comparable to Blockpit's single net row.
- Gas fees: **119/119 (100%)** txs agree within 0.5%.

No unexplained systematic amount error was found; decimals were either
statically verified or inferred with 100% vote share (table in appendix).

## 5. Verdict — can the pipeline replace the Blockpit flow?

**Yes for classification and amounts; not yet for raw coverage.**

- **Classification:** ours is strictly stronger than both the raw export and
  the corrected CSV. Every disagreement resolved in our favor or to a flagged
  policy choice; we also surface income their flow silently dropped
  (10 Suilend txs absent from Blockpit; fee income inside remove-liquidity
  txs labeled non-taxable by their cleanup heuristic).
- **Amounts/gas:** at parity or better (their rows mix rent refunds and
  EOA-only views; our event amounts are exact raw on-chain integers).
- **Coverage:** two real gaps must close before the old flow can be retired:
  1. **Base fee-only txs not enumerated** (77 txs): ingest via
     `getAssetTransfers` can't see approval-type txs → lose gas deductions.
     Fix: enumerate via block-scan or Etherscan-style txlist for the wallet.
  2. **Unclassified backlog** (158 base / 132 solana / 3 sui txs with CSV
     labels): these are in the `unclassified` table by design — work through
     the Ink/Inquirer TUI, prioritizing the 124 base Deposits (vfat
     automation) and the solana Jupiter/staking swaps.

## 6. Follow-ups

- **F1 (tax-relevant):** quantify 2025-tax-year fee income mislabeled
  Non-Taxable in B (row #3) once the §22 engine runs — if material, Felix may
  need to know for the filed report.
- **F2 (policy):** LST conversion (SUI↔vSUI/sSUI, xSOL) — disposal (our
  current decode) vs non-taxable staking (their treatment). Needs explicit
  decision; configurable like the LP basis carry-forward flag.
- **F3 (ingest):** Base fee-only tx enumeration (see §5.1).
- **F4:** single solana tx `283odoG3…` missing from raw_txs (predates
  retention?) — re-ingest manually.
- **F5:** the 6 unidentified Sui DEX package ids in the script's
  `OUT_OF_SCOPE_MARKERS` — attribute manually if those protocols ever matter.

---

## Appendix — full generated output (`bun scripts/validate-blockpit.ts`, 2026-06-12)

## Inputs

- Blockpit CSV: `/home/felix/Code/Misc/defi-tracker/liquidity-sheets/Transactions.csv` — 2325 data rows
- CSV in-scope rows (Base/Solana/Sui chain rows): 2194; distinct txs with Trx. ID: 1421; rows without Trx. ID: 0
- DB events: 2005 rows across 763 txs; raw_txs: 1500
- CSV date range (UTC): 2025-07-31T08:26:43.000Z → 2026-04-14T06:06:38.000Z

## Known-out-of-scope rows (excluded from coverage, counted separately)

| exclusion | rows |
|---|---|
| Bitvavo / CEX (Source Type=API) | 83 |
| Ethereum chain | 44 |
| Polygon chain | 2 |
| Manual rows | 2 |
| other/unknown source | 0 |
| out-of-scope Sui protocol txs (Cetus + unidentified DEXes, see below) | 1 rows / 1 txs |

Out-of-scope protocol tx breakdown (first matching marker per tx):

- Cetus CLMM: 1 txs

## Tx-level coverage — CSV → DB (does our pipeline see what Blockpit saw?)

| chain | CSV txs (in scope) | covered by events | rate |
|---|---|---|---|
| base | 347 | 90 | 25.9% |
| solana | 935 | 518 | 55.4% |
| sui | 138 | 135 | 97.8% |

Misses by bucket:

- **solana — unclassified in DB — CSV says spam/dust airdrop (all rows Non-Taxable In)**: 279 txs / 279 rows (labels: Non-Taxable In×279)
  - examples: `4tnoC97kZK7Q6HWV13VfSvQ7dp3Tf9mtWK6GBRbHtVaBvdWAry4XeCZxkvxSVaW3FPunLH8rmdKUcZzDzPXbJabe`, `2spvoXuFKGULqXGp7oSW68EhzaWFcYD6MAMJU4SSmrVQprbAdcQS1WZUXjmuNViQqmLif6mAVSNDo72Z6d2DFpwZ`, `UNQ1a4epqsipLjwomcec9TxRNyrM2CJr9xttKAdHBSBDZiZPW9XY8rJmK6XvryskMtcUNg7Vz2EVo8E3uciCSdz`
- **base — unclassified in DB (no handler matched)**: 158 txs / 167 rows (labels: Deposit×124, Trade×24, Withdrawal×16, Fee×2, Gift Received×1)
  - examples: `0xa99c3f2ac461051ccf607cea266dd30a02eed27120f702a56b135d2bbb3f1822`, `0x2de4930df36310f56f37215ca765e312d180d533a746f97110456deefb9976c5`, `0x31ea02e493869e3f31d5f8aaa83172cab2f115b969df61b3de83177809eaa34b`
- **solana — unclassified in DB (no handler matched)**: 132 txs / 167 rows (labels: Deposit×108, Withdrawal×43, Fee×8, Trade×8)
  - examples: `53BHrUmhUtPJRKNA1PPu4UAXQg1eBhaEmvUaFitswT1eBq2riva3Lr4X2U9rhLXuX9nugVUwEjor8Sdi8MaEr4P8`, `agiH4hnUigc19LD6Ft6BkKUfT5V5ZH3xHgMQhunsuqbMtDmh4X2sYyu8k8ECHxPRydnY3CeFTkadpseg3pGZQ7g`, `2wFB4qUuTdkpqNkf6WJtYxbF1kBBoj2dvxmqAZGCxnTvDe4HvP9kYQpVcsi6AkWaZEqhJ6PsXnni9PjTMXahoAuo`
- **base — not ingested (missing from raw_txs)**: 89 txs / 89 rows (labels: Fee×77, Trade×6, Deposit×4, Withdrawal×2)
  - examples: `0x10ccb959812e200236f29420169b5f68e66e65c6274f9e3e6d998e1585f28bba`, `0x36e8db0dbd0329f4a7629b0161a75659883732eb47fd0dbb425b64618ae54422`, `0x7339759d0d7522325a99d69569fd6a2db3d0e7e820d61984062f4bfb1a4f2508`
- **base — ingested + not unclassified, but no events (decoder skipped)**: 10 txs / 10 rows (labels: Withdrawal×6, Deposit×3, Trade×1)
  - examples: `0x67266d4a57557eba9430547bf900c0489e94e72925478322062fc7c6a0275016`, `0x279d05a23d10e566bb55c63c77bbefee49891426677a397206eb14905a251917`, `0x0b5a756c90f5f3cc5158d5153128286f5ad20859ffd6b46e4197e4ab0c054ca2`
- **solana — ingested + not unclassified, but no events (decoder skipped)**: 5 txs / 5 rows (labels: Withdrawal×3, Fee×2)
  - examples: `6iRfqG4v54jTWZuUAL8AKwyJUf4N6PMQuAKBEH1V7b3wujziHehcSK8hbVNjpdjAmLFCJcR8J11mMiFneahkU8K`, `2BcoT4sJkK4MR6tYsYE9o7X5brNpRKfDtAVSn4KqsN7fQbq71jKYKJet4hASChVz1GApUrwnn3gnk8YKPUn2Fx1g`, `yPZesFPqhzu8yAZ9FjTYEbu4ZmBdx5ecKZA3otwLoVfZuwyZb6QfSmT581xaJhyG79BedHMjKr9ibRcc9iTSrC4`
- **sui — unclassified in DB (no handler matched)**: 3 txs / 3 rows (labels: Deposit×3)
  - examples: `Az5pywwXYFKVTcdQXxyEnQwG9FySyD2H8ShbQNXsFn5z`, `GXKh3GgiLE61ZXutW8dLN63mYx4ELbmvFvu2wfzzgFAH`, `4aZZ32zudisDrp6RfKXmcuXVKP19uWeHy7u2TeimmEBg`
- **solana — not ingested (missing from raw_txs)**: 1 txs / 1 rows (labels: Deposit×1)
  - examples: `283odoG3bmAGvSjqQmYW9iXz4vi2PisdkBwpnhLqq2FePQ1LDSrgyhMtPQxLc7s1AGYu5Su6rim1GxbNHFjun24s`

## Tx-level coverage — DB → CSV (did Blockpit see what we decoded?)

| chain | DB event txs | present in CSV | rate |
|---|---|---|---|
| base | 90 | 90 | 100.0% |
| solana | 521 | 518 | 99.4% |
| sui | 152 | 135 | 88.8% |

- **sui — in range, missing from CSV**: 10 txs (event types: lend_reward:claim×17, lend_supply:deposit×17, gas:fee×10)
  - examples: `14dXPAZXjiabgrmt5tBoBCfd45yxqRrxHJTgEynjdEzs`, `28wQMAxgYyerofL3wetiTBQfG7injN8Yn8QbQpiMTaKF`, `39iZXquF5NXuHUuX9NB5tKeBvxFoqTYiPdFBP6NGyaBw`
- **sui — gas-only tx (Blockpit drops fee-only txs)**: 7 txs (event types: gas:fee×7)
  - examples: `4kAGfWNTMDLgpRSsWaKMvVjQxqmVwmmW4NAuPgMuXDhx`, `BiEN6nSqiV35Z2HdSLeUPBj9FnkJ8Zia9C4ryvwsX1av`, `CPRNKVX7eZf22kgUwuGptaFVjKuZyCmJbrKd2dF2WUnn`
- **solana — outside CSV date range**: 3 txs (event types: lp_fee:collect×6, lp_withdraw:remove_liquidity×1, lp_withdraw:close_position×1)
  - examples: `269jU15B5mXHnfs4vswooQJy7YJXNNDKHUsStD83GwfttUEPirhhye3TLjAmUAbM46drFneEciKE6iVQ9TnYwiB2`, `2NgkohrsmsCNuXcnMzkpoFYuDbGMZhwvvJ8mKoCv5t5LgaevtB853VfPyTr16LYn7HrmPd7ku1CWDwT4MUtghnno`, `paRMxJv148xdcWSCKMA5E1cMGuLLdLeNgW1YTrWYiMuXzj4DKAPgnRUY61KPaRWrpfdvt2iFN2RavprnRaGnyPP`

## Group-level matching (within txs covered by both)

Groups = per-tx (direction, asset) flow sums — Blockpit aggregates per tx,
our events are per instruction, so sums are the comparable unit.

- matched groups (asset present on both sides): 1237
- amounts agree within 0.5%: 1087/1237 (87.9%)
- CSV legs with no event counterpart:
  - solana — position-NFT placeholder (Blockpit models the NFT as an asset; we model positionId): 140 (e.g. `2YE4wtbcTv6s9ySkHFuhWDNwGW1TE1FRE4MQCpmKx7wjzayzLos9si7SZRwATgVun7yKDVospxdF2ainf8e64ZJ2 (out OWP)`, `4sDSJgLum4E62EFgWsviCDSD9Db8NWV7Hjr9mUx6P2njYSR9QnUmwXwG1zqyQSvTyetf4DHtYdejnsoMpfGxDUoa (in OWP)`, `4guzXQJEoqjbHCYKg5tUEQcY4BUjgo9DA5SELaCAyqZhjcVJcbVU92iKArrwayeqCaQrrj7T8LcymwrBP7pDwWJJ (out OWP)`)
  - sui — no event leg for in SUI: 44 (e.g. `E2b6nzD21hUjpChHg66gUCwb7xSe3ryQpNxvgDtNuLML (in SUI)`, `B8EssjZxuY9NNB9KjFq1VCXt2nx5duHduoJDSHQBP1Eu (in SUI)`, `GvQ511jaMsjMZyiS4fADANJAEmQq6wmFkZZB9aSJzDPW (in SUI)`)
  - solana — no event leg for out SOL: 43 (e.g. `5PUZrtVE9Q4idppSYz4RKQAgirE7udNqqcAR8z8aGyPksV33GJB9yZeS7y5rfZeajVKVCtUrJAYpmPqVra1woxzQ (out SOL)`, `3U9HKWYRcYzvifzo92QQ54qF7Avw5c1JNEPF2fDP5MBWzMdNHCWsQjENcCDRiTduwQdxt1JFnTPyHNewSVAcvSku (out SOL)`, `5f3v7FyTGPpZDXhhzu3q8LfHBGE1R9KdQWwfWvqNT18uL69txnciuxrScsqocVcdtMNhoy3D5SYte3QtAXAoExWm (out SOL)`)
  - base — position-NFT placeholder (Blockpit models the NFT as an asset; we model positionId): 29 (e.g. `0x5b305737313aa7f48db0fae50e53487314f345604334986385992d934f925f2b (out AERO-CL-POS)`, `0xfc97c0ff66c78d90f1e0523447b7b6c9e487e3fb97f6e8d07570ddb5b3b502fb (in AERO-CL-POS)`, `0xae4386883136100e88056df04644d34e8d23440c76c5d76db221ba2deb49a1c8 (in AERO-CL-POS)`)
  - sui — no event leg for out USDC: 17 (e.g. `E2b6nzD21hUjpChHg66gUCwb7xSe3ryQpNxvgDtNuLML (out USDC)`, `B8EssjZxuY9NNB9KjFq1VCXt2nx5duHduoJDSHQBP1Eu (out USDC)`, `GvQ511jaMsjMZyiS4fADANJAEmQq6wmFkZZB9aSJzDPW (out USDC)`)
  - sui — no event leg for in CETUS: 16 (e.g. `4MMzgqWmYeCAqw7d9EFuErLTd1YURkNcRbwTvuQFMp3J (in CETUS)`, `HEiY8KhnWYMjk865Ac53bszVoVjev5Tc2pfUETncgHzL (in CETUS)`, `F7smVrP9BbLPmVEss7CHMnHRCkMPHFgMSsNowzTYnt1X (in CETUS)`)
  - sui — no event leg for out SUI: 15 (e.g. `3MmvuxsaPkytSntEaufGK1VKrfabj3K6KMSBeA8A2k49 (out SUI)`, `HsoWoboQjzAQY596gMjxPfKJq8UkCaE2wg5ibhLmRvHC (out SUI)`, `9CtfoMyTx86TqvXdjupaUMGgAZJaKeSsTQv7KrKAzjJo (out SUI)`)
  - solana — no event leg for in XSOL: 11 (e.g. `4DH1NHWBEZCoXJKokJSrC7fFf74K9YA3RvJyhqtKngW6nhgguAEA8UX8saJjEmHKFqDSobja2rAePx8PYP3eZifN (in XSOL)`, `5RJvA4zGMPXxGALFWtKVSG625qryV2546iVxGc1uL7X4tMCvf5dNdr6i49DDudzfP6uru1sEvqgUUrQxbiH1wpb1 (in XSOL)`, `2gJKQhWetqbK6nDCJxQ6ebpSuh2PnPDwDopcy2VDec7AVywNc4ppSqNxytEoaMqSHohHniYJrp25eHLBrew27pkf (in XSOL)`)
  - solana — no event leg for in SOL: 10 (e.g. `L3q1kEpy6fCT9JC1WbeCNTo5oXamEHBrytCVH7yk7Zqq9sqVjRZRzyXthzkpxcv2JJRMTq6xMD4yURBqRhL6b29 (in SOL)`, `28k3Uv36jakimJ99i7Jq6Tp9zGJkAyy5jFHRprhcexoNTC68gNMoBfyGkWDbzZvwBNKntGuuV75thA6TQ7Bag8Rp (in SOL)`, `5gaJpdG9TFnEamjCXwjgUdfffgWRpL684RaQktRW97m4s4CwP3HKV7vqZu8v2PhBBmtHdA9XesHsm2WSQA4r16Gy (in SOL)`)
  - sui — no event leg for in IKA: 9 (e.g. `DUsyg9vUYYx7z6DV1TfYe3b74ipq7CgnugC5CVsdoopj (in IKA)`, `Bt1TYcqNepbhNMGoFNCGdMcj6MFiFb28G9TWQ1vvPjqx (in IKA)`, `3F2McAEBcKEAFprXCiQETt83M1XsE7j8h8Xjtuu6LNBe (in IKA)`)
  - sui — no event leg for in USDC: 7 (e.g. `3MmvuxsaPkytSntEaufGK1VKrfabj3K6KMSBeA8A2k49 (in USDC)`, `9CtfoMyTx86TqvXdjupaUMGgAZJaKeSsTQv7KrKAzjJo (in USDC)`, `4MMzgqWmYeCAqw7d9EFuErLTd1YURkNcRbwTvuQFMp3J (in USDC)`)
  - sui — no event leg for out IKA: 5 (e.g. `HEHKCoKeJXDy3oNLbkreHwczw24WNJYRWcA6crQs79vP (out IKA)`, `FTR7nGhVJLciPjQ9hyCh6ZADhdBZTKddFryh9cjSA1Ms (out IKA)`, `uqicxucztTebFDbhTQchwreB6DLPFcKazDauA4qwd4g (out IKA)`)
  - sui — no event leg for in WAL: 4 (e.g. `5av92iE5UGhHVrZrtG1Pqp8392CfUQWwyGbyhMwPtBke (in WAL)`, `3XZtPh5uooJZfMiCJRT9GHbzHZDcJgLVVVy2rFfojgKX (in WAL)`, `7Tzzqcgx3GZprfmabz5YuGyYm8kMH4Q7VA97bSD2wUy (in WAL)`)
  - base — no event leg for in USDC: 4 (e.g. `0x3e145b543fa73b33302b857c0a09d368259915187422953f30ae9858e383dbd4 (in USDC)`, `0xbffefecac78eb8cfc2abb0490c95ce6984359558db0ae35d6bff1e54599871ea (in USDC)`, `0xfa08d719b759833e409a1f647b0a3cd1f1b19186c13af59f22496c7b57510616 (in USDC)`)
  - solana — no event leg for out USDC: 3 (e.g. `XMzsc8uKYU4b9FiX3xRBC9p69PhRFGBoWmx8W6nor9UNe3mM8ALK24mCdbbxu6strmj162e4fBEY63vZXcWoJZ7 (out USDC)`, `3H9Waiy2JPagrgjdR2EqRH1WbJr4qnucXYBFhUV6KUMiXFiUffuA7qVA4BZuirHLL2qZhAQi5c9HzTQHyTGTLZES (out USDC)`, `2Jr3UY4gS9jKvFUb3AWp8Kr6KEcgPBifUNMpyBK1RHF75xGN4xa1jzzhwgPCwjYWkSCbiGrJRYovHEUqL7DNCEtZ (out USDC)`)
  - sui — no event leg for in DEEP: 3 (e.g. `Aqr9ohEKUMSd9dZv1fXxnrq1b6K5WkwW9KhbKV4vJgQp (in DEEP)`, `Ep32TVHnRd99UwPbYaSfdqgPjRjPkTBHELo2aJVngPW5 (in DEEP)`, `4s7Z3r8EPPhq7mPVp7HVV9XfjEG7YQ6rhPsjbnjzPPgE (in DEEP)`)
  - solana — no event leg for in EUSX: 2 (e.g. `28rR25X5uPhFg6EgSxNwkWFXKRuYdamYHmAUmJnD5mDLrxX9dYxQyB8asar7KBDniZj4x3EffgoyNSseM83ntPd5 (in EUSX)`, `62DWHdVDCgB4goMxqiio65KQtbhFGPsFaYytE5pixjkH7u1xVhgpSqqr8c1tPqTeGFQti7KLDFWJLvyGxBhtwDSD (in EUSX)`)
  - base — no event leg for in WETH: 2 (e.g. `0xb7dbd0979c498028d271a22af6db6619661219a7e8963ce8ddcd08f9aa240e4c (in WETH)`, `0x9b65b90a11bf79c53eb0556e976663671da2c72a75d2c20c282adb0645ef6bb5 (in WETH)`)
  - sui — no event leg for out CETUS: 2 (e.g. `J7gkhefwXXzjsr43PtNTX1Mc5NhXLACmtP5YAtUNCULp (out CETUS)`, `G2jA2EVz2ubJYozkJfixCAvN29NKssNvovQ7KwT2TqKR (out CETUS)`)
  - sui — no event leg for out VSUI: 2 (e.g. `DqA5VBtM6pdMppipa3Vbonnc451SgczBSzM3UA4QrpzS (out VSUI)`, `7od72goRjtrCnpGMCkeZx4DSGGSf3h6jRfN5ZaGaR2Kn (out VSUI)`)
  - solana — no event leg for out XSOL: 1 (e.g. `L3q1kEpy6fCT9JC1WbeCNTo5oXamEHBrytCVH7yk7Zqq9sqVjRZRzyXthzkpxcv2JJRMTq6xMD4yURBqRhL6b29 (out XSOL)`)
  - solana — no event leg for in DLJZLeR1LAPBNaqePUiDCvdKcwW5c34dkVafjQJ3PCdR: 1 (e.g. `5QtKGReP8u9D9NbLiKNfFPgYdAVKTPwjCS8E99GwxUy8wz7kbmKMdcNVJUX5iVB2Pc2j4LvtLGzMSyHdBmUXgZje (in DLJZLeR1LAPBNaqePUiDCvdKcwW5c34dkVafjQJ3PCdR)`)
  - sui — no event leg for out SSUI: 1 (e.g. `BqYiW5xx9WZwvvGMdzj8uqPyTxtUZ7z6rjXnd7PiHTY8 (out SSUI)`)
  - sui — no event leg for out NAVX: 1 (e.g. `12jNAvgWUnW4HpSLLau7vs9rKmGiain4bfE5Su25tp98 (out NAVX)`)
  - solana — no event leg for out EUSX: 1 (e.g. `2tcL13Z2zP7rstbjM4jxX1hXsDBQhW7raHFyVhrj6mza6DKJwQKvm1LPFN6idGRCW6KcRDpp42S1fUV78UATar8 (out EUSX)`)
- event legs with no CSV counterpart:
  - sui — lend_supply:deposit (out sSUI): 49 (e.g. `gxCmw33JbPqbo8qgVJNQSqDvRC2caw4RxHRaCTCX1ez`, `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`, `G63Xc3XSQXoF1V9TKPsXNEouXD5pHu1RREonP3gGwGbX`)
  - sui — lend_reward:claim (in sSUI): 38 (e.g. `6neETEZ7Lor21By6mo8DPXzHyHzxdZuxYRqcksg1mSZj`, `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`, `G63Xc3XSQXoF1V9TKPsXNEouXD5pHu1RREonP3gGwGbX`)
  - base — transfer:send+lp_deposit:open_position (out WETH): 23 (e.g. `0xc28013f43ce2087929f6693955a378ebd9ee68e0297487207f3840b458bdd061`, `0x8294238dbafcf327627fa3f9a8a3d6d98a566284315201c3df379766e3b0b19e`, `0x313ff0c5c31ff57305ce55b9275219522e230ffcddaff05ca30fbdfb69e8c70c`)
  - base — transfer:send (out USDC): 19 (e.g. `0x441adf66a80fcdbbd2da28f76538075b34923a43d1385de0c4d1aedf4abc4874`, `0xf3f8fc1762f3920e797673df4a778c4443fe09cbb40c4c9237f084efbfd0a6d0`, `0x69251368ac838b981cc098b20d59bb7b620646421424642b35a106436340b444`)
  - base — transfer:send+lp_deposit:open_position (out USDC): 19 (e.g. `0xfb0e3bb8153f39028dfeb60e4f3e3ddc39d066c9ff48d192b7426f3202bb5e43`, `0xc28013f43ce2087929f6693955a378ebd9ee68e0297487207f3840b458bdd061`, `0x313ff0c5c31ff57305ce55b9275219522e230ffcddaff05ca30fbdfb69e8c70c`)
  - sui — lp_deposit:open_position (out USDC): 17 (e.g. `Aqr9ohEKUMSd9dZv1fXxnrq1b6K5WkwW9KhbKV4vJgQp`, `3XZtPh5uooJZfMiCJRT9GHbzHZDcJgLVVVy2rFfojgKX`, `CQiu5fnSWsURuZr2obK9qbaskQT9h3dUhzYEpGoS3CU2`)
  - sui — swap:trade (in USDC): 15 (e.g. `3XZtPh5uooJZfMiCJRT9GHbzHZDcJgLVVVy2rFfojgKX`, `CQiu5fnSWsURuZr2obK9qbaskQT9h3dUhzYEpGoS3CU2`, `B6EByChDsoLNuiuMitCaHe1ozdu5HdKGzP44u5tA8URK`)
  - solana — swap:trade (in 4sWNB8zGWH…): 13 (e.g. `4DH1NHWBEZCoXJKokJSrC7fFf74K9YA3RvJyhqtKngW6nhgguAEA8UX8saJjEmHKFqDSobja2rAePx8PYP3eZifN`, `5RJvA4zGMPXxGALFWtKVSG625qryV2546iVxGc1uL7X4tMCvf5dNdr6i49DDudzfP6uru1sEvqgUUrQxbiH1wpb1`, `2gJKQhWetqbK6nDCJxQ6ebpSuh2PnPDwDopcy2VDec7AVywNc4ppSqNxytEoaMqSHohHniYJrp25eHLBrew27pkf`)
  - base — transfer:send (out WETH): 13 (e.g. `0x441adf66a80fcdbbd2da28f76538075b34923a43d1385de0c4d1aedf4abc4874`, `0xf3f8fc1762f3920e797673df4a778c4443fe09cbb40c4c9237f084efbfd0a6d0`, `0x69251368ac838b981cc098b20d59bb7b620646421424642b35a106436340b444`)
  - base — transfer:send+lp_deposit:add_liquidity (out USDC): 13 (e.g. `0xbce3c47e83644d45b72a1c26ffffb8739c670efdc3714a4cc4bc9479612f5235`, `0xe9373c02b539416fc4a04589e375e49d1c9fd43474ab9750e4100c304e974964`, `0x08b61bc2d9fc3c3cedeb5c859a75ac713042e5f916bc9c3eef4c0ca8bf67f6ea`)
  - base — transfer:send+lp_deposit:add_liquidity (out WETH): 8 (e.g. `0xe9373c02b539416fc4a04589e375e49d1c9fd43474ab9750e4100c304e974964`, `0x08b61bc2d9fc3c3cedeb5c859a75ac713042e5f916bc9c3eef4c0ca8bf67f6ea`, `0x94dbd7af16bebc6c944e3113ab5bdb9fb502d129fadcee9253144cf403d24b87`)
  - base — lp_deposit:add_liquidity (out USDC): 8 (e.g. `0xa6475731bb2389d25e03af5d2abf794c152e39f903f882e7f31e7aa49a156fef`, `0x8eb2cef09b64f7c38a4b308a1d1677b22938542cdbec1a03af1e94e73a3bd89f`, `0xbffefecac78eb8cfc2abb0490c95ce6984359558db0ae35d6bff1e54599871ea`)
  - base — transfer:unwrap (out WETH): 6 (e.g. `0x5eb68141ec18388f12161a368ec22312d26a157097fc5e810376cbe22e1c8cf7`, `0x8c12fb60cfbcd34cda4710f616f8e30193a7f567cd3b4a8bf281e4188e816cd3`, `0x99c9dac6c9ac26dd8963bce8d9773110163892522d8bdc01650f583356bf0242`)
  - sui — lp_deposit:add_liquidity (out USDC): 5 (e.g. `5av92iE5UGhHVrZrtG1Pqp8392CfUQWwyGbyhMwPtBke`, `B6EByChDsoLNuiuMitCaHe1ozdu5HdKGzP44u5tA8URK`, `8zaHCx4Zo6tdDpXxTzGXLNNDejQZAWtCDb9YP1ovbxmY`)
  - sui — lend_reward:claim (in DEEP): 5 (e.g. `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`, `G63Xc3XSQXoF1V9TKPsXNEouXD5pHu1RREonP3gGwGbX`, `GKZrdqqp7uS2VcyNZPKBTpnyVtVneKtwxq3JMgNiLUwa`)
  - sui — lend_supply:deposit (out DEEP): 5 (e.g. `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`, `G63Xc3XSQXoF1V9TKPsXNEouXD5pHu1RREonP3gGwGbX`, `GKZrdqqp7uS2VcyNZPKBTpnyVtVneKtwxq3JMgNiLUwa`)
  - solana — swap:trade (out SOL): 4 (e.g. `5RJvA4zGMPXxGALFWtKVSG625qryV2546iVxGc1uL7X4tMCvf5dNdr6i49DDudzfP6uru1sEvqgUUrQxbiH1wpb1`, `2gJKQhWetqbK6nDCJxQ6ebpSuh2PnPDwDopcy2VDec7AVywNc4ppSqNxytEoaMqSHohHniYJrp25eHLBrew27pkf`, `XMzsc8uKYU4b9FiX3xRBC9p69PhRFGBoWmx8W6nor9UNe3mM8ALK24mCdbbxu6strmj162e4fBEY63vZXcWoJZ7`)
  - base — transfer:send+swap:trade+lp_deposit:open_position (out WETH): 4 (e.g. `0xfb0e3bb8153f39028dfeb60e4f3e3ddc39d066c9ff48d192b7426f3202bb5e43`)
  - sui — lend_reward:claim (in WAL): 4 (e.g. `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`, `GrJHRjHab5s4XVyE9SLtAwEg42J8TpYHxn2jfJ1i5si2`)
  - sui — lend_supply:deposit (out WAL): 4 (e.g. `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`, `GrJHRjHab5s4XVyE9SLtAwEg42J8TpYHxn2jfJ1i5si2`)
  - base — lp_deposit:open_position (out USDC): 4 (e.g. `0x3e145b543fa73b33302b857c0a09d368259915187422953f30ae9858e383dbd4`, `0x7df837d32e31a68f8027c28ee1434952842409f615d8e9338fda44b0ce3093de`, `0xe6c791dec29238d9961d5fce19d3f2f26f34ae7c1196314aac331755ba1ab601`)
  - base — transfer:send+swap:trade+lp_deposit:open_position (out USDC): 4 (e.g. `0x6e22d4b90d7feb09271e3205921f5a1d05ca46bf42df2897b203c223ea6e64fc`)
  - base — transfer:send (out AERO): 4 (e.g. `0x99c9dac6c9ac26dd8963bce8d9773110163892522d8bdc01650f583356bf0242`, `0x348c1e9e12cf8f210f633068533b745c0084e2dd2ece1cd338474003cd75f32a`, `0x35b82b2b2a9cda4aa6f305b65e7dab01cbf96156e97329b1a6d5faf4a1de6882`)
  - solana — lp_deposit:add_liquidity (out USDC): 3 (e.g. `3HrjazDv8avLV6ciKhgoe6ARknWqHUANas7LGrfWZDS6rxzcs5LoVbaV2eVerKXac3yMzrMVf1h9176QJkvJYzyB`, `65qLarhDBKQtqm2NnP8z4JU9zzy7tqS9vZGP9TQQWkhEyesYa9XHY8Jv8cR79QkZxgouktctvTE95wCLudjWpCYA`, `VDCq4TwCjiggv2Zg5hF2BzxJwjBZM6Vr1MjREPDBHZWdraoLSeYxv7UVmFKwVpbznx62MdwmeNyQ816iY8X7gcj`)
  - sui — lp_deposit:add_liquidity (out SUI): 3 (e.g. `4zQn4xnrSBnAmfmNdZGMP3ie9j1KsMo1S8MsG4bGmFip`, `B5PdDxrCCgZmpD9cqsJZACL89AaYncT9BNoZhemVTsUY`, `6DgzyUJVFNeRsVEmA26NihbAyKerZH6XqG4VdAiXxz5H`)
  - base — transfer:send+swap:trade+lp_deposit:add_liquidity (out USDC): 3 (e.g. `0x871bf4372369a03346d6c3bae6df917c17af7a93c93fe7bc211e39b9bc65d5cc`)
  - solana — swap:trade (in USX): 2 (e.g. `28rR25X5uPhFg6EgSxNwkWFXKRuYdamYHmAUmJnD5mDLrxX9dYxQyB8asar7KBDniZj4x3EffgoyNSseM83ntPd5`, `62DWHdVDCgB4goMxqiio65KQtbhFGPsFaYytE5pixjkH7u1xVhgpSqqr8c1tPqTeGFQti7KLDFWJLvyGxBhtwDSD`)
  - base — lp_fee:collect (in WETH): 2 (e.g. `0xbce3c47e83644d45b72a1c26ffffb8739c670efdc3714a4cc4bc9479612f5235`, `0xb00b7fdd1fbbb45df23ed7b8c62e725a0a52903e7a2d0e5e1cf89faf7c753a9d`)
  - sui — swap:trade (in SUI): 2 (e.g. `Fwe7LiXBfZz16XpQGy9AKSPsdri98b22SviX8zntiSp5`, `6qH9pf6Gn9XcvoaJjTR8LD3Gdqg7QpYFwZAz6PPVKr53`)
  - sui — lend_borrow:repay+lend_supply:deposit (out USDC): 2 (e.g. `G3zswdqGKjSCLQH5ecZNkuGWmaoxQWUznaC9fGfHeGTS`)
  - base — lp_fee:collect (in USDC): 2 (e.g. `0x94dbd7af16bebc6c944e3113ab5bdb9fb502d129fadcee9253144cf403d24b87`, `0x5b305737313aa7f48db0fae50e53487314f345604334986385992d934f925f2b`)
  - base — lp_deposit:add_liquidity (out WETH): 2 (e.g. `0xb7dbd0979c498028d271a22af6db6619661219a7e8963ce8ddcd08f9aa240e4c`, `0x9b65b90a11bf79c53eb0556e976663671da2c72a75d2c20c282adb0645ef6bb5`)
  - solana — swap:trade (out 5YMkXAYccH…): 1 (e.g. `L3q1kEpy6fCT9JC1WbeCNTo5oXamEHBrytCVH7yk7Zqq9sqVjRZRzyXthzkpxcv2JJRMTq6xMD4yURBqRhL6b29`)
  - solana — swap:trade (in USDC): 1 (e.g. `L3q1kEpy6fCT9JC1WbeCNTo5oXamEHBrytCVH7yk7Zqq9sqVjRZRzyXthzkpxcv2JJRMTq6xMD4yURBqRhL6b29`)
  - solana — swap:trade (in 8Jx8AAHj86…): 1 (e.g. `2gJKQhWetqbK6nDCJxQ6ebpSuh2PnPDwDopcy2VDec7AVywNc4ppSqNxytEoaMqSHohHniYJrp25eHLBrew27pkf`)
  - solana — swap:trade (out 8Jx8AAHj86…): 1 (e.g. `2gJKQhWetqbK6nDCJxQ6ebpSuh2PnPDwDopcy2VDec7AVywNc4ppSqNxytEoaMqSHohHniYJrp25eHLBrew27pkf`)
  - solana — swap:trade (in SOL): 1 (e.g. `2gJKQhWetqbK6nDCJxQ6ebpSuh2PnPDwDopcy2VDec7AVywNc4ppSqNxytEoaMqSHohHniYJrp25eHLBrew27pkf`)
  - solana — swap:trade (out jupSoLaHXQ…): 1 (e.g. `3ovpcACxWa8s91649thnjEzHafhtytpifhMQcK5xT5UTH28oZQoe2epiW6WkXuCEkT8H78tJMvxEk1jyXWMszjwQ`)
  - solana — swap:trade (in 5YMkXAYccH…): 1 (e.g. `3CzuT6oUpYYAukddSekvk5dTYr1YbYuj3CdnabqyRJrZMEq2x4wM5ZUaurRQiZhyMsjBCDR2kx5SgFadrd2BcCho`)
  - sui — swap:trade (out USDC): 1 (e.g. `FgfHXGRvTJxyVF5NJUPtNXjXLtVTS9m3i8wYB72ekMKQ`)
  - solana — swap:trade (in JITOSOL): 1 (e.g. `38K8VeiXbZU67JiGbqZsxLsYrZWEJDZBzLPagxBkRZbmL5P7ChpLAtmjYyA9URWjAGfiDy3Fw6ctw845XYZZnZ4H`)
  - sui — lp_deposit:open_position (out SUI): 1 (e.g. `Fwe7LiXBfZz16XpQGy9AKSPsdri98b22SviX8zntiSp5`)
  - sui — swap:trade (out sSUI): 1 (e.g. `6neETEZ7Lor21By6mo8DPXzHyHzxdZuxYRqcksg1mSZj`)
  - sui — lend_reward:claim (in IKA): 1 (e.g. `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`)
  - sui — lend_supply:deposit (out IKA): 1 (e.g. `DgPWNqqcqudQrd1XExZtQ2ZCBYq3SnV82zhXFo3xBx77`)
  - sui — lend_reward:claim (in HAEDAL): 1 (e.g. `G63Xc3XSQXoF1V9TKPsXNEouXD5pHu1RREonP3gGwGbX`)
  - sui — lend_supply:deposit (out HAEDAL): 1 (e.g. `G63Xc3XSQXoF1V9TKPsXNEouXD5pHu1RREonP3gGwGbX`)
  - sui — lend_supply:deposit (out SUI): 1 (e.g. `6qH9pf6Gn9XcvoaJjTR8LD3Gdqg7QpYFwZAz6PPVKr53`)
  - solana — swap:trade (out EUSX): 1 (e.g. `4EZH9dUTQNxRPaU8MX6UtUbGyBxLSXXFemmch9K4AH1EYvkjdSsc92ieXu1KGrZWnkLFdsKkNcANDfccU2N6YF1D`)
  - base — swap:trade (in USDC): 1 (e.g. `0x974101ee515b86da7eeae7d5c7dcfb02954aedb83b3bd21e92a9e7dbf9241a27`)
  - base — transfer:send (out cbBTC): 1 (e.g. `0x99c9dac6c9ac26dd8963bce8d9773110163892522d8bdc01650f583356bf0242`)
  - base — swap:trade (out AERO): 1 (e.g. `0x9c6f24e08f91d3e17381f5e18ffd5bec7ca8be2adb6fad68e85e860985534c95`)
  - solana — swap:trade (out USX): 1 (e.g. `2tcL13Z2zP7rstbjM4jxX1hXsDBQhW7raHFyVhrj6mza6DKJwQKvm1LPFN6idGRCW6KcRDpp42S1fUV78UATar8`)
  - solana — swap:trade (in EUSX): 1 (e.g. `2tcL13Z2zP7rstbjM4jxX1hXsDBQhW7raHFyVhrj6mza6DKJwQKvm1LPFN6idGRCW6KcRDpp42S1fUV78UATar8`)
  - solana — swap:trade (out USDT): 1 (e.g. `2Jr3UY4gS9jKvFUb3AWp8Kr6KEcgPBifUNMpyBK1RHF75xGN4xa1jzzhwgPCwjYWkSCbiGrJRYovHEUqL7DNCEtZ`)
  - sui — swap:trade (in vSUI): 1 (e.g. `2LWZ7qC8iYwcDuqUdopaJUiMrUnjdJJdekiwPGmu7mE4`)
  - sui — lend_supply:deposit (out vSUI): 1 (e.g. `2LWZ7qC8iYwcDuqUdopaJUiMrUnjdJJdekiwPGmu7mE4`)
  - sui — lend_borrow:borrow (in SUI): 1 (e.g. `2LWZ7qC8iYwcDuqUdopaJUiMrUnjdJJdekiwPGmu7mE4`)

Heuristic (no Trx. ID) rows: 0 rows → 0 legs matched
via (timestamp ±2 min, asset, amount).

Inferred decimals (assets without a confident static entry):

| chain:symbol | inferred decimals | vote share | samples | event asset ids |
|---|---|---|---|---|
| solana:AI16Z | 9 | 100% | 42 | HeLp6NuQkm…V98jwC |
| solana:CRT | 9 | 100% | 3 | CRTx1JouZh…ARTy2s |
| solana:EUSX | 6 | 100% | 5 | 3ThdFZQKM6…xop1WC |
| solana:PUMP | 6 | 100% | 27 | pumpCmXqMf…7H9Dfn |
| solana:USX | 6 | 100% | 11 | 6FrrzDk5mQ…6p3tgG |

## Classification agreement (matched legs)

- agree (their label ∈ expected set for our type:subtype): 980
- their-fallback (swap legs Blockpit recorded as bare Deposit/Withdrawal — Blockpit decode gap, not ours): 229
- disagree: 30

Disagreements:

- lp_deposit:add_liquidity (out) vs 'Trade': 7 (e.g. `5av92iE5UGhHVrZrtG1Pqp8392CfUQWwyGbyhMwPtBke (SUI)`, `0xbce3c47e83644d45b72a1c26ffffb8739c670efdc3714a4cc4bc9479612f5235 (WETH)`, `0xb00b7fdd1fbbb45df23ed7b8c62e725a0a52903e7a2d0e5e1cf89faf7c753a9d (WETH)`)
- lp_withdraw:remove_liquidity (in) vs 'Trade': 7 (e.g. `0x8d02a9a45868107ac51d44b7ebed36d5b389f12655305ecec3487fb511f8fe44 (VIRTUAL)`, `0x55f47c39de62ef182d8da49da7976a40bb0c959e6c6a7017a7448bcfef6ce74b (USDC)`, `0x74550efdcfca798e1c572462f87b9867b4cbe1bcd2a068cba7d8ed0e90ea766c (cbBTC)`)
- lp_deposit:open_position (out) vs 'Trade': 6 (e.g. `3XZtPh5uooJZfMiCJRT9GHbzHZDcJgLVVVy2rFfojgKX (SUI)`, `7Tzzqcgx3GZprfmabz5YuGyYm8kMH4Q7VA97bSD2wUy (SUI)`, `Ep32TVHnRd99UwPbYaSfdqgPjRjPkTBHELo2aJVngPW5 (SUI)`)
- lp_fee:collect (in) vs 'Trade': 2 (e.g. `0xbce3c47e83644d45b72a1c26ffffb8739c670efdc3714a4cc4bc9479612f5235 (USDC)`, `0xb00b7fdd1fbbb45df23ed7b8c62e725a0a52903e7a2d0e5e1cf89faf7c753a9d (USDC)`)
- transfer:wrap (out) vs 'Withdrawal': 2 (e.g. `0x3e145b543fa73b33302b857c0a09d368259915187422953f30ae9858e383dbd4 (ETH)`, `0xd1bdbb0d8fc255f4a59943ea4eb8d26441998bfcac0171947e3b385d3f487e17 (ETH)`)
- transfer:wrap (in) vs 'Deposit': 2 (e.g. `0x3e145b543fa73b33302b857c0a09d368259915187422953f30ae9858e383dbd4 (WETH)`, `0xd1bdbb0d8fc255f4a59943ea4eb8d26441998bfcac0171947e3b385d3f487e17 (WETH)`)
- transfer:send (out) vs 'Trade': 2 (e.g. `0xb7dbd0979c498028d271a22af6db6619661219a7e8963ce8ddcd08f9aa240e4c (USDC)`, `0x9b65b90a11bf79c53eb0556e976663671da2c72a75d2c20c282adb0645ef6bb5 (USDC)`)
- transfer:unwrap (in) vs 'Deposit': 2 (e.g. `0x99c9dac6c9ac26dd8963bce8d9773110163892522d8bdc01650f583356bf0242 (ETH)`, `0x9c6f24e08f91d3e17381f5e18ffd5bec7ca8be2adb6fad68e85e860985534c95 (ETH)`)

Full matrix (our type:subtype × their Label):

| ours | dir | their label | count |
|---|---|---|---|
| lp_deposit:add_liquidity | out | Withdrawal | 303 |
| lp_fee:collect | in | Deposit | 265 |
| swap:trade | out | Withdrawal | 116 |
| swap:trade | in | Deposit | 113 |
| swap:trade | out | Trade | 97 |
| swap:trade | in | Trade | 96 |
| lp_withdraw:remove_liquidity | in | Deposit | 91 |
| lp_withdraw:close_position | in | Deposit | 48 |
| lp_deposit:open_position | out | Withdrawal | 24 |
| lp_reward:gauge_claim | in | Deposit | 24 |
| lend_supply:withdraw | in | Deposit | 8 |
| lp_deposit:add_liquidity | out | Trade | 7 |
| lp_withdraw:remove_liquidity | in | Trade | 7 |
| lp_deposit:open_position | out | Trade | 6 |
| transfer:wrap | out | Trade | 6 |
| transfer:wrap | in | Trade | 6 |
| lp_reward:emission_claim | in | Deposit | 4 |
| lend_supply:deposit | out | Withdrawal | 3 |
| lp_fee:collect | in | Trade | 2 |
| lend_borrow:borrow | in | Deposit | 2 |
| transfer:wrap | out | Withdrawal | 2 |
| transfer:wrap | in | Deposit | 2 |
| transfer:send | out | Trade | 2 |
| lend_borrow:repay | out | Withdrawal | 2 |
| transfer:unwrap | in | Deposit | 2 |
| lend_reward:claim | in | Income | 1 |

## Classification agreement vs SOURCE B (corrected pipeline output — source of truth)

- corrected CSV: `/home/felix/Code/Misc/defi-tracker/liquidity-sheets/tax-report-2025/04d-lp-positions/Transactions_with_lp_corrections.csv` — 2011 data rows
- known-synthetic injected rows (Trx. ID `lp-…`, LP basis carry-forward legs, no on-chain tx): 39
- excluded (same scope rules as A): CEX 83, Ethereum 44, Polygon 2, Manual 2, other 0
- in-scope corrected txs: 1084; matched against DB events: 689; corrected txs with no DB events (mostly same gaps as source A): 394
- DB event txs absent from B: removed-by-correction (Sickle/NPM rows replaced by synthetic position rows): 54 (e.g. `0x08b61bc2d9fc3c3cedeb5c859a75ac713042e5f916bc9c3eef4c0ca8bf67f6ea`, `0x0c789df51e227279f433bfc2023b753b75f57a2f0f6f599860a9aee805b28e4c`, `0x0eff15c033e0a258861e5f8b8f37e5266ed1275414b13c4a9f4f9b6c4f14a8ae`); gas-only: 7; outside range: 3; other: 10

Paired legs: 1165

- **agree** (their corrected label ∈ expected set): 643 (55.2%)
- their-fallback (un-fixed Blockpit fallback swap rows that survived into B): 0
- **disagree**: 522 (44.8%)

Disagreements (residual = B label identical to raw export, i.e. their pipeline never corrected the leg; deliberate = their correction actively chose this label):

- lp_deposit:add_liquidity (out) vs 'Withdrawal': 177 (residual 177 / deliberate 0; comments: (none)×177)
  - examples: `4YksFZt9AEsq4tBXFaLyLXXXwTZaHgW66viXf4yMcGzDJtZ3Dse2aV6yQV3RzttKQkzZ8ZEfdEKTvtNpVtj9br6y (SOL)`, `4YksFZt9AEsq4tBXFaLyLXXXwTZaHgW66viXf4yMcGzDJtZ3Dse2aV6yQV3RzttKQkzZ8ZEfdEKTvtNpVtj9br6y (USDC)`, `3HrjazDv8avLV6ciKhgoe6ARknWqHUANas7LGrfWZDS6rxzcs5LoVbaV2eVerKXac3yMzrMVf1h9176QJkvJYzyB (SOL)`
- swap:trade (out) vs 'Withdrawal': 101 (residual 101 / deliberate 0; comments: (none)×92, SwapAndUnstake×5, SwapAndStake×1, SwapAndDeposit×1)
  - examples: `3RX6p382iXWqX5qmST73XYQtLozMEMmdAL5kV78dMhoWTqsVVUgLAUruknwWRcrHxqevDjYDp4v2iZtMUydDUbnL (SOL)`, `TDEAWnToXHbt8vidHGhvpEacCp2aWMpQhpCLU8spf2H5GuD1Rsj2GUu9bWHDuActiPAR53xgQY6J6xCuCAjJGdP (USDC)`, `45JFG5xL7KmQv5L4BCCmwandwmJ1nSKF91URxHg2RyZmCH2iUDBKdHsXz87bwbUXpDZCUY43p2ZtXTsqbSeJTudB (USDC)`
- swap:trade (in) vs 'Deposit': 100 (residual 100 / deliberate 0; comments: (none)×93, SwapAndUnstake×5, SwapAndStake×1, SwapAndDeposit×1)
  - examples: `3RX6p382iXWqX5qmST73XYQtLozMEMmdAL5kV78dMhoWTqsVVUgLAUruknwWRcrHxqevDjYDp4v2iZtMUydDUbnL (USDC)`, `TDEAWnToXHbt8vidHGhvpEacCp2aWMpQhpCLU8spf2H5GuD1Rsj2GUu9bWHDuActiPAR53xgQY6J6xCuCAjJGdP (SOL)`, `3HrjazDv8avLV6ciKhgoe6ARknWqHUANas7LGrfWZDS6rxzcs5LoVbaV2eVerKXac3yMzrMVf1h9176QJkvJYzyB (USDC)`
- lp_fee:collect (in) vs 'Non-Taxable In': 65 (residual 0 / deliberate 65; comments: (none)×56, Fallback×5, RemoveLiquidity×3, UniV3Family_ClaimRewards×1)
  - examples: `4YSXDohLwPbRu2XomX8awK9XkHiFJSXtEBYDiT7SQTRtBrpxmQ97VN8zQ8pnac4wiDjtC84jUY7Z5VwrFtPmQ3J8 (USDC)`, `5ocy3J3Sh9gnTquZEaWWebExztceRqYYAbx9JCnug3XETYLkEeraNcaxonh2EqzBtRPD27diN55HEuUCKK7oPZTT (USDC)`, `GDDCaGJ9UePQEaGk8wwUfxJEYm4H8z5c4k1TPbJZwTSz (USDC)`
- lp_fee:collect (in) vs 'Deposit': 36 (residual 36 / deliberate 0; comments: (none)×36)
  - examples: `3Fk1M7aLzzkLptNvQbdmxrqoMgjUocAvsP1tE5ECvfyhftTRihMjVUDVD9hCjoHiQ3rszoXMJafFsBNRmvEF8Xo8 (EUSX)`, `3Fk1M7aLzzkLptNvQbdmxrqoMgjUocAvsP1tE5ECvfyhftTRihMjVUDVD9hCjoHiQ3rszoXMJafFsBNRmvEF8Xo8 (USX)`, `3SVCZdXtx6DgYnURTuvf4R9YtLJk9gevVcqMofwjg7q1GdVaH1VgdYEhMb1w1cC7PwbrxzQstpusdXE4tUGnMvP5 (SOL)`
- swap:trade (in) vs 'Non-Taxable In': 17 (residual 0 / deliberate 17; comments: (none)×8, AddLiquidityAndStake×5, AddLiquidityAndDeposit×3, UnstakeAndClaim×1)
  - examples: `VDCq4TwCjiggv2Zg5hF2BzxJwjBZM6Vr1MjREPDBHZWdraoLSeYxv7UVmFKwVpbznx62MdwmeNyQ816iY8X7gcj (USDC)`, `Aqr9ohEKUMSd9dZv1fXxnrq1b6K5WkwW9KhbKV4vJgQp (USDC)`, `5av92iE5UGhHVrZrtG1Pqp8392CfUQWwyGbyhMwPtBke (USDC)`
- swap:trade (out) vs 'Non-Taxable Out': 13 (residual 0 / deliberate 13; comments: (none)×8, AddLiquidityAndDeposit×2, AddLiquidityAndStake×2, Stake×1)
  - examples: `VDCq4TwCjiggv2Zg5hF2BzxJwjBZM6Vr1MjREPDBHZWdraoLSeYxv7UVmFKwVpbznx62MdwmeNyQ816iY8X7gcj (SOL)`, `D3zvNEpEUviXvWVA8AHDywqetfCy56iGGjYvfg8ELBnr (SUI)`, `HLb7YBPoadKxeKRvJ35PLKLvtjnWvB1MktZLK6MTYdN1 (SUI)`
- lend_supply:withdraw (in) vs 'Deposit': 4 (residual 4 / deliberate 0; comments: Withdraw×4)
  - examples: `53ShnYC2xJmY9PAZ4pm7smSS1z7nPMxF5W3NnBSXWkSX (USDC)`, `CT3XSYZVszwiWKD2njC1VHUyVcyAnLoMdwfdrQWJCypg (NAVX)`, `Cz7EwXyXNynSQqjeSNkseiQ6BeFuRBxSZk98uL58Wp2M (VSUI)`
- lp_reward:gauge_claim (in) vs 'Non-Taxable In': 4 (residual 0 / deliberate 4; comments: Fallback×4)
  - examples: `0x695a4dd540fc5cbabbadd3fadc67b282d80b0e34f879ee9c943365fd503e0ed8 (AERO)`, `0x84b5c4df0d4752c2c832b28f1ba93d47cf62ba21681afc0b10a778009d5a435c (AERO)`, `0x54c323b4173ed05d6a865af40c867b873fc09ddd21429997ebcf78880bf1c6b8 (AERO)`
- lp_withdraw:remove_liquidity (in) vs 'Deposit': 3 (residual 3 / deliberate 0; comments: (none)×3)
  - examples: `2QjyicHtNRW8y9SDifKgcmi7g9ik3xZLtPSWwVhfHaNER1KeuL2iZmXqH7XXCS49Gik7sfpWXH1tnVjzPmzE2gDy (SOL)`, `2QjyicHtNRW8y9SDifKgcmi7g9ik3xZLtPSWwVhfHaNER1KeuL2iZmXqH7XXCS49Gik7sfpWXH1tnVjzPmzE2gDy (USDC)`, `5V13mCQmPAE12fV74EassPbwJHyHFqKiPkeovy5Bp8yMYC768ngFzBEgPXwtCWmwQfLqhESoUKYHrzteydB8Yyxj (SOL)`
- lp_deposit:open_position (out) vs 'Withdrawal': 1 (residual 1 / deliberate 0; comments: SwapAndUnstake×1)
  - examples: `Fwe7LiXBfZz16XpQGy9AKSPsdri98b22SviX8zntiSp5 (USDC)`
- lend_supply:withdraw (in) vs 'Reward': 1 (residual 0 / deliberate 1; comments: WithdrawAndClaim×1)
  - examples: `gxCmw33JbPqbo8qgVJNQSqDvRC2caw4RxHRaCTCX1ez (SSUI)`

Full matrix vs B (our type:subtype × their corrected Label):

| ours | dir | their label | count |
|---|---|---|---|
| lp_deposit:add_liquidity | out | Withdrawal | 177 |
| lp_deposit:add_liquidity | out | Non-Taxable Out | 133 |
| lp_fee:collect | in | Reward | 130 |
| swap:trade | out | Trade | 104 |
| swap:trade | out | Withdrawal | 101 |
| swap:trade | in | Deposit | 100 |
| swap:trade | in | Trade | 96 |
| lp_withdraw:remove_liquidity | in | Non-Taxable In | 95 |
| lp_fee:collect | in | Non-Taxable In | 65 |
| lp_fee:collect | in | Deposit | 36 |
| lp_deposit:open_position | out | Non-Taxable Out | 30 |
| lp_withdraw:close_position | in | Non-Taxable In | 27 |
| swap:trade | in | Non-Taxable In | 17 |
| swap:trade | out | Non-Taxable Out | 13 |
| lp_reward:gauge_claim | in | Reward | 13 |
| lp_reward:emission_claim | in | Reward | 4 |
| lend_supply:withdraw | in | Deposit | 4 |
| lp_reward:gauge_claim | in | Non-Taxable In | 4 |
| lp_withdraw:remove_liquidity | in | Deposit | 3 |
| lend_supply:withdraw | in | Non-Taxable In | 3 |
| lend_supply:deposit | out | Non-Taxable Out | 3 |
| lend_borrow:borrow | in | Non-Taxable In | 2 |
| lend_borrow:repay | out | Non-Taxable Out | 2 |
| lp_deposit:open_position | out | Withdrawal | 1 |
| lend_supply:withdraw | in | Reward | 1 |
| lend_reward:claim | in | Income | 1 |

## Amount agreement — deterministic sample of 50 matched flow groups

- within 0.5% tolerance: 47/50
- mean relative diff: 3.6466%; max: 75.6751%
- outliers:
  - `0x8eb2cef09b64f7c38a4b308a1d1677b22938542cdbec1a03af1e94e73a3bd89f` out ETH: csv=0.10881703385240764 vs events=0.21625868353583186 (49.68%)
  - `2LWZ7qC8iYwcDuqUdopaJUiMrUnjdJJdekiwPGmu7mE4` out SUI: csv=125 vs events=288.968 (56.74%)
  - `3LguhXnTxPih2WLa2RZYmrczWK1TWzFNCmyugKtTaWv7pBZpw34VWoqy7GjXp3n9sZuAdiTFm6kNNfDH1iqMkmxc` in SOL: csv=0.013688044 vs events=0.003329604 (75.68%)

Amount mismatches across ALL matched groups (> 0.5%), categorized:

- total: 150/1237
- **unexplained (lp_fee:collect)**: 52
  - `0x94dbd7af16bebc6c944e3113ab5bdb9fb502d129fadcee9253144cf403d24b87` in WETH: csv=0.000049089761864566 vs events=0.03305156744515248 (99.85%)
  - `2YcsHWjdzuFr2LAUHmLoUPuiuWTdmAVo1rrPMttqqnry1W1BLYTQZbEvPRESG94oBZkBiYpoMmccYi8mhJFvut2s` in SOL: csv=0.010382634 vs events=0.000029694 (99.71%)
  - `0x871bf4372369a03346d6c3bae6df917c17af7a93c93fe7bc211e39b9bc65d5cc` in USDC: csv=0.109041 vs events=24.552991 (99.56%)
  - `j5qSA4DkDkaj1VhtCptCMwRJ8gwGc8yFw8PAZnfZ1TfrFczVCgto8u8wHmgKq9jR9vAzYxHoxp2NkLLpotrtVrP` in SOL: csv=0.010413705 vs events=0.000052414 (99.50%)
- **unexplained (swap:trade)**: 23
  - `Aqr9ohEKUMSd9dZv1fXxnrq1b6K5WkwW9KhbKV4vJgQp` in USDC: csv=1.890572 vs events=1292.646575 (99.85%)
  - `Brv8CBYYh5v2JAKCdKTJQdw89PUuHwFVwDA8aez1WRDw` in USDC: csv=2.639706 vs events=1355.99759 (99.81%)
  - `3fpvsdyK9yaey5Z8kgNV5drR4FeK7cWPuBC6e5xAcxp98Px3a1ugkXMD1ZF7it4n3mdkvHTqT3GBn8tfhfENKCy9` in JITOSOL: csv=0.061109988 vs events=27.499445894 (99.78%)
  - `0x0c789df51e227279f433bfc2023b753b75f57a2f0f6f599860a9aee805b28e4c` in USDC: csv=0.032931 vs events=6.927412 (99.52%)
- **dust-vs-internal-leg**: 19
  - `0x3e145b543fa73b33302b857c0a09d368259915187422953f30ae9858e383dbd4` in WETH: csv=1.303e-15 vs events=7.2484705 (100.00%)
  - `0xd1bdbb0d8fc255f4a59943ea4eb8d26441998bfcac0171947e3b385d3f487e17` in WETH: csv=1.39e-15 vs events=0.24992737246630348 (100.00%)
  - `0xe9373c02b539416fc4a04589e375e49d1c9fd43474ab9750e4100c304e974964` in WETH: csv=6.29e-16 vs events=0.04212155516091576 (100.00%)
  - `0x871bf4372369a03346d6c3bae6df917c17af7a93c93fe7bc211e39b9bc65d5cc` in WETH: csv=1.34e-16 vs events=0.006634011279801774 (100.00%)
- **unexplained (lp_deposit:add_liquidity)**: 14
  - `5RHb73EmaJYjwsgdoAbh3bvG6WwaStEekCZDVGUG2B8YVCSti9iqzE4Zrt8enSGfyxwo1kDD3fvBRuHYHfc4x4R4` out SOL: csv=0.010600506 vs events=0.000230634 (97.82%)
  - `3LkmFz8RKrFsnG7YFJo4h7UoLGwBWZkszRSLiqNhDYvtc4QdhytC542E99a752ZLuqZ4r1uspUrTjJn2MTAoFiAB` out SOL: csv=0.012245516 vs events=0.001878688 (84.66%)
  - `5nxzBfbnB5MUahKd1GDjx6RaKCheVkKAFBkeQ8YmrwQocMroTD6YuyyWbWbxd1dyPx3ejSKxLdQBPs32hRn1dmTz` out SOL: csv=0.094071397 vs events=0.083701387 (11.02%)
  - `4hs6wxyuLvXjNgkXscyCM4Nz8HGejVQ9sbbog1dk7b8no2EChHjPs9DJsvjNA2kDsH6kFzxUH2TQ1ZHeJLGtuEQK` out SOL: csv=0.243404243 vs events=0.233038279 (4.26%)
- **custody-chain double-count (send + lp leg)**: 8
  - `0x3e145b543fa73b33302b857c0a09d368259915187422953f30ae9858e383dbd4` out ETH: csv=7.255 vs events=14.5034705 (49.98%)
  - `0xd1bdbb0d8fc255f4a59943ea4eb8d26441998bfcac0171947e3b385d3f487e17` out ETH: csv=0.25015250972505604 vs events=0.5000798821913582 (49.98%)
  - `0xb480f44aa0e0e843aaadeef86028df74d846b566cb64590b66c4eeee0342eabb` out ETH: csv=1.0955760165315174 vs events=2.18981497246491 (49.97%)
  - `0x974101ee515b86da7eeae7d5c7dcfb02954aedb83b3bd21e92a9e7dbf9241a27` out ETH: csv=0.019878200369744237 vs events=0.03973024922195666 (49.97%)
- **zap multi-type group (lp_fee:collect+lp_withdraw:close_position)**: 7
  - `0x8558e9b4eb95d74030618e8bc8e98c3e206935e966b157031303017ece80a063` in WETH: csv=0.008476713838908398 vs events=7.030822372839689 (99.88%)
  - `0xc28013f43ce2087929f6693955a378ebd9ee68e0297487207f3840b458bdd061` in USDC: csv=8.592807 vs events=6383.69236 (99.87%)
  - `0x313ff0c5c31ff57305ce55b9275219522e230ffcddaff05ca30fbdfb69e8c70c` in WETH: csv=0.009410337301557376 vs events=6.711577390768815 (99.86%)
  - `0x6e22d4b90d7feb09271e3205921f5a1d05ca46bf42df2897b203c223ea6e64fc` in USDC: csv=5.552151 vs events=2172.818072 (99.74%)
- **unexplained (lp_reward:gauge_claim)**: 5
  - `0x99c9dac6c9ac26dd8963bce8d9773110163892522d8bdc01650f583356bf0242` in AERO: csv=0.000007850466995185 vs events=0.000350872807454903 (97.76%)
  - `0x9c6f24e08f91d3e17381f5e18ffd5bec7ca8be2adb6fad68e85e860985534c95` in AERO: csv=0.000188162013475398 vs events=0.002785031091348885 (93.24%)
  - `0x7e1222ccd5d2ae650456d3d2fb70a413ec971cedadaef19a5177cd51e8a8e495` in AERO: csv=0.003600886271473432 vs events=0.003633588568590748 (0.90%)
  - `0x35b82b2b2a9cda4aa6f305b65e7dab01cbf96156e97329b1a6d5faf4a1de6882` in AERO: csv=0.002886352315016659 vs events=0.002912565403649504 (0.90%)
- **zap multi-type group (lp_withdraw:remove_liquidity+lp_fee:collect)**: 5
  - `5X64vdftP7YAv7GwCnjRLdq6QXTtNrUz2gBT2CsnwjhF5WGhAspoMW2DXDB3KogMiJUf2ouWaqA4HZTrRH7trmQF` in SOL: csv=0.069557434 vs events=0.059194995 (14.90%)
  - `3Ze68eUMaUQ9sDniu8yN88Ddyc1xVS44TLJKnHFDBNgMatx16aY4HPdYDMwEQ8x2dGdaekz35qXE5U7J9BMBpxrv` in SOL: csv=0.07554417 vs events=0.065261498 (13.61%)
  - `GimsyTnmuKMf6j4Httw2HHFNQhWvhSzMR3DTpxvEnCWB1oh4JtA2x7WgqA34uSiLFXo71tBaLWZVtaEu6ycvCbG` in SOL: csv=0.133501735 vs events=0.123139795 (7.76%)
  - `3eELqtpjLgkeKCTrKagjGCxN1rXkn44nT8i47aHvLu52ZfkcEsQi9SKkwBittpaZ67Qi4q7BFHxPbrqbWHbaWod9` in SOL: csv=0.545552894 vs events=0.535190455 (1.90%)
- **unexplained (transfer:wrap)**: 4
  - `0x7df837d32e31a68f8027c28ee1434952842409f615d8e9338fda44b0ce3093de` in WETH: csv=0.003344803818560007 vs events=1.1376056548950189 (99.71%)
  - `0x71a4bd9e455e7f78709361b59aad3cbbfd47888c47eb1af04849e4704eb7b669` in WETH: csv=0.002034606166050608 vs events=0.50744440338425 (99.60%)
  - `0xe6c791dec29238d9961d5fce19d3f2f26f34ae7c1196314aac331755ba1ab601` in WETH: csv=0.035351082545383446 vs events=7.097954103831905 (99.50%)
  - `0x8eb2cef09b64f7c38a4b308a1d1677b22938542cdbec1a03af1e94e73a3bd89f` in WETH: csv=0.001277448838516248 vs events=0.10871909852194048 (98.83%)
- **unexplained (lp_withdraw:remove_liquidity)**: 3
  - `5RbFNMVZXARwk2SPEhRHGDYXfxxXCRwABGEMtEKLZGcDYA6D8q97mHN2RVJNQjYTWGVu4JYRV9C35BaMhnxUa27E` in SOL: csv=0.094061878 vs events=0.083701386 (11.01%)
  - `5f6P2bJKRkJQQCkeQ4N6dUuHPXdG9mhf7yuLJLZC4cfg19irzNQFDx9asXTBZhSQKu2kjXmaRdao97R72VG8GxMZ` in SOL: csv=0.659152556 vs events=0.648791622 (1.57%)
  - `3q9FsXJxHPYohzFiYHNRTSL9mWKd2vNG6KNC2BRaNkeouirW5xJbvLx8n63782YGkuFkzPWGstyHpihQqo6GHQSC` in SOL: csv=0.790813459 vs events=0.78045918 (1.31%)
- **zap multi-type group (lp_fee:collect+lp_withdraw:close_position+swap:trade)**: 2
  - `0xfb0e3bb8153f39028dfeb60e4f3e3ddc39d066c9ff48d192b7426f3202bb5e43` in USDC: csv=3.224821 vs events=2522.799652 (99.87%)
  - `0x6e22d4b90d7feb09271e3205921f5a1d05ca46bf42df2897b203c223ea6e64fc` in WETH: csv=0.003738801830441931 vs events=1.21398666302374 (99.69%)
- **zap multi-type group (lp_withdraw:close_position+transfer:unwrap)**: 2
  - `0x5eb68141ec18388f12161a368ec22312d26a157097fc5e810376cbe22e1c8cf7` in ETH: csv=7.250572622204204 vs events=14.501145244408407 (50.00%)
  - `0x8c12fb60cfbcd34cda4710f616f8e30193a7f567cd3b4a8bf281e4188e816cd3` in ETH: csv=7.121234822702879 vs events=14.242469645405759 (50.00%)
- **unexplained (lp_withdraw:close_position)**: 1
  - `0x99c9dac6c9ac26dd8963bce8d9773110163892522d8bdc01650f583356bf0242` in USDC: csv=0.144762 vs events=132.698361 (99.89%)
- **zap multi-type group (swap:trade+lp_withdraw:close_position)**: 1
  - `0x9c6f24e08f91d3e17381f5e18ffd5bec7ca8be2adb6fad68e85e860985534c95` in USDC: csv=0.217049 vs events=99.187499 (99.78%)
- **zap multi-type group (lp_withdraw:close_position+lp_fee:collect)**: 1
  - `FgfHXGRvTJxyVF5NJUPtNXjXLtVTS9m3i8wYB72ekMKQ` in USDC: csv=7.602203 vs events=133.415288 (94.30%)
- **zap multi-type group (transfer:unwrap+lp_withdraw:close_position)**: 1
  - `0x9c6f24e08f91d3e17381f5e18ffd5bec7ca8be2adb6fad68e85e860985534c95` in ETH: csv=0.06608934109293683 vs events=0.10745658124903491 (38.50%)
- **zap multi-type group (swap:trade+lp_deposit:add_liquidity)**: 1
  - `4DKhGWuCRZAmquknbLEfuLCzMsxFXUjgVG5RqqG9AAJa` out SUI: csv=1383.51015408 vs events=1451.918881158 (4.71%)
- **zap multi-type group (swap:trade+lp_deposit:open_position)**: 1
  - `5UM9TAzSxdNZbooKw4mMSgxwGYnvRVWEKMD6XvQaZxdQ` out SUI: csv=7427.874044664 vs events=7567.026186912 (1.84%)

## Gas-fee agreement (CSV fee columns vs our gas:fee events, per tx)

- txs with a fee on both sides: 119; agree within 0.5%: 119 (100.0%)

