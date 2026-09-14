# 서버 목록 — 실행 계획

앱이 서버를 여러 개 기억하고 **골라 들어가는** 화면을 만든다. 게임 클라이언트의 서버
선택기와 같은 자리다. 왜 이 길인지는 [TODO.md](../TODO.md) 의
*서버마다 계정을 새로 만들어야 하는 문제 — 서버별 계정으로 간다 (결정)* 절에 있다
(2026-08-28 결정). 이 문서는 그 결정을 코드로 옮기는 순서다.

작성: 2026-08-29. 기준 코드: v1.0.0 (`44e5452`).

> **구현 결과 (2026-09-14)** — 단계 1~4 구현, 단계 5(serverName)는 하지 않았다. 계획과 달라진 점:
>
> 1. **`activeUrl` 대신 `activeId` + 늘 있는 기본 서버 항목.** 주소를 저장하면 `npm run app` 이
>    켤 때마다 LAN IP 를 새로 알아내는 동작이 첫 주소로 굳는다. 기본 항목은 주소를 저장하지 않고
>    `DEFAULT_API_BASE_URL` 을 매번 따라간다. 계획의 "같은 오리진 고정 항목" 규칙이 여기 흡수됐다.
> 2. **이동은 화면이 아니라 `_layout` 이 한다.** 서버 전환을 부팅처럼 다룬다 — 로딩 화면 →
>    토큰 확인 → `serverGeneration` 증가 → `_layout` 이 `dismissAll` + `replace('/')`.
> 3. **서버 목록은 늘 스택 맨 아래에서 연다** (`lib/server-list.ts`). 전환 뒤에 이전 서버 화면을
>    걷어내는 방식은 로그인 상태가 바뀌는 타이밍과 보호 라우트가 엇갈려 결정적이지 않았다.
> 4. **확인 전에는 기억해 둔 사용자를 띄우지 않는다.** 폐기된 토큰이면 잠깐 로그인된 것처럼
>    보였다가 풀리는 틈이 생겼다. 서버에 닿지 않을 때만 기억해 둔 사용자로 잇는다.
> 5. **지금 서버도 지울 수 있다** (기본 서버로 옮겨 감). 계획은 정하지 않았던 부분.
> 6. 앱을 열 때 목록부터 보여줄지는 index 의 모듈 변수가 아니라 **부팅 결과**로 정한다 — 웹에서
>    `/repos` 로 새로고침하면 index 를 거치지 않아 모듈 변수가 틀렸다.
>
> 검증은 아래 체크리스트를 웹(Edge)에서 자동으로 돌렸다. 네이티브는 TODO *검증 대기* 에.

## 목표와 범위

**목표.** 서버마다 `(주소, 토큰, 사용자)` 를 기억해 두고, 목록에서 고르면 재로그인 없이
그 서버로 들어간다. 계정은 지금처럼 서버마다 따로다.

**하지 않는 것.**

- 서버 코드 변경 없음 — 5단계(선택)의 health 한 줄만 예외.
- 정체성 통합(OAuth·키) 아님 — TODO 의 결정대로 하지 않는다.
- 딥링크 초대·초대 코드로 바로 가입 — 별개 P1 항목. 이 작업과 섞지 않는다.
- 오프라인 캐시 확장 없음 — 지금처럼 "마지막으로 알던 사용자"만 잇는다.

## 순서 — 왜 이 차례인가

| 단계 | TODO 항목 | 내용 | 끝났을 때 상태 |
| --- | --- | --- | --- |
| 1 | ② | `(주소, 토큰)` 을 한 함수로만 바꾸게 | 순수 리팩토링. 동작 동일 |
| 2 | ① | `listup.servers` 저장 구조 + 기존 키 이전 | 저장만 바뀜. UX 동일 |
| 3 | ④ | 401 을 그 서버 항목만 비우게 | 단일 서버에선 차이 없음 |
| 4 | ③ | 목록 화면 + 폼 개조 + 라우팅 | 사용자에게 보이는 변화 |
| 5 | (선택) | `/api/health` 에 `serverName` | 서버 쪽 유일한 변경 |

위험한 것(토큰이 엉뚱한 서버로 가는 창)을 먼저 닫고, 화면을 마지막에 얹는다.
**각 단계가 끝날 때마다 앱이 정상 동작한다** — 어디서 멈춰도 손해가 없고,
단계 = 커밋 하나라 문제가 생기면 단계 단위로 되돌린다.

