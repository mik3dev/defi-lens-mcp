/** One `allowFailure` multicall result; `result` is untrusted until its type is checked. */
export interface Outcome {
  status: 'success' | 'failure';
  result?: unknown;
}

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumber = (v: unknown): v is number => typeof v === 'number';
export const isBigint = (v: unknown): v is bigint => typeof v === 'bigint';

/** The result of a successful call that passes `guard`; undefined otherwise. */
export function success<T>(
  outcome: Outcome | undefined,
  guard: (v: unknown) => v is T,
): T | undefined {
  return outcome?.status === 'success' && guard(outcome.result) ? outcome.result : undefined;
}
