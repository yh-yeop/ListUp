# API

기본 주소는 `http://localhost:4000` 이고 모든 경로는 `/api` 로 시작합니다.

## 인증

로그인·가입 응답의 `token` 을 이후 요청에 붙입니다.

```
Authorization: Bearer <token>
```

토큰은 서버에 상태를 두지 않는 HMAC 서명 토큰입니다. 만료(기본 30일)되거나 서명이 맞지 않으면
`401` 이 오고, 앱은 이를 받으면 자동으로 로그아웃합니다.

## 오류 형식

```json
{ "error": { "code": "conflict", "message": "사람이 읽을 수 있는 설명", "details": { } } }
```

| code | HTTP | 언제 |
| --- | --- | --- |
| `bad_request` | 400 | 입력이 잘못됨 |
| `unauthorized` | 401 | 토큰 없음/만료 |
| `forbidden` | 403 | 멤버지만 권한이 모자람 |
| `not_found` | 404 | 없거나, **멤버가 아니라 숨긴 경우** |
| `conflict` | 409 | 병합 충돌, 초대 소진, 중복 가입, 파일/폴더 이름 충돌, 나눠 올리기 위치 어긋남 등 |
| `payload_too_large` | 413 | 파일 하나 크기·저장소 총량·하루 업로드 한도 초과, JSON 본문 1MB 초과 |
| `too_many_requests` | 429 | 로그인·재설정 코드 실패가 잦음. `details.retryAfterSeconds` 뒤에 다시 |
| `internal` | 500 | 서버 오류. `requestId` 가 함께 오므로 로그와 대조할 수 있습니다 |

병합 충돌·경로 충돌일 때는 `details.conflicts` 에 문제가 된 경로 목록이 들어갑니다 (파일 올리기·여러 파일 커밋·이동·
제안 만들기·병합 모두).

`GET` 경로는 모두 `HEAD` 도 받습니다 — 파일·zip 내려받기는 본문 없이 크기·`ETag` 만 줍니다.

---

## 서버 상태

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | 로그인 없이. `{ok, time, maxUploadBytes, apiVersion, apiLevel, version, serverName, history}` |
| GET | `/server/lan` | 로그인. 같은 공유기에서 이 서버에 닿는 주소 `{urls: ["http://192.168.0.10:4000"]}` |

```json
{ "ok": true, "time": 1789355589634, "maxUploadBytes": 2147483648, "apiVersion": 1, "apiLevel": 4, "version": "1.4.0", "serverName": "우리집 음악서버", "history": { "days": 30, "keepOlder": "none" } }
```

- **`apiVersion`** — API 호환 버전(`shared` 의 `API_VERSION`). 서버와 앱이 서로 알아듣지 못하게
  바뀔 때만 올립니다. 설치형 클라이언트는 서버와 따로 업데이트되므로, 들어가기 전에 이 값을 자기
  값과 견주고 다르면 들어가지 않습니다. **이 필드가 없는 서버(1.0.0)는 `1` 로 봅니다.**
- **`apiLevel`** — 기능 수준(`API_LEVEL`). 호환을 깨지 않고 기능을 더할 때 올립니다(옛 앱은 무시).
  앱은 자기가 쓰는 기능이 있는 수준(`REQUIRED_SERVER_API_LEVEL`) 미만 서버에는 "서버가 오래됨"으로
  들어가지 않습니다. 2 = 1.2.0 (나눠 올리기·여러 파일 커밋·다운로드 링크·zip·Range·재설정),
  3 = `serverName`·제안 목록 페이지, 4 = 1.4.0 (즉시 올리기·되돌리기·이력 보존·충돌 정리·용량·공개 링크·
  따라가기·공유기 주소). 앱은 없는 기능을 감추고, 들어가는 조건은 그대로 2 입니다.
  **필드가 없는 서버(1.1.0 까지)는 `1`** 입니다.
- `version` — 서버 버전(`server/package.json`). 사람에게 보여주는 용도이고 호환 판단에는 쓰지 않습니다.
- `maxUploadBytes` — 파일 하나의 업로드 한도. 앱이 올리기 전에 검사합니다.
- `serverName` — 서버 주인이 `LISTUP_SERVER_NAME` 으로 붙인 이름, 없으면 `null`. 앱은 서버를 목록에
  더할 때 이름 칸에 미리 채웁니다. **필드가 없는 서버(1.3.0 까지)는 `null`** 로 봅니다.