---

## 단계 1 — `(주소, 토큰)` 을 한 함수로만 바꾸게 (②)

**왜.** `apiBaseUrl`(`app/src/api/client.ts:48`)과 `authToken`(`:112`)이 따로 놓인 모듈
변수라 지금은 `setApiBaseUrl` / `setAuthToken` 을 각각 부른다. 요청 하나 안에서는 안전하다 —
`request()` 가 헤더 구성(`:139`) → `usedToken` 캡처(`:152`) → fetch 까지 await 없이 동기로
읽는다. 위험은 **호출자가 둘을 따로 바꾸는 사이** 다른 화면의 요청이 끼는 경우다. 지금은
`_layout.tsx` 가 토큰 복원이 끝날 때까지 Stack 을 안 그려서 이 창이 닫혀 있지만, 목록에서
**화면이 떠 있는 채로 런타임 전환**이 생기면 열린다 — A 서버 토큰이 B 서버로 간다.

**할 일.**

- `client.ts`: `setApiBaseUrl` / `setAuthToken` 을 지우고 하나로 —

  ```ts
  /** 주소와 토큰은 짝이다. 따로 바꾸면 토큰이 엉뚱한 서버로 가므로 이 함수로만 바꾼다. */
  export function setApiTarget(url: string | null, token: string | null): void
  ```

  내부에서 `apiBaseUrl`·`authToken`·`maxUploadBytesCache` 를 **동기 한 번에** 바꾼다
  (JS 단일 스레드라 동기 함수 하나면 원자적이다).
- 호출자 갱신: `auth.tsx` (부팅 복원, `persist`, `changePassword`, `clearSession`),
  `server.tsx` (저장, 기본값 복원). `changePassword` 는 같은 서버의 토큰 교체이므로
  `setApiTarget(getApiBaseUrl(), result.token)`.
- 남은 호출자 없는지: `grep -rn "setApiBaseUrl\|setAuthToken" app/`

**확인.** `npm run typecheck`. 웹에서 로그인 → 로그아웃 → 비밀번호 변경 → 서버 주소 변경 스모크.

## 단계 2 — 저장 구조와 이전 (①)

**스키마.** AsyncStorage 키 `listup.servers` 하나. 새 모듈 `app/src/state/servers.ts` 에
로드(이전 포함)·저장·upsert·remove·setActive 를 모은다.

```ts
{
  version: 1,
  activeUrl: string | null,        // '' = 같은 오리진(웹 빌드). null = 고른 서버 없음
  servers: [{
    url: string,                   // 항목의 식별자. 정규화(끝 슬래시 제거). 중복 금지
    label: string | null,          // 사용자가 붙인 이름. 없으면 url 을 보여준다
    token: string | null,
    user: User | null,             // 마지막으로 확인한 사용자 — 오프라인 세션 유지용
    lastUsedAt: number | null,
  }]
}
```

**기존 키 이전 — 이 작업에서 가장 조심할 부분.** 쓰던 사람이 로그아웃되면 안 된다.

1. `listup.servers` 가 있으면 그대로 쓴다.
2. 없으면 legacy 3키를 읽는다 — `listup.apiUrl`(`client.ts:46`), `listup.token`·`listup.user`
   (`auth.tsx:14,16`). 항목 하나를 만든다: `url = 저장된 apiUrl ?? DEFAULT_API_BASE_URL`.
3. **새 키 저장이 성공한 뒤에** legacy 키를 지운다. 중간에 죽어도 다음 부팅이 다시 이전한다.
4. legacy 도 없으면(첫 실행): `DEFAULT_API_BASE_URL` 항목 하나, 토큰 없음 — 오늘과 같은
   `/login` 직행이 된다.

**부팅(`auth.tsx`) 이 바뀌는 모양.** store 로드 → active 항목의 `(url, token)` 을
`setApiTarget` 한 번으로 적용 → 지금과 같은 `me()` 검증(성공: 항목의 user 갱신 / 401:
그 항목의 token·user 비움 / 오프라인: 항목의 user 로 세션 유지).

**확인.** 웹 devtools 로 legacy 키만 있는 상태를 만들고 새로고침 → 로그인 유지 +
`listup.servers` 생성 + legacy 삭제. 스토리지 전체 삭제(첫 실행) → `/login`.

## 단계 3 — 401 을 그 서버 항목만 (④)

