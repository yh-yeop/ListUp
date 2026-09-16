import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';

function trustProxyFor(value: string | undefined) {
  const before = process.env.LISTUP_TRUST_PROXY;
  if (value === undefined) delete process.env.LISTUP_TRUST_PROXY;
  else process.env.LISTUP_TRUST_PROXY = value;
  try {
    return loadConfig().trustProxy;
  } finally {
    if (before === undefined) delete process.env.LISTUP_TRUST_PROXY;
    else process.env.LISTUP_TRUST_PROXY = before;
  }
}

describe('LISTUP_TRUST_PROXY', () => {
  it('없으면 루프백 프록시만 믿는다', () => {
    assert.deepEqual(trustProxyFor(undefined), ['loopback']);
  });

  it('끔·전부·목록으로 읽는다', () => {
    assert.equal(trustProxyFor('0'), false);
    assert.equal(trustProxyFor('true'), true);
    assert.deepEqual(trustProxyFor('loopback, 10.0.0.0/8, ::1'), ['loopback', '10.0.0.0/8', '::1']);
  });

  it('잘못된 값이면 뜨지 않는다', () => {
    assert.throws(() => trustProxyFor('yes'));
    assert.throws(() => trustProxyFor('10.0.0.0/33'));
    assert.throws(() => trustProxyFor('10.0.0.1/8/2'));
  });
});
