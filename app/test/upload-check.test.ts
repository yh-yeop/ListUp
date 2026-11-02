import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkUploadPlan, describeUploadCheck, formatCount, type UploadPlanInput } from '../src/lib/pure/upload-check';

/** 기존 파일(경로 → 크기)로 입력을 만든다. fileCount·totalSize 는 기존 목록에서. */
function plan(existing: Record<string, number> | null, items: [string, number][], over: Partial<UploadPlanInput> = {}) {
  const map = existing ? new Map(Object.entries(existing)) : null;
  return checkUploadPlan({
    items: items.map(([path, size]) => ({ path, size })),
    existing: map,
    fileCount: map ? map.size : 0,
    totalSize: map ? [...map.values()].reduce((sum, size) => sum + size, 0) : 0,
    maxFiles: 5000,
    maxRepoBytes: null,
    ...over,
  });
}

// 서버의 같은 사례: server/test/files.test.ts 「파일이 있는 이름 아래에는…」「폴더가 있는 이름으로는…」,
// server/test/commit.test.ts 「새 파일끼리 파일·폴더 이름이 겹치면 409」, server/test/proposals.test.ts 「용량 한도」.
describe('checkUploadPlan — 이름 겹침 (서버 findPathConflict 와 같은 판정)', () => {
  it('파일이 있는 이름 아래에는 올릴 수 없다 — 상대는 그 파일', () => {
    const check = plan({ '겹침/이름': 6 }, [['겹침/이름/안.txt', 1]]);
    assert.deepEqual(check.conflicts, [{ path: '겹침/이름/안.txt', against: '겹침/이름' }]);
  });

  it('파일 a 가 있으면 a/b.txt 는 겹친다', () => {
    assert.deepEqual(plan({ a: 1 }, [['a/b.txt', 1]]).conflicts, [{ path: 'a/b.txt', against: 'a' }]);
  });

  it('폴더가 있는 이름으로는 파일을 올릴 수 없다 — 상대는 그 아래 파일', () => {
    const check = plan({ '겹침/폴더/안.txt': 1 }, [['겹침/폴더', 6]]);
    assert.deepEqual(check.conflicts, [{ path: '겹침/폴더', against: '겹침/폴더/안.txt' }]);
  });

  it('새 항목끼리 파일·폴더 이름이 겹치면 둘 다 걸린다', () => {
    const check = plan({}, [
      ['x', 1],
      ['x/y', 1],
    ]);
    assert.deepEqual(check.conflicts, [
      { path: 'x', against: 'x/y' },
      { path: 'x/y', against: 'x' },
    ]);
  });

  it('같은 경로를 덮어쓰는 것은 겹침이 아니다', () => {
    assert.deepEqual(plan({ a: 1, 'b/c.txt': 1 }, [['a', 5], ['b/c.txt', 5]]).conflicts, []);
  });

  it('이름이 앞부분만 같은 것은 겹치지 않는다 (a 와 ab/c)', () => {
    assert.deepEqual(plan({ a: 1 }, [['ab/c', 1], ['a.txt', 1]]).conflicts, []);
  });

  it('전체 목록을 모르면(existing null) 겹침 검사를 건너뛴다', () => {
    assert.deepEqual(plan(null, [['a/b.txt', 1]]).conflicts, []);
  });

  it('NFD 로 들어온 경로도 NFC 로 고쳐 견준다', () => {
    const nfd = '사진'.normalize('NFD');
    // 서버 목록(NFC)의 파일 '사진' 아래로 NFD 경로 — 같은 이름이므로 겹친다.
    assert.deepEqual(plan({ 사진: 1 }, [[`${nfd}/a.txt`, 1]]).conflicts, [{ path: '사진/a.txt', against: '사진' }]);
    // NFD 로 같은 파일을 다시 올리면 덮어쓰기 — 겹침도, 새 파일도 아니다.
    const check = plan({ '사진/a.txt': 1 }, [[`${nfd}/a.txt`, 1]], { maxFiles: 1 });
    assert.deepEqual(check.conflicts, []);
    assert.equal(check.tooMany, null);
  });
});