**이미 절반은 되어 있다.** `client.ts:189` 의 가드(`authToken === usedToken`)가 "다른
토큰으로 바뀌었으면 무시"라, 서버 전환 뒤 늦게 도착한 이전 서버의 401 은 세션을 못 건드린다.

**할 일.**

- 가드에 주소 비교를 더해 완전하게: `usedBaseUrl` 도 캡처하고
  `apiBaseUrl === usedBaseUrl` 일 때만 무효 처리.
- 핸들러 교체: `setUnauthorizedHandler(clearSession)`(`auth.tsx:55`)이 지금은 전부 지운다.
  → **active 항목의 token·user 만** 비우고 저장, `setUser(null)`. 항목 자체는 목록에 남아
  "로그인 안 됨"으로 보인다. `logout()` 도 같은 함수를 쓴다.
- 라우팅은 가드가 index 로 보낸다 — 4단계 전까지는 오늘처럼 `/login` 으로 떨어진다.

**확인.** 저장된 토큰 문자열을 devtools 로 훼손하고 새로고침 → 로그인 화면, 항목은 유지.
(서버 두 개 시나리오는 전환 UI 가 생기는 4단계 뒤 통합 체크리스트에서.)

## 단계 4 — 화면 (③)

**라우팅.**

| 경로 | 접근 | 내용 |
| --- | --- | --- |
| `/servers` (신설) | 로그인 전후 | 서버 카드 목록 + 추가 버튼 |
| `/server` | 로그인 전후 | **추가/수정 폼** (기존 화면 개조. `?url=` 있으면 수정) |
| `/` (index) | — | active 에 user 있으면 `/repos` · 없고 항목이 2개 이상이면 `/servers` · 아니면 `/login` |

index 분기 덕에 **서버 하나만 쓰는 사람의 흐름은 오늘과 완전히 같다.**
`_layout.tsx` 에서 `servers` 를 `server` 옆(가드 밖)에 등록한다.

**목록 카드.** label(없으면 url) · url(mono) · 로그인된 사용자 displayName 또는 "로그인 안 됨" ·
`formatRelativeTime(lastUsedAt)` · 현재 배지. 탭 = 전환, 별도 버튼 = 수정·삭제(확인 대화상자,
`dialogs.ts`).

**전환(switchServer).**

1. 헬스체크(`server.tsx` 의 `checkServer` 5초 — `client.ts` 나 lib 로 옮겨 공용화)
2. 실패 → 인라인 에러, 아무것도 안 바꾼다 (오프라인으로 볼 수 있는 것이 없으므로 막는 편이 예측 가능)
3. 성공 → setActive + lastUsedAt 갱신 + `setApiTarget(url, token)` + `setUser(entry.user)`
   → 토큰 있으면 `/repos`, 없으면 `/login` (로그인 화면은 지금처럼 어느 서버인지 주소를 보여준다)

**폼(`server.tsx` 개조).**

- 추가: 주소 + 이름(선택) + 연결 확인 → 저장 = upsert 후 **바로 전환** (서버를 더하는 이유가
  들어가려는 것이므로). 이미 있는 주소면 그 항목으로.
- 수정: 라벨은 자유. **주소를 바꾸면 그 항목의 토큰을 비운다** — 토큰을 발급한 서버 밖으로
  보내지 않는다는 기존 방침(`server.tsx:115` 주석) 유지. 같은 서버의 터널 주소 회전이어도
  재로그인이다(안전 우선 — 고정 주소로 옮기면 사라지는 마찰).
- "기본값으로" 버튼은 제거. 대신 추가 폼이 `DEFAULT_API_BASE_URL` 을 "이 기기가 추측한
  주소"로 제안한다.
- 같은 오리진 항목(url `''`, 웹 빌드): 주소 수정·삭제 불가, 라벨만. 지우면 이 폼으로
  되살릴 수 없기 때문(폼은 http(s) 주소만 받는다).

**진입점.** `login.tsx:124` 의 "서버 주소" 링크와 `settings.tsx:141` 의 서버 행 →
`/servers` 로. 두 곳뿐이다.

**삭제.** active 를 지우면 `activeUrl = null` → index 가 `/servers` 로 보낸다.

## 단계 5 (선택) — 서버가 이름을 알려주기

주소만으로는 목록에서 구분이 안 된다. 서버 쪽 유일한 변경:

