export type Chain = 'base' | 'solana' | 'sui';

export type Wallet = {
  chain: Chain;
  address: string;
  label: string;
  status: 'active' | 'archived';
};

// Addresses are added per-phase when the first ingest adapter for each chain
// is wired in. See issue #1 ledger row L12 for the deferral rationale.
export const Wallets: ReadonlyArray<Wallet> = [];