- `history` — 변경 이력 보존 설정(`LISTUP_HISTORY_DAYS`·`LISTUP_HISTORY_KEEP_OLDER`). 앱의 변경 이력 화면이
  안내합니다. 없으면 모두 남기는 옛 서버입니다.
- `/server/lan` — 폰·PC 앱은 이 주소마다 내 토큰으로 `/auth/me` 를 물어, 같은 사용자로 답하는 곳(= 같은 서버)을
  찾으면 조각 올리기·내려받기를 터널 대신 그리로 보냅니다. 내부 주소라 로그인한 사람에게만 줍니다.

---

## 인증

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/auth/signup` | `{email, password, displayName}` → `{token, user}` (201) |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | 현재 사용자 |
| PATCH | `/auth/me` | `{displayName}` |
| POST | `/auth/password` | `{currentPassword, newPassword}` → `{ok, token}` |
| POST | `/auth/reset` | `{email, code, newPassword}` → `{token, user}` — 로그인 없이 |

비밀번호는 8자 이상 200자 이하. 로그인 실패 메시지는 이메일 존재 여부와 무관하게 동일하고, 응답 시간도
같게 맞춥니다. `/auth/password` 에서 현재 비밀번호가 틀리면 `401` 이 아니라 **`400`** 입니다 —
`401` 은 "토큰이 무효"라는 뜻이라 앱이 로그아웃해 버리기 때문입니다.

- **로그인 실패는 횟수를 셉니다.** 같은 이메일 기준과 같은 IP 기준을 따로 세고, 한도를 넘으면
  `429` 로 잠시 막습니다(막힌 동안은 올바른 비밀번호도 막힙니다). 성공하면 기록이 지워집니다.
- **`/auth/password` 는 성공 시 새 `token` 을 함께 줍니다.** 비밀번호를 바꾸면 그 사용자의
  기존 토큰이 **모두** 무효가 되므로(다른 기기 로그아웃), 요청을 보낸 기기는 이 새 토큰으로
  갈아 끼워야 합니다.

### 비밀번호 재설정 (`/auth/reset`)

재설정 코드는 **서버를 돌리는 사람이** 발급합니다 — 저장소 소유자가 남의 계정을 풀 수 있으면 안 되고,
이메일을 보낼 수단이 없는 자가호스팅 도구라서입니다.

```bash
npm run reset-password -- me@example.com     # 서버가 켜져 있어도 됩니다
```

- 코드는 초대 코드와 같은 모양(`ABCDE-12345`)이고 **30분 동안 한 번** 씁니다. 새로 발급하면 그 사람의
  이전 코드는 못 씁니다. DB(`password_resets`)에는 해시만 둡니다.
- 성공하면 비밀번호를 바꾸고 토큰 세대를 올려 **다른 기기의 로그인을 모두 끊고**, 이 요청에는 새
  `token` 을 줍니다(바로 로그인).
- 틀린 코드·없는 계정·만료는 모두 같은 `400` 입니다. 실패는 로그인과 **같은 제한**으로 세어 `429` 로 막습니다.

---

## 저장소

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos` | — | 내가 참여 중인 저장소 목록 |
| POST | `/repos` | — | `{name, description?}` → `{repo}` (201). 만든 사람이 owner |
| GET | `/repos/:repoId` | viewer | 요약(파일 수, 용량, 멤버 수, 열린 제안 수, 내 역할) |
| PATCH | `/repos/:repoId` | owner | `{name?, description?}` |
| DELETE | `/repos/:repoId` | owner | 저장소 삭제 |
| GET | `/repos/:repoId/members` | viewer | 멤버 목록 (이메일은 owner 에게만) |
| PATCH | `/repos/:repoId/members/:userId` | owner | `{role}` — `viewer` 또는 `editor`. owner 의 역할은 못 바꿈(400), 멤버가 아니면 404 |
| DELETE | `/repos/:repoId/members/:userId` | 본인 또는 owner | 내보내기/나가기. owner 는 나갈 수 없음 |
| POST | `/repos/:repoId/transfer` | owner | `{userId}` — 넘긴 사람은 editor 로 남음. 자기 자신은 400, 멤버가 아니면 404 |
| GET | `/repos/:repoId/storage` | viewer | 용량 `{current, history: {snapshots, oldestAt, extraBytes}, duplicates, duplicateBytes, largest, retention}` — 이력이 붙잡은 크기는 지금 파일에 없고 지난 시점에만 있는 내용 |
| POST | `/repos/mirror` | — | `{link}` — 다른 서버의 따라가기 링크로 미러 저장소를 만든다(아래 *서버 간 따라가기*) |
| POST | `/repos/:repoId/mirror/sync` | owner | 지금 가져오기 → `{repo, result: {changed, fetched, fetchedBytes}}` |
| DELETE | `/repos/:repoId/mirror` | owner | 따라가기를 그만둔다 — 보통 저장소가 된다 |
| GET | `/repos/:repoId/history` | viewer | 스냅샷 목록. 응답 `{snapshots, next}` — `next` 가 있으면 `?before=&beforeId=` 로 이어서 요청 (둘 다 있어야 커서로 봄). `limit` 기본 30, 최대 100 |

