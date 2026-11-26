import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { bearerAuth } from '../../../src/transports/http.js';

function run(authorization: string | undefined) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  const next = vi.fn();
  const req = { headers: authorization === undefined ? {} : { authorization } };
  bearerAuth(['T32a', 'T32b'])(
    req as unknown as Request,
    res as unknown as Response,
    next as NextFunction,
  );
  return { res, headers, next };
}

describe('bearerAuth', () => {
  const rejected = { error: 'unauthorized' };

  it('rejects a missing header', () => {
    const { res, headers, next } = run(undefined);
    expect(res.statusCode).toBe(401);
    expect(headers['WWW-Authenticate']).toBe('Bearer');
    expect(res.body).toEqual(rejected);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong token with the identical body', () => {
    const { res, headers, next } = run('Bearer wrong');
    expect(res.statusCode).toBe(401);
    expect(headers['WWW-Authenticate']).toBe('Bearer');
    expect(res.body).toEqual(rejected);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a Basic scheme', () => {
    const { res, next } = run('Basic VDMyYTpUMzJh');
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(rejected);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token that is only a prefix of a valid one', () => {
    expect(run('Bearer T32').res.statusCode).toBe(401);
    expect(run('Bearer ').res.statusCode).toBe(401);
  });

  it('accepts any configured token', () => {
    for (const token of ['T32a', 'T32b']) {
      const { next, res } = run(`Bearer ${token}`);
      expect(next).toHaveBeenCalledOnce();
      expect(res.statusCode).toBe(200);
    }
  });

  it('accepts a case-insensitive scheme', () => {
    expect(run('bearer T32a').next).toHaveBeenCalledOnce();
  });
});
