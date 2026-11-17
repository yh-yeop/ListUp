# 실행 기록 실측 샘플 (2026-11-17)

수집 기능이 제대로 도는지 보려고 개발용 리눅스 컨테이너(논리 코어 4개 · RAM 16GB → `PC-저사양`)에서 모은 기록입니다.
친구 기기 데이터가 아니고, 디버그 옵션(테스트 에러 3개 · 강제 종료 흉내)을 일부러 섞었습니다.

- `telemetry-measured.csv` — PC 앱(Electron, `os=Linux 6`) 11회 + 브라우저(Chromium, `os=Linux`) 5회 = 16행, 기기 2대
- `telemetry-measured-errors.csv` — 에러 종류별 개수(`session_id,error_type,count`)

`scripts/merge_telemetry.py` 로 합친 결과입니다. 알려진 문제: 브라우저 「강제 종료 흉내」 행(1fae6c38)이 `crashed=0` 으로 남음 — TODO.md 「검증 대기」.
