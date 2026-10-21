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

function serverNameFor(value: string | undefined) {
  const before = process.env.LISTUP_SERVER_NAME;
  if (value === undefined) delete process.env.LISTUP_SERVER_NAME;
  else process.env.LISTUP_SERVER_NAME = value;
  try {
    return loadConfig().serverName;
  } finally {
    if (before === undefined) delete process.env.LISTUP_SERVER_NAME;
    else process.env.LISTUP_SERVER_NAME = before;
  }
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(next)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(values);
  try {
    return run();
  } finally {
    apply(before);
  }
}

describe('LISTUP_AUTH_SECRET', () => {
  it('개발에서 안 주면 매번 새로 만든다', () => {
    const secret = withEnv({ LISTUP_AUTH_SECRET: undefined, NODE_ENV: 'development' }, () => loadConfig().authSecret);
    assert.match(secret, /^[0-9a-f]{64}$/);
  });

  it('production 에서 안 주면 뜨지 않는다', () => {
    assert.throws(
      () => withEnv({ LISTUP_AUTH_SECRET: undefined, NODE_ENV: 'production' }, () => loadConfig()),
      /LISTUP_AUTH_SECRET 환경변수가 필요합니다/,
    );
  });

  it('주었으면 32자 이상이어야 한다 — 빈 값은 개발에서도 거부', () => {
    for (const NODE_ENV of ['development', 'production']) {
      for (const value of ['', 'short', 'a'.repeat(31)]) {
        assert.throws(
          () => withEnv({ LISTUP_AUTH_SECRET: value, NODE_ENV }, () => loadConfig()),
          /32자 이상/,
          `${NODE_ENV} ${JSON.stringify(value)}`,
        );
      }
    }
    const key = 'k'.repeat(32);
    assert.equal(withEnv({ LISTUP_AUTH_SECRET: key, NODE_ENV: 'production' }, () => loadConfig().authSecret), key);
  });
});

describe('LISTUP_SERVER_NAME', () => {
  it('없거나 공백뿐이면 null', () => {
    assert.equal(serverNameFor(undefined), null);
    assert.equal(serverNameFor('   '), null);
  });

  it('제어 문자·겹친 공백을 정리하고 60자로 자른다', () => {
    assert.equal(serverNameFor('  우리집\n\t음악서버  '), '우리집 음악서버');
    assert.equal(serverNameFor('가'.repeat(80))?.length, 60);
  });
});

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
