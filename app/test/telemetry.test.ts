import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FPS_WARMUP_MS,
  RunStats,
  TELEMETRY_HEADER,
  browserOs,
  classifyDevice,
  countCsvRows,
  errorTypeOf,
  errorTypesToCsv,
  isUuid,
  localDate,
  makePending,
  parseCpuRange,
  parseMemTotalMb,
  parseProcStatusRssMb,
  randomUuid,
  recoverPending,
  rowToCsv,
  sanitizeErrorType,
  type TelemetryMeta,
} from '../src/lib/pure/telemetry';

const META: TelemetryMeta = {
  session_id: '11111111-1111-4111-8111-111111111111',
  device_id: '22222222-2222-4222-8222-222222222222',
  date: '2026-11-17',
  app_version: '1.10.0',
  device_class: 'PC-고사양',
  os: 'Windows 11',
};

describe('classifyDevice', () => {
  it('PC 는 코어 8개·RAM 15GB(표기 16GB) 이상이어야 고사양', () => {
    assert.equal(classifyDevice({ mobile: false, cores: 8, ramMb: 16088 }), 'PC-고사양');
    assert.equal(classifyDevice({ mobile: false, cores: 8, ramMb: 15.5 * 1024 }), 'PC-고사양');
    assert.equal(classifyDevice({ mobile: false, cores: 4, ramMb: 32768 }), 'PC-저사양');
    assert.equal(classifyDevice({ mobile: false, cores: 16, ramMb: 8192 }), 'PC-저사양');
  });

  it('모바일은 코어 8개·RAM 5.5GB(표기 6GB) 이상이면 고급형', () => {
    assert.equal(classifyDevice({ mobile: true, cores: 8, ramMb: 5700 }), '모바일-고급형');
    assert.equal(classifyDevice({ mobile: true, cores: 8, ramMb: 3800 }), '모바일-보급형');
    assert.equal(classifyDevice({ mobile: true, cores: 4, ramMb: 12000 }), '모바일-보급형');
  });

  it('브라우저처럼 RAM 이 8GB 에서 잘려 오면 잘린 값 이상은 기준을 채운 것으로, 모르면 코어만 본다', () => {
    assert.equal(classifyDevice({ mobile: false, cores: 12, ramMb: 8192, ramCapMb: 8192 }), 'PC-고사양');
    assert.equal(classifyDevice({ mobile: false, cores: 12, ramMb: 4096, ramCapMb: 8192 }), 'PC-저사양');
    assert.equal(classifyDevice({ mobile: false, cores: 12, ramMb: null }), 'PC-고사양');
    assert.equal(classifyDevice({ mobile: true, cores: null, ramMb: null }), '모바일-보급형');
  });
});

