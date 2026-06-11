import { canonicalAsset } from './assets';
import type { Chain } from '../types/event';

/**
 * Pure transfer-matching engine for [1D.2] + issue #11.
 *
 * Two heuristics over decoded `transfer:send` / `transfer:receive` events
 * (all events in the DB belong to own wallets by construction — handlers only
 * emit events for configured wallets):
 *
 * 1. `same_asset_30min_own_wallet` (issue #11, same chain): send from own
 *    wallet A + receive at own wallet B, same raw asset id, amount within
 *    ±0.5%, inside a 30-min window. Exact amount → confidence 1.0, shaved →
 *    0.8.
 * 2. `cross_chain_same_asset_30min` ([1D.2]): send on chain A + receive on
 *    chain B, same CANONICAL asset (registry-normalized, decimals-adjusted),
 *    amount similarity ≥ 0.9 (bridge fees shave the received side), inside a
 *    30-min window. Confidence = 0.7·amountSimilarity + 0.3·timeProximity.
 *
 * Candidate pairs are resolved greedily by confidence; each event joins at
 * most one link. A chosen pair where either side had multiple viable
 * candidates is 'pending' (TUI review), an unambiguous pair is 'confirmed'.
 */
export interface TransferLeg {
  eventId: number;
  chain: Chain;
  wallet: string;
  txHash: string;
  /** Epoch seconds. */
  timestamp: number;
  /** Chain-local asset id exactly as stored on the event. */
  asset: string;
  /** Raw amount in native units. */
  amount: bigint;
}

export type LinkHeuristic = 'same_asset_30min_own_wallet' | 'cross_chain_same_asset_30min';

export interface LinkMatch {
  outEventId: number;
  inEventId: number;
  confidence: number;
  status: 'confirmed' | 'pending';
  heuristic: LinkHeuristic;
  kind: 'self_transfer' | 'bridge';
}

export const LINK_WINDOW_SECONDS = 1800;

/** Same-chain amount tolerance: ±0.5% (issue #11). */
const SELF_TRANSFER_TOLERANCE_BPS = 50n;
/** Cross-chain minimum amount similarity after bridge fees. */
const MIN_BRIDGE_AMOUNT_SIMILARITY = 0.9;

interface Candidate {
  out: TransferLeg;
  in: TransferLeg;
  confidence: number;
  dt: number;
  heuristic: LinkHeuristic;
  kind: LinkMatch['kind'];
}

function withinWindow(out: TransferLeg, inn: TransferLeg): number | undefined {
  const dt = Math.abs(inn.timestamp - out.timestamp);
  return dt <= LINK_WINDOW_SECONDS ? dt : undefined;
}

function selfTransferCandidate(out: TransferLeg, inn: TransferLeg): Candidate | undefined {
  if (out.chain !== inn.chain) return undefined;
  if (out.wallet === inn.wallet) return undefined;
  if (out.asset !== inn.asset) return undefined;
  const dt = withinWindow(out, inn);
  if (dt === undefined) return undefined;
  const max = out.amount > inn.amount ? out.amount : inn.amount;
  const diff = out.amount > inn.amount ? out.amount - inn.amount : inn.amount - out.amount;
  // diff/max ≤ 0.5% — bigint-exact: diff·10000 ≤ max·50.
  if (diff * 10_000n > max * SELF_TRANSFER_TOLERANCE_BPS) return undefined;
  return {
    out,
    in: inn,
    confidence: diff === 0n ? 1.0 : 0.8,
    dt,
    heuristic: 'same_asset_30min_own_wallet',
    kind: 'self_transfer',
  };
}

function bridgeCandidate(out: TransferLeg, inn: TransferLeg): Candidate | undefined {
  if (out.chain === inn.chain) return undefined;
  const dt = withinWindow(out, inn);
  if (dt === undefined) return undefined;
  const outAsset = canonicalAsset(out.chain, out.asset);
  const inAsset = canonicalAsset(inn.chain, inn.asset);
  if (outAsset === undefined || inAsset === undefined) return undefined;
  if (outAsset.symbol !== inAsset.symbol) return undefined;
  // Decimals-normalized cross-multiplication keeps the ratio bigint-exact
  // (Number(amount) is lossy above 2^53 — any 18-decimals amount over ~9 tokens).
  const outScaled = out.amount * 10n ** BigInt(inAsset.decimals);
  const inScaled = inn.amount * 10n ** BigInt(outAsset.decimals);
  if (outScaled <= 0n || inScaled <= 0n) return undefined;
  const [minScaled, maxScaled] =
    outScaled < inScaled ? [outScaled, inScaled] : [inScaled, outScaled];
  const amountSimilarity = Number((minScaled * 1_000_000n) / maxScaled) / 1_000_000;
  if (amountSimilarity < MIN_BRIDGE_AMOUNT_SIMILARITY) return undefined;
  const timeProximity = 1 - dt / LINK_WINDOW_SECONDS;
  const confidence = Math.round((0.7 * amountSimilarity + 0.3 * timeProximity) * 10_000) / 10_000;
  return {
    out,
    in: inn,
    confidence,
    dt,
    heuristic: 'cross_chain_same_asset_30min',
    kind: 'bridge',
  };
}

/**
 * Match outgoing legs against incoming legs. Self-transfer candidates rank
 * above bridge candidates for the same legs implicitly via confidence; greedy
 * resolution guarantees each event appears in at most one returned link.
 */
export function matchTransfers(
  outs: readonly TransferLeg[],
  ins: readonly TransferLeg[],
): LinkMatch[] {
  const candidates: Candidate[] = [];
  for (const out of outs) {
    for (const inn of ins) {
      const candidate = selfTransferCandidate(out, inn) ?? bridgeCandidate(out, inn);
      if (candidate !== undefined) candidates.push(candidate);
    }
  }

  // Ambiguity is judged against the full viable-candidate set, before greedy
  // consumption: an event with ≥2 viable partners yields a 'pending' link.
  const outCandidateCount = new Map<number, number>();
  const inCandidateCount = new Map<number, number>();
  for (const c of candidates) {
    outCandidateCount.set(c.out.eventId, (outCandidateCount.get(c.out.eventId) ?? 0) + 1);
    inCandidateCount.set(c.in.eventId, (inCandidateCount.get(c.in.eventId) ?? 0) + 1);
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.dt - b.dt ||
      a.out.eventId - b.out.eventId ||
      a.in.eventId - b.in.eventId,
  );

  const usedOut = new Set<number>();
  const usedIn = new Set<number>();
  const matches: LinkMatch[] = [];
  for (const c of candidates) {
    if (usedOut.has(c.out.eventId) || usedIn.has(c.in.eventId)) continue;
    usedOut.add(c.out.eventId);
    usedIn.add(c.in.eventId);
    const ambiguous =
      (outCandidateCount.get(c.out.eventId) ?? 0) > 1 ||
      (inCandidateCount.get(c.in.eventId) ?? 0) > 1;
    matches.push({
      outEventId: c.out.eventId,
      inEventId: c.in.eventId,
      confidence: c.confidence,
      status: ambiguous ? 'pending' : 'confirmed',
      heuristic: c.heuristic,
      kind: c.kind,
    });
  }
  return matches;
}
