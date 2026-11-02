import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/index.ts';
import { listSnapshots, listTrash, listTree, readEntry, readManifest } from '../src/services/snapshots.ts';
import { auth, createHarness, createRepo, signup, uploadFile, type Harness, type Session } from './helpers.ts';

// 서비스 계층의 읽기 쿼리(휴지통·정렬·과거 한 파일 찾기)를 HTTP 로 쌓은 이력 위에서 직접 호출해 본다.

async function del(h: Harness, s: Session, repoId: string, path: string) {
  const res = await h.app.inject({
    method: 'DELETE',
    url: `/api/repos/${repoId}/files?path=${encodeURIComponent(path)}`,
    headers: auth(s),
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function move(h: Harness, s: Session, repoId: string, from: string, to: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/repos/${repoId}/files/move`,
    headers: auth(s),
    payload: { from, to },
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function put(h: Harness, s: Session, repoId: string, path: string, content: string) {
  const res = await uploadFile(h.app, s, repoId, path, content);
  assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
}

function headOf(db: Db, repoId: string): string {
  return (db.prepare(`SELECT head_snapshot_id AS h FROM repos WHERE id = ?`).get(repoId) as { h: string }).h;
}

/** listTrash 가 저장소 필터를 나중에 걸던 때의 쿼리 — 새 쿼리와 결과가 같아야 한다. */
function listTrashReference(db: Db, repoId: string, limit: number) {
  return db
    .prepare(
      `SELECT c.path, s.id AS snapshot_id, s.parent_id, s.message, s.created_at, s.author_id, u.display_name,
              c.prev_blob_hash, c.prev_size, c.prev_mime_type
         FROM snapshot_changes c
         JOIN snapshots s ON s.id = c.snapshot_id
         JOIN users u ON u.id = s.author_id
        WHERE s.repo_id = ?
          AND c.blob_hash IS NULL AND c.prev_blob_hash IS NOT NULL AND s.parent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM repo_files f WHERE f.repo_id = s.repo_id AND f.path = c.path)
          AND NOT EXISTS (
                SELECT 1 FROM snapshot_changes m
                 WHERE m.snapshot_id = c.snapshot_id AND m.prev_blob_hash IS NULL AND m.blob_hash = c.prev_blob_hash)
          AND NOT EXISTS (
                SELECT 1 FROM snapshot_changes l JOIN snapshots ls ON ls.id = l.snapshot_id
                 WHERE l.path = c.path AND ls.repo_id = s.repo_id
                   AND (ls.created_at > s.created_at OR (ls.created_at = s.created_at AND ls.id > s.id)))
        ORDER BY s.created_at DESC, s.id DESC, c.path
        LIMIT ?`,
    )
    .all(repoId, limit) as { path: string; snapshot_id: string }[];
}

describe('휴지통 쿼리 (listTrash)', () => {
  let h: Harness;
  let owner: Session;
  let repoA: string;
  let repoB: string;

  before(async () => {
    h = await createHarness();
    owner = await signup(h.app, '소유자');
    repoA = await createRepo(h.app, owner, '저장소 A');
    repoB = await createRepo(h.app, owner, '저장소 B');

    for (const p of ['keep.txt', 'gone.txt', 'again.txt', 'moved.txt', 'twice.txt', 'shared.txt']) {
      await put(h, owner, repoA, p, `A ${p} v1`);
    }
    await del(h, owner, repoA, 'gone.txt'); // 휴지통에 남는다
    await del(h, owner, repoA, 'again.txt'); // 다시 올리면 빠진다
    await put(h, owner, repoA, 'again.txt', 'A again v2');
    await move(h, owner, repoA, 'moved.txt', 'renamed.txt'); // 이름 바꾸기는 휴지통이 아니다
    await del(h, owner, repoA, 'twice.txt');
    await put(h, owner, repoA, 'twice.txt', 'A twice v2');
    await del(h, owner, repoA, 'twice.txt'); // 마지막 삭제 한 번만
    await del(h, owner, repoA, 'shared.txt'); // 같은 경로를 B 가 나중에 바꿔도 A 에는 영향이 없다

    // B 는 A 와 같은 경로를 쓴다
    await put(h, owner, repoB, 'shared.txt', 'B shared v1');
    await put(h, owner, repoB, 'b-only.txt', 'B only');
    await put(h, owner, repoB, 'gone.txt', 'B gone');
    await del(h, owner, repoB, 'b-only.txt');
    await put(h, owner, repoB, 'shared.txt', 'B shared v2'); // A 의 shared.txt 삭제보다 나중
    await del(h, owner, repoB, 'gone.txt');
  });
  after(async () => {
    await h.close();
  });

  const keys = (rows: { path: string; snapshotId: string }[]) => rows.map((r) => `${r.snapshotId}:${r.path}`);

  it('저장소마다 자기 삭제만 — 다른 저장소의 삭제가 섞이지 않는다', () => {
    const a = listTrash(h.ctx.db, repoA, 100);
    const b = listTrash(h.ctx.db, repoB, 100);
    assert.deepEqual(a.map((e) => e.path).sort(), ['gone.txt', 'shared.txt', 'twice.txt']);
    assert.deepEqual(b.map((e) => e.path).sort(), ['b-only.txt', 'gone.txt']);
    const snapsOfB = new Set(listSnapshots(h.ctx.db, repoB, 100).map((s) => s.id));
    for (const e of a) assert.ok(!snapsOfB.has(e.snapshotId));
  });

  it('지운 뒤 다시 올린 파일·이름을 바꾼 파일은 빠지고, 두 번 지운 파일은 마지막 한 번만 나온다', () => {
    const a = listTrash(h.ctx.db, repoA, 100);
    const paths = a.map((e) => e.path);
    assert.ok(!paths.includes('again.txt'));
    assert.ok(!paths.includes('moved.txt'));
    assert.ok(!paths.includes('renamed.txt'));
    assert.equal(paths.filter((p) => p === 'twice.txt').length, 1);
    assert.equal(a.find((e) => e.path === 'twice.txt')!.size, 'A twice v2'.length); // v2 내용으로 지운 마지막 삭제
  });

  it('최근 지운 것부터 나오고 limit 을 따른다', () => {
    const a = listTrash(h.ctx.db, repoA, 100);
    for (let i = 1; i < a.length; i++) assert.ok(a[i - 1]!.deletedAt >= a[i]!.deletedAt);
    assert.deepEqual(keys(listTrash(h.ctx.db, repoA, 2)), keys(a).slice(0, 2));
  });

  it('이전 쿼리(저장소 필터를 나중에 거는 모양)와 같은 결과·같은 순서다', () => {
    for (const repoId of [repoA, repoB]) {
      for (const limit of [1, 2, 100]) {
        const expected = listTrashReference(h.ctx.db, repoId, limit).map((r) => `${r.snapshot_id}:${r.path}`);
        assert.deepEqual(keys(listTrash(h.ctx.db, repoId, limit)), expected);
      }
    }
  });
});

describe('폴더 목록 정렬 (listTree)', () => {
  let h: Harness;
  let head: string;

  before(async () => {
    h = await createHarness();
    const owner = await signup(h.app, '소유자');
    const repoId = await createRepo(h.app, owner, '정렬');
    for (const p of [
      'a10.txt', 'a2.txt', 'a1.txt', '10.txt', '2.txt', '나.txt', '가.txt', '다.txt', 'b.txt',
      'd10/x.txt', 'd2/x.txt', 'd1/x.txt', '가폴더/x.txt', '나폴더/x.txt',
    ]) {
      await put(h, owner, repoId, p, p);
    }
    head = headOf(h.ctx.db, repoId);
  });
  after(async () => {
    await h.close();
  });

  it('숫자는 크기로, 숫자 < 한글(가나다) < 영문 — 파일과 폴더 모두', () => {
    const tree = listTree(h.ctx.db, head, '');
    assert.deepEqual(tree.files.map((f) => f.name), [
      '2.txt', '10.txt', '가.txt', '나.txt', '다.txt', 'a1.txt', 'a2.txt', 'a10.txt', 'b.txt',
    ]);
    assert.deepEqual(tree.dirs.map((d) => d.name), ['가폴더', '나폴더', 'd1', 'd2', 'd10']);
  });

  it('recursive 는 경로 전체를 같은 규칙으로 정렬한다', () => {
    const tree = listTree(h.ctx.db, head, '', { recursive: true });
    const paths = tree.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })));
    assert.ok(paths.indexOf('d2/x.txt') < paths.indexOf('d10/x.txt'));
    assert.ok(paths.indexOf('a2.txt') < paths.indexOf('a10.txt'));
    assert.ok(paths.indexOf('가.txt') < paths.indexOf('나.txt'));
  });
});

describe('과거 스냅샷의 한 파일 (readEntry)', () => {
  let h: Harness;
  let repoId: string;
  let snapshotIds: string[]; // 최근 것부터

  before(async () => {
    h = await createHarness();
    const owner = await signup(h.app, '소유자');
    repoId = await createRepo(h.app, owner, '과거 찾기');
    const other = await createRepo(h.app, owner, '다른 저장소');
    await put(h, owner, other, 'added.txt', 'other repo');

    await put(h, owner, repoId, 'untouched.txt', 'never changes'); // 늘 그대로
    await put(h, owner, repoId, 'updated.txt', 'u v1');
    await put(h, owner, repoId, 'deleted.txt', 'd v1');
    await put(h, owner, repoId, 'added.txt', 'a v1'); // 추가
    await put(h, owner, repoId, 'updated.txt', 'u v2 longer'); // 수정
    await del(h, owner, repoId, 'deleted.txt'); // 삭제
    await put(h, owner, repoId, 'updated.txt', 'u v3 the longest of all');
    await put(h, owner, repoId, 'deleted.txt', 'd version two'); // 지운 뒤 다시
    await move(h, owner, repoId, 'added.txt', 'moved.txt'); // 이동
    await put(h, owner, repoId, 'late.txt', 'late'); // 마지막에 추가
    snapshotIds = listSnapshots(h.ctx.db, repoId, 100).map((s) => s.id);
  });
  after(async () => {
    await h.close();
  });

  it('과거 스냅샷마다 모든 경로에서 readManifest(...).get(path) 와 같다', () => {
    const db = h.ctx.db;
    const head = headOf(db, repoId);
    assert.equal(snapshotIds[0], head);
    assert.ok(snapshotIds.length >= 10); // head 가 아닌 스냅샷이 많아 새 경로를 탄다
    const paths = [
      'untouched.txt', 'updated.txt', 'deleted.txt', 'added.txt', 'moved.txt', 'late.txt', 'nope.txt', 'untouched.txt/x',
    ];
    for (const snapshotId of snapshotIds) {
      const manifest = readManifest(db, snapshotId);
      for (const path of paths) {
        assert.deepEqual(readEntry(db, snapshotId, path), manifest.get(path), `${snapshotId} ${path}`);
      }
    }
  });

  it('값이 시점마다 실제로 달라진다 (수정·삭제·재추가가 비교에 들어 있다)', () => {
    const db = h.ctx.db;
    const sizes = (path: string) => new Set(snapshotIds.map((id) => readEntry(db, id, path)?.size ?? -1));
    assert.ok(sizes('updated.txt').size >= 4); // 없음 + v1 + v2 + v3
    assert.ok(sizes('deleted.txt').size >= 3); // 없음 + v1 + v2
    assert.equal(sizes('late.txt').size, 2);
    assert.equal(readEntry(db, snapshotIds.at(-1)!, 'updated.txt'), undefined); // 첫 스냅샷에는 아직 없다
    assert.equal(readEntry(db, snapshotIds.at(-2)!, 'updated.txt')?.size, 'u v1'.length);
  });

  it('없는 스냅샷이면 없음을 돌려주고, 이력에 닿지 않으면 readManifest 처럼 던진다', () => {
    const db = h.ctx.db;
    assert.equal(readEntry(db, 'snap_does_not_exist', 'untouched.txt'), undefined);
    assert.equal(readManifest(db, 'snap_does_not_exist').size, 0);
    // 부모 줄을 일부러 끊어, head 에서 따라가도 목표에 닿지 않게 한다.
    const victim = snapshotIds.at(-1)!;
    const next = snapshotIds.at(-2)!;
    db.prepare(`UPDATE snapshots SET parent_id = NULL WHERE id = ?`).run(next);
    try {
      assert.throws(() => readManifest(db, victim), /이력/);
      assert.throws(() => readEntry(db, victim, 'untouched.txt'), /이력/);
    } finally {
      db.prepare(`UPDATE snapshots SET parent_id = ? WHERE id = ?`).run(victim, next);
    }
  });
});
