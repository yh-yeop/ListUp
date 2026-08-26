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
| `conflict` | 409 | 병합 충돌, 초대 소진, 중복 가입, 파일/폴더 이름 충돌 등 |
| `payload_too_large` | 413 | 파일 하나 크기·저장소 총량·하루 업로드 한도 초과 |
| `internal` | 500 | 서버 오류. `requestId` 가 함께 오므로 로그와 대조할 수 있습니다 |

병합 충돌·경로 충돌일 때는 `details.conflicts` 에 문제가 된 경로 목록이 들어갑니다.

---

## 인증

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/auth/signup` | `{email, password, displayName}` → `{token, user}` (201) |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | 현재 사용자 |
| PATCH | `/auth/me` | `{displayName}` |
| POST | `/auth/password` | `{currentPassword, newPassword}` |

비밀번호는 8자 이상. 로그인 실패 메시지는 이메일 존재 여부와 무관하게 동일하고, 응답 시간도
같게 맞춥니다. `/auth/password` 에서 현재 비밀번호가 틀리면 `401` 이 아니라 **`400`** 입니다 —
`401` 은 "토큰이 무효"라는 뜻이라 앱이 로그아웃해 버리기 때문입니다.

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
| DELETE | `/repos/:repoId/files?path=` | editor | 파일 또는 폴더 삭제 |
| POST | `/repos/:repoId/files/move` | editor | `{from, to}` — 파일·폴더 이동/이름 변경 |
| GET | `/repos/:repoId/raw?path=&snapshot=&inline=1` | viewer | 파일 내려받기 |
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
| 파일 하나 최대 크기 | 100MB (`LISTUP_MAX_UPLOAD_MB`) |
| 저장소 총량 | 2GB (`LISTUP_MAX_REPO_MB`) |
| 사용자별 하루 제안용 업로드 | 1GB (`LISTUP_MAX_STAGING_MB_PER_DAY`) |
| 저장소당 파일 수 | 5,000 |
| 한 제안의 변경 수 | 200 |
| 경로 길이 / 깊이 | 512자 / 24단계 |
| 초대 만료 | 최대 365일 |
| 초대 사용 횟수 | 최대 10,000 |
| 댓글 길이 | 2,000자 |
