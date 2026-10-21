import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions } from '../src/lib/pure/versions';

const sign = (a: string, b: string) => Math.sign(compareVersions(a, b));

describe('compareVersions', () => {
  it('자리마다 숫자로 견준다 — 문자열로 견주면 1.10.0 이 1.9.9 보다 작다', () => {
    assert.equal(sign('1.10.0', '1.9.9'), 1);
    assert.equal(sign('1.9.9', '1.10.0'), -1);
    assert.equal(sign('2.0.0', '1.99.99'), 1);
    assert.equal(sign('1.7.10', '1.7.9'), 1);
  });

  it('같은 버전은 0 — 앞의 v(대소문자)·앞자리 0 은 무시한다', () => {
    assert.equal(compareVersions('1.7.1', '1.7.1'), 0);
    assert.equal(compareVersions('v1.7.1', '1.7.1'), 0);
    assert.equal(compareVersions('V1.7.1', 'v1.7.1'), 0);
    assert.equal(compareVersions('1.07.1', '1.7.1'), 0);
  });

  it('모자란 자리는 0 으로 본다', () => {
    assert.equal(compareVersions('1.8', '1.8.0'), 0);
    assert.equal(sign('1.8.1', '1.8'), 1);
    assert.equal(sign('1', '1.0.1'), -1);
  });

  it('-beta·+빌드 같은 꼬리는 무시한다 — 프리릴리즈는 같은 번호의 정식과 같다', () => {
    // GitHub releases/latest 는 프리릴리즈를 주지 않고, 앱 버전은 version:set 이 x.y.z 로만 받는다.
    assert.equal(compareVersions('1.8.0-beta.2', '1.8.0'), 0);
    assert.equal(compareVersions('1.8.0+5', '1.8.0'), 0);
    assert.equal(sign('1.8.0-rc.1', '1.7.9'), 1);
    assert.equal(sign('v1.10.0-beta', '1.9.9'), 1);
  });

  it('잘못된 문자열은 0.0.0 처럼 — NaN 을 내지 않는다', () => {
    for (const bad of ['', 'garbage', 'v', '1.x.3', '..', 'latest']) {
      assert.ok(Number.isFinite(compareVersions(bad, '1.0.0')), bad);
      assert.ok(Number.isFinite(compareVersions('1.0.0', bad)), bad);
    }
    assert.equal(compareVersions('', '0.0.0'), 0);
    assert.equal(compareVersions('garbage', '0'), 0);
    assert.equal(sign('garbage', '0.0.1'), -1);
    assert.equal(compareVersions('1.x.3', '1.0.3'), 0);
  });

  it('a,b 를 바꾸면 부호가 바뀐다', () => {
    const versions = ['0.9.0', '1.0.0', '1.2', '1.9.9', '1.10.0', 'v1.10.1', '2.0.0-beta', '10.0.0'];
    for (const a of versions) {
      for (const b of versions) assert.equal(sign(a, b), -sign(b, a) || 0, `${a} vs ${b}`);
    }
  });
});
