# 설치형 클라이언트 — 실행 계획

서버가 켜져 있든 말든 **늘 켤 수 있는 클라이언트**를 폰과 PC 에 설치한다. 마인크래프트와
같은 구조다 — 클라이언트는 설치해 두고, 서버 목록은 클라이언트가 들고 있고, 들어갈 때만
서버에 붙는다.

작성: 2026-09-14. 기준 코드: `72620bf` (서버 목록).

> **진행**
>
> - **1단계 완료** (2026-09-14). 계획과 같게 갔고, 더한 것: 클라이언트 모드에서는 로그아웃·세션
>   만료·지금 서버 삭제 뒤에도 서버 목록으로 돌아간다(`startAtServerList`). 확인은 클라이언트 모드
>   웹 빌드를 `/api` 가 없는 정적 서버에 올려서 했다 — 같은 주소로 요청이 새면 드러나게.
> - **2단계 완료** (2026-09-14). 더한 것: 목록을 열면 서버마다 핑을 보내 상태 배지("연결됨 / 닿지
>   않음 / 서버가 오래됨 / 앱 업데이트 필요")를 단다 — 마인크래프트 서버 목록처럼, 눌러 보기 전에
>   알 수 있게. 확인은 `apiVersion` 이 2·0·없음인 가짜 서버로 했다.
> - **3단계 빌드 성공, 실기기 미확인** (2026-09-14). 계획과 달라진 점:
>   - Android Studio 대신 **Google 명령줄 도구(sdkmanager)** 로 SDK 를 받았다. SDK Manager 가 GUI 라
>     자동으로 설치할 수 없었다. 같은 위치(`%LOCALAPPDATA%\Android\Sdk`)라 나중에 Android Studio 를
>     깔아도 그대로 쓴다. `sdkmanager.bat` 은 Git Bash 에서 `platforms;android-36` 의 `;` 을 잘라
>     먹어 `--package_file` 로 넘겼다.
>   - JDK 설치 뒤에도 이미 열린 창은 예전 `JAVA_HOME`(JDK 8)을 들고 있어, 빌드 스크립트가 17 이 아니면
>     기본 설치 위치에서 17 을 찾는다.
>   - 이 환경은 `NoDefaultCurrentDirectoryInExePath=1` 이라 `cmd` 가 현재 폴더의 `gradlew.bat` 을
>     못 찾았다 → 절대 경로로 부른다.
>   - `expo prebuild` 가 `app/package.json` 의 android·ios 스크립트를 `expo run:*` 으로 바꿔서 빌드
>     뒤 되돌린다. SDK 57 에서 없어진 `edgeToEdgeEnabled` 를 `app.json` 에서 뺐고, 안드로이드에서
>     다크 모드(`userInterfaceStyle`)를 쓰려면 필요한 `expo-system-ui` 를 더했다.
>   - 서명은 `android/` 를 고치지 않고 gradle 에 주입(`-Pandroid.injected.signing.*`)한다.
>     APK 서명 인증서가 새 키스토어와 일치함을 `apksigner` 로 확인했다.
>   - 기본은 arm64-v8a 만 빌드한다(`LISTUP_ANDROID_ABIS` 로 바꿈) — 크기와 빌드 시간을 줄이려고.
> - **4단계 구현, 실제 설치 확인 전** (2026-09-16). 계획보다 커졌다 — 클라이언트만이 아니라 **이 PC 에서 서버 열기**를
>   같은 앱에 넣었다(서버를 여는 사람이 Node·터미널 없이). 스킴 가정(아래 표)은 시험으로 확인했다. 서버는 앱 안의
>   utilityProcess 에서 돌고, 이를 위해 better-sqlite3 를 13(N-API)으로 올렸다. 설치 파일 이름은
>   `listup-<버전>-windows-setup.exe`. 자세한 구조는 `docs/ARCHITECTURE.md` *PC 앱*, 남은 확인은 TODO *검증 대기 — PC 앱*.

## 왜 필요한가

서버 목록(`72620bf`)을 만들었지만 그 목록을 여는 화면이 아직 서버에 묶여 있다.

| 막는 것 | 지금 | 결과 |
| --- | --- | --- |
| 웹 클라이언트를 서버가 준다 | `npm run serve` 가 `app/dist` 를 서빙 | 서버가 꺼지면 메뉴도 안 열린다 |
| 웹 저장소는 주소(origin)마다 따로다 | 서버 목록이 브라우저 localStorage 에 | 빠른 터널 주소가 바뀌면 **목록이 빈 채로 시작** |
| 폰은 Expo Go | 앱 코드를 PC 의 Metro 에서 받는다 | PC 가 꺼지면 앱이 안 뜬다 |

| 마인크래프트 | ListUp |
| --- | --- |
| 런처로 설치한 클라이언트 | **APK / PC 설치 파일 (이 계획)** |
| 클라이언트에 저장된 멀티플레이 서버 목록 | `listup.servers` (있음) |
| 서버 추가 / 직접 연결 | 서버 추가 폼 (있음) |
| LAN 서버 | `http://192.168…` — 설치형이어야 붙는다 (아래 3·4단계) |
| "구버전 서버입니다" | **없음 → 2단계** |

## 결정 (2026-09-14)

- **폰: 이 PC 에서 직접 빌드한 APK.** Expo 계정(EAS)은 쓰지 않는다. 대신 JDK 17 과 Android SDK 를
  설치한다.
- **PC: 설치형 앱.** 웹 클라이언트(GitHub Pages)는 https 페이지라 LAN 의 http 서버에 못 붙어서 뺐다.

## 하지 않는 것

- iOS — Mac 이 있어야 빌드된다.
- 자동 업데이트, 앱 스토어 배포 — 설치 파일을 릴리즈에 올리고 사람이 받아 설치한다.
- LAN 서버 자동 찾기(마인크래프트의 "LAN 월드") — 서버 추가로 주소를 넣는다. 나중 일.
- 서버가 웹을 서빙하는 지금 방식은 **그대로 둔다.** 브라우저로 여는 길은 남는다.

## 순서

| 단계 | 내용 | 끝났을 때 |
| --- | --- | --- |
| 1 | 클라이언트 모드 (앱 코드) | 웹 빌드로 확인 가능. 기존 동작 그대로 |
| 2 | 버전 호환 확인 (서버 + 앱) | 서로 다른 버전이 붙으면 알려줌 |
| 3 | 안드로이드 APK | 폰에 설치해 PC 없이 켜짐 |
| 4 | PC 설치형 앱 | PC 에 설치해 서버 없이 켜짐 |
| 5 | 배포 | 릴리즈에 APK·설치 파일 |

1·2 는 코드만 바꾸고 지금 환경에서 검증된다. 3 은 도구 설치가, 4 는 새 의존성(Electron)이
들어가므로 뒤로 둔다. **3 과 4 는 서로 기대지 않는다** — 어느 쪽을 먼저 해도 된다.

---

## 단계 1 — 클라이언트 모드

**무엇이 다른가.** 설치형 클라이언트에는 "이 앱을 준 서버"가 없다. 지금의 **기본 서버** 항목
(`app/src/state/servers.ts`)은 "앱을 서버가 줬거나(웹 같은 오리진) 개발 중(LAN IP 추측)"일 때만
뜻이 있다. 릴리스 네이티브 빌드에서는 `extra.listupApiUrl`(`http://localhost:4000`)로 떨어져
폰 자신을 가리키는 쓸모없는 항목이 된다.

**판별.**

| 빌드 | 모드 | 기본 서버 |
| --- | --- | --- |
| 서버가 서빙하는 웹 (`EXPO_PUBLIC_LISTUP_API_URL=/`) | 서버 모드 | 있음 ("이 사이트") |
| 개발 중 (`__DEV__`, Expo Go) | 서버 모드 | 있음 (LAN IP 추측) |
| 릴리스 네이티브 (`!__DEV__ && Platform.OS !== 'web'`) | **클라이언트 모드** | 없음 |
| PC 앱용 웹 빌드 (`EXPO_PUBLIC_LISTUP_CLIENT=1`) | **클라이언트 모드** | 없음 |

`client.ts` 에 `IS_CLIENT_BUILD` 하나를 두고 이 표대로 정한다.

**바꿀 것.**

- `servers.ts` — "기본 서버는 늘 있다" 불변식을 **서버 모드일 때만**으로. 클라이언트 모드에서는
  목록이 비어 있을 수 있고 `activeId` 도 `null` 일 수 있다(`ServerStore.activeId: string | null`).
- `auth.tsx` — 고른 서버가 없으면 요청 대상도 없다. `activeServer` 가 `null` 일 수 있게 하고,
  `login`/`signup` 은 서버가 없으면 오류.
- `index.tsx` — 클라이언트 모드에서는 **로그인돼 있지 않으면 늘 서버 목록부터** (마인크래프트
  타이틀 화면). 로그인돼 있으면 지금처럼 `/repos`.
- `servers.tsx` — 목록이 비었을 때 안내(`EmptyState`: "서버 추가로 들어갈 서버 주소를 넣으세요").
- `server.tsx` — 추가 폼의 주소 칸은 지금처럼 비워 두고 시작.
- 로그인 화면의 "서버: …" 는 클라이언트 모드에서 늘 "다른 서버" 로.

**확인.** `EXPO_PUBLIC_LISTUP_CLIENT=1` 로 웹을 빌드해 정적 서버(서버와 다른 포트)로 띄우고,
서버 목록 흐름 테스트(35개)를 클라이언트 모드용으로 고쳐 돌린다. 서버 모드 웹도 그대로 통과해야
한다.

## 단계 2 — 버전 호환 확인

**왜.** 지금은 서버가 자기 버전의 웹을 주니 늘 맞았다. 클라이언트를 따로 설치하면 새 앱이 옛
서버에, 옛 앱이 새 서버에 붙는다. 조용히 어긋나면 "왜인지 안 되는" 오류로 나타난다.

**규칙.** 정수 하나 `apiVersion` — API 가 **호환되지 않게** 바뀔 때만 올린다. 지금을 `1` 로 정한다.

- 서버: `/api/health`(`server/src/app.ts`)에 `apiVersion: 1`, `version: "1.x.y"` 를 더한다.
  이 필드가 없는 서버(v1.0.0)는 `1` 로 본다.
- 앱: `shared` 에 `API_VERSION = 1`. 연결 확인(`checkServer`)이 `apiVersion` 도 돌려준다.
- 다르면: 목록 카드에 배지("서버가 더 오래됨" / "앱을 업데이트하세요"), 전환은 막고 이유를
  보여준다. 서버 추가 폼의 연결 확인에서도 같은 안내.

**확인.** 서버 테스트에 health 필드 1건. 앱은 필드 없는 응답·다른 값 응답으로 흐름 테스트.

## 단계 3 — 안드로이드 APK

**도구 설치 (이 PC).** 필요한 버전은 설치된 react-native 0.86.2 에서 읽었다
(`node_modules/react-native/gradle/libs.versions.toml`).

| 도구 | 버전 | 지금 | 방법 |
| --- | --- | --- | --- |
| JDK | 17 (`jvmToolchain(17)`) | 8 | `winget install Microsoft.OpenJDK.17`, `JAVA_HOME` |
| Android SDK Platform | 36 (compileSdk·targetSdk) | 없음 | Android Studio(`winget install Google.AndroidStudio`) 의 SDK Manager |
| Build-Tools | 36.0.0 | 없음 | 〃 |
| NDK | 27.1.12297006 | 없음 | 〃 |
| `ANDROID_HOME` | SDK 경로 | 없음 | 환경변수 |

디스크 여유 257GB, Windows 긴 경로(`LongPathsEnabled=1`)는 켜져 있음을 확인했다.

**빌드 구성.**

- `npx expo prebuild --platform android` 로 `android/` 를 만든다. **커밋하지 않는다**(`.gitignore`) —
  `app.json` 에서 매번 다시 만든다(Expo CNG). 설정은 전부 `app.json`·플러그인에 둔다.
- **LAN http 허용** — 안드로이드 9+ 는 릴리스 빌드에서 http 를 막는다. `expo-build-properties`
  플러그인으로 `android.usesCleartextTraffic: true`. (터널·고정 주소는 https 라 상관없다.)
- **서명 키** — `keytool` 로 릴리스 키스토어를 만든다. **저장소에 넣지 않는다**(서명 키
  `auth-secret.txt` 와 같은 취급). 이 키를 잃으면 **같은 앱으로 업데이트 설치가 안 되고** 지우고
  다시 깔아야 한다(서버 목록·로그인 사라짐) → 백업 위치를 README 에 적는다. 경로·비밀번호는
  환경변수로 받는다.
- `npm run build:android` — prebuild → `gradlew assembleRelease` → `release/listup-<버전>.apk`.

**확인.** 폰에 APK 설치 → PC 와 서버를 모두 끈 채로 켜서 서버 목록이 뜸 → 서버 켜고 LAN(http)
주소 추가·로그인 → 터널(https) 주소 추가·전환 → 파일 선택·업로드, 내려받기·공유 시트 →
앱을 지웠다 다시 깔지 않고 새 APK 로 업데이트 설치해 목록이 남는지.

## 단계 4 — PC 설치형 앱

**구성.** 새 워크스페이스 `desktop/` (Electron). 1단계의 클라이언트 모드 웹 빌드를 앱 안에 넣고
Electron 창에 띄운다. 네이티브 코드는 없다 — 파일 선택·내려받기는 웹 구현(`app/src/lib/files.ts`)을
그대로 쓴다.

**웹 빌드를 어떤 주소로 띄우나 — 먼저 확인할 가정.** 세 조건을 동시에 만족해야 한다.

| 조건 | 왜 |
| --- | --- |
| 주소(origin)가 **늘 같다** | 서버 목록이 localStorage 에 있다. 바뀌면 목록이 사라진다 |
| 그 페이지에서 **http LAN 서버에 요청**할 수 있다 | https·보안 컨텍스트면 mixed content 로 막힌다 |
| 서버의 CORS 를 통과한다 | 서버는 `LISTUP_CORS_ORIGIN=*` 이면 요청 origin 을 되돌려 준다(`origin: true`) |

후보는 **보안 컨텍스트가 아닌 표준 커스텀 스킴**(`protocol.registerSchemesAsPrivileged` 로
`standard: true, secure: false` 인 `app://listup`)이다. 고정 origin 이고 localStorage 를 쓸 수 있고,
보안 컨텍스트가 아니라 http 요청이 mixed content 로 막히지 않을 것으로 본다. **아직 확인하지
않았다** — 이 단계는 이 가정을 확인하는 작은 시험부터 한다. 안 되면 대안은 고정 포트의
`http://127.0.0.1:<포트>` 로컬 서빙(포트 충돌 처리 필요).

- **로그인 정보 저장소를 창에 넣어 준다** — preload 에서 `window.listupDesktop.credentials =
  { get(key), set(key, value), remove(key) }` (모두 Promise). 값은 main 프로세스가 Electron
  `safeStorage`(Windows DPAPI)로 암호화해 앱 데이터 폴더에 쓴다. 앱 쪽(`app/src/lib/credentials.ts`)은
  이미 이 계약대로 만들어 가짜 저장소로 확인했다 — 이게 없으면 저장 스위치가 보이지 않는다.
- SPA 이므로 모르는 경로는 `index.html` 로(서버의 SPA fallback 과 같은 일).
- 웹 빌드가 `/_expo/...` 절대 경로를 쓰므로 `file://` 로는 안 된다 — 스킴 핸들러가 `dist` 를 서빙.
- **서버 주인이 CORS 를 좁혔다면** PC 앱의 origin(`app://listup`)을 목록에 넣어야 붙는다 → README.
- 설치 파일: `electron-builder` NSIS → `release/ListUp-Setup-<버전>.exe`. 코드 서명은 하지 않는다
  (Windows SmartScreen 경고가 뜬다 → README).
- `npm run build:desktop`.

**확인.** 설치 → 서버 없이 켜서 목록 → LAN http 서버·터널 https 서버에 각각 추가·로그인·전환 →
업로드(파일 선택 대화상자), 내려받기(저장 대화상자) → 앱을 껐다 켜도 목록·로그인 유지.

## 단계 5 — 배포

> **바뀜 (2026-09-14)** — APK 는 GitHub 릴리즈에 올린다. `npm run release:publish` 가 서버 묶음과 APK 를
> 빌드해 태그와 함께 올리고, 앱은 최신 릴리즈를 보고 업데이트를 알린다(`app/src/lib/updates.ts`).
> 버전은 `npm run version:set` 으로 맞춘다. 아래 원래 계획의 "release 스크립트가 모은다" 는 이것으로 대체.

- `npm run release` 가 서버 묶음과 함께 APK·설치 파일도 `release/` 에 모은다(있을 때만).
- README 에 **클라이언트 설치** 절: 폰(APK 설치 허용), PC(SmartScreen), 서버 추가하는 법.
- ARCHITECTURE: 서버 모드 / 클라이언트 모드, 버전 호환 규칙.

---

## 위험과 확인 안 된 가정

| 항목 | 영향 | 대응 |
| --- | --- | --- |
| Windows 에서 RN new arch 네이티브 빌드(CMake)의 경로 길이 | 빌드 실패 | 긴 경로는 켜져 있음. 그래도 실패하면 `subst` 로 짧은 드라이브에서 빌드 |
| Electron 커스텀 스킴에서 http LAN 요청·localStorage | PC 앱이 LAN 에 못 붙음 / 목록 유실 | 4단계 첫 시험. 안 되면 고정 포트 로컬 서빙 |
| 안드로이드 release 에서 http 차단 | LAN 서버에 못 붙음 | `usesCleartextTraffic` |
| 서명 키 분실 | 업데이트 설치 불가 | 저장소 밖 백업, README |
| 클라이언트·서버 버전 어긋남 | 알 수 없는 오류 | 2단계 |
| 설치형 클라이언트의 토큰 보관 | 기기에 서버 수만큼 토큰 | 지금 웹과 같은 등급. README 조심할 점에 이미 있음 |

## 규모 추정

| 단계 | 변경 |
| --- | --- |
| 1 | `servers.ts`·`auth.tsx`·`index`·`servers`·`login` ±150줄 |
| 2 | 서버 health +5줄·테스트 1건, `shared` +10, 앱 ±60 |
| 3 | `app.json`·플러그인 설정, 빌드 스크립트 ~80줄, `.gitignore` / 도구 설치 |
| 4 | `desktop/` 신설 ~150줄(main·스킴 핸들러·builder 설정), 빌드 스크립트 |
| 5 | release 스크립트 ±40, 문서 |
