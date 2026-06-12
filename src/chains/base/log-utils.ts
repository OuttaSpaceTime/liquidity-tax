import type { RawRpcLog } from './raw-json';

/**
 * Shared EVM receipt-log decoding utilities for the Base ingest and the Base
 * protocol handlers (uniswap-v3/aerodrome/aave-v3/morpho) — previously
 * copy-pasted per handler.
 */

/** keccak256('Transfer(address,address,uint256)') — ERC-20 and ERC-721. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Last 20 bytes of a 32-byte topic/word, lowercase `0x`-prefixed. */
export function topicAddress(word: string): string {
  return `0x${word.slice(-40)}`.toLowerCase();
}

/** uint256 data word `index` (0-based) of a log. */
export function dataWord(data: string, index: number): bigint {
  const start = 2 + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 0 ? 0n : BigInt(`0x${word}`);
}

/** int256 data word `index` (0-based) of a log, two's complement. */
export function signedWord(data: string, index: number): bigint {
  const start = 2 + index * 64;
  const word = data.slice(start, start + 64);
  if (word.length === 0) return 0n;
  let value = BigInt(`0x${word}`);
  if (value >= 1n << 255n) value -= 1n << 256n;
  return value;
}

/** A receipt log with decimal logIndex and lowercase emitter address. */
export interface ParsedLog {
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export function parseLog(log: RawRpcLog): ParsedLog {
  return {
    logIndex: Number.parseInt(log.logIndex, 16),
    address: log.address.toLowerCase(),
    topics: log.topics,
    data: log.data,
  };
}

/** One ERC-20 Transfer log, normalized for amount-matched token resolution. */
export interface Erc20Transfer {
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

/** All ERC-20 Transfer logs (3 topics — ERC-721 Transfers carry 4) in log order. */
export function erc20Transfers(logs: readonly ParsedLog[]): Erc20Transfer[] {
  return logs
    .filter((log) => log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3)
    .map((log) => ({
      logIndex: log.logIndex,
      token: log.address,
      from: topicAddress(log.topics[1]!),
      to: topicAddress(log.topics[2]!),
      value: dataWord(log.data, 0),
    }));
}