- 멤버를 내보내거나 viewer 로 강등하면 **그 사람이 만든 초대는 함께 회수**됩니다.

---

## 파일

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos/:repoId/files?path=&snapshot=&recursive=` | viewer | 폴더 목록 `{tree: {path, snapshotId, dirs, files, recursive?}}`. `snapshot` 을 주면 과거 시점, `recursive=1` 이면 하위 폴더 파일까지 모두 `files` 에(`dirs` 는 비고 `recursive: true`) |
| POST | `/repos/:repoId/files?path=` | editor | multipart 업로드 = 직접 커밋 (201). `path` 가 없으면 파일 이름으로 저장소 맨 위에 |
| POST | `/repos/:repoId/files/commit` | editor | `{changes:[{path, blobHash\|null}], message?}` — 여러 파일을 스냅샷 하나로 |
| DELETE | `/repos/:repoId/files?path=` | editor | 파일 또는 폴더 삭제 → `{removed, snapshotId}`. 없으면 404 |
| POST | `/repos/:repoId/files/move` | editor | `{from, to}` — 파일·폴더 이동/이름 변경 → `{moved, snapshotId}`. 같은 경로·자기 안으로는 400, 없으면 404, 겹치면 409 |
| GET | `/repos/:repoId/raw?path=&snapshot=&inline=1` | viewer | 파일 내려받기 (`Range` 지원) |
| POST | `/repos/:repoId/download-link` | viewer | `{path, snapshot?, archive?}` → `{url, expiresAt}` — 로그인 헤더 없이 받는 짧은 링크 |
| GET | `/dl?t=` | (링크) | 링크로 파일 또는 폴더 zip 받기 |
| POST | `/repos/:repoId/blobs` | viewer | 제안용 파일 업로드 → `{blob: {hash, size, mimeType, name}}` |

### 경로 규칙

- 앞뒤 `/` 와 중복 `/` 는 정리하고, 백슬래시는 `/` 로 받습니다. `.`/`..` 세그먼트, 제어문자,
  제로폭·양방향 제어 같은 유니코드 format 문자는 거부합니다.
- **유니코드 NFC 로 정규화**합니다. macOS 가 만드는 자소 분리(NFD) 한글 파일명도 같은 경로로
  취급됩니다.
- **같은 이름의 파일과 폴더는 공존할 수 없습니다.** `a` 가 파일인데 `a/b.txt` 를 올리거나, `a/` 폴더가
  있는데 파일 `a` 를 올리면 `409` 에 `details.conflicts` 로 부딪힌 경로를 알려줍니다.

### 업로드

경로는 multipart 파트 순서에 의존하지 않도록 **쿼리스트링**으로 받습니다.

```bash
curl -X POST "http://localhost:4000/api/repos/$REPO/files?path=문서/계획.txt" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@계획.txt"
```

응답:

```json
{
  "file": { "path": "문서/계획.txt", "size": 128, "mimeType": "text/plain", "...": "" },
  "snapshotId": "snap_...",
  "unchanged": false
}
```

내용이 기존과 완전히 같으면 새 스냅샷을 만들지 않고 `unchanged: true` 를 돌려줍니다(그래도 `201`).

- 한도(`LISTUP_MAX_UPLOAD_MB`)를 넘는 파일은 `413` 이고 **아무것도 커밋되지 않습니다.**
- 저장소 총량이 `LISTUP_MAX_REPO_MB` 를 넘게 되면 `413` 입니다.
- 업로드가 진행되는 동안 다른 커밋이 생겨도 그 커밋 위에 올라갑니다 (덮어쓰지 않음).

### 나눠 올리기 (큰 파일, 끊겨도 이어서)

한 요청 본문이 프록시 한도(Cloudflare 100MB)를 넘지 않게 **8MB 조각**으로 보냅니다. 앱과 `npm run sync` 는 늘 이 길을 씁니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/repos/:repoId/uploads` | `{name, size, hash?}` → `{upload: {id, repoId, name, size, received, chunkSize}}` (201), 또는 이미 있는 내용이면 `{upload: null, blob}` (200). 최소 viewer |
| PUT | `/uploads/:uploadId?offset=N` | `Content-Type: application/octet-stream` 조각 → `{upload}`. 다른 형식·빈 조각은 400 |
| GET | `/uploads/:uploadId` | 어디까지 받았는지 (`received`) |
| POST | `/uploads/:uploadId/complete` | `{blob: {hash, size, mimeType, name}}` (201). 덜 받았으면 409 + `details {received, size}`, 받은 내용이 `hash` 와 다르면 400 |
| DELETE | `/uploads/:uploadId` | 취소. 조각을 받는 중이면 409 — 잠시 뒤 다시 |

