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
| `conflict` | 409 | 병합 충돌, 초대 소진, 중복 가입 등 |
| `payload_too_large` | 413 | 업로드 한도 초과 |

병합 충돌일 때는 `details.conflicts` 에 문제가 된 경로 목록이 들어갑니다.

---

## 인증

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/auth/signup` | `{email, password, displayName}` → `{token, user}` (201) |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | 현재 사용자 |
| PATCH | `/auth/me` | `{displayName}` |
| POST | `/auth/password` | `{currentPassword, newPassword}` |

비밀번호는 8자 이상. 로그인 실패 메시지는 이메일 존재 여부와 무관하게 동일합니다.

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
| GET | `/repos/:repoId/history` | viewer | 스냅샷 목록 (`limit`, `before`) |

---

## 파일

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos/:repoId/files?path=&snapshot=` | viewer | 폴더 목록. `snapshot` 을 주면 과거 시점 |
| POST | `/repos/:repoId/files?path=` | editor | multipart 업로드 = 직접 커밋 |
| DELETE | `/repos/:repoId/files?path=` | editor | 파일 또는 폴더 삭제 |
| POST | `/repos/:repoId/files/move` | editor | `{from, to}` — 파일·폴더 이동/이름 변경 |
| GET | `/repos/:repoId/raw?path=&snapshot=&inline=1` | viewer | 파일 내려받기 |
| POST | `/repos/:repoId/blobs` | viewer | 제안용 파일 업로드 → `{hash, size, mimeType, name}` |

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

### 폴더 삭제

`path` 가 폴더면 그 아래 전부가 지워지고, 지워진 경로 목록이 응답에 들어옵니다.
실제 파일 바이트는 다른 스냅샷이 참조할 수 있으므로 남습니다.

### 다운로드

`Content-Type` 은 업로더가 보낸 값이 아니라 **확장자 화이트리스트**로 정합니다.
`inline=1` 은 이미지·오디오·비디오·PDF·평문에만 적용되고, 그 외(HTML·SVG 포함)는 항상
`attachment` 로 내려갑니다.

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

---

## 변경 제안

| 메서드 | 경로 | 최소 권한 | 설명 |
| --- | --- | --- | --- |
| GET | `/repos/:repoId/proposals?status=` | viewer | 목록 (`open`/`merged`/`closed`) |
| POST | `/repos/:repoId/proposals` | **viewer** | 제안 만들기 |
| GET | `/proposals/:proposalId` | viewer | 상세 + 충돌 여부 |
| PATCH | `/proposals/:proposalId` | 작성자 | `{title?, description?}` |
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
- 거부되는 경우: 없는 파일 삭제, 내용이 기존과 동일, 같은 경로 중복, 올리지 않은 blob 참조.

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

성공하면 새 스냅샷이 만들어지고 제안은 `merged` 가 됩니다.
제안 이후 같은 파일이 저장소에서 바뀌었다면:

```json
409 { "error": { "code": "conflict", "message": "…", "details": { "conflicts": ["문서/회의록.md"] } } }
```

---

## 제한값

| 항목 | 값 |
| --- | --- |
| 파일 하나 최대 크기 | 100MB (`LISTUP_MAX_UPLOAD_MB`) |
| 저장소당 파일 수 | 5,000 |
| 한 제안의 변경 수 | 200 |
| 경로 길이 / 깊이 | 512자 / 24단계 |
| 초대 만료 | 최대 365일 |
| 초대 사용 횟수 | 최대 10,000 |
| 댓글 길이 | 2,000자 |
