import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressFacts, troubleshootAdvice } from '../src/lib/pure/troubleshoot';

describe('연결 문제 해결 — 주소 모양', () => {
  it('공유기 안·이 기기 주소를 알아본다', () => {
    assert.equal(addressFacts('http://192.168.0.10:4000').localNetwork, true);
    assert.equal(addressFacts('http://10.1.2.3').localNetwork, true);
    assert.equal(addressFacts('http://172.20.0.1:4000').localNetwork, true);
    assert.equal(addressFacts('http://172.40.0.1:4000').localNetwork, false);
    assert.equal(addressFacts('http://localhost:4000').localNetwork, false);
    assert.equal(addressFacts('http://localhost:4000').thisDevice, true);
    assert.equal(addressFacts('http://127.0.0.1:4000').thisDevice, true);
    assert.equal(addressFacts('http://192.168.0.10').thisDevice, false);
    assert.equal(addressFacts('https://listup.example.com').localNetwork, false);
  });

  it('빠른 터널 주소', () => {
    assert.equal(addressFacts('https://abc-def.trycloudflare.com').quickTunnel, true);
    assert.equal(addressFacts('https://listup.example.com').quickTunnel, false);
  });

  it('https 페이지의 http 주소만 혼합 콘텐츠 — 앱(null)과 localhost 는 아니다', () => {
    assert.equal(addressFacts('http://192.168.0.10:4000', 'https:').mixedContent, true);
    assert.equal(addressFacts('http://192.168.0.10:4000', 'http:').mixedContent, false);
    assert.equal(addressFacts('http://192.168.0.10:4000', null).mixedContent, false);
    assert.equal(addressFacts('http://localhost:4000', 'https:').mixedContent, false);
    assert.equal(addressFacts('https://listup.example.com', 'https:').mixedContent, false);
  });

  it('주소가 아니면 모두 false', () => {
    assert.deepEqual(addressFacts('아무거나'), { thisDevice: false, localNetwork: false, quickTunnel: false, mixedContent: false });
  });
});

describe('연결 문제 해결 — 안내', () => {
  const none = { thisDevice: false, localNetwork: false, quickTunnel: false, mixedContent: false };

  it('들어갈 수 있으면 확인할 것이 없다', () => {
    assert.equal(troubleshootAdvice({ status: 'ok', version: '1.10.0' }, none).steps.length, 0);
  });

  it('버전이 다르면 누구를 업데이트할지만', () => {
    const older = troubleshootAdvice({ status: 'server-older', version: '1.1.0' }, none);
    assert.match(older.summary, /v1\.1\.0/);
    assert.equal(older.steps[0].title, '서버 업데이트');
    assert.equal(troubleshootAdvice({ status: 'app-older' }, none).steps[0].title, '앱 업데이트');
  });

  it('주소 모양으로 짚은 원인이 이유별 확인보다 먼저 온다', () => {
    const advice = troubleshootAdvice(
      { status: 'unreachable', reason: 'network' },
      { thisDevice: false, localNetwork: true, quickTunnel: false, mixedContent: true },
    );
    assert.match(advice.steps[0].title, /https/);
    assert.match(advice.steps[1].title, /공유기/);
    assert.ok(advice.steps.some((step) => step.title === '이 기기의 인터넷'));
  });

  it('이유마다 요약이 다르다 — HTTP 상태를 보인다, ListUp 이 아니면 포트를 권한다', () => {
    assert.match(troubleshootAdvice({ status: 'unreachable', reason: 'timeout' }, none).summary, /시간 안에/);
    assert.match(troubleshootAdvice({ status: 'unreachable', reason: 'http', httpStatus: 530 }, none).summary, /530/);
    const notListup = troubleshootAdvice({ status: 'unreachable', reason: 'not-listup' }, none);
    assert.ok(notListup.steps.some((step) => step.title === '포트'));
    const quick = troubleshootAdvice({ status: 'unreachable', reason: 'http', httpStatus: 530 }, { ...none, quickTunnel: true });
    assert.match(quick.steps[0].title, /빠른 터널/);
  });
});
