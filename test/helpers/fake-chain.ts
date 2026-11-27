import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  type Hex,
  hexToBigInt,
  isAddressEqual,
  multicall3Abi,
  parseAbi,
  stringToHex,
} from 'viem';
import { type Endpoint, startRpcServer } from './rpc-server.js';

/** Behaviour of one fake contract. Absent from the table = an address with no code. */
export interface FakeContract {
  symbol?: string;
  symbolBytes32?: string;
  decimals?: number;
  balances?: Record<Address, bigint>;
  revert?: boolean;
  /** Return data by 4-byte selector, answered for any arguments; takes precedence over the fields above. */
  raw?: Record<Hex, Hex>;
  /** Return data computed from the full calldata; undefined falls through. Takes precedence over `raw`. */
  respond?: (callData: Hex) => Hex | undefined;
}

export interface FakeChain extends Endpoint {
  /** Block number of every eth_call received, in order. */
  callBlocks: bigint[];
  /** Target of every call inside the received multicalls, in order. */
  callTargets: Address[];
}

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const innerAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function getEthBalance(address) view returns (uint256)',
]);

interface CallResult {
  success: boolean;
  returnData: Hex;
}

const REVERT: CallResult = { success: false, returnData: '0x' };

function lookup<T>(table: Record<Address, T>, address: Address): T | undefined {
  const key = (Object.keys(table) as Address[]).find((k) => isAddressEqual(k, address));
  return key === undefined ? undefined : table[key];
}

function answer(c: FakeContract, name: string, args: readonly unknown[]): CallResult {
  const ok = (returnData: Hex): CallResult => ({ success: true, returnData });
  if (name === 'symbol' && c.symbol !== undefined) {
    return ok(encodeAbiParameters([{ type: 'string' }], [c.symbol]));
  }
  if (name === 'symbol' && c.symbolBytes32 !== undefined) {
    return ok(stringToHex(c.symbolBytes32, { size: 32 }));
  }
  if (name === 'decimals' && c.decimals !== undefined) {
    return ok(encodeAbiParameters([{ type: 'uint8' }], [c.decimals]));
  }
  if (name === 'balanceOf' && c.balances) {
    const balance = lookup(c.balances, args[0] as Address) ?? 0n;
    return ok(encodeAbiParameters([{ type: 'uint256' }], [balance]));
  }
  return REVERT;
}

function decodeInner(
  callData: Hex,
): { functionName: string; args: readonly unknown[] } | undefined {
  try {
    const { functionName, args = [] } = decodeFunctionData({ abi: innerAbi, data: callData });
    return { functionName, args };
  } catch {
    return undefined;
  }
}

/**
 * In-process JSON-RPC chain for unit tests: answers eth_getBlockByNumber and Multicall3 aggregate3
 * eth_calls from a table of fake contracts, so multicall decoding paths run without a network.
 */
export async function startFakeChain(opts: {
  blockNumber: bigint;
  /** Timestamp of the latest block (default 1). */
  timestamp?: bigint;
  contracts: Record<Address, FakeContract>;
  ethBalances?: Record<Address, bigint>;
  /** Behaviour of every address absent from `contracts` (default: no code). */
  fallback?: FakeContract;
}): Promise<FakeChain> {
  const callBlocks: bigint[] = [];
  const callTargets: Address[] = [];
  const inner = (target: Address, callData: Hex): CallResult => {
    callTargets.push(target);
    const contract = lookup(opts.contracts, target) ?? opts.fallback;
    const computed = contract?.respond?.(callData);
    if (computed !== undefined) return { success: true, returnData: computed };
    const raw = contract?.raw?.[callData.slice(0, 10).toLowerCase() as Hex];
    if (raw !== undefined) return { success: true, returnData: raw };
    const decoded = decodeInner(callData);
    if (decoded?.functionName === 'getEthBalance' && isAddressEqual(target, MULTICALL3)) {
      const balance = lookup(opts.ethBalances ?? {}, decoded.args[0] as Address) ?? 0n;
      return { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [balance]) };
    }
    if (!contract) return { success: true, returnData: '0x' }; // no code: empty success
    if (contract.revert || !decoded) return REVERT; // unknown selector reverts
    return answer(contract, decoded.functionName, decoded.args);
  };
  const server = await startRpcServer(({ method, params }) => {
    const p = (params ?? []) as unknown[];
    if (method === 'eth_getBlockByNumber') {
      const timestamp = `0x${(opts.timestamp ?? 1n).toString(16)}`;
      return { result: { number: `0x${opts.blockNumber.toString(16)}`, timestamp } };
    }
    if (method !== 'eth_call') return { error: { code: -32601, message: `fake: ${method}` } };
    const { data } = p[0] as { data: Hex };
    callBlocks.push(hexToBigInt(p[1] as Hex));
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    const calls = decoded.args[0] as readonly { target: Address; callData: Hex }[];
    const results = calls.map((c) => inner(c.target, c.callData));
    return {
      result: encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: results,
      }),
    };
  });
  return { ...server, callBlocks, callTargets };
}
