export const CHAIN_IDS = ['ethereum', 'base', 'arbitrum', 'polygon'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];
