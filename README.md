# ListUp

컴팩트한 공용 클라우드 시스템 — 초대 코드 하나로 남의 저장소에 참여하고, 파일을 나누고,
바꾸고 싶은 것이 있으면 **변경 제안**을 올려 검토를 받는 파일 공유 협업 플랫폼입니다.
모바일(iOS/Android)과 PC(웹)에서 같은 코드베이스로 동작합니다.

> git 의 협업 방식(제안 → 리뷰 → 병합)을 가져오되, 대상은 코드가 아니라 **파일**입니다.
> 브랜치·머지 커맨드를 몰라도 쓸 수 있도록 개념을 줄였습니다.

---

## 무엇을 할 수 있나

| 하고 싶은 일 | 방법 |
| --- | --- |
| 내 자료를 모아 두기 | 저장소를 만들고 파일을 올립니다. |
| 다른 사람 참여시키기 | 초대 코드를 만들어 전달합니다. 권한·기간·인원을 정할 수 있습니다. |
| 남의 저장소에 들어가기 | 받은 코드를 입력하면 어떤 저장소인지 먼저 확인한 뒤 참여합니다. |
| 남의 파일을 고치고 싶을 때 | 변경 제안을 올립니다. 저장소는 그대로 두고, 편집자가 확인 후 반영합니다. |
| 실수로 덮어썼을 때 | 변경 이력에서 이전 시점의 파일을 그대로 내려받습니다. |

권한은 세 단계입니다.

- **열람(viewer)** — 파일을 보고 내려받고, **변경 제안을 올릴 수 있습니다.**
- **편집(editor)** — 파일을 직접 올리고 지우고, 남의 제안을 병합할 수 있습니다.
- **소유자(owner)** — 저장소 설정과 멤버를 관리합니다.

초대받은 사람이 곧바로 기여할 수 있다는 점이 핵심입니다. 열람 권한만 줘도 제안은 올릴 수 있고,
저장소 내용은 편집자가 승인하기 전까지 바뀌지 않습니다.

---

## 구성

```
listup/
├─ shared/    타입·권한 규칙·경로 정규화 (서버와 앱이 함께 씀)
├─ server/    Fastify + SQLite + 콘텐츠 주소 파일 저장소
└─ app/       Expo (React Native) — iOS / Android / 웹
```

- **서버**: Fastify 5, better-sqlite3, 로컬 파일 스토리지. 외부 서비스 없이 단독 실행됩니다.
- **앱**: Expo SDK 57 + expo-router. 하나의 코드베이스로 모바일과 PC 웹을 모두 씁니다.
- **공용 패키지**: 권한 판정(`hasRole`)과 경로 정규화(`normalizePath`) 같은 규칙을 서버와 앱이
  같은 코드로 공유합니다. 클라이언트에서 한 검사는 편의를 위한 것이고, 실제 판정은 서버가 다시 합니다.

자세한 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), API 목록은
[docs/API.md](docs/API.md)를 보세요. 남은 작업과 우선순위는 [TODO.md](TODO.md) 에서
관리합니다.

---

## 실행하기

### 1. 설치

```bash
npm install
```

### 2. 서버 켜기

```bash
npm run server        # http://localhost:4000
```

기본값으로 `server/data/` 아래에 SQLite 파일과 업로드된 파일이 쌓입니다.
설정은 환경변수로 바꿉니다.

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `LISTUP_PORT` | `4000` | 포트 |
| `LISTUP_DATA_DIR` | `server/data` | DB·파일 저장 위치 |
| `LISTUP_AUTH_SECRET` | (개발 시 자동 생성) | 토큰 서명 키. **운영에서는 반드시 지정** |
| `LISTUP_TOKEN_TTL_DAYS` | `30` | 로그인 유지 기간 |
| `LISTUP_MAX_UPLOAD_MB` | `100` | 파일 하나의 최대 크기 |
| `LISTUP_MAX_REPO_MB` | `2048` | 저장소 하나의 총량 |
| `LISTUP_MAX_STAGING_MB_PER_DAY` | `1024` | 사용자별 하루 제안용 업로드 총량 |
| `LISTUP_CORS_ORIGIN` | `*` | 허용 오리진 (쉼표로 여러 개) |
| `LISTUP_WEB_DIR` | `app/dist` | 함께 서빙할 웹 빌드 위치 |
| `LISTUP_TRUST_PROXY` | (없음) | `1` 이면 프록시(터널·리버스 프록시)가 준 클라이언트 IP 를 신뢰 |
| `LISTUP_LOG_LEVEL` | `info` | 로그 레벨 (`debug`, `warn`, `error` …) |

값이 잘못되면(정수가 아니거나 범위를 벗어나면) 기본값으로 넘어가지 않고 서버가 뜨지 않습니다.
이름을 잘못 쓴 `LISTUP_*` 변수는 경고로 알려줍니다.

키를 지정하지 않으면 서버를 다시 켤 때마다 새 키가 만들어져 모두 로그아웃됩니다.
운영에서는 `NODE_ENV=production` 일 때 키가 없으면 아예 뜨지 않습니다.

백업은 파일 복사가 아니라 아래 명령으로 합니다 (WAL 모드라 실행 중인 DB 파일을 그냥 복사하면
최근 변경이 빠집니다). `blobs/` 디렉터리는 별도로 복사하세요.

