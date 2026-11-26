import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/lib/logger.js';

function capture() {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on('data', (d) => chunks.push(String(d)));
  return { out, text: () => chunks.join('') };
}

afterEach(() => vi.restoreAllMocks());

describe('createLogger', () => {
  it('writes one JSON line with level, msg, time', () => {
    const { out, text } = capture();
    createLogger('info', [], out).info('hello', { a: 1 });
    const lines = text().trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] as string);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', a: '1' });
    expect(new Date(rec.time).toISOString()).toBe(rec.time);
  });
  it('drops messages below level', () => {
    const { out, text } = capture();
    const log = createLogger('info', [], out);
    log.debug('d');
    expect(text()).toBe('');
    log.warn('w');
    log.error('e');
    expect(text().trim().split('\n')).toHaveLength(2);
  });
  it('redacts secrets in msg and fields', () => {
    const { out, text } = capture();
    createLogger('info', ['SECRET'], out).info('url SECRET', { u: 'https://h/SECRET', n: 5 });
    expect(text()).not.toContain('SECRET');
    expect(text()).toContain('[REDACTED]');
  });
  it('writes nothing to stdout and defaults to stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createLogger('info', []).info('x');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