- `offset` 이 서버가 받은 길이와 다르면 `409` 에 `details.received` — 그 위치부터 다시 보내면 됩니다.
  끊긴 조각은 받은 데까지만 남습니다. 같은 세션에 조각이 동시에 오면 뒤의 것도 `409` + `details.received`.
- 세션은 만든 사람만 쓰고, 그 저장소 멤버가 아니게 되면 `404` 입니다. 서버를 다시 켜도 이어지고,
  오래 멈춘 세션은 정리 작업(GC)이 지웁니다.
- 크기 한도는 세션을 만들 때 `size` 로 먼저 봅니다. **편집 권한이 없는 사람**(제안용)은 하루 업로드
  한도도 만들 때와 완료할 때 봅니다.
- 완료한 blob 은 아직 저장소에 들어간 것이 아닙니다. `files/commit` 이나 변경 제안에 `blobHash` 로 담습니다.
- **즉시 올리기 (1.4.0).** `hash`(내용의 sha256, 16진수 64자)를 함께 보내면, **이 저장소에 올렸거나 이력에 있는**
  같은 내용(크기까지 같음)일 때 세션 없이 `200 {upload: null, blob}` 을 줍니다 — 보낼 것이 없습니다. 다른 저장소의
  내용은 해시를 알아도 즉시 받지 못합니다. 세션을 열면 완료할 때 받은 내용의 해시와 견줘 다르면(전송 중 손상)
  기록하지 않고 `400` 입니다. 앱은 PC 앱에서는 늘, 브라우저는 512MB·폰은 128MB 까지 미리 계산합니다.

### 여러 파일 커밋 (`files/commit`)

```json
POST /api/repos/:repoId/files/commit
{ "changes": [ { "path": "사진/1.jpg", "blobHash": "a1b2…" }, { "path": "옛날.txt", "blobHash": null } ], "message": "폴더 올리기" }
```

- 한 번에 반영하고 **스냅샷 하나**를 만듭니다. `blobHash: null` 은 삭제(없는 파일이면 `400`).
- 이 저장소에 올렸거나 이력에 있는 blob 만 담을 수 있습니다. 이름 충돌 `409`, 한도 `413`/`409`.
- 응답 `{snapshotId, unchanged, added, updated, deleted}`. 바뀐 것이 없으면 `200` 에 `unchanged: true`.

### 되돌리기 (`restore`, 1.4.0)

```json
POST /api/repos/:repoId/restore
{ "snapshotId": "snap_…", "path": "문서" }
```

- 편집자. 과거 시점의 내용으로 저장소 전체(`path` 없음), 폴더, 파일 하나를 되돌립니다. 그 범위 안에서 그 시점에
  없던 파일은 지우고, 범위 밖은 그대로입니다. **새 스냅샷**으로 남으므로 되돌린 것도 다시 되돌릴 수 있습니다.