- `server/src/config.ts` 에 `LISTUP_SERVER_NAME` (선택, 기본 없음)
- `/api/health`(`server/src/app.ts:171`) 응답에 `serverName` 추가
- 앱은 연결 확인 응답의 `serverName` 을 라벨 기본값으로 제안

안 해도 기능은 성립한다 — 사용자가 라벨을 직접 붙이면 된다.

---

## 엣지 케이스

| 경우 | 처리 |
| --- | --- |
| 같은 오리진 웹 빌드 (url `''`) | 고정 항목. 삭제·주소 수정 불가 |
| 빠른 터널 주소 회전 | 죽은 항목이 남는다 → lastUsedAt 보고 삭제. 새 주소는 새 항목(또는 기존 항목 주소 수정 = 재로그인) |
| 웹에서 다른 서버 접근과 CORS | 기본 `LISTUP_CORS_ORIGIN=*` 라 동작. 주인이 좁힌 서버는 웹에서 실패 — 네이티브는 무관. **목록의 값어치는 주로 네이티브에 있다** |
| 만료된 토큰으로 전환 | 헬스체크는 무인증이라 통과 → `/repos` 진입 시 401 → 그 항목만 비우고 `/login` |
| 전환 직후 이전 서버의 늦은 응답 | `usedToken`+`usedBaseUrl` 가드로 세션 훼손 없음. 화면에 잠깐 스테일 에러가 보일 수 있음(수용) |
| AsyncStorage 저장 실패 | 기존 방침대로 메모리 상태도 바꾸지 않고 에러 표시 (`server.tsx` 의 save 와 같음) |

**보안 메모.** 브라우저 localStorage 에 토큰이 서버 수만큼 남는다. 노출 등급은 지금(1개)과
같고 개수만 는다 — README *조심할 점* 에 한 줄 추가한다. 개인 키 방식이었다면 "전 서버, 영구"
였을 것을 "그 서버, 30일 + `token_epoch` 무효화"로 유지하는 것이 이 설계의 목적이다.

## 검증

**서버 두 개 레시피** (PowerShell, 터미널 둘):

```powershell
npm run server                                                        # A: 4000, server/data
$env:LISTUP_PORT='4001'; $env:LISTUP_DATA_DIR="$env:TEMP\listup-b"; npm run server   # B: 4001, 임시 DB
```

B 는 빈 DB 라 계정을 새로 가입한다 — 그게 바로 이 기능의 시나리오다.

**체크리스트.**

- [ ] `npm run typecheck` · `npm test` (서버는 안 건드렸으니 118개 그대로)
- [ ] **이전**: legacy 키 상태에서 새로고침 → 로그인 유지, `listup.servers` 생성, legacy 삭제
- [ ] 첫 실행(스토리지 없음) → 오늘과 같은 `/login` 직행
- [ ] A 로그인 → B 추가·가입 → 전환 왕복. 각자 자기 저장소만 보임
- [ ] A 비밀번호를 다른 브라우저(시크릿)에서 변경 → A 로 전환하면 그 항목만 풀리고 B 세션 유지
- [ ] 꺼진 서버로 전환 → 에러만, 상태 그대로
- [ ] 항목 삭제 / 라벨 수정 / 주소 수정(= 그 항목 재로그인)
- [ ] 같은 오리진 웹 빌드(`npm run build:web` + 서버 서빙) → 고정 항목으로 동작
- [ ] Expo Go(LAN)에서 목록·전환 — 네이티브가 주 사용처다

**문서.** README(서버 주소 화면 설명 갱신 + 조심할 점 한 줄) ·
ARCHITECTURE 앱 구조(라우트·`servers.ts` 추가) · TODO(항목 체크, 끝나면 완료 절로).

## 규모 추정

| 파일 | 변경 |
| --- | --- |
| `app/src/api/client.ts` | ±30줄 (setApiTarget, 401 가드) |
| `app/src/state/servers.ts` | 신설 ~120줄 |
| `app/src/state/auth.tsx` | ±80줄 (부팅·persist·핸들러) |
| `app/app/servers.tsx` | 신설 ~200줄 |
| `app/app/server.tsx` | ±60줄 (폼 개조) |
| `index` / `_layout` / `login` / `settings` | 각 몇 줄 |
| 서버 | 0줄 (5단계 선택 시 ~5줄) |

앱 쪽 합계 대략 500줄. 스키마·마이그레이션·암호 라이브러리·`token_epoch` 는 손대지 않는다.
