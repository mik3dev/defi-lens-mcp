import type { ChainId } from '../../src/chains.js';

/**
 * Blocks the chain tests fork and record at. Each value is the chain's latest finalized block
 * minus 1 000 on the day of pinning. Changing a value requires re-recording:
 * `RECORD=1 pnpm test:fork`.
 */
export const PINNED: Record<ChainId, bigint> = {
  ethereum: 0n, // set at recording time
  base: 0n, // set at recording time
  arbitrum: 0n, // set at recording time
  polygon: 0n, // set at recording time
};