- 응답 `{snapshotId, unchanged, added, updated, deleted}` (바뀌면 201, 같으면 200 `unchanged: true`).
- 없는 시점(보존 기간이 지나 정리됨 포함)·그 시점에도 지금도 없는 경로는 404, 되살릴 자리에 범위 밖의 같은 이름
  파일·폴더가 있으면 409, 미러 저장소는 409.

### 폴더 삭제

`path` 가 폴더면 그 아래 전부가 지워지고, 지워진 경로 목록이 응답에 들어옵니다.
실제 파일 바이트는 다른 스냅샷이 참조할 수 있으므로 남습니다.

### 다운로드

`Content-Type` 은 업로더가 보낸 값이 아니라 **확장자 화이트리스트**로 정합니다.
`inline=1` 은 이미지·오디오·비디오·PDF·평문에만 적용되고, 그 외(HTML·SVG 포함)는 항상
`attachment` 로 내려갑니다.

캐시: 응답에 항상 `ETag: "<blobHash>"` 가 붙습니다. `snapshot` 없이 현재 파일을 받으면
`Cache-Control: private, no-cache` 라 브라우저가 매번 `If-None-Match` 로 확인하고(내용이 같으면
`304`), `snapshot` 을 지정하면 그 시점의 내용은 바뀌지 않으므로 `immutable` 로 오래 캐시합니다.
제안 파일(`/proposals/:id/raw`)도 `immutable` 입니다.

**이어받기.** `Accept-Ranges: bytes` 이고 단일 구간 `Range` 를 주면 `206`, 범위를 벗어나면 `416` 입니다.
`If-Range` 에 ETag 를 주면 그 사이 파일이 바뀐 경우 전체(`200`)를 줍니다.

### 다운로드 링크와 폴더 zip

`POST /repos/:repoId/download-link` 가 주는 `url`(`/api/dl?t=…`)은 **로그인 헤더 없이** 받을 수 있어,
브라우저·OS 의 다운로드 기능이 디스크로 바로 받고 이어받습니다.

- 링크는 **그 사용자·그 저장소·그 경로(·시점) 하나**에 묶이고 **10분** 뒤 만료됩니다. 받을 때 멤버인지
  다시 확인하고, 비밀번호를 바꿔 토큰 세대가 오르면 쓸 수 없습니다. 만료·위조는 `404`.
- `archive: true` 면 `path` 는 폴더(`""` 는 저장소 전체)이고 링크는 **zip** 을 흘려보냅니다. 압축하지 않고
  담으며(대부분 이미 압축된 파일이라), 크기를 미리 계산해 `Content-Length` 를 주고, 4GB 가 넘으면 ZIP64 입니다.


### 제안용 업로드 (`/blobs`)

올린 파일은 **그 저장소에 올린 것으로 기록**되며, 제안에는 이 저장소에 올렸거나 이 저장소의
이력에 있는 blob 만 담을 수 있습니다. 사용자별로 하루(`LISTUP_MAX_STAGING_MB_PER_DAY`)를 넘으면
`413` 입니다.

---

## 초대

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| POST | `/repos/:repoId/invites` | editor | `{role?, expiresInDays?, maxUses?}` |
| GET | `/repos/:repoId/invites` | editor | 발급 목록 |
| DELETE | `/invites/:inviteId` | editor 이면서 발급자, 또는 owner | 회수 (viewer 로 내려간 발급자는 403) |
| GET | `/invites/:code` | 로그인 | 참여 전 미리보기 |
| POST | `/invites/:code/join` | 로그인 | 참여 |

- `role` 은 `viewer`(기본) 또는 `editor`. **`owner` 는 줄 수 없습니다.**
- 코드는 소문자·하이픈·공백을 섞어 보내도 됩니다 (`abcde-12345` → `ABCDE12345`).
- 미리보기는 저장소 이름·소유자·멤버 수·파일 수와 `currentRole`(이미 멤버면 그 역할)을 줍니다.
- 이미 멤버인 사람이 다시 참여를 호출하면 `alreadyMember: true` 를 돌려주고 **사용 횟수를
  소모하지 않습니다.**
