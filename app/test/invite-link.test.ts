import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appLinkFor, inviteLinkFor, isLocalNetworkAddress } from '../src/lib/invite-link';

describe('초대 링크', () => {
  it('서버 주소 끝의 / 를 떼고 코드를 붙인다', () => {
    assert.equal(inviteLinkFor('https://listup.example.com/', 'AB CD'), 'https://listup.example.com/join?code=AB%20CD');
  });

  it('앱 링크에는 서버 주소와 코드가 함께 들어간다', () => {
    assert.equal(
      appLinkFor('http://192.168.0.10:4000', 'X1'),
      'listup://join?server=http%3A%2F%2F192.168.0.10%3A4000&code=X1',
    );
  });

  it('같은 네트워크 안에서만 닿는 주소를 알아본다', () => {
    for (const url of ['http://localhost:4000', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.0.10:4000', 'http://172.20.0.1', 'http://nas.local']) {
      assert.equal(isLocalNetworkAddress(url), true, url);
    }
    for (const url of ['https://listup.tailffc023.ts.net', 'http://172.32.0.1', 'http://8.8.8.8', '주소 아님']) {
      assert.equal(isLocalNetworkAddress(url), false, url);
    }
  });
});
