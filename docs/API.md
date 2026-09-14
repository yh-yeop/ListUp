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
| `payload_too_large` | 413 | 파일 하나 크기·저장소 총량·하루 업로드 한도 초과 |
| `too_many_requests` | 429 | 로그인·재설정 코드 실패가 잦음. `details.retryAfterSeconds` 뒤에 다시 |
| `internal` | 500 | 서버 오류. `requestId` 가 함께 오므로 로그와 대조할 수 있습니다 |

병합 충돌·경로 충돌일 때는 `details.conflicts` 에 문제가 된 경로 목록이 들어갑니다.

---

## 서버 상태

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | 로그인 없이. `{ok, time, maxUploadBytes, apiVersion, apiLevel, version}` |

```json
{ "ok": true, "time": 1789355589634, "maxUploadBytes": 2147483648, "apiVersion": 1, "apiLevel": 2, "version": "1.2.0" }
```

- **`apiVersion`** — API 호환 버전(`shared` 의 `API_VERSION`). 서버와 앱이 서로 알아듣지 못하게
  바뀔 때만 올립니다. 설치형 클라이언트는 서버와 따로 업데이트되므로, 들어가기 전에 이 값을 자기
  값과 견주고 다르면 들어가지 않습니다. **이 필드가 없는 서버(1.0.0)는 `1` 로 봅니다.**
- **`apiLevel`** — 기능 수준(`API_LEVEL`). 호환을 깨지 않고 기능을 더할 때 올립니다(옛 앱은 무시).
  앱은 자기가 쓰는 기능이 있는 수준(`REQUIRED_SERVER_API_LEVEL`) 미만 서버에는 "서버가 오래됨"으로
  들어가지 않습니다. 2 = 1.2.0 (나눠 올리기·여러 파일 커밋·다운로드 링크·zip·Range·재설정).
  **필드가 없는 서버(1.1.0 까지)는 `1`** 입니다.
- `version` — 서버 버전(`server/package.json`). 사람에게 보여주는 용도이고 호환 판단에는 쓰지 않습니다.
- `maxUploadBytes` — 파일 하나의 업로드 한도. 앱이 올리기 전에 검사합니다.

---

## 인증

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/auth/signup` | `{email, password, displayName}` → `{token, user}` (201) |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | 현재 사용자 |
| PATCH | `/auth/me` | `{displayName}` |
| POST | `/auth/password` | `{currentPassword, newPassword}` |
| POST | `/auth/reset` | `{email, code, newPassword}` → `{token, user}` — 로그인 없이 |

비밀번호는 8자 이상. 로그인 실패 메시지는 이메일 존재 여부와 무관하게 동일하고, 응답 시간도
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
| POST | `/repos` | — | `{name, description?}` → 만든 사람이 owner |
| GET | `/repos/:repoId` | viewer | 요약(파일 수, 용량, 멤버 수, 열린 제안 수, 내 역할) |
| PATCH | `/repos/:repoId` | owner | `{name?, description?}` |
| DELETE | `/repos/:repoId` | owner | 저장소 삭제 |
| GET | `/repos/:repoId/members` | viewer | 멤버 목록 (이메일은 owner 에게만) |
| PATCH | `/repos/:repoId/members/:userId` | owner | `{role}` — `viewer` 또는 `editor` |
| DELETE | `/repos/:repoId/members/:userId` | 본인 또는 owner | 내보내기/나가기. owner 는 나갈 수 없음 |
| POST | `/repos/:repoId/transfer` | owner | `{userId}` — 넘긴 사람은 editor 로 남음 |
| GET | `/repos/:repoId/history` | viewer | 스냅샷 목록. 응답 `{snapshots, next}` — `next` 가 있으면 `?before=&beforeId=` 로 이어서 요청 (`limit` 최대 100) |

- 멤버를 내보내거나 viewer 로 강등하면 **그 사람이 만든 초대는 함께 회수**됩니다.

---

## 파일

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos/:repoId/files?path=&snapshot=` | viewer | 폴더 목록. `snapshot` 을 주면 과거 시점 |
| POST | `/repos/:repoId/files?path=` | editor | multipart 업로드 = 직접 커밋 |
| POST | `/repos/:repoId/files/commit` | editor | `{changes:[{path, blobHash\|null}], message?}` — 여러 파일을 스냅샷 하나로 |
| DELETE | `/repos/:repoId/files?path=` | editor | 파일 또는 폴더 삭제 |
| POST | `/repos/:repoId/files/move` | editor | `{from, to}` — 파일·폴더 이동/이름 변경 |
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

내용이 기존과 완전히 같으면 새 스냅샷을 만들지 않고 `unchanged: true` 를 돌려줍니다.

- 한도(`LISTUP_MAX_UPLOAD_MB`)를 넘는 파일은 `413` 이고 **아무것도 커밋되지 않습니다.**
- 저장소 총량이 `LISTUP_MAX_REPO_MB` 를 넘게 되면 `413` 입니다.
- 업로드가 진행되는 동안 다른 커밋이 생겨도 그 커밋 위에 올라갑니다 (덮어쓰지 않음).