- 초대를 만든 사람이 더 이상 그 저장소의 editor 이상 멤버가 아니면 그 초대는 쓸 수 없습니다
  (`409`). 목록의 `active` 도 `false` 입니다.
- 코드 모양이 틀리면 `400`, 없는 코드(또는 지워진 저장소)는 `404`, 회수·만료·소진은 `409` 입니다.
  미리보기는 이미 멤버인 사람에게는 회수·만료된 코드도 보여 줍니다(`currentRole`).

---

## 변경 제안

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos/:repoId/proposals?status=&limit=&before=` | viewer | 목록 (`open`/`merged`/`closed`, 그 밖은 400). 아래 *제안 목록 페이지* |
| POST | `/repos/:repoId/proposals` | **viewer** | 제안 만들기 → `{proposal}` (201) |
| GET | `/proposals/:proposalId` | viewer | 상세 + 충돌 여부 |
| PATCH | `/proposals/:proposalId` | 작성자 | `{title?, description?}` — `open` 상태에서만 |
| GET | `/proposals/:proposalId/raw?path=&inline=1` | viewer | 제안에 담긴 파일 내려받기 (`inline` 은 `/raw` 와 같음) |
| POST | `/proposals/:proposalId/comments` | viewer | `{body}` → `{comments}` (201) |
| POST | `/proposals/:proposalId/resolve` | 작성자 또는 editor | `{resolutions: {경로: "mine"\|"theirs"\|"merge"}}` → `{proposal}`. 아래 *충돌 정리* |
| POST | `/proposals/:proposalId/merge` | **editor** | 저장소에 반영 → `{proposal, snapshotId}`. 열려 있지 않거나 변경이 없으면 409 |
| POST | `/proposals/:proposalId/close` | 작성자 또는 editor | 닫기 → `{proposal}`. 이미 반영됐으면 409, 이미 닫혔으면 그대로 200 |
| POST | `/proposals/:proposalId/reopen` | 작성자 또는 editor | 다시 열기 → `{proposal}`. 닫힌 것만(아니면 409) |

**제안 목록 페이지.** 응답은 `{proposals, next}` 이고 새 제안(번호가 큰 것)부터 옵니다.

- `limit` 을 주면(최대 100, 숫자가 아니면 30) 그만큼만 주고, 더 있으면 `next` 에 `{before: <이 페이지 마지막 번호>}` 를 줍니다.
  다음 페이지는 `?limit=30&before=<next.before>` 로 부릅니다. 더 없으면 `next: null`.
- 커서가 제안 번호라 그 사이에 새 제안이 올라와도 페이지가 밀리거나 겹치지 않습니다.
- `limit` 이 없으면 예전처럼 전부를 한 번에 주고 `next: null` 입니다 (1.3.0 까지의 앱).
- `before` 가 양의 정수가 아니면 400.

### 제안 만들기

```json
POST /api/repos/:repoId/proposals
{
  "title": "3월 회의록 오타 수정",
  "description": "마지막 문단을 다듬었습니다.",
  "changes": [
    { "path": "문서/회의록.md", "blobHash": "a1b2…" },
    { "path": "문서/구버전.md", "blobHash": null }
  ]
}
```

- `blobHash` 는 `POST /repos/:repoId/blobs` 로 먼저 올려 받은 값입니다.
- `blobHash: null` 은 삭제 제안입니다.
- **`op`(추가/수정/삭제)는 보내지 않습니다.** 서버가 현재 저장소 상태를 보고 판정합니다.
- 거부되는 경우: 없는 파일 삭제, 내용이 기존과 동일, 같은 경로 중복, 올리지 않은 blob 참조,
  **다른 저장소에 올린 blob 참조**(400), 제안 안의 경로끼리 파일/폴더 이름이 겹침(400), 저장소의 파일·폴더와
  이름 충돌(409), 저장소 총량·파일 수 한도(413/409).

### 상세 응답에서 볼 것

상세·만들기·고치기·닫기·다시 열기는 모두 `{proposal: {...}}` 로 감싸서 줍니다.

```json
{
  "proposal": {
    "status": "open",
    "mergeable": false,
    "conflicts": ["문서/회의록.md", "새폴더/안.txt"],
    "conflictDetails": [
      { "path": "문서/회의록.md", "reason": "changed" },
      { "path": "새폴더/안.txt", "reason": "name" }
    ],
    "changes": [
      { "path": "…", "op": "update", "size": 2048, "baseBlobHash": "…", "baseSize": 1990 }
    ]
  }
}
```

`conflictDetails` 는 `conflicts` 의 경로마다 이유를 붙입니다 — `changed` 는 제안 뒤 저장소에서 같은 파일이
바뀐 것, `name` 은 더하려는 경로가 저장소의 파일·폴더와 이름이 겹치게 된 것. 1.3.0 까지의 서버에는 없습니다.

`baseBlobHash`/`baseSize` 는 제안 당시의 원본이므로, 리뷰 화면에서 "현재본"과 "제안본"을
나란히 내려받아 비교할 수 있습니다.

### 충돌 정리 (`resolve`, 1.4.0)

반영할 수 없는 제안(`conflictDetails`)을 지우지 않고 그 자리에서 풉니다. **지금의 충돌 경로마다 빠짐없이** 고릅니다.

- `mine` — 제안 내용을 그대로(저장소의 그 변경을 덮어씀). `changed` 충돌만.
- `theirs` — 저장소 내용을 그대로 — 그 파일을 제안에서 뺍니다. `name` 충돌은 이것만 됩니다.
- `merge` — 텍스트를 줄 단위 3-way(diff3)로 합칩니다. 상세의 `conflictDetails[].autoMerge` 가 참인 것만 —
  1MB 이하 UTF-8 텍스트이고 양쪽이 서로 다른 줄을 고쳤을 때(붙어 있는 줄을 따로 고치면 git 처럼 충돌). 합칠 수
  없으면 409.

정리하면 제안의 기준을 지금 저장소로 옮겨 다시 반영할 수 있게 되고, 무엇을 골랐는지 의견으로 남습니다. "충돌 난
파일만 빼고 반영"은 모두 `theirs` 로 정리한 뒤 반영하면 됩니다. 빠진 충돌·충돌 아닌 경로·이름 충돌의 `mine` 은 400,
그 사이 저장소가 바뀌면 409.

### 병합

```
POST /api/proposals/:proposalId/merge
```

성공하면 새 스냅샷이 만들어지고 제안은 `merged` 가 됩니다. 병합 시점에도 파일/폴더 이름 충돌,
저장소당 파일 수, 저장소 총량을 다시 검사합니다.
제안 이후 같은 파일이 저장소에서 바뀌었다면:

```json
409 { "error": { "code": "conflict", "message": "…", "details": { "conflicts": ["문서/회의록.md"] } } }
```

---

## 공개 링크 (1.4.0)

저장소 밖의 사람(계정 없음)과 다른 서버에게 주는 링크입니다. 링크는 `<서버>/s/<토큰>` — 서버가 주는 웹이 열고,
API 는 `/api/s/<토큰>/…` 입니다. 토큰이 곧 권한이라 로그인하지 않습니다(18바이트 무작위, 로그에는 가립니다).

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| POST | `/repos/:repoId/shares` | editor (mirror 는 owner) | `{kind, path?, label?, expiresInDays?, maxUses?, maxMb?}` → `{share}` (201) |
| GET | `/repos/:repoId/shares` | editor | `{shares}` — 따라가기 키는 소유자에게만 |
| DELETE | `/shares/:shareId` | 만든 사람 또는 owner | 회수 → `{share}` |
| GET | `/s/:token` | (링크) | `{share: {kind, label, repoName, name, isFile, expiresAt, files?, remainingBytes?, maxFileBytes?}}` |
| GET | `/s/:token/raw?path=` | (받기 링크) | 대상 안의 파일 하나 (`Range` 가능, 이어받기는 횟수에 세지 않음) |
| GET | `/s/:token/zip` | (받기 링크) | 대상 폴더를 zip 으로 |
| POST·PUT·GET·DELETE | `/s/:token/uploads…` | (받기 함) | 나눠 올리기와 같은 모양(`/uploads/:id?offset=`, `/complete`) |
| POST | `/s/:token/submit` | (받기 함) | `{name, message?, files: [{path, blobHash}]}` → 변경 제안 하나 (201 `{number, files}`) |
| GET | `/s/:token/mirror` | (따라가기 키) | 저장소의 지금 모습 `{repo, head, files: [{path, blobHash, size, mimeType, updatedAt}]}` |
| GET | `/s/:token/mirror/blobs/:hash` | (따라가기 키) | 지금 파일의 내용 |

- **kind** — `download`(받기 링크: `path` 의 파일·폴더, `''` 은 저장소 전체), `upload`(받기 함: 올린 파일이 `path`
  폴더로 가는 변경 제안이 됨), `mirror`(따라가기 키: 저장소 전체, 기한 없음).
- 기간은 기본 7일(`expiresInDays: null` 이면 없음, 최대 365), 받기 링크의 `maxUses` 는 받은 횟수, 받기 함은 보낸
  횟수입니다. 받기 함의 `maxMb` 는 기본 `LISTUP_MAX_STAGING_MB_PER_DAY`.
- 받기 함은 **덮어쓰지 않습니다** — 같은 이름이 있으면 `이름 (1).확장자` 로 더합니다. 제안의 작성자는 링크를 만든
  사람이고 `guestName` 에 보낸 사람이 적은 이름이 들어갑니다. 손님이 보낸 `hash` 는 손상 확인에만 쓰고 즉시
  올리기는 하지 않습니다(저장소에 어떤 내용이 있는지 해시로 떠보지 못하게).
- 회수·만료·소진, 또는 만든 사람이 그 권한(editor·owner)을 잃으면 `409`(이유를 알려 줌). 없는 토큰은 `404`.
- 미러 저장소에는 받기 함을 만들 수 없습니다.

### 서버 간 따라가기 (미러)

원본 서버의 소유자가 따라가기 키를 만들어 링크를 주면, 다른 서버의 누군가가 `POST /repos/mirror {link}` 로 그 저장소의
**읽기 전용 사본**을 만듭니다. 그 서버가 원본의 지금 모습을 받아 **없는 내용(해시)만** 내려받아 해시를 다시 확인하고
스냅샷 하나로 반영합니다. `LISTUP_MIRROR_INTERVAL_MIN`(기본 30분)마다, 또는 소유자가 "지금 가져오기"로.

- 저장소 요약의 `mirror` 에 `{sourceUrl, lastSyncedAt, lastError, syncing}`.
- 미러 저장소에 파일을 올리거나 바꾸거나 제안하면 409 — 원본에서 바꾸면 따라옵니다. 그만두면 보통 저장소.
- 원본 서버가 꺼져 있거나 키가 회수돼도 사본은 그대로 봅니다(`lastError` 에 남음).
- 남이 준 주소로 서버가 요청을 보내므로, 실패 이유는 자세히 돌려주지 않습니다.

---

## 제한값

| 항목 | 값 |
| --- | --- |
| 파일 하나 최대 크기 | 2GB (`LISTUP_MAX_UPLOAD_MB`). multipart 업로드는 프록시 한도(Cloudflare 100MB)에도 걸립니다 |
| 나눠 올리기 조각 | 8MB (서버는 16MB 까지 받음) |
| 한 번의 여러 파일 커밋 | 5,000 |
| 다운로드 링크 수명 | 10분 |
| 재설정 코드 수명 | 30분, 한 번 |
| 저장소 총량 | 4GB (`LISTUP_MAX_REPO_MB`) |
| 사용자별 하루 제안용 업로드 | 1GB (`LISTUP_MAX_STAGING_MB_PER_DAY`) |
| 저장소당 파일 수 | 5,000 |
| 한 제안의 변경 수 | 200 |
| 경로 길이 / 깊이 | 512자 / 24단계 |
| 초대 만료 | 최대 365일 |
| 초대 사용 횟수 | 최대 10,000 |
| 댓글 길이 | 2,000자 |
| 제안 제목 / 설명 | 120자 / 2,000자 |
| JSON 요청 본문 | 1MB |
| 자동 병합할 텍스트 | 1MB, UTF-8 |
| 공개 링크 기간 | 기본 7일, 최대 365일 |
| 받기 함 한 번에 보내는 파일 | 200 |
| 변경 이력 보존 | 최근 30일(`LISTUP_HISTORY_DAYS`), 그 전은 `LISTUP_HISTORY_KEEP_OLDER` |