describe('browserOs', () => {
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
  it('UA 만으로는 Windows 10 과 11 을 가를 수 없다 — Client Hints platformVersion 13 이상이 11', () => {
    assert.equal(browserOs(WIN), 'Windows 10/11');
    assert.equal(browserOs(WIN, { platform: 'Windows', platformVersion: '15.0.0' }), 'Windows 11');
    assert.equal(browserOs(WIN, { platform: 'Windows', platformVersion: '10.0.0' }), 'Windows 10');
  });

  it('안드로이드·iOS·맥은 메이저 버전만', () => {
    const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
    assert.equal(browserOs(android), 'Android 10');
    assert.equal(browserOs(android, { platform: 'Android', platformVersion: '14.0.0' }), 'Android 14');
    assert.equal(browserOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15'), 'iOS 17');
    assert.equal(browserOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { platform: 'macOS', platformVersion: '15.1.0' }), 'macOS 15');
    assert.equal(browserOs('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux');
  });
});

describe('RunStats', () => {
  it('첫 5초(로딩)와 화면이 안 보이던 1초는 fps 에서 뺀다', () => {
    const stats = new RunStats(0);
    stats.addFpsSecond(10, 1000, 1000, true); // 로딩 구간
    stats.addFpsSecond(10, 1000, FPS_WARMUP_MS - 1, true); // 로딩 구간
    stats.addFpsSecond(60, 1000, FPS_WARMUP_MS + 1000, true);
    stats.addFpsSecond(0, 1000, FPS_WARMUP_MS + 2000, false); // 백그라운드 — 0 이 찍혀도 최솟값이 아니다
    stats.addFpsSecond(30, 1000, FPS_WARMUP_MS + 3000, true);
    const s = stats.snapshot();
    assert.equal(s.avgFps, 45);
    assert.equal(s.minFps, 30);
  });

  it('타이머가 크게 밀린 구간(잠들었다 깸)은 믿지 않는다', () => {
    const stats = new RunStats(0);
    stats.addFpsSecond(1, 60_000, 70_000, true);
    assert.equal(stats.snapshot().minFps, null);
  });

  it('메모리는 최댓값, 실행 시간은 보이던 시간의 분(소수 1자리), 에러는 종류별로', () => {
    const stats = new RunStats(0);
    for (const mb of [120.04, 380.26, 200, null, NaN, -1]) stats.addRamSample(mb as number | null);
    stats.addActiveMs(61_000);
    stats.addActiveMs(30_000);
    stats.addError('TypeError');
    stats.addError('TypeError');
    stats.addError('console.error');
    const row = stats.toRow(META, 0);
    assert.equal(row.max_ram_mb, 380.3);
    assert.equal(row.duration_min, 1.5);
    assert.equal(row.error_count, 3);
    assert.deepEqual(stats.errorTypes, { TypeError: 2, 'console.error': 1 });
    assert.equal(row.avg_fps, null);
  });
});

describe('CSV', () => {
  it('열 순서대로 쓰고, 못 잰 값은 빈 칸', () => {
    const row = new RunStats(0).toRow(META, 1);
    assert.equal(TELEMETRY_HEADER, 'session_id,device_id,date,app_version,device_class,os,avg_fps,min_fps_1s,max_ram_mb,duration_min,error_count,crashed\n');
    assert.equal(rowToCsv(row), `${META.session_id},${META.device_id},2026-11-17,1.10.0,PC-고사양,Windows 11,,,,0,0,1\n`);
  });

  it('쉼표·따옴표가 든 값은 감싼다', () => {
    const row = new RunStats(0).toRow({ ...META, os: 'a,"b"' }, 0);
    assert.match(rowToCsv(row), /,"a,""b""",/);
  });

  it('에러 종류 파일은 종류별 한 줄, 행 수는 헤더·빈 줄·BOM 을 빼고 센다', () => {
    assert.equal(errorTypesToCsv(META.session_id, { b: 1, a: 2, z: 0 }), `${META.session_id},a,2\n${META.session_id},b,1\n`);
    assert.equal(countCsvRows(null), 0);
    assert.equal(countCsvRows(TELEMETRY_HEADER), 0);
    assert.equal(countCsvRows(`\uFEFF${TELEMETRY_HEADER}x\ny\n\n`), 2);
  });
});

describe('에러 종류 이름', () => {
  it('클래스 이름만 — 메시지는 보지 않고, 이상한 이름은 Error 로', () => {
    assert.equal(errorTypeOf(new TypeError('C:\\Users\\user\\secret.txt 를 못 읽음')), 'TypeError');
    class ApiError extends Error {}
    assert.equal(errorTypeOf(new ApiError('x')), 'ApiError');
    const named = new Error('x');
    named.name = '파일 /home/me/a.txt';
    assert.equal(errorTypeOf(named), 'Error');
    assert.equal(errorTypeOf('문자열'), 'String');
    assert.equal(sanitizeErrorType('ApiError.503'), 'ApiError.503');
    assert.equal(sanitizeErrorType('a b'), 'Error');
    assert.equal(sanitizeErrorType('A'.repeat(100)).length, 40);
  });
});

describe('recoverPending — 남은 임시 기록', () => {
  const row = new RunStats(0).toRow(META, 0);

  it('화면에 떠 있던 중에 끊겼으면 crashed=1', () => {
    const r = recoverPending(JSON.stringify(makePending(row, { TypeError: 1 }, 'active')));
    assert.equal(r?.row.crashed, 1);
    assert.deepEqual(r?.errorTypes, { TypeError: 1 });
  });

  it('백그라운드로 내려간 뒤 OS 가 치웠으면 정상 종료(0) — 안드로이드에서 밀어 끄기', () => {
    assert.equal(recoverPending(JSON.stringify(makePending(row, {}, 'background')))?.row.crashed, 0);
  });

  it('치명적 예외 직후 저장했으면 백그라운드여도 1', () => {
    assert.equal(recoverPending(JSON.stringify(makePending(row, {}, 'background', true)))?.row.crashed, 1);
  });

  it('깨졌거나 모양이 다르면 버린다', () => {
    assert.equal(recoverPending(null), null);
    assert.equal(recoverPending('{'), null);
    assert.equal(recoverPending(JSON.stringify({ v: 1, row: { ...row, session_id: 'x' } })), null);
  });

  it('표에 없는 값은 옮기지 않는다 — 끼어든 필드는 행에 안 들어간다', () => {
    const tampered = makePending({ ...row, ...({ user: 'me' } as object) }, {}, 'active');
    const r = recoverPending(JSON.stringify(tampered));
    assert.equal(Object.keys(r!.row).length, 12);
    assert.ok(!('user' in r!.row));
  });
});

describe('/proc 읽기·날짜·UUID', () => {
  it('VmRSS·MemTotal·코어 범위', () => {
    assert.equal(parseProcStatusRssMb('Name:\tapp\nVmRSS:\t  204800 kB\n'), 200);
    assert.equal(parseProcStatusRssMb('Name: x'), null);
    assert.equal(parseMemTotalMb('MemTotal:        7864320 kB\nMemFree: 1 kB'), 7680);
    assert.equal(parseCpuRange('0-7\n'), 8);
    assert.equal(parseCpuRange('0-3,6-7'), 6);
    assert.equal(parseCpuRange('0'), 1);
    assert.equal(parseCpuRange('x'), null);
  });

  it('날짜는 현지 YYYY-MM-DD, UUID 는 v4 모양', () => {
    assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    let seed = 1;
    const fake = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const id = randomUuid(fake);
    assert.ok(isUuid(id), id);
    assert.ok(isUuid(randomUuid()));
    assert.notEqual(randomUuid(), randomUuid());
  });
});
