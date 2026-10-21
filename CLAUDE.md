# CLAUDE.md

초대 코드로 참여하는 자가 호스팅 파일 공유·협업 도구(shared · server · app · desktop 워크스페이스 monorepo).
전체 소개는 [README.md](README.md), 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), API 는
[docs/API.md](docs/API.md), 남은 일·결정 기록은 [TODO.md](TODO.md).

## 작업 방식 (git)

**`main` 에서 직접 작업하고 커밋·푸시한다.** 기능 브랜치·PR 은 쓰지 않는다(이력에 머지 커밋이 없다).
커밋 제목은 한국어로, `feat(…)`/`fix(…)`/`chore`/`docs(…)` 접두를 붙인다. 버전을 올린 커밋은 `chore: v<버전>` 이나 제목 끝 `— v<버전>`.

**TODO.md 가 작업 목록의 유일한 기준이다.** 작업할 때마다 갱신하고, 끝난 항목은 지우지 않고 완료 절로 옮긴다
(규칙은 TODO.md 「진행 규칙」).

## 문서 배치

- 리포 전체 안내·환경변수·명령은 `README.md`, 작업 목록은 루트 `TODO.md`.
- 설계·API·계획 문서는 **`docs/`** 아래 (`ARCHITECTURE.md`, `API.md`, `PLAN-*.md`).
- 릴리즈 노트는 `docs/releases/v<버전>.md` — 릴리즈 본문으로 그대로 올라간다.

## 코드를 바꾸면 같이 고쳐야 하는 것

**`npm run check:sync`(`scripts/check-sync.mjs`)가 검사하는 것은 「검사」 칸에 `check:sync [번호]` 로 적었다** —
CI 가 typecheck 앞에서 돌린다. 나머지는 수동이고, 타입 검사·e2e 가 잡는 것은 따로 적었다.

| 바꾼 것 | 같이 고칠 것 | 검사 |
|---|---|---|
| 서버가 읽는 `LISTUP_*` 환경변수 추가 | `server/src/config.ts` 의 `KNOWN_ENV`(빠지면 "알 수 없는 환경변수" 경고) + README 환경변수 표 | `check:sync [1]` |
| API 경로·응답 필드 추가/변경 | `docs/API.md` (+ 타입은 `shared/index.ts`) | 수동 |
| 호환을 깨지 않는 기능 추가 | `shared` 의 `API_LEVEL` 상향 + 그 위 주석의 수준 목록 + `docs/API.md` `apiLevel` 설명. 새 앱이 그 기능에 기대면 `REQUIRED_SERVER_API_LEVEL` 도 | 수동 |
| 옛 상대가 못 알아듣는 변경 | `API_VERSION` 상향 — 옛 앱이 전부 막히므로 웬만하면 `API_LEVEL` 로 (이유는 `shared/index.ts` 주석). `e2e/specs/3-version.mjs` | 수동 |
| 버전 | **`npm run version:set -- <버전>`** 으로만 (package.json 5곳·lock·`app/app.json` version·versionCode) + `docs/releases/v<버전>.md` | `check:sync [2]`(전부 일치·versionCode 공식) `[3]`(노트). 릴리즈 때 `release:publish` 도 package.json·app.json version 과 노트를 다시 본다 |
| DB 스키마 | `server/src/db/schema.sql.ts` 의 `MIGRATIONS` 끝에 항목 추가(기존 항목은 고치지 않는다), 위에 **왜** 주석. 데이터를 옮기는(`run`) 마이그레이션은 `server/test/migrations.test.ts` 에 이전 전후 대조 | 수동 |
| PC 앱 IPC (`window.listupDesktop`) | `shared/index.ts` `DesktopBridge` + `desktop/src/protocol.ts` `IPC` 채널 + `desktop/src/preload.ts` 구현 + `desktop/src/main.ts` `ipcMain.handle` | preload 는 typecheck, main 핸들러는 수동(`test:desktop`) |
| 앱·PC 앱 소스 파일 추가 | `docs/ARCHITECTURE.md` 구조 블록 (`app/src/…`, `desktop/src/…`) | `check:sync [5]` 가 `app/src/lib`·`desktop/src` 만 **경고**(실패 아님). 나머지는 수동 |
| 화면의 버튼 글자·`accessibilityLabel` | e2e 가 `getByRole(…, { name })` 으로 찾는다 → `e2e/` 의 해당 이름 | `test:e2e` |
| 사용자에게 보이는 기능 | README 「무엇을 할 수 있나」(+ 릴리즈에 나갈 거면 `docs/releases/v<버전>.md`) | 수동 |

## 테스트

