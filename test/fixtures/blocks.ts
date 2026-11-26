import type { ChainId } from '../../src/chains.js';

/**
 * Blocks the chain tests fork and record at. Each value is the chain's latest finalized block
 * minus 1 000 on the day of pinning. Changing a value requires re-recording:
 * `RECORD=1 pnpm test:fork`.
 */
export const PINNED: Record<ChainId, bigint> = {
  ethereum: 26_499_763n, // finalized 26_500_763 − 1 000 on 2026-11-26
  base: 62_611_111n, // finalized 62_612_111 − 1 000 on 2026-11-26
  arbitrum: 527_782_324n, // finalized 527_783_324 − 1 000 on 2026-11-26
  polygon: 98_004_500n, // finalized 98_005_500 − 1 000 on 2026-11-26
};