```bash
npm run backup -- ./backups     # ./backups/listup-<날짜시각>.db 생성
```

### 3. 앱 켜기

```bash
npm run app           # Expo 개발 서버
```

- **PC**: 터미널에서 `w` — 브라우저로 열립니다.
- **모바일**: Expo Go 앱으로 QR 코드를 찍습니다. 서버 주소는 개발 PC 의 LAN IP 로 자동
  설정됩니다(기기에서 `localhost` 는 기기 자신을 가리키므로).

모바일로 붙일 때 확인할 것:

- **서버(`npm run server`)도 함께 켜 두어야 합니다.** 앱은 QR 의 호스트에서 API 주소를
  유추하므로(`http://<PC의 LAN IP>:4000`) 서버가 꺼져 있으면 로그인 화면에서 멈춥니다.
- 폰과 PC 가 **같은 공유기**에 있어야 합니다.
- 처음 실행할 때 Windows 방화벽이 물으면 허용하세요 (4000·8081 포트).
- `npm run app` 은 기본 경로로 나가는 인터페이스의 IP 를 골라 Expo 에 넘깁니다
  (`scripts/start-app.mjs`). VirtualBox·Docker 같은 가상 어댑터가 있으면 Expo 가 폰에서
  닿지 않는 IP 를 고르는 일이 있어서입니다. 직접 정하려면
  `REACT_NATIVE_PACKAGER_HOSTNAME` 을 미리 지정하면 그 값을 씁니다.

서버 주소는 앱 안에서도 바꿀 수 있습니다 — 로그인 화면 아래 "서버 주소" 또는 설정 화면에서
입력하면 연결을 확인한 뒤 기기에 저장됩니다 (릴리스 빌드에서 다른 서버를 쓸 때).
빌드 시점에 지정하려면:

```bash
EXPO_PUBLIC_LISTUP_API_URL=https://listup.example.com npm run app
```

### 4. 웹 정적 빌드

```bash
npm run build:web --workspace @listup/app    # app/dist/ 에 생성
```

서버는 `app/dist/index.html` 이 있으면 웹 빌드를 **API 와 같은 오리진으로 함께 서빙**합니다
(`LISTUP_WEB_DIR` 로 위치 변경, 비우려면 빌드 결과를 지우면 됩니다).
`EXPO_PUBLIC_LISTUP_API_URL=/` 로 빌드하면 웹 번들이 상대 경로로 API 를 부르므로,
도메인이 무엇이든 재빌드 없이 동작합니다.

### 5. 임시 공개 — Cloudflare 빠른 터널

서버 하나만 공개하면 웹까지 같이 나갑니다. cloudflared 설치
(`winget install Cloudflare.cloudflared`) 후:

```bash
powershell -ExecutionPolicy Bypass -File deploy-tunnel.ps1
```

출력에 나오는 `https://….trycloudflare.com` 이 공개 주소입니다. 주의:

- URL 은 실행할 때마다 바뀌고, 프로세스가 꺼지면 사라집니다.
- **Windows PowerShell 에서 빌드하세요.** Git Bash 는 `EXPO_PUBLIC_LISTUP_API_URL=/` 의
  `/` 를 Windows 경로로 바꿔 버려(MSYS path 변환) 번들이 깨집니다.
- 로그인 요청 제한이 아직 없으므로(TODO `P0`) URL 은 아는 사람에게만 공유하세요.

---

## 검증

```bash
npm test          # 서버 테스트 (HTTP 수준)
npm run typecheck # 서버 + 앱 타입 검사
```

테스트는 인증·권한·경로 탈출 방어·초대 소진·병합 충돌 같은 규칙을 실제 HTTP 요청 수준에서
확인합니다. 웹 빌드는 Playwright 로 가입 → 저장소 생성 → 업로드 → 초대 → 참여 → 제안 →
병합까지의 흐름을 브라우저에서 통과시켜 확인했습니다.

**네이티브(iOS/Android)는 아직 실기기에서 실행해 본 적이 없습니다.** 특히 파일 선택과 저장은
웹과 구현이 갈리는 지점이라, 실기기 확인 전까지는 미검증으로 봐 주세요. 확인해야 할 목록은
[TODO.md](TODO.md) 의 *검증 대기* 절에 있습니다.

---

## 알아 둘 점

- **자동 병합은 하지 않습니다.** 제안을 만든 시점 이후 같은 파일이 저장소에서 바뀌었다면 충돌로
  막고, 무엇이 덮어써지는지 사람이 보고 결정하게 합니다. 파일 대부분이 바이너리라 줄 단위 병합이
  의미가 없기 때문입니다.
- **빈 폴더는 없습니다.** 폴더는 파일 경로에서 만들어지므로, 안에 파일이 없으면 사라집니다(git 과 같음).
- **삭제해도 이전 시점은 남습니다.** 스냅샷마다 그 시점의 전체 파일 목록이 보관됩니다.
- 참조되지 않는 업로드 파일(제안에 담기 전에 버려진 것 등)을 지우는 정리 작업은 아직 없습니다.
  실제 운영 시에는 주기적인 GC 가 필요합니다. → [TODO.md](TODO.md) `P0`
