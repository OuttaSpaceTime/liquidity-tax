/**
 * `raw_txs.raw_json` payload contract for chain=base — verbatim
 * Alchemy/JSON-RPC shapes (hex quantities), produced by `./ingest.ts` and
 * parsed by the Base protocol handlers. Types-only module so the decode layer
 * does not depend on the RPC-orchestration internals.
 */

export interface AlchemyAssetTransfer {
  hash: string;
  blockNum: string;
  from: string;
  to: string | null;
  category: string;
  asset?: string | null;
  value?: number | null;
  tokenId?: string | null;
  rawContract?: { address?: string | null; value?: string | null; decimal?: string | null };
  erc1155Metadata?: Array<{ tokenId: string; value: string }> | null;
  metadata?: { blockTimestamp?: string };
  uniqueId?: string;
}

export interface RawRpcTransaction {
  hash: string;
  from: string;
  to: string | null;
  blockNumber: string;
  value: string;
  input: string;
  gas: string;
  nonce: string;
  transactionIndex: string;
  [key: string]: unknown;
}

export interface RawRpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
  [key: string]: unknown;
}

export interface RawRpcReceipt {
  transactionHash: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  /** OP-stack L1 data fee — present on Base receipts. */
  l1Fee?: string | null;
  blockNumber: string;
  from: string;
  to: string | null;
  contractAddress: string | null;
  logs: RawRpcLog[];
  [key: string]: unknown;
}

/** Shape of `raw_txs.raw_json` for chain=base — protocol handlers parse this. */
export interface BaseRawJson {
  source: 'alchemy';
  tx: RawRpcTransaction;
  receipt: RawRpcReceipt;
  blockTimestamp: number;
  transfers: AlchemyAssetTransfer[];
  addresses: string[];
}

/** Structural guard: the payload iff it carries receipt logs + tx, else undefined. */
export function asBaseRawJson(rawJson: unknown): BaseRawJson | undefined {
  const candidate = rawJson as Partial<BaseRawJson> | null;
  if (candidate?.receipt?.logs === undefined || candidate.tx === undefined) return undefined;
  return candidate as BaseRawJson;
}