describe('checkUploadPlan — 파일 수', () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 1]));

  it('기존 4999개 + 새 2개는 한도(5000)를 넘는다', () => {
    const check = plan(many(4999), [['new1', 1], ['new2', 1]]);
    assert.deepEqual(check.tooMany, { count: 5001, max: 5000 });
  });

  it('기존 4999개 + 새 1개는 꼭 한도라 괜찮다', () => {
    assert.equal(plan(many(4999), [['new1', 1]]).tooMany, null);
  });

  it('덮어쓰기는 수를 늘리지 않는다', () => {
    assert.equal(plan(many(5000), [['f0', 2], ['f1', 2]]).tooMany, null);
    assert.deepEqual(plan(many(4999), [['f0', 2], ['new1', 1], ['new2', 1]]).tooMany, { count: 5001, max: 5000 });
  });

  it('전체 목록을 모르면 모두 새 파일로 센다', () => {
    const check = plan(null, [['a', 1], ['b', 1]], { fileCount: 4999 });
    assert.deepEqual(check.tooMany, { count: 5001, max: 5000 });
  });
});

describe('checkUploadPlan — 용량 (서버 assertRepoBytes 와 같은 셈)', () => {
  it('한도 100 에 60 이 있으면 50 을 더 올릴 수 없다', () => {
    assert.deepEqual(plan({ 'a.bin': 60 }, [['b.bin', 50]], { maxRepoBytes: 100 }).tooBig, { bytes: 110, max: 100 });
  });

  it('덮어쓰는 파일은 옛 크기를 빼고 센다 — 60 → 100 은 꼭 한도라 괜찮다', () => {
    assert.equal(plan({ 'a.bin': 60 }, [['a.bin', 100]], { maxRepoBytes: 100 }).tooBig, null);
    assert.deepEqual(plan({ 'a.bin': 100 }, [['b.bin', 1]], { maxRepoBytes: 100 }).tooBig, { bytes: 101, max: 100 });
  });

  it('한도를 모르면(maxRepoBytes null — API_LEVEL 6 미만 서버) 용량은 보지 않는다', () => {
    assert.equal(plan({ 'a.bin': 60 }, [['b.bin', 1e12]]).tooBig, null);
  });
});

describe('describeUploadCheck', () => {
  it('문제가 없으면 null', () => {
    assert.equal(describeUploadCheck(plan({ a: 1 }, [['b', 1]])), null);
  });

  it('겹침은 앞의 3건만 적고 나머지는 「외 N건 더」', () => {
    const notice = describeUploadCheck(
      plan({ a: 1 }, [['a/1', 1], ['a/2', 1], ['a/3', 1], ['a/4', 1], ['a/5', 1]]),
    );
    assert.equal(notice?.tone, 'error');
    assert.equal(notice?.title, '이름이 겹쳐 올릴 수 없습니다.');
    assert.equal(
      notice?.message,
      '파일과 폴더는 같은 이름을 쓸 수 없습니다.\na/1 ↔ 파일 a\na/2 ↔ 파일 a\na/3 ↔ 파일 a\n외 2건 더',
    );
  });

  it('폴더와 겹치면 「폴더」로 적는다', () => {
    const notice = describeUploadCheck(plan({ 'a/b.txt': 1 }, [['a', 1]]));
    assert.match(notice?.message ?? '', /^a ↔ 폴더 a$/m);
  });

  it('여럿이 걸리면 제목은 첫 문제, 나머지는 본문에', () => {
    const notice = describeUploadCheck(plan({ a: 1 }, [['a/b', 200]], { fileCount: 5000, maxRepoBytes: 100 }));
    assert.equal(notice?.title, '이름이 겹쳐 올릴 수 없습니다.');
    assert.match(notice?.message ?? '', /파일이 너무 많아 올릴 수 없습니다\.\n저장소당 파일은 최대 5,000개인데, 올리면 5,001개가 됩니다\./);
    assert.match(notice?.message ?? '', /저장소 용량 한도를 넘어 올릴 수 없습니다\./);
  });

  it('천 단위 쉼표', () => {
    assert.equal(formatCount(5000), '5,000');
    assert.equal(formatCount(999), '999');
    assert.equal(formatCount(1234567), '1,234,567');
  });
});