관련 코드를 고쳤으면 커밋 전에 돌린다. 의존성은 루트 `npm ci` (Node 22 이상, CI 는 24).
Electron 실행 파일이 필요 없으면 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`.

```
npm run check:sync    # 문서·코드 짝 (env 표·버전·릴리즈 노트·공개 금지 패턴·구조 블록). 표준 node 만
npm run typecheck     # server + app + desktop
npm test              # 서버 테스트 (node:test + tsx, HTTP 수준)
npm run test:e2e      # 웹 흐름 — 웹을 두 모드로 빌드해 브라우저로. 임시 DB·빈 포트
npm run test:desktop  # PC 앱 흐름 — 실제 Electron
npm run test:android  # 안드로이드 흐름 — 에뮬레이터 + 시험용 APK
```

- `test:e2e` 브라우저: Windows 는 설치된 Edge, 그 밖에는 `npx playwright-core install chromium`
  (`E2E_BROWSER_CHANNEL` 로 바꿀 수 있다). 실패 화면은 `e2e/.cache/failures/`.
  **앱 화면·서버 흐름을 고쳤으면 반드시 돌린다.**
- `test:desktop` 은 Electron 실행 파일이 있어야 한다(위 SKIP 으로 설치했으면 못 돈다).
- `test:android` 는 Android SDK·에뮬레이터·JDK 와 **정식 서명 키**(`~/.listup`)가 있어야 한다 — 시험용 APK 도 같은 키로 서명한다.

**GitHub Actions(`.github/workflows/ci.yml`)가 푸시·PR 마다 check:sync → typecheck → test → test:e2e 를 돌린다**
(같은 브랜치에 새로 푸시하면 앞선 실행은 취소된다).
desktop·android 흐름은 CI 에서 돌지 않으므로 그쪽을 고쳤으면 직접 돌린다.

## 릴리즈

`npm run version:set -- <버전>` → `docs/releases/v<버전>.md` 작성 → 커밋·푸시 → **Windows 에서**
`npm run release:publish`. 이 명령이 gh 로그인·깨끗한 작업 트리·`main` 이 원격과 같음·태그 없음·노트 있음·
버전 일치·서명 키를 먼저 보고, **그 커밋의 CI(check-runs)가 모두 끝나 성공했는지**(진행 중이면 끝난 뒤 다시) 확인한
다음 로컬에서 `check:sync`·`typecheck`·`test` 를 돌린 뒤에야 서버 묶음·APK·PC 설치 파일을 만들어 태그와 함께
GitHub Releases 에 올린다. 그래서 **푸시하고 CI 가 녹색이 된 뒤에** 돌린다. `-- --skip-ci` 는 CI 확인만 건너뛰고
(크게 경고한다, 로컬 검사는 그대로) e2e 를 거치지 않은 커밋이 배포되므로 급할 때만.
릴리즈는 이 명령으로만 올린다 — 설치된 앱이 GitHub 최신 릴리즈를 보고 업데이트한다(`app/src/lib/updates.ts`,
`desktop/src/updater.ts`).

## 주의

- **안드로이드 서명 키를 새로 만들지 않는다.** 키가 바뀌면 이미 설치한 폰이 덮어 설치를 못 한다.
  `app/android-signing-cert.json`(정식 키 지문)은 지우거나 바꾸지 않고, 키가 없으면 빌드가 멈추는 게 정상이다.
  `--new-key` 는 지문이 없을 때(처음·포크)만 (`scripts/android-signing.mjs`).
- **권한·변경 판정은 서버가 한다.** 클라이언트가 보낸 제안의 `op` 는 믿지 않고 서버가 head 기준으로 다시
  판정한다(`docs/ARCHITECTURE.md`). 앱·shared 의 검사는 편의용이고, 서버 쪽 검사를 빼지 않는다.
- **이 리포는 공개다.** 실제 서버 주소(`*.ts.net` 노드·tailnet 이름, 터널 주소), 개인 PC 경로(`C:\Users\<이름>`),
  키·백업 보관 위치는 커밋하지 않는다. 문서에는 `https://<내 노드>.<tailnet>.ts.net`, `%USERPROFILE%\…` 처럼 쓴다.
  tailnet 주소·`C:\Users\<이름>` 꼴은 `check:sync [4]` 가 추적 파일 전체에서 찾아 실패시킨다(자리표시는 `scripts/check-sync.mjs` 의 `USER_PLACEHOLDERS`).
- **비밀은 커밋하지 않는다** — `LISTUP_AUTH_SECRET`(유출되면 토큰 위조), `server/data/`(DB·`auth-secret.txt`),
  `~/.listup/android-signing.json`(비밀번호 평문)과 keystore. `data/`·`*.db` 는 `.gitignore` 에 있다.
- **AGPL-3.0 소스 링크를 유지한다.** 앱의 「소스 코드」 링크(`app/src/lib/updates.ts` 의 `SOURCE_URL`)는
  §13 대응이라 지우지 않는다.
