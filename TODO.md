# Study TODO — reviewing agent-written code for liquidity-tax

Topics to study so I can judge the implementation as PRs land. Ordered by leverage.

## Tier 1 — must own; testing alone won't catch errors here

- [ ] **German §23 crypto tax** — what counts as disposal vs. income; 1-year Haltefrist reset; LP deposit stance (our assumption: not a disposal)
  - Read: https://koinly.io/blog/defi-tax-germany/
  - Affects: `[0.2]` matrix, `[1A.2]` label map, `[1C.4]` haSUI policy
- [ ] **Koinly custom-CSV semantics** — what each accepted label does in the tax engine; `reward` vs `stake` vs `lending interest` vs blank → Liquidity In/Out
  - Read: https://support.koinly.io/en/articles/9489976 (cover-to-cover)
  - Affects: `[1A.2]`, `[1D.4]`
- [ ] **Uniswap V3 rebalance semantics** — fee vs principal split when `decreaseLiquidity + collect` happen in one tx
  - Read: Uniswap V3 whitepaper §6 "Fee Accounting" — https://uniswap.org/whitepaper-v3.pdf
  - Affects: `[1A.3]` (the single most error-prone handler case)

## Tier 2 — read enough to spot when the agent is bluffing

- [ ] **EVM event logs + ABI decoding** — topic0/1-3, indexed vs data, viem's `getLogs` + `parseAbi` + `decodeEventLog`
  - Read: https://viem.sh/docs/actions/public/getLogs
  - Affects: `[1A.1]`, every EVM handler
- [ ] **Aave V3 scaled-balance math** — aToken = scaled × liquidityIndex; RAY 1e27 fixed-point
  - Read: Aave V3 technical paper §3 — https://github.com/aave/aave-v3-core/blob/master/techpaper/Aave_V3_Technical_Paper.pdf
  - Affects: `[1A.5]` and the `lend_interest:accrued` decision if ever revisited
- [ ] **Aerodrome / Velodrome ve(3,3)** — why gauge rewards ≠ LP fees (different source, different tax treatment)
  - Read: Velodrome docs gauges one-pager
  - Affects: `[1A.4]`

## Tier 3 — TS patterns for matrix-style code

- [ ] **Mapped types + indexed access** (the `TaxEventMap[T]` trick)
  - Read: https://www.typescriptlang.org/docs/handbook/2/mapped-types.html + https://www.typescriptlang.org/docs/handbook/2/indexed-access-types.html
  - Affects: `[0.2]` reviewability
- [ ] **Discriminated unions + `satisfies`** — narrow typing when handlers emit `TaxEvent`s
  - Read: https://www.typescriptlang.org/docs/handbook/2/narrowing.html
  - Affects: every handler PR

## Tier 4 — ramp into as PRs arrive

- [ ] **Drizzle** — `.$type<T>()`, `blob({mode:'bigint'})`, `drizzle-kit` migration loop
  - Read: https://orm.drizzle.team/docs/get-started-sqlite
  - When: first exposure in `[0.1]` PR
- [ ] **Solana transaction model** — accounts, CPI depth, instruction discriminators
  - When: Phase 1B issues file
- [ ] **Sui object model + Move events** — object IDs, shared vs owned, Move event struct layout
  - When: Phase 1C issues file

---

## Suggested schedule

- This weekend (~4 hrs): Tier 1 end-to-end
- Before reviewing `[0.2]` PR (~1 hr): Tier 3 both items
- Spread across first 3–4 PRs (~2 hrs total): Tier 2
- Tier 4: on demand

**Single highest-leverage read:** Uniswap V3 whitepaper §6 — where the trickiest decoder math lives.
