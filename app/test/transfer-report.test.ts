import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canCancel,
  describeUploadOutcome,
  phaseLabel,
  type UploadSummary,
} from '../src/lib/pure/transfer-report';

const summary = (over: Partial<UploadSummary>): UploadSummary => ({
  total: 3,
  uploaded: 3,
  failures: [],
  cancelled: false,
  commit: { added: 3, updated: 0 },
  ...over,
});

describe('describeUploadOutcome', () => {
  it('첫 파일 도중 멈춤 — 저장소는 그대로라고 알린다', () => {
    const notice = describeUploadOutcome(summary({ uploaded: 0, cancelled: true, commit: null }));
    assert.deepEqual(notice, { tone: 'info', title: '멈췄습니다 — 0/3개 올림', message: '저장소는 그대로입니다.' });
  });

  it('둘째 파일 도중 멈춤 — 다 올린 것은 반영했다고 알린다', () => {
    const notice = describeUploadOutcome(summary({ uploaded: 1, cancelled: true, commit: { added: 1, updated: 0 } }));
    assert.equal(notice?.title, '멈췄습니다 — 1/3개 올림');
    assert.equal(notice?.message, '다 올린 파일은 저장소에 반영했습니다. 나머지는 올리지 않았습니다.');
  });

  it('실패는 앞의 3건만 적고 나머지는 「외 N건 더」', () => {
    const failures = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, message: '너무 큽니다' }));
    const notice = describeUploadOutcome(summary({ total: 6, uploaded: 1, failures }));
    assert.equal(notice?.tone, 'error');
    assert.equal(notice?.title, '1개 올렸습니다.');
    assert.equal(notice?.message, '5개는 올리지 못했습니다.\na: 너무 큽니다\nb: 너무 큽니다\nc: 너무 큽니다\n외 2건 더');
  });

  it('실패가 3건 이하면 「외」 줄이 없다', () => {
    const notice = describeUploadOutcome(summary({ uploaded: 2, failures: [{ name: 'x', message: '권한 없음' }] }));
    assert.equal(notice?.message, '1개는 올리지 못했습니다.\nx: 권한 없음');
  });

  it('여러 개를 올리면 추가·수정 수를 알린다', () => {
    const notice = describeUploadOutcome(summary({ commit: { added: 2, updated: 1 } }));
    assert.deepEqual(notice, { tone: 'success', title: '3개 올렸습니다 — 추가 2 · 수정 1' });
  });

  it('여러 개를 올렸는데 바뀐 것이 없으면 그렇게 알린다', () => {
    const notice = describeUploadOutcome(summary({ commit: { added: 0, updated: 0 } }));
    assert.equal(notice?.title, '바뀐 파일이 없습니다.');
  });

  it('1개를 그대로 올렸으면 토스트 없음', () => {
    assert.equal(describeUploadOutcome(summary({ total: 1, uploaded: 1, commit: { added: 1, updated: 0 } })), null);
  });
});

describe('canCancel', () => {
  it('보내는 중에는 멈출 수 있다(phase 가 없으면 sending)', () => {
    assert.equal(canCancel({ phase: 'sending', doneFiles: 0, totalFiles: 1 }), true);
    assert.equal(canCancel({ doneFiles: 2, totalFiles: 3 }), true);
  });

  it('마지막 파일을 마무리하는 중에는 멈추지 못한다', () => {
    assert.equal(canCancel({ phase: 'finishing', doneFiles: 2, totalFiles: 3 }), false);
    assert.equal(canCancel({ phase: 'finishing', doneFiles: 0, totalFiles: 1 }), false);
  });

  it('중간 파일을 마무리하는 중에는 멈출 수 있다', () => {
    assert.equal(canCancel({ phase: 'finishing', doneFiles: 0, totalFiles: 3 }), true);
  });

  it('커밋 중에는 멈추지 못한다', () => {
    assert.equal(canCancel({ phase: 'committing', doneFiles: 3, totalFiles: 3 }), false);
  });
});

describe('phaseLabel', () => {
  it('보내는 중은 화면이 붙인 이름, 마무리·커밋은 단계 이름', () => {
    assert.equal(phaseLabel(undefined, '올리는 중'), '올리는 중');
    assert.equal(phaseLabel('sending', '담는 중'), '담는 중');
    assert.equal(phaseLabel('finishing', '올리는 중'), '서버에서 마무리하는 중');
    assert.equal(phaseLabel('committing', '올리는 중'), '반영하는 중');
    assert.equal(phaseLabel('committing', '올리는 중', '제안 만드는 중'), '제안 만드는 중');
  });
});