### 나눠 올리기 (큰 파일, 끊겨도 이어서)

한 요청 본문이 프록시 한도(Cloudflare 100MB)를 넘지 않게 **8MB 조각**으로 보냅니다. 앱과 `npm run sync` 는 늘 이 길을 씁니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/repos/:repoId/uploads` | `{name, size}` → `{upload: {id, size, received, chunkSize}}` (201). 최소 viewer |
| PUT | `/uploads/:uploadId?offset=N` | `Content-Type: application/octet-stream` 조각 → `{upload}` |
| GET | `/uploads/:uploadId` | 어디까지 받았는지 (`received`) |
| POST | `/uploads/:uploadId/complete` | `{blob: {hash, size, mimeType, name}}` (201) |
| DELETE | `/uploads/:uploadId` | 취소 |

- `offset` 이 서버가 받은 길이와 다르면 `409` 에 `details.received` — 그 위치부터 다시 보내면 됩니다.
  끊긴 조각은 받은 데까지만 남습니다.
- 세션은 만든 사람만 쓰고, 그 저장소 멤버가 아니게 되면 `404` 입니다. 서버를 다시 켜도 이어지고,
  오래 멈춘 세션은 정리 작업(GC)이 지웁니다.
- 크기 한도는 세션을 만들 때 `size` 로 먼저 봅니다. **편집 권한이 없는 사람**(제안용)은 하루 업로드
  한도도 만들 때와 완료할 때 봅니다.
- 완료한 blob 은 아직 저장소에 들어간 것이 아닙니다. `files/commit` 이나 변경 제안에 `blobHash` 로 담습니다.

### 여러 파일 커밋 (`files/commit`)

```json
POST /api/repos/:repoId/files/commit
{ "changes": [ { "path": "사진/1.jpg", "blobHash": "a1b2…" }, { "path": "옛날.txt", "blobHash": null } ], "message": "폴더 올리기" }
```

- 한 번에 반영하고 **스냅샷 하나**를 만듭니다. `blobHash: null` 은 삭제(없는 파일이면 무시).
- 이 저장소에 올렸거나 이력에 있는 blob 만 담을 수 있습니다. 이름 충돌 `409`, 한도 `413`/`409`.
- 응답 `{snapshotId, unchanged, added, updated, deleted}`. 바뀐 것이 없으면 `200` 에 `unchanged: true`.

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
| DELETE | `/invites/:inviteId` | 발급자 또는 owner | 회수 |
| GET | `/invites/:code` | 로그인 | 참여 전 미리보기 |
| POST | `/invites/:code/join` | 로그인 | 참여 |

- `role` 은 `viewer`(기본) 또는 `editor`. **`owner` 는 줄 수 없습니다.**
- 코드는 소문자·하이픈·공백을 섞어 보내도 됩니다 (`abcde-12345` → `ABCDE12345`).
- 미리보기는 저장소 이름·소유자·멤버 수·파일 수와 `currentRole`(이미 멤버면 그 역할)을 줍니다.
- 이미 멤버인 사람이 다시 참여를 호출하면 `alreadyMember: true` 를 돌려주고 **사용 횟수를
  소모하지 않습니다.**
- 초대를 만든 사람이 더 이상 그 저장소의 editor 이상 멤버가 아니면 그 초대는 쓸 수 없습니다
  (`409`). 목록의 `active` 도 `false` 입니다.

---

## 변경 제안

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos/:repoId/proposals?status=` | viewer | 목록 (`open`/`merged`/`closed`) |
| POST | `/repos/:repoId/proposals` | **viewer** | 제안 만들기 |
| GET | `/proposals/:proposalId` | viewer | 상세 + 충돌 여부 |
| PATCH | `/proposals/:proposalId` | 작성자 | `{title?, description?}` — `open` 상태에서만 |
| GET | `/proposals/:proposalId/raw?path=` | viewer | 제안에 담긴 파일 내려받기 |
| POST | `/proposals/:proposalId/comments` | viewer | `{body}` |
| POST | `/proposals/:proposalId/merge` | **editor** | 저장소에 반영 |
| POST | `/proposals/:proposalId/close` | 작성자 또는 editor | 닫기 |
| POST | `/proposals/:proposalId/reopen` | 작성자 또는 editor | 다시 열기 |

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
  **다른 저장소에 올린 blob 참조**(400), 파일/폴더 이름 충돌(409), 저장소 총량·파일 수 한도(413/409).

### 상세 응답에서 볼 것

```json
{
  "status": "open",
  "mergeable": false,
  "conflicts": ["문서/회의록.md"],
  "changes": [
    { "path": "…", "op": "update", "size": 2048, "baseBlobHash": "…", "baseSize": 1990 }
  ]
}
```

`baseBlobHash`/`baseSize` 는 제안 당시의 원본이므로, 리뷰 화면에서 "현재본"과 "제안본"을
나란히 내려받아 비교할 수 있습니다.

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
