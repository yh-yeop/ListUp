# REFACTOR.md — UX 1단계 리팩터링 인계 기록

대상: `app/app/**`, `app/src/components/**` (UI 계층)
기준점: 커밋 `994c832` — typecheck 통과, `npm test` 226개 통과, `test:e2e` 210개 통과.
절차: Haiku 찾기(5기) → Opus 일괄 검증 → 비판 Sonnet → 이견만 Opus 재판정 → Sonnet 수정(파일 겹침 없음). 연속 실패 N=2 이면 2단계.
1단계 "수정 대상" 조건: 파일 하나 안에서 끝나고, 버튼 글자·accessibilityLabel 을 바꾸지 않는 것. 여러 파일·라벨 변경·설계 판단은 2단계, 구조 변경은 3단계.

## §1 지적

### §1a Haiku (83건)

- **H1** `app/app/repo/[repoId]/index.tsx:520` [a11y] — 폴더 행 전체 Pressable 에 accessibilityLabel 이 있어 안의 다운로드·⋯ IconButton 이 스크린리더에서 접근되지 않는다. 같은 행의 받기·더보기 기능을 음성 사용자가 쓸 수 없다. → 제안: 행 전체를 하나의 Pressable 로 묶지 말고, 이름·아이콘 영역만 'dir.name 폴더 열기' Pressable 로 두고 zip 받기 IconButton 과 ⋯ IconButton 은 같은 Row 의 형제로 둔다.
- **H2** `app/app/repo/[repoId]/index.tsx:602` [a11y] — 파일 행 Pressable 의 accessibilityLabel('{name} 내려받기')이 안의 받기·더보기 IconButton 을 가려 ⋯ 메뉴가 음성으로 접근되지 않고, 같은 이름의 '내려받기' 버튼이 두 개 생긴다. → 제안: 행 바깥 래퍼를 View 로 바꾸고, 이름 영역만 Pressable(라벨 '{name} 내려받기')로 두며 IconButton 들은 형제로 배치한다. 중복 라벨이 생기지 않게 한다.
- **H3** `app/src/components/SearchResults.tsx:100` [a11y] — 검색 결과 행 Pressable 이 '{name} 내려받기' 라벨로 감싸 안의 '폴더 열기'·'버전' IconButton 이 스크린리더에서 접근되지 않고, 받기 버튼도 중복된다. → 제안: 행 래퍼를 View 로 바꾸고 파일명·경로 영역만 내려받기 Pressable 로 두며, 폴더 열기·버전·받기 IconButton 은 형제로 둔다.
- **H4** `app/app/repo/[repoId]/compare.tsx:415` [a11y] (라벨 변경) — 체크 행의 accessibilityLabel 이 item.label(경로)만이라 안의 '크기 다름' Badge 와 크기 Caption 이 읽히지 않는다. 크기 차이라는 상태가 색·배지로만 전달되고 음성에서는 빠진다. → 제안: accessibilityLabel 에 크기 차이 여부와 크기를 덧붙인다(예: `${item.label}, 크기 다름`). 또는 accessibilityHint 로 상세를 준다.
- **H5** `app/app/repo/[repoId]/compare.tsx:308` [dead-end] (라벨 변경) — 저장소 목록 불러오기가 실패하면 ErrorNotice 에 onRetry 가 없어 '다시 시도' 가 없다. 폴더를 고르기 전에는 다시 불러올 방법이 없고, 폴더 선택을 취소하면 복구 경로가 없다. 오류도 성공 후 지워지지 않는다. → 제안: <ErrorNotice message={error} onRetry={() => void retryLoad()} /> 로 두고, retryLoad 에서 loadRepo 를 다시 부른 뒤 성공 시 setError(null) 한다.
- **H6** `app/src/components/SearchResults.tsx:76` [dead-end] (라벨 변경) — 파일 목록 받기 실패 시 ErrorNotice 에 onRetry 가 없다. useRepoFiles 는 key 가 같으면 다시 받지 않으므로, 사용자는 검색어를 지우고 다시 입력해야 재시도된다. → 제안: useRepoFiles 에 재시도 카운터를 두고 반환한 retry 를 <ErrorNotice message={error} onRetry={retry} /> 로 넘긴다.
- **H7** `app/app/repo/[repoId]/index.tsx:420` [feedback] — '폴더 올리기' 버튼은 uploading 일 때만 비활성화된다. 누른 뒤 pickFolder 와 uploadFolder 안의 listRepoFolder 네트워크 요청(255행) 동안에는 다시 눌려 선택기와 확인창이 겹칠 수 있다. → 제안: 준비 단계(폴더 선택·목록 조회)용 busy 상태를 두고 disabled 에 함께 건다. 파일 올리기 버튼도 같은 상태를 반영한다.
- **H8** `app/app/repo/[repoId]/compare.tsx:511` [theme-token] (다른 파일: app/src/theme.ts) — TabChip 의 borderRadius 가 999 로 하드코딩되어 theme.ts 의 radius.pill 토큰을 우회한다. → 제안: borderRadius: radius.pill 로 바꾸고 상단 import 에 radius 를 추가한다.
- **H9** `app/app/repo/[repoId]/compare.tsx:439` [inconsistency] (다른 파일: app/src/components/ui.tsx) — 목록 카드 맨 아래의 '더 보기' 를 구분선·패딩·ghost compact 버튼으로 직접 짜 두었다. ui.tsx 의 LoadMoreFooter 가 같은 역할을 하지만 라벨을 바꿀 수 없어 쓰지 못한다. compact ghost 버튼은 세로 높이가 약 34px 로 44px 에 못 미친다. → 제안: LoadMoreFooter 에 label 인자(기본값 '더 보기')를 추가하고 여기서는 `${tabItems.length - shown}개 더 보기` 를 넘겨 쓴다. 그러면 구분선·패딩·버튼 크기가 공통 컴포넌트로 통일된다.
- **H10** `app/app/repo/[repoId]/compare.tsx:420` [touch-target] — 비교 목록 행의 paddingVertical 이 spacing.sm(8)이라 한 줄 행의 높이가 약 33px 로, 44px 보다 작다. 행 전체가 체크 대상이라 탭 영역이 좁다. → 제안: paddingVertical 을 spacing.md(12) 이상으로 올리거나 minHeight: 44 를 준다.
- **H11** `app/app/repo/[repoId]/compare.tsx:509` [touch-target] — TabChip 의 세로 패딩(spacing.xs+2)과 13px 글자로 칩 높이가 약 28px 이라 44px 보다 현저히 작다. → 제안: hitSlop={{ top: 8, bottom: 8 }} 를 주어 탭 영역을 넓히거나, minHeight 를 44 에 가깝게 준다. 시각 크기는 그대로 둘 수 있다.
- **H12** `app/src/components/SearchResults.tsx:118` [layout] — Caption 한 줄(numberOfLines=1)에 폴더 경로·크기·날짜를 함께 넣어, 경로가 길면 꼬리 부분이 잘려 360dp 폰에서 크기와 날짜가 보이지 않는다. → 제안: 폴더 경로와 '크기 · 날짜' 를 두 줄로 나누고, 경로 줄에는 ellipsizeMode='middle' 을 준다.
- **H13** `app/app/repo/[repoId]/new-proposal.tsx:312` [a11y] (라벨 변경) — 상위 폴더로 Pressable 에 accessibilityRole 과 accessibilityLabel 이 없어 스크린리더가 버튼인지 알 수 없다. → 제안: accessibilityRole="button" 과 accessibilityLabel="상위 폴더로" 를 추가한다. 보이는 글자는 그대로라 화면 이름은 바뀌지 않는다.
- **H14** `app/app/repo/[repoId]/new-proposal.tsx:312` [touch-target] — 상위 폴더로 행은 세로 패딩 8 에 12px 글자라 터치 높이가 약 32dp 로 44dp 에 못 미친다. → 제안: paddingVertical 을 spacing.md(12) 이상으로 올리거나 hitSlop 을 준다. 같은 목록의 폴더 행(paddingVertical md)과 높이를 맞춘다.
- **H15** `app/app/repo/[repoId]/new-proposal.tsx:336` [a11y] (라벨 변경) — 폴더 행 Pressable 에 accessibilityRole 이 없고 폴더라는 상태도 아이콘 이름에만 있어 스크린리더가 탐색 가능한 항목으로 인식하지 못한다. → 제안: accessibilityRole="button" 을 추가하고 accessibilityLabel 에 "<폴더명> 폴더 열기" 를 넣는다.
- **H16** `app/app/repo/[repoId]/new-proposal.tsx:361` [a11y] (라벨 변경) — 파일 삭제 담기 행 Pressable 에 역할이 없고, 담김 상태는 opacity 0.5 와 "담김" 글자로만 전해져 disabled 상태가 역할 정보로 노출되지 않는다. → 제안: accessibilityRole="button" 과 accessibilityState={{ disabled: alreadyStaged }} 를 추가하고 accessibilityLabel 에 "<파일명> 삭제 담기" 를 넣는다.
- **H17** `app/app/repo/[repoId]/new-proposal.tsx:219` [error-placement] — 제출·경로 검증 오류는 화면 맨 위에 표시되는데 제출 버튼은 긴 목록을 지난 맨 아래(398행)에 있어, 사용자가 누른 곳에서 오류가 보이지 않는다. → 제안: 제출 버튼 바로 위에도 같은 ErrorNotice 를 두거나, 경로 오류는 해당 변경 행의 Input 아래에 표시한다.
- **H18** `app/app/repo/[repoId]/new-proposal.tsx:249` [feedback] — 파일 담기 버튼의 loading 은 progress 가 생긴 뒤에만 켜진다. 파일 선택 창이 떠 있거나 getMaxUploadBytes 를 기다리는 동안(99행)은 버튼이 정상처럼 보이고 다시 눌리며, addFiles 의 uploading 가드도 통과해 중복 선택이 생긴다. → 제안: addFiles 시작 시점에 별도 picking 상태를 세우고 Button 의 loading·disabled 에 함께 연결한다.
- **H19** `app/app/repo/[repoId]/proposals.tsx:79` [touch-target] — 검토 중/전체 필터 칩은 세로 패딩 6 에 13px 글자라 높이가 약 29dp 뿐이다. → 제안: paddingVertical 을 최소 spacing.md 이상으로 올리거나 hitSlop(예: 8)을 준다.
- **H20** `app/app/repo/[repoId]/proposals.tsx:83` [a11y] (다른 파일: app/src/components/ui.tsx) — 선택 상태를 accessibilityState 로만 전달하는데, ui.tsx 주석대로 react-native-web 은 accessibilityState 를 읽지 않아 웹에서는 선택 여부가 색으로만 드러난다. → 제안: aria-checked={active} 를 함께 준다(ui.tsx IconButton 의 aria-expanded 방식과 같다).
- **H21** `app/app/repo/[repoId]/proposals.tsx:86` [theme-token] — 필터 칩의 paddingVertical 이 spacing.sm - 2 로 토큰 값이 아닌 임의 값을 만들고, 같은 파일 186행은 gap={4} 로 spacing.xs 를 직접 쓰지 않는다. → 제안: 토큰 값(spacing.xs 또는 spacing.sm)을 쓰고, 186행 gap 은 spacing.xs 로 바꾼다.
- **H22** `app/app/repo/[repoId]/proposals.tsx:164` [a11y] (라벨 변경) — 제안 카드 전체가 Pressable 인데 accessibilityRole 이 없어 탭 가능한 링크나 버튼으로 전달되지 않는다. → 제안: accessibilityRole="link"(상세 화면 이동) 을 주고, accessibilityLabel 에 "#번호 제목" 을 넣는다.
- **H23** `app/app/proposal/[proposalId].tsx:181` [error-placement] — 작업 오류(반영·닫기·다시 열기·의견 등록)가 모든 동작 버튼과 의견 입력보다 위(제안 본문과 파일 목록 사이)에 표시되어, 의견 등록 실패 등이 입력한 곳에서 멀리 떨어진다. → 제안: 의견 입력 카드 안(의견 등록 버튼 위)에도 오류를 보이게 하거나, 오류를 해당 동작 버튼 근처로 옮긴다.
- **H24** `app/app/proposal/[proposalId].tsx:213` [feedback] — run() 은 한 번에 한 작업만 표시(action)하지만, 다른 버튼은 자기 loading 만 보고 disabled 가 없어 반영 요청 중에도 제안 닫기 등을 눌러 두 요청이 겹칠 수 있다. → 제안: Button 의 disabled 에 action !== null 을 연결해 작업 중에는 모든 동작 버튼을 막는다.
- **H25** `app/app/proposal/[proposalId].tsx:371` [touch-target] (다른 파일: app/src/components/ui.tsx) — 변경 행의 제안본 받기·현재본 받기 버튼은 compact 라 세로 패딩 8 에 13px 글자로 높이가 약 33dp 다. → 제안: 이 화면만 바꾸려면 paddingVertical 을 md 로 올린다. 공용 기준을 바꾸려면 ui.tsx Button 의 compact 를 조정한다.
- **H26** `app/app/repo/[repoId]/members.tsx:260` [touch-target] (다른 파일: app/src/components/ui.tsx) — 멤버 행의 편집 권한 주기·소유자로 지정·내보내기 버튼이 compact 라 높이가 약 33dp 이고, 같은 줄에 나란히 있어 오른쪽으로 밀리면 좁은 360dp 에서 탭이 어렵다. → 제안: compact 대신 기본 크기를 쓰거나 각 버튼에 hitSlop 을 준다. 줄바꿈(wrap)은 이미 되어 있다.
- **H27** `app/app/repo/[repoId]/members.tsx:300` [feedback] — 저장소 삭제 버튼은 확인 창 뒤에도 loading 이나 disabled 가 없어, 요청이 진행되는 동안 다시 눌러 확인 창과 요청이 중복될 수 있다. → 제안: deleteRepo 에 삭제 중 상태를 두고 Button 에 loading·disabled 를 연결한다.
- **H28** `app/app/repo/[repoId]/members.tsx:308` [feedback] — 저장소에서 나가기 버튼도 leave() 요청 중 busy 상태가 없어 같은 방식으로 중복 요청이 가능하다. → 제안: leave 에 진행 상태를 두고 Button 에 loading·disabled 를 연결한다.
- **H29** `app/app/repo/[repoId]/invites.tsx:299` [feedback] — 회수 버튼은 확인 창 뒤 요청 중 loading 이나 disabled 가 없어 두 번 눌리면 확인 창과 회수 요청이 겹친다. → 제안: revoke 에 해당 초대 id 의 진행 상태를 두고 Button 에 loading·disabled 를 연결한다.
- **H30** `app/app/repo/[repoId]/invites.tsx:275` [touch-target] (다른 파일: app/src/components/ui.tsx) — 초대 행의 링크 복사·공유·코드 복사·회수 버튼이 모두 compact 라 높이가 약 33dp 다. → 제안: 행 안의 버튼 높이를 44dp 근처로 맞추거나 hitSlop 을 준다.
- **H31** `app/app/repo/[repoId]/invites.tsx:337` [touch-target] — 역할·유효 기간·사용 횟수 칩이 세로 패딩 6 에 13px 글자라 높이가 약 29dp 이고, 세 줄이 칩으로 빽빽하게 늘어서 있다. → 제안: paddingVertical 을 spacing.md 이상으로 올리거나 hitSlop 을 준다.
- **H32** `app/app/repo/[repoId]/invites.tsx:340` [a11y] — 선택 상태를 accessibilityState 로만 전달하는데 react-native-web 은 이를 읽지 않아 웹에서 선택된 칩을 구분할 수 없고, 색에만 의존한다. → 제안: aria-checked={active} 를 추가한다.
- **H33** `app/app/repo/[repoId]/invites.tsx:326` [inconsistency] (다른 파일: app/src/components/ui.tsx, app/app/repo/[repoId]/proposals.tsx) — Chip 이 proposals.tsx 79행의 필터 칩과 같은 알약 모양 선택 버튼을 따로 구현하고 있으며, 공용 ui.tsx 에는 같은 역할의 컴포넌트가 없다. → 제안: ui.tsx 에 Chip(또는 SegmentChip) 을 추가해 두 파일이 함께 쓰게 하고, 패딩·접근성 속성을 한 곳에서 맞춘다.
- **H34** `app/app/repo/[repoId]/trash.tsx:234` [inconsistency] (라벨 변경) — 뷰어(열람 권한)에게도 개별 파일 되돌리기 버튼 라벨이 "되돌리기"로 나와, 누르면 제안이 만들어진다는 점이 드러나지 않는다. 같은 화면의 묶음 버튼(202행)과 versions.tsx(185행)는 "되돌리기 제안"으로 바꾼다. → 제안: accessibilityLabel 과 보이는 글자 모두 isEditor 에 따라 분기한다. 예: label={isEditor ? `${entry.name} 되돌리기` : `${entry.name} 되돌리기 제안`} 와 같은 식으로 맞추고, 보이는 아이콘 버튼의 라벨도 같은 값을 쓴다.
- **H35** `app/app/repo/[repoId]/history.tsx:99` [a11y] (라벨 변경) (다른 파일: e2e) — accessibilityLabel 이 행의 보이는 내용(작성자·상대 시각·파일 수·용량·"현재" 표시)을 통째로 덮어써서, 스크린리더 사용자는 "…시점의 파일 보기"만 듣고 그 시점의 정보를 알 수 없다. → 제안: 라벨에 핵심 정보를 함께 담는다. 예: `${snapshot.message || '변경'} 시점, ${snapshot.author.displayName}, ${formatRelativeTime(snapshot.createdAt)}, 파일 ${snapshot.fileCount}개의 파일 보기` 형태로 만들고, 현재 시점이면 "현재"를 덧붙인다. e2e 가 이 라벨을 찾으므로 e2e 의 이름도 함께 고친다.
- **H36** `app/app/repo/[repoId]/trash.tsx:227` [feedback] (다른 파일: app/src/components/ui.tsx) — 행의 다운로드·되돌리기 아이콘 버튼에는 busy/disabled 상태가 없다. 133행은 다운로드 중 busy 키("dl:…")를 세팅하지만 어디에서도 로딩 표시로 쓰지 않아, 내려받는 동안 아무 반응이 없고, 되돌리는 중 누른 행 버튼은 94행 가드에 막혀 조용히 무시된다. → 제안: IconButton 에 disabled 와 busy(로딩 표시) prop 을 추가하고, trash.tsx 에서 busy === `dl:${entry.snapshotId}:${entry.path}` 또는 busy === key 일 때 해당 버튼에 스피너를 보이며 나머지 행 버튼은 disabled 로 만든다.
- **H37** `app/app/repo/[repoId]/versions.tsx:183` [feedback] — 되돌리기 버튼에는 loading 이 연결되어 있지 않아(174-182행 다운로드 버튼만 loading), 되돌리는 네트워크 요청 중 스피너 없이 버튼만 흐려진다. 진행 중인지 알기 어렵다. → 제안: 되돌리기 Button 에 loading={busy === version.snapshotId} 를 추가한다(다운로드 버튼과 같은 방식).
- **H38** `app/src/components/ui.tsx:190` [a11y] — Button 은 busy·disabled 를 accessibilityState 로만 넘기는데, 같은 파일 242행 주석이 react-native-web 이 accessibilityState 를 읽지 않는다고 적고 있다. 웹에서는 로딩·비활성 상태가 스크린리더에 전달되지 않는다. → 제안: accessibilityState 옆에 aria-disabled={!!isDisabled} 와 aria-busy={!!loading} 을 함께 넘겨 웹에서도 상태가 노출되게 한다(IconButton 의 aria-expanded 와 같은 방식).
- **H39** `app/src/components/RepoNav.tsx:56` [a11y] — 선택된 탭 상태가 accessibilityState 로만 전달되어 웹에서는 전달되지 않을 수 있고, 시각적으로는 색과 배경으로만 표시된다. → 제안: Pressable 에 aria-selected={active} 를 추가한다(accessibilityState 는 네이티브용으로 유지).
- **H40** `app/src/components/ui.tsx:197` [touch-target] — compact 버튼의 세로 패딩이 spacing.sm(8px)라 글자 높이를 더해도 약 33px 이 되어 44px 보다 작다. compact 버튼은 되돌리기·받기·다시 시도·더 보기 등 여러 화면에서 쓰인다. → 제안: compact 일 때 minHeight: 44 를 주거나(글자 크기·배경은 그대로) hitSlop 을 세로로 줘서 터치 영역을 44px 이상으로 맞춘다.
- **H41** `app/src/components/ui.tsx:244` [touch-target] — IconButton 은 아이콘 20px 과 패딩 8px×2 로 약 36px 이다. hitSlop 8 은 네이티브에서만 여유를 주므로 웹에서는 36px 그대로이고, 휴지통 행마다 두 개가 붙어 있다. → 제안: 패딩 대신 minWidth/minHeight 44 를 주고 아이콘을 가운데 정렬한다. 행 간격이 좁아지지 않도록 확인한다.
- **H42** `app/src/components/RepoNav.tsx:57` [touch-target] — 탭 Pressable 은 세로 패딩 spacing.sm(8px)과 글자 높이로 약 33px 이며, 가로 스크롤 안에 있어 손가락으로 누르기 어렵다. → 제안: minHeight: 44 를 주거나 hitSlop 을 세로 방향으로 준다.
- **H43** `app/src/components/RepoNav.tsx:121` [touch-target] — 경로 빵부스러기의 홈 아이콘은 15px 이고 hitSlop 6 이 네이티브에서만 적용되어 누르는 영역이 약 27px 이다. → 제안: minWidth/minHeight 44 를 주고 아이콘을 가운데 정렬한다.
- **H44** `app/src/components/RepoNav.tsx:139` [touch-target] — 경로 세그먼트는 글자만 있는 링크라 높이가 약 17px 이고, hitSlop 6 을 더해도 44px 에 못 미친다. → 제안: Pressable 에 minHeight: 44 와 hitSlop 을 세로로 넉넉히 준다(글자 위치는 그대로).
- **H45** `app/src/components/ui.tsx:432` [a11y] — ErrorNotice 의 오류 문구가 일반 Text 라 스크린리더에 경고로 전달되지 않는다. 같은 앱의 토스트는 role=alert 을 쓰는데, 인라인 오류는 그렇지 않다. history·versions·trash 의 목록 로드 실패가 여기에 해당한다. → 제안: 문구 Text 에 accessibilityRole="alert" 와 웹용 role="alert" 을 넣는다(Toast.tsx 의 error 처리와 같은 방식).
- **H46** `app/src/components/ui.tsx:272` [a11y] (다른 파일: Field 를 쓰는 화면 파일들) — Field 의 라벨은 그냥 Text 이고 자식 Input 과 연결되지 않아, 스크린리더 사용자는 라벨 없이 입력창만 듣게 된다. → 제안: Field 가 label 을 자식 입력창의 accessibilityLabel 로 전달하거나(자식이 없으면 그대로 두고), 호출하는 쪽에서 입력창에 accessibilityLabel 을 주도록 문서화한다.
- **H47** `app/src/components/RepoNav.tsx:93` [theme-token] — 배지 글자 크기가 fontSize: 11 로 하드코딩되어 theme 의 fontSize 토큰(가장 가까운 fontSize.xs=12)을 우회한다. 같은 파일 88행 paddingHorizontal: 5, 60행 gap: 6 도 spacing 토큰 밖의 값이다. → 제안: fontSize: 11 을 fontSize.xs 로 바꾸고, 필요한 여백은 spacing 토큰으로 맞춘다.
- **H48** `app/src/components/ui.tsx:86` [a11y] — Title 이 접근성 제목(accessibilityRole="header")으로 표시되지 않아 스크린리더의 제목 탐색에서 화면 제목을 건너뛴다. → 제안: Text 에 accessibilityRole="header" 를 주고 웹에서는 aria-level 을 1 로 준다.
- **H49** `app/app/login.tsx:100` [a11y] (라벨 변경) (다른 파일: app/src/components/ui.tsx) — 아이디 입력칸(TextInput)에 accessibilityLabel 이 없고, 위 Field 라벨 Text 와도 연결돼 있지 않아 스크린 리더가 칸 이름을 알 수 없다. 비밀번호 칸(111행)도 같은 문제다. → 제안: ui.tsx 의 Field 가 자식 Input 에 label 을 accessibilityLabel 로 넘기도록 고친다(Input 이 accessibilityLabel 을 받게 하고 Field 가 기본값으로 전달). 호출부 login.tsx 는 그대로 두고 아이디·비밀번호 칸 모두 적용되는지 확인한다.
- **H50** `app/app/signup.tsx:64` [a11y] (라벨 변경) (다른 파일: app/src/components/ui.tsx) — 아이디 입력칸에 accessibilityLabel 이 없고 Field 라벨과 연결돼 있지 않다. 이름(56행)·비밀번호(75행) 칸도 같은 문제다. → 제안: ui.tsx 의 Field 가 자식 Input 에 라벨을 accessibilityLabel 로 전달하게 고쳐 세 칸 모두 이름을 얻게 한다.
- **H51** `app/app/reset-password.tsx:61` [a11y] (라벨 변경) (다른 파일: app/src/components/ui.tsx) — 아이디 입력칸에 accessibilityLabel 이 없고 Field 라벨과 연결돼 있지 않다. 재설정 코드(71행)·새 비밀번호(80행) 칸도 같은 문제다. → 제안: ui.tsx 의 Field 가 자식 Input 에 라벨을 accessibilityLabel 로 전달하게 고쳐 세 칸 모두 이름을 얻게 한다.
- **H52** `app/app/join.tsx:167` [a11y] (라벨 변경) (다른 파일: app/src/components/ui.tsx) — 초대 코드 입력칸에 accessibilityLabel 이 없고 Field 라벨 '초대 코드'와 연결돼 있지 않아, 가장 중요한 입력칸의 이름이 스크린 리더에 전달되지 않는다. → 제안: ui.tsx 의 Field 가 자식 Input 에 라벨을 accessibilityLabel 로 전달하게 고친다. 필요하면 이 칸에만 accessibilityLabel="초대 코드" 를 직접 준다.
- **H53** `app/app/repos.tsx:128` [a11y] (라벨 변경) (다른 파일: app/src/components/ui.tsx) — 저장소 이름 입력칸에 accessibilityLabel 이 없고 Field 라벨과 연결돼 있지 않다. 같은 파일 설명 입력칸(131행)도 같은 문제다. 검색 칸(158행)만 accessibilityLabel 이 있어 일관성도 깨진다. → 제안: ui.tsx 의 Field 가 자식 Input 에 라벨을 accessibilityLabel 로 전달하게 고친다. 그러면 저장소 이름·설명 칸 모두 적용된다.
- **H54** `app/app/login.tsx:106` [layout] — 아이디 칸 placeholder '아이디 (예전에 이메일로 가입했다면 그 이메일)' 이 360dp 폭(좌우 여백 16 + 카드 패딩 16 + 입력칸 패딩 12 를 빼면 약 270dp)에서 한 줄을 넘어 잘린다. 긴 안내가 placeholder 에만 있어 나머지가 보이지 않는다. → 제안: placeholder 는 '아이디' 로 줄이고, 이메일로 가입한 경우 안내는 Field hint 로 옮긴다(예: '예전에 이메일로 가입했다면 그 이메일을 씁니다.').
- **H55** `app/app/login.tsx:127` [touch-target] — '비밀번호를 잊었나요?' 는 글자 13dp 만 있는 링크라 높이가 약 18dp 이고 hitSlop 8 을 더해도 약 34dp 다. 44dp 에 못 미친다. → 제안: hitSlop 을 12 이상으로 늘리거나 paddingVertical 을 주어 탭 영역을 44dp 가까이 맞춘다.
- **H56** `app/app/login.tsx:135` [theme-token] — fontSize 13 을 직접 적었다. theme.ts 의 fontSize.sm 이 같은 값(13)이라 토큰을 우회하고 있다. → 제안: style={{ fontSize: fontSize.sm }} 로 바꾸고 상단 theme import 에 fontSize 를 추가한다.
- **H57** `app/app/login.tsx:142` [touch-target] — '회원가입' 은 패딩 없는 expo-router Link 글자라 탭 영역이 약 20dp 다. hitSlop 도 없어 44dp 에 한참 못 미친다. → 제안: Link 를 Pressable(accessibilityRole="link", hitSlop 12 이상)으로 감싸 router.push('/signup') 을 호출하고, 글자 스타일은 그대로 둔다.
- **H58** `app/app/login.tsx:156` [theme-token] — Body 에 fontSize 12 를 직접 적었다. theme.ts 의 fontSize.xs 가 12 라 토큰을 우회한다. → 제안: style={{ fontSize: fontSize.xs }} 로 바꾸고 theme import 에 fontSize 를 추가한다.
- **H59** `app/app/login.tsx:159` [touch-target] — '다른 서버'/'바꾸기' 링크는 글자 12dp 뿐이라 높이가 약 15dp 이고, hitSlop 8 을 더해도 약 31dp 다. 44dp 에 못 미친다. → 제안: Pressable 에 paddingVertical(spacing.sm) 을 주거나 hitSlop 을 12 이상으로 늘린다.
- **H60** `app/app/login.tsx:160` [theme-token] — fontSize 12 를 직접 적었다. theme.ts 의 fontSize.xs 와 같은 값이다. → 제안: fontSize: fontSize.xs 로 바꾼다.
- **H61** `app/app/signup.tsx:86` [error-placement] — 비밀번호 8자 미만 오류(27행)는 비밀번호 칸(74~82행)과 아이디 칸 아래 Remember 옵션 뒤에 떠서, 어느 칸이 문제인지 바로 연결되지 않는다. → 제안: 비밀번호 Field 바로 아래(또는 Field hint 자리)에 오류를 보이게 하거나, 최소 길이 오류일 때 해당 Field 에 빨간 테두리를 준다.
- **H62** `app/app/reset-password.tsx:91` [error-placement] — '비밀번호 8자 이상' 오류(34행)가 RememberLogin 아래 카드 끝에 뜨는데, 문제의 새 비밀번호 칸은 79~87행에 있어 멀리 떨어져 있다. 코드 누락 오류(29행)도 같은 위치라 어느 칸 문제인지 모호하다. → 제안: 각 검증 오류를 해당 Field 바로 아래에 표시하거나, 오류 발생 시 해당 Input 에 포커스를 준다.
- **H63** `app/app/reset-password.tsx:96` [theme-token] — Body 에 fontSize 12 를 직접 적었다. theme.ts 의 fontSize.xs 와 같은 값이다. → 제안: style={{ fontSize: fontSize.xs }} 로 바꾸고 theme import 에 fontSize 를 추가한다.
- **H64** `app/app/join.tsx:188` [error-placement] — 참여(join) 실패 오류(150행)는 이 카드 상단에 뜨는데, '코드로 참여하기' 버튼은 아래 미리보기 카드(242행)에 있다. 버튼을 누른 뒤 오류가 버튼에서 두 카드 위에 보인다. → 제안: 참여 오류는 미리보기 카드 안 참여 버튼 바로 위에 따로 표시한다(코드 조회 오류는 지금 자리 유지).
- **H65** `app/app/join.tsx:193` [feedback] — '코드 확인' 버튼은 loading={busy && !preview} 라서, 미리보기가 이미 떠 있는 상태에서 조회가 진행돼도 로딩 표시가 없고 disabled 도 아니어서 연타하면 조회가 여러 번 나간다. lookup() 에도 busy 가드가 없다. → 제안: loading 조건을 busy 로 바꾸거나 disabled={!normalized || busy} 를 주고, lookup() 시작에 if (busy) return 가드를 둔다.
- **H66** `app/app/join.tsx:219` [theme-token] — 미리보기 안 권한 박스의 borderRadius 에 spacing.md(12)를 써서 radius 토큰을 우회하고 있다. 값은 radius.md 와 같다. → 제안: borderRadius: radius.md 로 바꾸고 상단 theme import 에 radius 를 추가한다.
- **H67** `app/app/join.tsx:286` [touch-target] — '설치한 앱에서 열기' 는 패딩 없는 expo-router Link 글자라 탭 영역이 약 20dp 다. hitSlop 도 없다. → 제안: Link 를 Pressable(accessibilityRole="link", hitSlop 12 이상)으로 감싸 같은 주소를 연다. 글자 스타일은 그대로 둔다.
- **H68** `app/app/repos.tsx:93` [touch-target] — 헤더 '내 정보' 아이콘 버튼은 24dp 아이콘에 세로 패딩이 없고 hitSlop 8 뿐이라 탭 영역이 약 40dp 다. 같은 역할의 IconButton(ui.tsx, padding sm + hitSlop 8, 약 56dp)이 이미 있는데 손으로 다시 만들었다. → 제안: Pressable 과 Ionicons 를 IconButton(icon="person-circle-outline", label="내 정보", onPress=…, ui.tsx)으로 바꾼다. 접근성 이름은 그대로 '내 정보'다.
- **H69** `app/app/repos.tsx:111` [a11y] (다른 파일: app/src/components/ui.tsx) — '새 저장소' 버튼은 누르면 입력 카드가 열리고 닫히는데, 상태가 variant(배경색)로만 바뀌고 접근성 상태(expanded)가 없다. 스크린 리더는 펼침 여부를 알 수 없다. → 제안: ui.tsx 의 Button 이 expanded 를 받아 aria-expanded 를 주게 하고(IconButton 과 같은 방식), 여기서 creating 을 넘긴다. 라벨은 바꾸지 않는다.
- **H70** `app/app/settings.tsx:167` [feedback] — 비밀번호 입력의 onSubmitEditing={savePassword} 가 버튼의 disabled 조건(현재 비밀번호 없음, 새 비밀번호 8자 미만)과 savingPassword 가드를 우회한다. 키보드 Enter 로 빈 현재 비밀번호가 서버에 전송되고, 요청 중 Enter 를 연타하면 중복 요청이 나간다. → 제안: onSubmitEditing 을 버튼과 같은 조건으로 막는다: () => { if (currentPassword && newPassword.length >= 8 && !savingPassword) void savePassword(); }
- **H71** `app/app/host.tsx:324` [feedback] — 재설정 코드 입력의 onSubmitEditing={() => void issue()} 가 버튼의 disabled={!running || !email.trim()} 조건을 우회한다. 서버가 꺼져 있어도 Enter 로 발급을 시도할 수 있고, issue() 자체에 busy 가드가 없어 중복 발급이 가능하다. → 제안: issue() 시작에 if (busy || !running || !email.trim()) return; 가드를 두고, onSubmitEditing 도 같은 조건을 쓴다.
- **H72** `app/app/host.tsx:224` [feedback] — 공개 방식 라디오 Pressable 은 disabled={busy !== null} 로 막히지만 시각적 변화(opacity)도 accessibilityState 의 disabled 도 없어, 저장 중에도 모든 항목이 활성처럼 보인다. 누른 항목에도 진행 표시가 없다. → 제안: style 에 opacity: busy !== null ? 0.5 : pressed ? 0.6 : 1 을 주고, accessibilityState={{ disabled: busy !== null, checked: chosen }} 를 aria-checked 와 함께 준다. 누른 항목(busy === `tunnel-${option.mode}`)에 ActivityIndicator 를 보인다.
- **H73** `app/app/host.tsx:397` [feedback] — StartupCard 의 '이름 저장'(397행), '포트 저장'(427행), DataCard 의 '다른 폴더 쓰기'(454행)가 act 의 busy 를 loading 으로 받지 않는다. 요청 중 스피너가 없고 다시 눌러도 막히지 않으며, 이름 저장은 status 가 갱신되기 전까지 disabled 가 풀리지 않는다. busy 는 DataCard 의 백업 버튼에서만 쓰인다. → 제안: StartupCard·DataCard 에 busy 를 넘기고 각 버튼에 loading={busy === 'server-name'}, loading={busy === 'port'}, loading={busy === 'data-dir'} 를 준다.
- **H74** `app/app/host.tsx:82` [error-placement] — HostPanel 의 act 실패 메시지가 화면 맨 위(82행)에만 나온다. 그런데 act 를 쓰는 TunnelCard(120행), StartupCard(122행), DataCard(123행)는 화면 아래쪽이라, 누른 자리에서 화면 몇 개 분량 떨어진 곳에 오류가 뜬다. → 제안: act 의 오류 상태를 카드마다 두거나 TunnelCard·StartupCard·DataCard 안에 ErrorNotice 를 두어, 실패한 카드 안에서 바로 보이게 한다.
- **H75** `app/app/settings.tsx:179` [touch-target] — '서버'·'이 PC 에서 서버 열기'·'받은 파일 저장 폴더' 행(179, 197, 211행)의 Pressable 은 패딩 없이 Caption 글자 한 줄 높이(약 16~18px)만 탭 영역이 된다. 44px 에 한참 못 미친다. → 제안: Pressable 스타일에 paddingVertical: spacing.md 를 주거나 minHeight: 44 를 더한다(세 곳 모두).
- **H76** `app/app/settings.tsx:135` [error-placement] — 이름 저장과 비밀번호 변경의 오류가 모두 화면 맨 위 ErrorNotice(135행)에 한 번만 뜬다. 비밀번호 카드(149~176행)는 이름 카드 아래에 있어 오류와 버튼 사이가 멀다. → 제안: 비밀번호 카드 안, 변경 버튼(170행) 위에 비밀번호 전용 ErrorNotice 를 두고, 이름 오류는 이름 카드 안에 둔다.
- **H77** `app/src/components/AppVersion.tsx:40` [touch-target] — '소스 코드' Link 가 13px 글자만 있고 패딩이 없어 탭 영역이 한 줄 높이(약 18px)다. AGPL 소스 링크라 쉽게 눌러야 한다. → 제안: Link 스타일에 paddingVertical: spacing.md 를 주거나 minHeight: 44 와 alignItems 를 준다. accessibilityRole="link" 를 함께 명시한다.
- **H78** `app/src/components/AppVersion.tsx:80` [touch-target] (다른 파일: app/src/components/ui.tsx) — compact ghost 버튼('업데이트 확인' 80행, '릴리즈 페이지에서 받기' 96행, 165행)의 높이가 paddingVertical 8 + 13px 글자 줄 ≈ 34px 다. 같은 compact 버튼이 HostCard.tsx 73·84행, host.tsx 453행 등에도 쓰인다. → 제안: ui.tsx 의 Button 에서 compact 일 때도 minHeight: 44 를 주고 가로 패딩만 줄인다. 레이아웃이 바뀌므로 화면을 확인한다.
- **H79** `app/src/components/AppVersion.tsx:137` [feedback] (다른 파일: app/src/lib/apk-update.ts) — installApkUpdate 를 try/finally 로만 감싸 실패하면 예외가 그대로 빠지고, 153행 onPress 의 void 도 이를 잡지 않는다. 버튼은 원래대로 돌아가는데 실패 문구가 전혀 없다. 같은 문제가 DesktopUpdatePanel 66행 updates.install().finally(...) 에도 있다. apk-update 안에서 이미 잡는지는 확인이 필요하다. → 제안: install 과 DesktopUpdatePanel 의 설치 호출에 catch 를 두어 error 상태를 만들고, 버튼 아래 ErrorNotice 로 실패 이유를 보인다.
- **H80** `app/app/settings.tsx:200` [a11y] (라벨 변경) (다른 파일: e2e/) — PC 앱 진입 행의 accessibilityLabel '이 PC 서버 관리' 가 화면에 보이는 글자 '이 PC 에서 서버 열기' 를 담지 않는다. 음성 명령으로 화면 글자를 부르면 안 맞는다. → 제안: accessibilityLabel 을 보이는 글자에 맞춰 '이 PC 에서 서버 열기' 로 바꾸고, 이 이름을 찾는 e2e 가 있으면 함께 고친다.
- **H81** `app/app/host.tsx:520` [theme-token] — 최근 로그 박스의 borderRadius: 8 이 하드코딩돼 theme.ts 의 radius.sm(8) 토큰을 우회한다. → 제안: import 에 radius 를 추가하고 borderRadius: radius.sm 으로 바꾼다.
- **H82** `app/app/server.tsx:165` [inconsistency] — '주소' 라벨과 값을 Caption+Body 로 손으로 짰다. ui.tsx 의 Field(label, hint) 가 같은 자리를 맡는데, 라벨 스타일이 다르다(Field 는 13px·600·textMuted, 여기는 Caption 12px·textFaint). → 제안: <Field label="주소" hint="기본 서버는 이 앱이 정한 주소를 따라갑니다. 주소는 바꿀 수 없습니다."> 로 감싸고, 값은 <Body style={{ fontFamily: monoFont }}> 로 둔다.
- **H83** `app/src/components/AppVersion.tsx:95` [inconsistency] — 자동 업데이트 실패 문구를 danger 색 Caption 으로 손으로 썼다. ui.tsx 의 ErrorNotice 가 같은 역할(빨간 배경과 글자)을 한다. 같은 패턴이 175행에도 있다. → 제안: <Caption style={{ color: colors.danger }}> 를 <ErrorNotice message={`자동 업데이트에 실패했습니다: ${state.error}`} /> 로 바꾸고, 175행도 같은 방식으로 맞춘다.

### §1b Opus 샘플링 — 화면 감사 (번호 = O<번호>, 경로는 app/ 기준)

이미 처리됨: O20(저장소 목록 빈 화면, 커밋 994c832). 다음 기능은 같은 커밋에서 이미 들어갔다 — 제안 목록 페이지네이션, 저장소 찾기, 파일·폴더 행 ⋯ 펼치기, useMorePages/LoadMoreFooter.

- **O1** 저장소 탭 화면이 맥락을 잃고 헤더 제목을 반복 — proposals.tsx:64, members.tsx:198, invites.tsx:151, history.tsx:~104 가 Stack.Screen 과 같은 <Title> 을 다시 그림. 저장소 이름은 파일 탭(index.tsx:346)에만. 약 15개 화면에서 제목 중복. 제안: RepoHeader(저장소 이름·역할 배지·RepoNav)를 5개 탭에서 공유, 섹션 이름은 헤더에만. (M)
- **O2** 소유자 설정·저장소 삭제가 멤버 탭에 숨어 있고 삭제 확인이 약함 — members.tsx:207-235, 298-316. deleteRepo(members.tsx:170-185)는 되돌릴 수 없는데 confirmAction 하나(웹은 window.confirm, dialogs.ts:16-21), busy 상태 없어 두 번 눌림. 제안: 소유자 전용 설정 탭, 이름을 입력해야 삭제, loading. (M, 탭 라벨 추가)
- **O3** 동작 뒤 피드백이 들쭉날쭉 — 조용히 성공: 역할 변경 members.tsx:90-108, 내보내기 :132-150, 초대 만들기 invites.tsx:77-88, 회수 :124-138, 이름 변경 index.tsx:316-318, 제안 병합·닫기·다시 열기 proposal/[proposalId].tsx:64-84, 참여 join.tsx:146-148. 소유권 이전·저장소 정보 저장은 토스트. 삭제는 notify 대신 notifySuccess 여야(index.tsx:290). 제안: 상태를 바꾸는 동작은 모두 notifySuccess. (S)
- **O4** 오류가 원인과 멀리 뜸 — new-proposal.tsx:219 ErrorNotice 는 위, 제출 버튼은 아래(:398). settings.tsx:135 이름 폼과 비밀번호 폼이 error 상태 하나를 공유. proposal/[proposalId].tsx:181 actionError 가 변경 목록 위, 병합·닫기 버튼은 아래(:201). invites.tsx 만들기 실패는 인라인(:220), 회수 실패는 토스트(:136). 제안: 인라인 오류는 그 폼·버튼 옆, settings 는 폼마다 오류 상태. (S)
- **O5** 손으로 만든 칩/세그먼트 3벌 — proposals.tsx:67-89(role radio, 색만 바뀜), invites.tsx:326-360(로컬 Chip, radio, 굵게), compare.tsx:500-518(TabChip, role tab, borderRadius 999 하드코딩). 제안: ui.tsx 에 ChipGroup(role prop), minHeight 36-40. compare 는 role tab 과 이름 유지. (S-M)
- **O6** 복사된 기본 요소 — SwitchRow 3벌(RememberLogin.tsx:14-34, compare.tsx:337-353, host.tsx:343-370), SectionTitle 20벌(<Body style={{fontWeight:'600'}}> 카드 제목: members.tsx:209,289, proposal/[proposalId].tsx:185,252, new-proposal.tsx:243,304, invites.tsx:170, settings.tsx:150, host.tsx 7곳), Notice 3벌(index.tsx:359-388 과거 시점 배너, proposal/[proposalId].tsx:161-179 충돌 카드, join.tsx:216-228 역할 상자 — borderRadius: spacing.md). (S each)
- **O7** 44px 미만 터치 영역 — compact Button(ui.tsx:194-195, 약 34px), RepoNav 탭(RepoNav.tsx:52-63 약 34px), Breadcrumb(RepoNav.tsx:121-144, 15px 아이콘·13px 글자, hitSlop 6), 설정 이동 행(settings.tsx:179-227, 패딩 없는 Caption 행 16-18px — ListRow/NavRow 추출), compare 체크 행(compare.tsx:420). (S)
- **O8** 역할/라벨 없는 Pressable — repos.tsx:87 '내 정보' 라벨만, role 없음; repos.tsx:179 RepoCard role 만, 라벨 없음; proposals.tsx:145 ProposalCard 둘 다 없음; new-proposal.tsx:312('상위 폴더로'), :336(폴더 행), :361('삭제 담기' 파일 행) 둘 다 없음, 이 화면은 Breadcrumb 대신 자기 '위로' 행. (S)
- **O9** 파일 화면 동작 줄이 360dp 폰에서 3줄로 접힘 — index.tsx:390-425 큰 버튼 최대 4개(파일 올리기·폴더 올리기·변경 제안 만들기·내 폴더와 비교). 비슷하게 invites.tsx:273-306(작은 버튼 4개), members.tsx:258-281(3개), proposals.tsx:67-97 머리 줄. 제안: 주 버튼 하나 + 더 보기 메뉴. e2e: 파일 올리기 8회·폴더 올리기 3회·내 폴더와 비교 2회. (M, 라벨·배치 변경)
- **O10** 제안 상세 흐름 — 병합·닫기 버튼(proposal/[proposalId].tsx:201-241)이 변경 목록 전체 뒤. 병합 뒤 '파일 목록에서 확인할 수 있습니다'(:235-240)에 버튼 없음, 돌아가기는 맨 아래 ghost(:297). 상태 색 매핑 중복(:136-145 vs proposals.tsx:129-139) → ProposalStatusBadge. (S)
- **O11** 새 제안 화면 폴더 변수 하나가 두 역할 — browsePath 가 '새 파일을 둘 곳'이자 '삭제 고르려고 둘러보는 폴더'(new-proposal.tsx:54, 96-97, 252-255). 제출 버튼이 긴 트리 아래(:398), 폴더 행 사이 구분선 없음(:335). (M)
- **O12** 웹·PC 앱에 손으로 새로고침할 방법이 없음 — RefreshControl 은 react-native-web 에서 동작 안 함(미확인). 제안 상세·멤버·초대·이력·버전·휴지통은 브라우저 새로고침 전까지 낡을 수 있음. 제안: Screen 에 onRefresh — 네이티브는 RefreshControl, 웹은 헤더 '새로고침' IconButton. (M, 라벨 추가)
- **O13** 휴지통 행이 바쁜 동안 피드백 없음 — trash.tsx:227-236 되돌리기·받기 IconButton 에 스피너 없음, 다른 동작 중 누르면 if (busy) return(:94, :132)으로 조용히 무시. 제안: index.tsx:531,604 의 busyPath 방식. (S)
- **O14** 지운 뒤 되돌리기 없음, 휴지통 찾기 어려움 — 삭제 토스트가 '변경 이력 → 휴지통'을 말하지만(index.tsx:290) 토스트에 동작 없음(Toast.tsx:75 닫기만). 휴지통은 이력 탭 버튼으로만(history.tsx:~111). 제안: showToast 에 action. (M, 라벨 추가)
- **O15** 비교 화면 빈틈 — '둘 다 (크기 다름 N)' 탭에 동작 없음(compare.tsx:275, selectable = tab !== 'both'). 주 동작 버튼이 최대 200행 뒤(:451-472), Screen 은 고정 아래쪽 미지원. iOS '지원 안 함' EmptyState(:240-250)에 돌아갈 길 없음. (M)
- **O16** 서버 폼이 저장에 두 번 클릭 — '저장하고 들어가기'가 '연결 확인' 성공 전까지 꺼짐(server.tsx:52, 192-210). 선택인 이름 칸이 필수인 주소 칸보다 앞(:152-183). e2e 비용 큼(연결 확인 11회, inputs().nth() 순서). 보류 권장. (M)
- **O17** 호스트 화면 '서버 끄기' 확인 없음 — host.tsx:100-106 연결된 모두에게 서버를 끄는데 확인 없음, '다른 폴더 쓰기'(:454-461)도. 제안: confirmAction. CI 가 desktop 흐름을 안 돌림. (S)
- **O18** 웹 확인 대화상자가 확인 라벨·위험 스타일 무시 — dialogs.ts:16-21 window.confirm. 제안: 앱 안 ConfirmDialog 모달. 많은 spec 이 page.on('dialog') 로 문구를 봄. 1단계 아님. (L)
- **O19** 테마 토큰 우회 — login.tsx:135,156,160 과 reset-password.tsx:96 fontSize 12/13, RepoNav.tsx:93 fontSize 11, compare.tsx:511 borderRadius 999, host.tsx:243,250,520 radius 9/4/8, join.tsx:219 borderRadius: spacing.md. 로그인 화면 서버 표시가 맨 아래 12px(login.tsx:148-164) — '서버: …' 문구는 e2e 가 8회 이상 봄. (S)
- **O20** 저장소 목록의 손으로 만든 빈 화면 — repos.tsx:152-169. (처리됨)

## §2 판정 (2026-10-28)

Opus 가 §1 102건을 코드와 대조해 판정하고 표본으로 1건(N1)을 더 찾았다. 비판 Sonnet 은 이견 0건을 냈다(재판정 없음).
집계: 수정 대상 44 · 2단계 48 · 3단계 6 · 기각 5. 중복으로 묶은 O8·O13·O19 는 수정 대상 칸에 셌지만 고칠 곳은 가리킨 H 항목이다.

### §2a 수정 대상 (41)

- **H5** `app/app/repo/[repoId]/compare.tsx` — 308행을 `{error ? <ErrorNotice message={error} onRetry={repoFiles ? undefined : () => { setError(null); loadRepo().catch((err) => setError(err instanceof ApiError ? err.message : '저장소 목록을 불러오지 못했습니다.')); }} /> : null}` 로 바꾼다 — 저장소 목록을 못 받았을 때만 공용 '다시 시도'를 보인다. 기존 버튼 글자는 그대로. _근거:_ 65-67행 useEffect 의 loadRepo 실패는 setError 만 하고 ErrorNotice(308행)에 onRetry 가 없다. choose()(84·90행)가 다시 부르긴 하지만 폴더를 고르기 전에는 복구 길이 없다. 파일 하나 안에서 끝나고 기존 라벨은 바뀌지 않는다.
- **H6** `app/src/components/SearchResults.tsx` — useRepoFiles 에 `const [attempt, setAttempt] = useState(0);` 을 두고 useEffect deps 에 attempt 를 더한 뒤 `{ files, error, retry: () => setAttempt((n) => n + 1) }` 를 돌려준다(오류 때 loadedFor.current 는 이미 null). 76행을 `<ErrorNotice message={error} onRetry={retry} />` 로 바꾼다. _근거:_ 15-47행 useRepoFiles 는 실패하면 loadedFor 를 null 로 두지만 deps(repoId,key,snapshotId,enabled)가 그대로라 다시 돌지 않는다. 76행 ErrorNotice 에도 onRetry 가 없다. 같은 파일 안에서 끝난다.
- **H7** `app/app/repo/[repoId]/index.tsx` — `const [preparing, setPreparing] = useState(false)` 를 둔다. upload()·uploadFolder() 맨 앞 가드를 `if (uploading || preparing) return;` 로 바꾸고, 선택기가 돌아온 뒤(`if (sources.length === 0) return;` 다음)부터 runUpload 호출 직전까지를 setPreparing(true) … try/finally setPreparing(false) 로 감싼다(선택기 대기 중에는 켜지 않는다 — 웹 취소가 안 돌아오면 버튼이 잠기므로). 파일 올리기 Button 에 disabled={preparing}, 폴더 올리기·내 폴더와 비교의 disabled 를 `uploading || preparing` 로. _근거:_ 420행 폴더 올리기는 disabled={uploading} 뿐이고 uploading 은 progress 가 생긴 뒤에야 true 다. 그 사이 withinLimit(getMaxUploadBytes)·listRepoFolder(255행)·confirmAction 동안 다시 누를 수 있다. 한 파일, 라벨 불변.
- **H8** `app/app/repo/[repoId]/compare.tsx` — 27행 theme import 에 radius 를 더하고 511행 `borderRadius: 999` 를 `borderRadius: radius.pill` 로 바꾼다(값 동일). _근거:_ TabChip 511행이 999 하드코딩, theme.ts radius.pill=999. 값이 같은 토큰 치환이라 화면 변화 없음.
- **H10** `app/app/repo/[repoId]/compare.tsx` — 420행 비교 목록 행 Pressable 스타일의 `paddingVertical: spacing.sm` 을 `paddingVertical: spacing.md` 로 바꾼다(다른 목록 행과 같은 값). _근거:_ 410-423행 행 전체가 체크 대상인데 paddingVertical 8 에 13px 글자라 약 33px. 이 화면 안의 행 높이만 바뀌고 라벨·e2e 이름(checkbox '모두 고르기', tab) 영향 없음.
- **H12** `app/src/components/SearchResults.tsx` — 118-121행 Caption 하나를 둘로 나눈다: `<Caption numberOfLines={1}>{folder || '맨 위'}</Caption>` 와 `<Caption>{formatBytes(file.size)} · {formatRelativeTime(file.updatedAt)}</Caption>`. (Caption 은 ellipsizeMode 를 받지 않으므로 넘기지 않는다.) _근거:_ 118행 numberOfLines={1} 한 줄에 경로·크기·날짜를 이어 붙여 경로가 길면 크기·날짜가 잘린다. 같은 파일 안 표시만 바뀌고 접근 이름('{name} 내려받기')과 e2e 문구('N개 찾음')는 그대로.
- **H13** `app/app/repo/[repoId]/new-proposal.tsx` — 312행 '상위 폴더로' Pressable 에 accessibilityRole="button" 을 더한다. accessibilityLabel 은 넣지 않는다(이름은 보이는 글자 '상위 폴더로' 그대로). _근거:_ 312-324행 Pressable 에 역할이 없다. 역할만 더하면 접근 이름은 바뀌지 않고, e2e/specs 에 새 제안 화면을 찾는 곳이 없다(grep '상위 폴더'·'삭제 담기' 없음).
- **H14** `app/app/repo/[repoId]/new-proposal.tsx` — 319행 '상위 폴더로' 행의 `paddingVertical: spacing.sm` 을 `spacing.md` 로 바꿔 아래 폴더 행(344행)과 높이를 맞춘다. _근거:_ 같은 목록의 폴더·파일 행은 paddingVertical md 인데 이 행만 sm(약 34px). 이 화면 안의 행 하나만 바뀌고 e2e 영향 없음.
- **H15** `app/app/repo/[repoId]/new-proposal.tsx` — 336행 폴더 행 Pressable 에 accessibilityRole="button" 만 더한다. 제안된 accessibilityLabel('… 폴더 열기')은 접근 이름이 바뀌므로 넣지 않는다. _근거:_ 336-353행 폴더 행에 역할이 없다. 역할만 더하면 이름은 dir.name 그대로라 1단계 조건 충족, e2e 는 이 화면을 쓰지 않는다.
- **H16** `app/app/repo/[repoId]/new-proposal.tsx` — 361행 파일 행 Pressable 에 accessibilityRole="button" 만 더한다. disabled 는 이미 Pressable disabled 로 네이티브 accessibilityState·웹 aria-disabled 에 반영되므로 따로 넣지 않고, 라벨도 바꾸지 않는다. _근거:_ 361-384행에 역할이 없는 것은 사실. disabled 노출 주장은 틀렸다 — RN/RNW Pressable 의 disabled 가 상태로 나간다(e2e 3-version 이 aria-disabled 를 읽는다). 역할 추가만 1단계.
- **H18** `app/app/repo/[repoId]/new-proposal.tsx` — `const [preparing, setPreparing] = useState(false)` 를 두고 addFiles 첫 가드를 `if (uploading || preparing) return;` 로 바꾼다. `if (sources.length === 0) return;` 다음부터 함수 끝까지를 setPreparing(true) … try/finally setPreparing(false) 로 감싼다(선택기 대기 중에는 켜지 않는다). 249행 Button 을 loading={uploading || preparing} 로. _근거:_ 85행 가드는 uploading(progress!==null)만 보는데 99행 getMaxUploadBytes 대기 중에는 progress 가 아직 null 이라 버튼이 다시 눌린다. 한 파일, 라벨 불변.
- **H20** `app/app/repo/[repoId]/proposals.tsx` — 83행 `accessibilityState={{ selected: active }}` 를 `aria-checked={active}` 로 바꾼다(RememberLogin.tsx:19 와 같은 방식, role radio 에는 checked 가 맞는 상태). _근거:_ react-native-web 0.21 createDOMProps 는 accessibilityState 를 읽지 않는다(코드 확인). role radio 의 선택 상태가 웹에 나가지 않는다. 한 파일, 이름 불변, e2e 는 이 칩을 찾지 않는다.
- **H21** `app/app/repo/[repoId]/proposals.tsx` — 186행과 191행 `<Row gap={4}>` 를 `<Row gap={spacing.xs}>` 로 바꾼다(값 동일). 86행 `spacing.sm - 2` 는 칩 크기 문제(H19/O5)와 함께 다루므로 건드리지 않는다. _근거:_ 186·191행 gap={4} 는 spacing.xs(4)와 같은 값의 하드코딩. 값이 같은 토큰 치환만 1단계, 칩 패딩은 시각 변경이라 제외.
- **H22** `app/app/repo/[repoId]/proposals.tsx` — 164행 ProposalCard 의 Pressable 에 accessibilityRole="button" 을 더한다(repos.tsx RepoCard 196행과 같은 방식). accessibilityLabel 은 넣지 않는다. _근거:_ 164-167행 카드 Pressable 에 역할이 없다. e2e 12-lists 는 이 화면을 getByText(exact)와 getByRole('button',{name:'더 보기'})로 찾는데, 카드 이름('#32 제안 32 …')에 '더 보기'가 들어가지 않아 영향 없음.
- **H24** `app/app/proposal/[proposalId].tsx` — 동작 버튼 disabled 를 action 과 묶는다: 저장소에 반영 disabled={!proposal.mergeable || action !== null}, 제안 닫기 disabled={action !== null}, 다시 열기 disabled={action !== null}, 의견 등록 disabled={!comment.trim() || action !== null}. _근거:_ 64-84행 run() 은 action 하나만 쓰는데 205-228·289행 버튼들은 자기 loading 만 보고 disabled 가 없어(반영 버튼은 mergeable 만) 요청이 겹칠 수 있다. 한 파일, 라벨 불변.
- **H27** `app/app/repo/[repoId]/members.tsx` — `const [leaving, setLeaving] = useState(false)` 를 두고 deleteRepo()·leave() 에서 확인 뒤 setLeaving(true), 실패(catch)에서 notifyError 후 setLeaving(false). '저장소 삭제'(300행)·'저장소에서 나가기'(308행) Button 에 loading={leaving} 을 준다(둘 중 하나만 보이므로 상태 하나로 충분). _근거:_ 170-185행 deleteRepo 는 확인 뒤 요청 중 상태가 없고 300행 Button 에 loading/disabled 가 없다. 한 파일, 라벨 불변.
- **H28** `app/app/repo/[repoId]/members.tsx` — H27 과 같은 leaving 상태를 leave() 에도 쓴다: 확인 뒤 setLeaving(true), catch 에서 setLeaving(false); 308행 Button 에 loading={leaving}. _근거:_ 152-168행 leave() 에도 진행 상태가 없다. H27 과 같은 파일·같은 상태로 함께 고친다.
- **H29** `app/app/repo/[repoId]/invites.tsx` — `const [revoking, setRevoking] = useState<string | null>(null)` 를 두고 revoke() 에서 확인 뒤 setRevoking(invite.id), finally setRevoking(null). 299행 '회수' Button 에 loading={revoking === invite.id} 를 준다. _근거:_ 124-138행 revoke 는 확인 뒤 요청 중 표시가 없다. 한 파일, 라벨 불변.
- **H32** `app/app/repo/[repoId]/invites.tsx` — 340행 Chip 의 `accessibilityState={{ selected: active }}` 를 `aria-checked={active}` 로 바꾼다. _근거:_ RNW 는 accessibilityState 를 읽지 않아 role radio 의 선택 상태가 웹에서 빠진다. 한 파일, 이름 불변, e2e 7-invite-link 는 이 칩을 찾지 않는다.
- **H36** `app/app/repo/[repoId]/trash.tsx` — ui.tsx 는 건드리지 않는다. react-native import 에 ActivityIndicator 를 더하고, 행(227-236행)에서 `busy === key || busy === `dl:${key}`` 이면 두 IconButton 대신 `<ActivityIndicator size="small" color={colors.textMuted} />` 를 그린다(index.tsx 546·632행 busyPath 방식). _근거:_ 133행이 busy 에 'dl:…' 를 넣지만 어디서도 표시하지 않고, 94·132행 if (busy) return 이 다른 행 누름을 조용히 버린다. ui.tsx 를 고치는 대신 같은 파일 안에서 index.tsx 방식으로 진행 표시를 하면 1단계로 끝난다.
- **H37** `app/app/repo/[repoId]/versions.tsx` — busy 값에 종류를 붙인다: download() 는 setBusy(`dl:${version.snapshotId}`), restore() 는 setBusy(`restore:${version.snapshotId}`). '이 버전 받기' loading={busy === `dl:${version.snapshotId}`}, 되돌리기 Button 에 loading={busy === `restore:${version.snapshotId}`} 를 더한다(disabled={busy !== null} 은 그대로). _근거:_ 83·105행이 둘 다 setBusy(version.snapshotId) 라 되돌리는 동안 179행 '이 버전 받기' 버튼에 스피너가 돌고 되돌리기 버튼(184행)에는 없다. 지적보다 더 나쁜 오표시. 한 파일, 라벨 불변.
- **H39** `app/src/components/RepoNav.tsx` — 56행 `accessibilityState={{ selected: active }}` 를 `aria-selected={active}` 로 바꾼다(compare.tsx TabChip 506행과 같은 방식). _근거:_ RNW 0.21 은 accessibilityState 를 무시해 role tab 의 선택 상태가 웹에 나가지 않는다. 시각 변화가 없고 e2e 는 RepoNav 탭을 이름으로 찾지 않는다(getByRole('tab') 은 비교 화면 TabChip 용).
- **H45** `app/src/components/ui.tsx` — ErrorNotice 의 문구 Text(432행)에 `role="alert"` 를 더한다(Toast.tsx:81 과 같은 prop — RN·RNW 모두 받는다). 모양·레이아웃은 그대로. _근거:_ 419-439행 ErrorNotice 문구가 일반 Text 라 스크린리더가 오류로 알리지 않는다. 시각 변화가 없고 e2e 는 getByRole('alert') 를 쓰지 않는다(getByRole('status') 는 토스트).
- **H48** `app/src/components/ui.tsx` — Title(83-90행)의 Text 에 `role="heading"` 을 더한다. 스타일은 그대로. _근거:_ Title 이 제목 역할로 노출되지 않아 제목 탐색에서 빠진다. 공용 파일이지만 시각·레이아웃 변화가 없고 e2e 는 heading 역할을 찾지 않는다(getByText 는 영향 없음).
- **H55** `app/app/login.tsx` — 127-134행 '비밀번호를 잊었나요?' Pressable 의 `hitSlop={8}` 을 `hitSlop={12}` 로 바꾼다. _근거:_ 13px 글자 링크라 hitSlop 8 을 더해도 약 34dp. hitSlop 은 시각 크기를 바꾸지 않고 위아래 이웃(로그인 버튼과 gap lg)과 겹치지 않는다. e2e getByText('비밀번호를 잊었나요?') 그대로.
- **H56** `app/app/login.tsx` — 24행 theme import 에 fontSize 를 더하고 135행 `fontSize: 13` 을 `fontSize: fontSize.sm` 으로 바꾼다(값 동일). _근거:_ theme.ts fontSize.sm=13 과 같은 값의 하드코딩. 화면 변화 없음.
- **H58** `app/app/login.tsx` — 156행 `fontSize: 12` 를 `fontSize: fontSize.xs` 로 바꾼다(H56 에서 fontSize import 추가). _근거:_ fontSize.xs=12 와 같은 값. 화면 변화 없음, e2e getByText('서버: …') 그대로.
- **H59** `app/app/login.tsx` — 159행 '다른 서버'/'바꾸기' Pressable 의 `hitSlop={8}` 을 `hitSlop={12}` 로 바꾼다. _근거:_ 12px 글자라 hitSlop 8 로 약 31dp. 시각 변화 없는 hitSlop 확대이고 e2e getByText('다른 서버', exact) 영향 없음.
- **H60** `app/app/login.tsx` — 160행 `fontSize: 12` 를 `fontSize: fontSize.xs` 로 바꾼다. _근거:_ fontSize.xs=12 와 같은 값의 하드코딩.
- **H63** `app/app/reset-password.tsx` — 10행 theme import 에 fontSize 를 더하고 96행 `fontSize: 12` 를 `fontSize: fontSize.xs` 로 바꾼다. _근거:_ fontSize.xs=12 와 같은 값의 하드코딩. 화면 변화 없음.
- **H65** `app/app/join.tsx` — lookup() 맨 앞(parseInviteCode 전)에 `if (busy) return;` 을 둔다. 190-196행 '코드 확인' Button 의 disabled 를 `!normalized || busy` 로 바꾼다(loading={busy && !preview} 는 그대로 — 참여 중에 이 버튼이 돌면 안 되므로). _근거:_ 193행 loading={busy && !preview} 라 미리보기가 떠 있을 때 다시 조회하면 표시도 막힘도 없고, 122행 lookup 에 가드가 없다. 한 파일, 라벨 불변(e2e 의 /코드로 참여하기$/ 영향 없음).
- **H66** `app/app/join.tsx` — 32행 theme import 에 radius 를 더하고 219행 `borderRadius: spacing.md` 를 `borderRadius: radius.md` 로 바꾼다(값 12 동일). _근거:_ 간격 토큰을 모서리 반경에 쓰고 있다. 값이 같은 토큰 교정이라 화면 변화 없음.
- **H68** `app/app/repos.tsx` — 93-100행 헤더 '내 정보' Pressable 에 accessibilityRole="button" 을 더하고 `hitSlop={8}` 을 `hitSlop={12}` 로 바꾼다. IconButton 으로 바꾸지는 않는다(아이콘 24→20 이 되어 모양이 바뀐다). accessibilityLabel '내 정보' 는 그대로. _근거:_ 역할이 없고 세로 약 40dp 다. 역할 추가와 hitSlop 확대는 시각·이름 변화가 없고, e2e getByLabel('내 정보') 8회 그대로 동작한다.
- **H70** `app/app/settings.tsx` — 167행을 `onSubmitEditing={() => { if (currentPassword && newPassword.length >= 8 && !savingPassword) void savePassword(); }}` 로 바꾼다. _근거:_ savePassword(98-115행)는 newPassword 길이만 검사하고 currentPassword·savingPassword 는 보지 않아, Enter 로 빈 현재 비밀번호를 보내거나 연타로 중복 요청이 나간다. 버튼 disabled(174행)와 같은 조건으로 맞춘다.
- **H71** `app/app/host.tsx` — ResetCodeCard 의 issue()(292행) 맨 앞에 `if (busy || !running || !email.trim()) return;` 을 둔다(onSubmitEditing 은 issue 를 그대로 부르므로 같은 조건이 적용된다). _근거:_ 324행 onSubmitEditing 이 333행 disabled={!running || !email.trim()} 를 우회하고 issue 에 busy 가드가 없다. 한 파일, 라벨 불변.
- **H72** `app/app/host.tsx` — 231-236행 공개 방식 Pressable 스타일의 opacity 를 `busy !== null ? 0.5 : pressed ? 0.6 : 1` 로 바꾼다. 접근성 상태와 스피너는 더하지 않는다. _근거:_ 227행 disabled={busy !== null} 인데 시각 변화가 없다. 접근성 disabled 는 Pressable disabled 가 이미 내보내므로 지적의 그 부분은 불필요. 투명도만 바꾸면 레이아웃·이름(e2e desktop 의 radio '공개하지 않음')에 영향 없음.
- **H73** `app/app/host.tsx` — StartupCard 에 `busy: string | null` prop 을 더하고 122행에서 busy={busy} 를 넘긴다. '이름 저장'(397행)에 loading={busy === 'server-name'}, 포트 '저장'(427행)에 loading={busy === 'port'}, DataCard '다른 폴더 쓰기'(454행)에 loading={busy === 'data-dir'} 를 준다. _근거:_ act(59-69행)가 busy 를 세우지만 이 세 버튼은 loading 을 받지 않아 진행 표시도 중복 방지도 없다. 같은 파일 안 컴포넌트끼리의 prop 전달이고 라벨은 그대로.
- **H76** `app/app/settings.tsx` — error 상태를 nameError·passwordError 둘로 나눈다. saveName 은 nameError, savePassword 는 passwordError 만 세우고 지운다. 135행 ErrorNotice 를 지우고, 이름 카드 안 '이름 저장' 버튼(141행) 위에 `{nameError ? <ErrorNotice message={nameError} /> : null}`, 비밀번호 카드 안 '비밀번호 변경' 버튼(170행) 위에 `{passwordError ? <ErrorNotice message={passwordError} /> : null}` 를 둔다. _근거:_ 85-115행 두 폼이 error 하나를 같이 쓰고 135행 맨 위에만 뜬다. 한 파일 안에서 끝나고 버튼 글자·라벨은 바뀌지 않는다. e2e 는 getByText 로 찾아 위치와 무관. O4 의 settings 부분.
- **H81** `app/app/host.tsx` — 26행 theme import 에 radius 를 더하고 520행 `borderRadius: 8` 을 `borderRadius: radius.sm` 으로 바꾼다(값 동일). _근거:_ theme.ts radius.sm=8 과 같은 값의 하드코딩. 화면 변화 없음.
- **H82** `app/app/server.tsx` — 164-169행 기본 서버 주소 View 를 `<Field label="주소" hint="기본 서버는 이 앱이 정한 주소를 따라갑니다. 주소는 바꿀 수 없습니다."><Body style={{ fontFamily: monoFont }}>{describeUrl(normalized ?? '')}</Body></Field>` 로 바꾼다(Field 는 이미 import 되어 있다). 보이는 글자는 그대로. _근거:_ 같은 카드의 '이름'·'주소' 칸은 Field 라벨(13px·600·textMuted)인데 기본 서버일 때만 Caption 라벨이라 모양이 다르다. 한 파일, 글자 불변. e2e 는 getByText('서버: 기본 서버') 만 본다.
- **N1** `app/app/proposal/[proposalId].tsx` — ChangeRow 390행 `{busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}` 를 지운다. 그러면 ActivityIndicator 를 더 쓰지 않으니 react-native import 에서도 뺀다(다른 곳에서 쓰는지 먼저 확인). _근거:_ 376·386행 Button 이 이미 loading={busy === …} 으로 스피너를 그리는데 390행이 같은 줄에 스피너를 하나 더 그려 받는 동안 스피너가 두 개 보인다. 한 파일, 라벨 불변.

### §2b 중복(다른 항목으로 처리) (3)

- **O8** — H13·H15·H16(new-proposal)·H22(ProposalCard)·H68(repos '내 정보')과 중복 — 그 항목들로 고친다. repos.tsx RepoCard(194행)는 role 이 있고 이름이 내용에서 나와 따로 고칠 것이 없다.
- **O13** — H36 과 중복 — trash.tsx 안에서 index.tsx 의 busyPath 방식으로 고치는 H36 의 fix 로 처리한다.
- **O19** — 토큰 부분은 H8(compare 999)·H56/H58/H60(login)·H63(reset-password)·H66(join)·H81(host 520)과 중복 — 그 항목들로 고친다. host.tsx:243·250 의 9/4 는 18·8px 원의 반지름이라 토큰 대상이 아니다. 로그인 화면 서버 표시 위치는 e2e 문구가 걸린 2단계 몫이다.

### §2c 2단계 (48)

- **H1** — index.tsx:520 폴더 행 Pressable(role button, label '… 폴더 열기') 안에 zip·⋯ IconButton 이 중첩된 것은 사실(네이티브는 accessible=true 로 자식이 묶임). 그러나 행 전체 탭 영역을 이름 영역으로 줄이는 구조 변경이라 설계 판단 필요.
- **H2** — index.tsx:602 파일 행 Pressable 과 안의 IconButton 이 같은 이름 '{name} 내려받기'(638행)인 것은 사실. e2e 6-transfer 는 .first() 로 이 이름을 찾고 11-restore 는 /내려받기$/ 첫 요소의 aria-label 을 본다 — 행 구조·중복 라벨 제거는 e2e 영향과 탭 영역 설계가 걸려 1단계 아님. H1 과 같은 패턴.
- **H3** — SearchResults.tsx:100 행 Pressable 이 '{name} 내려받기' 이고 135행 IconButton 도 같은 이름 — 사실. 11-restore.mjs:70 이 /내려받기$/ 의 첫 요소 aria-label 순서에 기대므로 구조 변경은 e2e 확인이 필요한 2단계(H1·H2 와 같은 패턴).
- **H4** — compare.tsx:415 accessibilityLabel={item.label} 로 detail·크기·'크기 다름' 배지가 가려지는 것은 사실이나 고치려면 접근 이름을 바꿔야 한다(라벨 변경).
- **H9** — LoadMoreFooter(ui.tsx:448)는 label 을 받지 않아 compare.tsx:439-446 에 쓰려면 ui.tsx 와 compare.tsx 두 파일을 고쳐야 한다.
- **H11** — TabChip(compare.tsx:500-518)은 높이 약 28px 이 맞지만, 칩들이 `Row gap={spacing.xs} wrap`(368행)에 있어 줄바꿈되면 세로 hitSlop 이 이웃 칩과 겹친다. 칩 크기는 H33/O5 의 공용 칩 결정과 함께 해야 한다.
- **H17** — 219행 ErrorNotice 하나가 담기 실패(126행)·제목 누락·경로 오류·제출 실패를 함께 보여 준다. 어느 오류를 어디로 옮길지(제출 버튼 위, 행 아래 등) 설계 판단이 필요하다. O4·O11 과 겹친다.
- **H19** — proposals.tsx:79-90 칩 높이 약 29dp 는 사실이나, 칩 크기·여백은 invites Chip·compare TabChip 과 함께 공용 칩(H33/O5)으로 정해야 한다.
- **H23** — proposal/[proposalId].tsx:181 actionError 하나를 merge·close·reopen·comment 가 같이 쓴다. 오류를 동작별로 나눠 둘 곳을 정하는 설계 판단이 필요하다(O4 와 겹침).
- **H25** — H40 과 중복 — compact Button 높이(ui.tsx:197) 문제를 화면마다 따로 고치는 것은 공용 기준 결정이 먼저다.
- **H26** — H40 과 중복 — members.tsx:260-280 compact 버튼 높이는 공용 compact 기준 문제.
- **H30** — H40 과 중복 — invites.tsx:275-305 compact 버튼 높이는 공용 compact 기준 문제.
- **H31** — invites.tsx:337 Chip 은 `Row wrap`(194·208행) 안이라 세로 hitSlop 이 다음 줄 칩과 겹친다. 크기 변경은 공용 칩(H33/O5)과 함께.
- **H33** — invites.tsx:326 Chip·proposals.tsx:79·compare.tsx:500 이 각자 칩을 구현한 것은 사실. ui.tsx 에 공용 칩을 두는 것은 여러 파일 작업이다.
- **H34** — trash.tsx:234 IconButton 라벨을 isEditor 로 나누는 것은 접근 이름 변경이고, e2e 11-restore.mjs:120 이 열람자 화면에서 '노래 목록.txt 되돌리기'를 찾는다.
- **H35** — history.tsx:99 접근 이름을 바꾸는 제안이라 라벨 변경.
- **H40** — ui.tsx:197 compact paddingVertical sm 으로 약 33px 인 것은 사실이나, minHeight 44 는 compact 를 쓰는 모든 화면 레이아웃을 바꾼다. 세로 hitSlop 은 Row wrap 안의 버튼끼리 겹친다. 공용 기준 결정이 필요하다.
- **H41** — IconButton(ui.tsx:244-249)을 minWidth/minHeight 44 로 키우면 모든 목록 행 높이가 바뀐다. 공용 레이아웃 변경.
- **H42** — RepoNav 탭(52-66행) 약 33px. minHeight 는 레이아웃 변경이고, 가로 ScrollView(paddingVertical 2) 밖으로 나가는 hitSlop 은 안드로이드에서 닿지 않는다. H40 계열.
- **H43** — Breadcrumb 홈 아이콘(121-132행)은 15px+hitSlop 6. minWidth/minHeight 44 는 레이아웃 변경이고, 패딩 없는 가로 ScrollView 안이라 hitSlop 을 늘려도 안드로이드에서 밖으로 닿지 않는다.
- **H44** — Breadcrumb 세그먼트(139-154행)도 H43 과 같은 이유 — 레이아웃 변경이 필요하다.
- **H46** — Field(ui.tsx:260-279) 라벨이 입력칸과 연결되지 않은 것은 사실. 그러나 Input 에 accessibilityLabel 을 새로 붙이면 입력칸 접근 이름이 바뀌고(placeholder 기반 → 라벨), cloneElement·aria-labelledby 같은 방식 선택이 필요하다.
- **H49** — H46 과 중복 — Field 라벨 연결(ui.tsx)과 입력칸 접근 이름 변경 문제.
- **H50** — H46 과 중복.
- **H51** — H46 과 중복.
- **H52** — H46 과 중복.
- **H53** — H46 과 중복.
- **H54** — login.tsx:106 긴 placeholder 가 360dp 에서 잘리는 것은 사실이나, placeholder 를 줄이고 hint 로 옮기는 것은 보이는 글자 변경이다(로그인 화면은 e2e 가 많이 본다).
- **H57** — login.tsx:142 Link '회원가입' 탭 영역이 좁은 것은 사실이나, Link(<a href>)를 Pressable+router.push 로 바꾸면 요소·역할이 바뀐다. e2e 가 getByText('회원가입') 을 6회 쓴다.
- **H64** — join.tsx 는 lookup·join 이 error 하나(150행)를 같이 쓴다. 참여 오류를 미리보기 카드로 옮기려면 오류 상태를 나누는 설계가 필요하다. 미리보기 카드가 바로 아래라 급하지도 않다.
- **H67** — join.tsx:286 Link 를 Pressable 로 바꾸면 <a href> 가 사라진다. e2e 7-invite-link 가 getByText('설치한 앱에서 열기') 를 본다. H57 과 같은 판단.
- **H69** — Button(ui.tsx)은 expanded 를 받지 않아 ui.tsx 와 repos.tsx 두 파일을 고쳐야 한다.
- **H74** — host.tsx:82 act 오류가 맨 위에만 뜨는 것은 사실이나, 카드마다 오류 상태를 두는 설계 판단이 필요하다(O4 계열).
- **H75** — settings.tsx:179·197·211 행이 Caption 한 줄 높이인 것은 사실이나, paddingVertical 을 더하면 카드 레이아웃이 바뀌고 O7 의 NavRow 추출과 함께 정해야 한다.
- **H77** — AppVersion.tsx:40 '소스 코드' Link 의 탭 영역이 좁은 것은 사실이나, Link 에 패딩을 주면 Row 레이아웃이 바뀐다. AGPL §13 링크라 조심해야 하고, expo-router Link 는 이미 웹에서 <a> 다.
- **H78** — H40 과 중복 — compact 버튼 공용 높이 문제.
- **H80** — settings.tsx:200 accessibilityLabel 변경이고, e2e 가 getByRole('button', { name: '이 PC 서버 관리' }) 로 찾는다.
- **H83** — AppVersion.tsx:95·175 의 Caption 을 ErrorNotice(배경 상자)로 바꾸면 Row wrap 안 레이아웃이 바뀐다. e2e 5-updates 가 getByText('확인하지 못했습니다') 를 보므로 배치를 다시 정해야 한다.
- **O3** — members.tsx:99-107·132-150, invites.tsx:77-88·124-138, index.tsx:330-333, proposal 64-84 의 조용한 성공은 사실이고 index.tsx:305 는 notify 다. 여러 파일에 새 토스트 문구를 더하는 작업이다.
- **O4** — 여러 파일(new-proposal·proposal 상세·invites)의 오류 배치 설계 문제. settings 부분은 H76(수정 대상)과 중복이고, new-proposal 은 H17, proposal 상세는 H23 과 겹친다.
- **O5** — H33 과 중복 — 칩 세 벌을 ui.tsx 공용 칩으로 묶는 여러 파일 작업. compare 의 borderRadius 999 는 H8 로 따로 처리한다.
- **O7** — H40(compact)·H42(RepoNav)·H43/H44(Breadcrumb)·H75(settings 행)과 중복이다. compare 체크 행은 H10(수정 대상)으로 따로 처리한다.
- **O10** — 상태 색 매핑 중복(proposal 136-145 vs proposals.tsx:148-158)을 ProposalStatusBadge 로 묶는 것은 여러 파일 작업이다. 반영 뒤 이동 버튼을 더하면 새 라벨이 생긴다.
- **O12** — RNW 의 RefreshControl 은 당겨서 새로고침을 하지 않는다. 웹용 새로고침 버튼(새 라벨)을 Screen 과 여러 화면에 더하는 일이다.
- **O14** — Toast(Toast.tsx)에 동작 버튼을 더하고 index.tsx 삭제 흐름에 연결하는 것은 여러 파일 작업이고 새 라벨이 생긴다.
- **O15** — compare.tsx:275 selectable = tab !== 'both', 240-250 iOS EmptyState 에 action 없음은 사실. '둘 다' 탭 동작과 돌아가기 버튼을 더하는 것은 설계 판단이고 새 라벨이 생긴다.
- **O16** — server.tsx 저장 흐름과 칸 순서를 바꾸는 것은 e2e(inputs().nth 순서, '연결 확인' 13회)에 걸린다. 보류 권장에 동의한다.
- **O17** — host.tsx:100-106 서버 끄기에 확인이 없는 것은 사실. confirmAction 을 더하면 desktop e2e(getByRole('button',{name:'서버 끄기'}))에 대화상자 처리가 필요해 여러 파일 작업이 된다.

### §2d 3단계 (6)

- **O1** — proposals.tsx:69-71·members.tsx:197-198·invites.tsx:150-151 이 Stack.Screen 제목과 같은 <Title> 을 다시 그리는 것은 사실. 다섯 탭이 함께 쓰는 RepoHeader 를 새로 만드는 것은 구조 변경이다.
- **O2** — 소유자 전용 설정 탭과 이름을 입력하는 삭제 확인은 화면 재배치다. busy·loading 부분은 H27 과 중복(수정 대상).
- **O6** — SwitchRow 3벌(RememberLogin·compare:337·host:343), 카드 제목 <Body fontWeight 600> 여러 벌, Notice 3벌 모두 확인됨. 공용 SectionTitle·Notice·SwitchRow 체계를 새로 두는 것은 구조 변경이다.
- **O9** — index.tsx:405-440 동작 줄을 주 버튼과 더 보기 메뉴로 바꾸는 것은 화면 재배치이고, e2e 가 '파일 올리기'·'폴더 올리기'·'내 폴더와 비교' 를 직접 누른다.
- **O11** — new-proposal.tsx 의 browsePath(54행)가 담을 폴더와 둘러보는 폴더를 겸하는 것은 사실. 둘을 나누고 제출 위치를 바꾸는 것은 화면 구조 변경이다.
- **O18** — dialogs.ts window.confirm 을 앱 안 모달로 바꾸는 것은 새 공용 컴포넌트이고, 여러 spec 의 page.on('dialog') 를 다시 써야 한다.

### §2e 기각 (5)

- **H38** — 전제가 틀렸다. Button 은 Pressable disabled={isDisabled}(187행)를 넘기고 RNW Pressable 이 이를 aria-disabled 로 내보낸다(e2e 3-version.mjs:19 가 aria-disabled 를 읽는다). loading 도 isDisabled 에 들어가 있다. aria-busy 만 빠졌는데 버튼의 aria-busy 는 스크린리더 지원이 약해 고칠 가치가 낮다.
- **H47** — RepoNav.tsx:93 fontSize 11 은 탭 안 숫자 배지를 일부러 작게 한 값이고 theme 에 11 토큰이 없다. fontSize.xs(12)로 바꾸면 배지 크기가 달라질 뿐 얻는 것이 없다. padding 5·gap 6 도 같은 이유.
- **H61** — signup.tsx:86 ErrorNotice 는 제출 버튼(88행) 바로 위, 사용자가 누른 곳에 뜬다. 비밀번호 칸(74-82행)과도 RememberLogin 하나 사이라 멀지 않고, 서버 오류(아이디 중복 등)도 같은 자리라 지금 배치가 맞다.
- **H62** — reset-password.tsx:91 오류도 제출 버튼(93행) 바로 위에 뜬다. 카드 하나 안이라 칸과 멀지 않고, 서버 오류(코드 만료 등)와 같은 자리에 두는 편이 낫다.
- **H79** — 사실이 아니다. updates.ts:247-256 installApkUpdate 가 이미 try/catch 로 notifyError('새 버전을 설치하지 못했습니다.') 를 띄운다. 데스크톱 updates.install() 은 desktop/src/updater.ts:106 에서 동기로 boolean 을 돌려줄 뿐 throw 하지 않는다.


## §3 1단계 수정 결과 (2026-10-28)

Sonnet 수정자 6기(파일 묶음이 겹치지 않게)가 §2a 41건을 고쳤다 — 고침 41, 실패 0, 건너뜀 0. 중복 3건(O8·O13·O19)은 가리킨 항목으로 처리됐다.
바꾼 파일 19개(`app/app/**`, `app/src/components/**`), 버튼 글자·accessibilityLabel 은 그대로.

검사: `npm run typecheck`(server·app) 통과, `npm test` 226개(서버 187·앱 39) 통과, `npm run test:e2e` 210개 통과.
수정자 두 명이 보고한 타입 검사 실패는 다른 수정자가 고치던 중의 일시 상태였고, 끝난 뒤 다시 돌려 통과를 확인했다.
연속 실패로 2단계에 올라간 항목은 없다. 남은 것: §2c 2단계 48건, §2d 3단계 6건.


---

# 1.5단계 — 저장소 로직 최적화·단계별 절차적 UX 검증 (2026-11-02)

대상: 서버 저장소 로직(`server/src/services/**`, `server/src/routes/**`, `server/src/lib/storage.ts`)과 앱의 사용자 흐름(`app/app/**`, `app/src/**`).
기준점: 커밋 `9b770d8` — typecheck(server·app·desktop·mcp) 통과, `npm test` 262개(서버 201·앱 47·mcp 14) 통과.
절차: **Sonnet 찾기(5기)** → Opus 일괄 검증 → 비판 Sonnet → 이견만 Opus 재판정 → Sonnet 수정(파일 겹침 없음). 연속 실패 N=2 이면 2단계.
찾기 담당(겹치지 않게): L1 저장소 읽기 경로 · L2 저장소 쓰기 경로 · U1 처음 시작·초대 흐름 · U2 파일 다루기 흐름 · U3 제안·계정·멤버 흐름.
UX 쪽은 위 UX 1단계(§1~§3)의 시각·접근성 지적과 겹치지 않게 **절차(흐름·상태·이동·문구·순서)** 만 본다.
"수정 대상" 조건은 UX 1단계와 같다 — 파일 하나 안에서 끝나고 버튼 글자·accessibilityLabel 을 바꾸지 않는 것. 서버는 기존 테스트가 지키는 동작을 바꾸지 않는 것.
여러 파일·라벨 변경·API 모양 변경·설계 판단은 2단계, 구조 변경은 3단계.

## §4 지적

### §4b L2 저장소 쓰기 경로 (Sonnet, 12건)

총평: 쓰기 라우트는 `await` 없는 `db.transaction` 안에서 head 를 다시 읽고 판정해(better-sqlite3 동기) 같은 프로세스의 check-then-write 경합은 없다. 문제는 디스크↔DB 비동기 구간과 커밋마다 manifest 를 반복해 만드는 비용에 몰려 있다.

- **L2-1** `server/src/services/proposals.ts:166-186` (findConflicts) [perf][high] — `proposal_changes.base_blob_hash` 가 있는데 매번 `readManifest(base)` 로 base 를 부모 체인을 되감아 재구성. 병합 한 번에 head 3번 읽음, `detail()`(상세·create·merge 응답)마다 같은 계산. → 제안: baseHash 는 저장된 `base_blob_hash`, head manifest 는 호출자가 한 벌 넘김. base===head 단락 유지. 시험: 스냅샷 여러 개 쌓인 뒤 충돌/비충돌 판정 동일.
- **L2-2** `server/src/services/snapshots.ts:153-156` + `files.ts:132,210,287,330`·merge [perf][low] — 라우트의 `readManifest(head)` 와 `writeSnapshot` 의 `readHead` 가 같은 SELECT 두 번. → 제안: 복사본을 `writeSnapshot({current})` 로 넘김. L2-1 과 함께.
- **L2-3** `files.ts:246,344-347`, `services/proposals.ts:149-159`, `snapshots.ts:127-137` [perf][med] — `findPathConflict` 가 매번 manifest 키 전체를 `startsWith` 로 훑어 O(항목×전체). 빈 저장소에 5000개 commit ≈ 2500만 비교가 동기 트랜잭션 안. move 는 파일마다 검사(대상 `to` 하나면 됨). → 제안: 파일 Set + 조상 폴더 접두 Set 색인으로 O(깊이). 시험: files.test 의 이름 겹침 사례 유지.
- **L2-4** `server/src/routes/files.ts:111-164` [correctness][med] — 직접 업로드가 blob 파일을 먼저 확정한 뒤 트랜잭션(413/409)이 실패하면 새 blob 파일을 지우지 않음(`/blobs`·`uploads/complete` 는 지움). GC(24h 유예)까지 고아. → 제안: 실패 시 isNewBlob 이면 remove, 세 곳 정리 로직을 헬퍼로. 시험: maxRepoBytes 작은 하니스에서 413 뒤 `blobs.has(hash)` false.
- **L2-5** `files.ts:443-446,472`, `uploads.ts:159-160,183` [race][low] — isNewBlob 기반 인라인 삭제가 같은 해시를 동시에 올리는 요청과 경합 → blobs 행은 있는데 파일 없음. → 제안: 해시별 뮤텍스 또는 인라인 삭제 없이 GC 에 맡김.
- **L2-6** `files.ts:117,464`, `uploads.ts:170`, `services/gc.ts:52` [correctness][low] — `INSERT … ON CONFLICT DO NOTHING` 이라 오래 방치된 미참조 blob 을 다시 올려도 `blobs.created_at` 이 옛 값 → 다음 GC 가 곧바로 지워 제안 생성이 400. → 제안: `DO UPDATE SET created_at = excluded.created_at`(repo_blobs 는 쿼터용이라 그대로). 시험: gc.test 에 "옛 미참조 blob 재업로드 후 GC 가 남긴다".
- **L2-7** `server/src/lib/storage.ts:147-158` [perf][med] — `completeSession` 이 세션 파일(최대 2GB)을 다시 읽어 해시. complete 가 프록시 100초를 넘기면 클라이언트는 오류, 재시도 409, 끝나면 세션 삭제로 404 → hash 를 받을 길이 없음. → 제안: 연속 조각이면 세션별 해시 상태를 이어 갱신, 어긋나면 기존 재해시로 폴백.
- **L2-8** `storage.ts:89-104,147-158`, `uploads.ts:156` [correctness][low] — completeSession 실패 시 moveIntoPlace catch 가 세션 파일을 지워 세션 행만 남고 이후 재시도는 ENOENT 500. → 제안: 던지면 세션 행·파일 정리.
- **L2-9** `server/src/routes/uploads.ts:80-105`, `files.ts:431` [correctness][med] — 진행 중 세션 크기가 쿼터에 예약되지 않고 세션 수 상한 없음. 편집자는 세션 경로에 쿼터가 아예 없음(`/blobs` 는 편집자에게도 검). → 제안: 세션 size 예약·열린 세션 수 상한·편집자 정책 일치.
- **L2-10** `routes/proposals.ts:145-148` vs merge `:357`, `files.ts:145,248` [correctness][low] — (a) 제안 생성 파일 수 검사가 삭제를 빼지 않아 생성 409·병합 통과로 어긋남. (b) `assertRepoBytes` 가 절대치라 한도를 낮춘 뒤에는 삭제만 하는 commit·병합·작은 파일로 교체도 413. → 제안: adds−deletes, "총량이 늘지 않으면 통과". 시험: maxRepoBytes:100 하니스로 한도 초과 상태 삭제 병합.
- **L2-11** `services/proposals.ts:120-136`, `files.ts:215`, `routes/proposals.ts:107` [simplify][low] — 루프 안에서 매번 `db.prepare`. → 제안: 모듈 단위 캐시.
- **L2-12** `server/src/lib/storage.ts:164-172,179-181` [simplify][low] — `writeBuffer`(최종 경로에 직접 씀)·`read`(전체 메모리) 미사용. → 제안: 삭제.
- 문제없음: PUT 조각(busy·truncate), writeStream 단일 패스, uploads/complete 실패 경로, GC "DB 먼저 파일 나중" 순서, 병합·삭제·이동·커밋의 head 재조회.

### §4a L1 저장소 읽기 경로 (Sonnet, 10건)

인메모리 SQLite 에 실제 MIGRATIONS 를 적용해 `EXPLAIN QUERY PLAN`·합성 벤치로 확인(서버에 ANALYZE 없음).

- **L1-1** `server/src/services/snapshots.ts:415-436` (listTrash) [perf][high] — 바깥 루프가 `idx_snapchanges_blob (blob_hash IS NULL)` 로 **모든 저장소의** 삭제 변경을 읽은 뒤 repo 로 거르고, "나중에 같은 경로를 바꿨나" 서브쿼리가 저장소의 모든 스냅샷을 프로브. 40저장소×1000스냅샷에서 한 저장소 휴지통 ~410-480ms, 다른 저장소 이력에 비례. → 제안: `snapshots s CROSS JOIN snapshot_changes c` 로 저장소에서 출발, 세 번째 서브쿼리는 `INDEXED BY idx_snapchanges_path` 로 순서 강제 — 407→35ms, 결과 동일(499건). 시험: 저장소 2개로 섞이지 않음·삭제 후 재생성·이동 대조.
- **L1-2** `server/src/services/snapshots.ts:280-284` (listTree), `server/src/routes/downloads.ts:105` (sendArchive) [perf][high] — 정렬 비교마다 `localeCompare(b,'ko',{numeric:true})` 로 Collator 를 새로 만듦. 경로 2만 개 1166ms vs 모듈 Collator 49ms(24배). recursive 목록(내 폴더와 비교)에서 이벤트 루프를 막음. → 제안: 모듈 상단 `new Intl.Collator('ko',{numeric:true})`. 시험: 숫자 섞인 이름 순서.
- **L1-3** `server/src/services/snapshots.ts:99-118` (readEntry) + `:50-97` (readManifest) [perf][med] — 과거 스냅샷에서 파일 하나를 찾으려고 저장소 전체 manifest 를 만들고 스냅샷마다 `changesOf.all` (N+1). raw?snapshot=·download-link·/dl. → 제안: 재귀 CTE 로 체인을 돌며 그 경로의 가장 깊은 변경 하나 → `prev_*`, 없으면 head. 벤치 결과 일치.
- **L1-4** `server/src/services/snapshots.ts:371-383` (listFileVersions) [index][low] — `snapshot_changes` 에 repo_id 가 없어 저장소의 모든 스냅샷을 프로브. 1000개에 0.8ms 로 아직 빠름. → 제안: 지금은 둠(필요 시 새 MIGRATION 으로 비정규화).
- **L1-5** `server/src/services/snapshots.ts:260-278` (listTree head) [perf][low] — 하위 폴더를 열어도 head 전체 행을 읽어 접두로 거름. 3500파일 4-6ms. → 제안: PK 범위 질의·SQL 집계. 우선순위 낮음.
- **L1-6** `server/src/services/repos.ts:67-92`, `server/src/routes/repos.ts:38-49` [perf][low] — `GET /repos` 가 1+4N 쿼리, `ORDER BY updated_at` 동률 처리 없음. → 제안: 한 쿼리로, `, r.id` 덧붙임.
- **L1-7** `server/src/routes/downloads.ts:43,107-109` [perf][low] — zip 링크 발급 시 전체 manifest 로 존재 확인, `sendArchive` 가 파일마다 `blobs.has` 를 순차 await. → 제안: 범위 질의 EXISTS, has 를 묶어 병렬.
- **L1-8** `server/src/routes/repos.ts:271-277` (readCursor) [correctness][low] — `before` 만 오거나 숫자가 아니면 조용히 첫 페이지 → before 만 보내는 클라이언트 무한 루프. → 제안: 400.
- **L1-9** `server/src/routes/repos.ts:240-243,256-259` [simplify][low] — `length === limit` 로 next 를 정해 정확히 limit 개 남으면 빈 페이지 요청이 한 번 더. → 제안: limit+1 읽기.
- **L1-10** `server/src/routes/files.ts:~474` (parseRange) [correctness][low] — `bytes=5-2` 는 RFC 9110 상 무시하고 200 이어야 하는데 416. → 제안: end<start 면 null.
- 문제없음: listSnapshots(0.3ms), snapshotStats, NFC 처리.

### §4e U3 제안·계정·멤버 흐름 (Sonnet, 17건)

- **U3-1** `app/app/repo/[repoId]/new-proposal.tsx:411` [1][missing-feedback][med] — 제목이 비면 「제안 올리기」가 흐려진 채 이유가 없음(제목 칸은 화면 맨 위). submit() 의 검증 문구(172·176행)는 disabled 때문에 도달 불가. → 제안: disabled 는 submitting 만, 기존 검증 문구 사용.
- **U3-2** `new-proposal.tsx:69,86-142` [1][state-loss][med] — 첫 파일 올리는 중엔 `hasDraft` false 라 뒤로 가도 확인 없음, 언마운트 뒤에도 uploadMany 가 계속 → 쓰이지 않는 blob. → 제안: hasDraft 에 uploading||preparing, 나가면 abort.
- **U3-3** `new-proposal.tsx:195-206,70-84` [1][race][low] — 제출 중 뒤로 가서 버리면 응답 후 언마운트된 화면의 `router.replace` 가 지금 화면을 제안 상세로 바꿈. → 제안: submitting 중 beforeRemove 막기 또는 마운트 ref.
- **U3-4** `new-proposal.tsx:411,86-142` [1][state-loss][med] — 올리는 중에도 「제안 올리기」가 눌림 → 끝나는 업로드 결과가 버려짐. → 제안: disabled 에 uploading||preparing.
- **U3-5** `new-proposal.tsx:129` [1][wrong-message][med] — 여러 파일 중 일부 실패 시 `failures[0]` 하나만 보임. → 제안: 개수·이름 목록.
- **U3-6** `new-proposal.tsx:119-127,144-158,181-192` [1][ordering][low] — 같은 경로를 두 번/삭제로 담은 경로에 올리면 중복을 제출 때에야 알림, 어느 행인지 모름. → 제안: addFiles 에서 겹치면 건너뛰고 알림(또는 교체), 200개 상한 안내.
- **U3-7** `app/app/proposal/[proposalId].tsx:67-87,203-211` [2][dead-end][high] — 반영 409 뒤 refresh 를 안 해 conflicts/mergeable 이 옛 값 → 「반영할 수 없습니다」 카드 안 뜨고 같은 409 반복. → 제안: 409 면 `state.refresh()`.
- **U3-8** `[proposalId].tsx:70-86,208-216,225-227` [2][double-submit][med] — 성공 후 refresh 를 기다리지 않고 action 을 풀어 옛 status 로 버튼이 다시 활성 → 한 번 더 누르면 "이미 처리된 제안" 오류. → 제안: refresh 완료 뒤 해제 또는 응답 proposal 로 즉시 갱신(useAsync 보강 필요).
- **U3-9** `[proposalId].tsx:168-171` [2][wrong-message][med] — 충돌 카드 문구가 작성자용인데 편집자에게도 같음. → 제안: 역할별 문구.
- **U3-10** `[proposalId].tsx:351-363,383-386` [2][wrong-message][low] — 열린 제안의 「현재본 받기」는 head 파일인데 크기 표시는 baseSize, head 에서 지워졌으면 일반 오류. → 제안: "제안 당시 N"·404 문구.
- **U3-11** `app/app/repo/[repoId]/proposals.tsx:37-44,104-108` [2][wrong-message][med] — 필터 칩을 바꾸면 응답 전까지 이전 필터 목록이 로딩 표시 없이 남음. → 제안: 필터 변경 시 비우거나 로딩 표시.
- **U3-12** `proposals.tsx:50-55,45-48,106` [2][state-loss][low] — 더 보기로 펼친 뒤 상세 다녀오면 포커스 refresh 가 펼친 페이지를 버림, 새로고침 한 번 실패로 목록 전체가 오류 박스. → 제안: 실패 시 목록 유지·토스트.
- **U3-13** `app/app/my-proposals.tsx:20` [3][missing-feedback][low] — 서버가 기본 50개만 주고 next 가 없어 51번째 이후는 영영 안 보이고 표시도 없음. → 제안: 서버 next + useMorePages(서버·앱).
- **U3-14** `app/app/repo/[repoId]/members.tsx:42,100-107,121-130,142-150` [4][race][med] — 한 칸짜리 busy 라 다른 멤버 작업이 서로의 로딩을 지움, 다른 멤버 버튼은 busy 중에도 활성(소유자 지정 연타 → 403). → 제안: busy 중 모든 멤버 버튼·삭제/나가기 disabled.
- **U3-15** `members.tsx:312-331` [4][dead-end][med] — 소유자는 「나가기」가 없고 소유권을 넘겨야 한다는 안내도 없음. → 제안: Caption 안내.
- **U3-16** `app/app/settings.tsx:147-156` [5][double-submit][med] — 로그아웃이 서버를 최대 3초 기다리는 동안 버튼 변화 없음 → 다시 눌러 확인창 중복. → 제안: signingOut 상태·loading.
- **U3-17** `settings.tsx:102-119` [5][wrong-message][low] — 비밀번호 변경이 처리됐는데 응답만 못 받은 경우(status 0)도 "바꾸지 못했습니다" → 재시도 시 "현재 비밀번호가 올바르지 않습니다", 이어 401 로그아웃. → 제안: status 0 문구 구분.

### §4c U1 처음 시작·초대 흐름 (Sonnet, 13건)

- **U1-1** `app/app/join.tsx:167` (+152-153, `index.tsx:28`, `signup.tsx:35`, `join.tsx:254-258`) [3][dead-end][high] — 링크로 들어와 로그인·참여하면 replace 연쇄로 스택이 `[repo]` 한 장 → 저장소 화면에서 「내 저장소」로 갈 길이 없음(RepoNav 는 replace 탭뿐, 안드로이드 뒤로가기는 앱 종료). 가입 경로는 `[join, repo]` 로 뒤로 가면 옛 join. → 제안: 참여 후 이동을 한 곳에 모아 dismissAll → replace('/repos') → push('/repo/<id>').
- **U1-2** `join.tsx:129-173,197-257` [3][dead-end][high] — 로그인·가입 직후 보낸 참여 화면에서 조회/참여가 실패하면(만료·회수·소진) 뒤로가기도 「내 저장소」도 없음. 참여만 실패하면 같은 「참여하기」가 남아 반복. → 제안: 오류이거나 canGoBack 거짓이면 「내 저장소로」(새 라벨), 409 면 preview 내림.
- **U1-3** `join.tsx:248-295` (+ `InviteSummary.tsx:147-190`) [3][wrong-message][med] — 못 쓰는 초대(409)를 로그인 전에 보여 줘도 부제·pending·PendingInviteNote 는 "참여를 이어 갑니다" 그대로 → 가입 후 U1-2. → 제안: 400/404/409 면 clearPendingInvite·부제 교체(네트워크·429·401 은 유지).
- **U1-4** `app/src/lib/invite-link.ts:46-71` (+ `index.tsx:27-28`, `login.tsx:160`, `join.tsx:87-88`) [3,4][state-loss][med] — pending 초대가 서버와 묶여 있지 않아 다른 서버로 바꿔 로그인해도 그 서버로 참여 시도, switchServer 실패 시 남음, 포기해도 프로세스 동안 남음. → 제안: `{code, serverUrl}`, `peekPendingInvite(activeUrl)`. 순수 함수로 app/test.
- **U1-5** `join.tsx:57-95,98-101,125-127,252-253` [3][wrong-message][med] — 목록에 없는 다른 서버 링크에서 「더할까요?」 취소·연결 확인 실패 시 `handledServer` 가 이미 true 라 재시도 불가, 화면은 현재 서버 X 로 미리보기·가입·코드 확인. → 제안: `!onLinkServer` 면 "이 초대는 <Y> 서버의 것" + 들어가기, 실패 시 handledServer 해제.
- **U1-6** `login.tsx:67`, `signup.tsx:37`, `reset-password.tsx:42` (+ `auth.tsx:94-96`) [1,3][wrong-message][low] — 고른 서버 없이 로그인하면 `noServerError()` 가 일반 Error 라 "로그인에 실패했습니다" 로 삼켜짐. → 제안: err.message 사용, activeServer null 이면 제출 막기.
- **U1-7** `join.tsx:129-173` [3][missing-feedback][low] — 링크로 바로 참여했을 때 토스트 없음, alreadyMember 무시. → 제안: notifySuccess.
- **U1-8** `app/app/repo/[repoId]/invites.tsx:81-92` [2][missing-feedback][med] — 초대 만들기 후 안내 없음, 새 초대는 폰에서 화면 밖 → 다시 눌러 여러 개 생성. → 제안: 응답 invite 로 QR 열기 또는 성공 토스트.
- **U1-9** `invites.tsx:259-280` [2][wrong-message][low] — 「사용 불가」인데 소진·발급자 권한 상실 사유가 안 보이고 "1/1명 참여·기한 없음" 만. → 제안: 「횟수 모두 사용」「발급자 권한 없음」.
- **U1-10** `app/app/server.tsx:114-126` (+ `auth.tsx:442-444`) [4][ordering][low] — 주소를 이미 있는 주소로 고치면 로그아웃 확인을 받은 뒤에야 중복 오류. → 제안: 확인 전 중복 검사.
- **U1-11** `server.tsx:56,79-82,209-216` [1][missing-feedback][low] — 형식이 틀린 주소면 두 버튼이 이유 없이 disabled, 안내는 Enter 때만. → 제안: 상시 안내.
- **U1-12** `login.tsx:160` (+ `server-list.ts:102-105`) [4][state-loss][low] — 로그인 화면에서 서버 목록으로 갔다 같은 서버로 돌아오면 입력이 사라짐(dismissAll+replace). → 제안: 로그아웃 상태에선 push(e2e 1-server-list 확인 필요).
- **U1-13** `app/app/reset-password.tsx:51-56` [3,4][missing-feedback][low] — 초대를 들고 재설정으로 가면 PendingInviteNote 가 없음. → 제안: 추가.

### §4d U2 파일 다루기 흐름 (Sonnet, 20건)

- **U2-1** `app/app/repo/[repoId]/index.tsx:76,161-193` + `app/src/components/RepoNav.tsx:57` [1][state-loss][high] — 올리는 중 RepoNav 탭(replace)·뒤로가기로 화면이 언마운트되면 진행률·멈추기가 사라진 채 업로드는 계속, 돌아오면 「파일 올리기」가 다시 켜져 중복 업로드, 끝나도 목록 갱신 없음. compare.tsx:176-236 도 같고 열람자는 끝난 뒤 `router.push('/proposal/…')` 가 다른 화면을 가로챔. → 제안: 전송 상태를 모듈 스토어로, 또는 전송 중 beforeRemove 확인, 닫힌 뒤 push 금지.
- **U2-2** `app/src/lib/transfer.ts:131-153` (+ `client.ts:233`) [1][state-loss][high] — status 0 재시도가 약 30초(5회)뿐, 넘으면 finally 의 `cancelUpload` 가 서버 세션을 지워 받은 위치가 사라짐. 나머지 파일도 줄줄이 실패. 문서의 "끊겨도 이어서" 와 다름. → 제안: 끊김으로 멈춘 세션은 지우지 않고 (저장소·경로·크기·수정시각) 키로 기억해 getUpload 로 이어 감, 오프라인이면 남은 파일 시도 중단.
- **U2-3** `transfer.ts:146` / `client.ts:313` (completeUpload 30초 타임아웃) [1][wrong-message][med] — 수 GB 완료 시 서버 재해시가 30초를 넘으면 "서버 응답이 없습니다" 로 실패 처리, 서버는 계속 완료. (L2-7 과 짝) → 제안: 긴 타임아웃, 타임아웃 시 세션 상태 확인.
- **U2-4** `transfer.ts:224-228`, `index.tsx:188-189`, `compare.tsx:233-234` [1,4][ordering][high] — 파일↔폴더 이름 충돌(409)·파일 수·용량(413)이 모든 바이트를 올린 뒤 커밋에서야 드러나고 전부 반영 안 됨, 문구는 "반영하지 못했습니다" 뿐, 다시 올리면 전부 재전송. 사전 검사는 같은 이름 파일만. → 제안: 올리기 전 폴더 충돌·파일 수 검사, 실패 문구에 "올린 N개는 반영되지 않았습니다".
- **U2-5** `app/src/lib/files.ts:64,98` + `index.tsx:250-256,275-281` [1][wrong-message][med] — 6000개 폴더를 고르면 조용히 5000개로 자르고 확인창은 "파일 5000개" 만, 기존 파일 수도 안 더함. → 제안: truncated 반환·안내, fileCount 합산.
- **U2-6** `index.tsx:161-187` [1][missing-feedback][med] — 1개 올리면 성공 토스트 없음, `commit.unchanged` 도 구분 안 됨, 부분 실패 사유는 토스트(최대 12초)로만. → 제안: 1개도 성공 안내, unchanged 문구, 결과 패널.
- **U2-7** `app/src/components/TransferProgress.tsx:45-47` + `transfer.ts:146,208,224` [1][wrong-message][med] — 100% 뒤 completeUpload·commitFiles 동안 「멈추기」가 활성인데 효과 없고 결국 성공 반영. → 제안: "서버에서 마무리하는 중" 단계, 멈추기 숨김.
- **U2-8** `index.tsx:291-301,615-616,645-663` + `SearchResults.tsx:101,129` [2,5][double-submit][med] — 안드로이드 받는 중에도 행 Pressable 이 살아 있고 download() 에 busyPath 가드 없음 → 받는 중인 캐시 파일 삭제·덮어쓰기, 선택기 두 번, 스피너 엇갈림. → 제안: `if (busyPath) return` + 행 disabled.
- **U2-9** `index.tsx:291-295`, `versions.tsx:84-85`, `trash.tsx:136-142` → `files.ts:128-132` [2,3][missing-feedback][med] — 안드로이드 큰 파일 받기에 onProgress 를 안 넘겨 진행률·멈추기 없음, PC 앱은 will-download 핸들러 없음. → 제안: onProgress 연결, PC 앱 will-download IPC.
- **U2-10** `files.ts:165-174`, `local-folder.ts:177-187` [2,4][wrong-message][med] — expo-file-system `resumeAsync()` 는 pause 로 얻은 resumeData 가 있을 때만 이어 받으므로 오류 후엔 매번 처음부터(주석·문서와 다름). /dl 링크 10분 만료, zip 은 Range 없음. → 제안: Range 직접 또는 문구 정정.
- **U2-11** `index.tsx:326-351` (+ RenameRow 744-755) [3][missing-feedback][med] — 파일 이름 바꾸기 칸에 전체 경로가 채워져 이름만 쓰면 최상위로 옮겨짐, 힌트·성공 안내 없음. → 제안: 힌트·토스트.
- **U2-12** `index.tsx:93-99,365-369` (+ `useAsync.ts:31-47`, history/versions/trash) [1,3][dead-end][med] — refresh 일시 실패 시 `state.error` 분기가 받아 둔 목록·빵부스러기·RepoNav 를 모두 지우고 오류만. 「다시 시도」 중 로딩 표시 없음. (U3-12 와 같은 뿌리) → 제안: data 가 있으면 목록 유지 + 오류 얹기.
- **U2-13** `index.tsx:93-99,196-223` [1][race][low] — 폴더를 옮긴 직후 이전 tree 가 남은 동안 올리면 덮어쓰기 확인·splitUnchanged 가 이전 폴더 기준. → 제안: loading 이거나 tree.path≠path 면 비활성.
- **U2-14** `app/src/lib/pure/transfer-plan.ts:34-45` + `index.tsx:212-219` [1][wrong-message][low] — 직접 고른 파일에도 크기·수정시각 휴리스틱으로 "같은 파일" 이라 단정하고 건너뜀. → 제안: 직접 고른 파일엔 끄거나 문구 수정.
- **U2-15** `compare.tsx:143-171` [4][wrong-message][low] — 웹 다중 받기는 시작시켰을 뿐인데 "N개를 받았습니다", 선택이 남아 중복. → 제안: "받기를 시작했습니다", 선택 지움.
- **U2-16** `compare.tsx:176-190,215-231` [4][wrong-message][low] — 열람자 경로 실패가 "반영하지 못했습니다", 부분 실패 사유 없음, 준비 중 busy 없음. → 제안: "제안을 만들지 못했습니다", details, busy.
- **U2-17** `app/app/repo/[repoId]/history.tsx:36-39,50-57` + `trash.tsx:109` [3][race][low] — 휴지통에서 되돌리고 돌아와도 이력이 갱신 안 돼 headId 가 옛 값 → 「현재」 판정 틀림. → 제안: useFocusEffect refresh.
- **U2-18** `index.tsx:377-381,386-415` [3][wrong-message][low] — 과거 시점 보기에서 머리말 숫자는 현재 값. → 제안: 숨기거나 "현재 기준".
- **U2-19** `app/app/repo/[repoId]/versions.tsx:132-135` [3][dead-end][low] — 옮긴 파일의 버전은 옮긴 뒤부터만, 안내 없음. → 제안: 한 줄 안내.
- **U2-20** `SearchResults.tsx:115-117` + `index.tsx:484-487` [5][state-loss][low] — 검색 결과에서 폴더 열기 시 검색어가 지워짐. → 제안: 마지막 검색어 보관.

## §5 판정 (Opus, 2026-11-02)

Opus 가 §4 72건을 코드와 대조했다. 확인한 것: listTrash·재작성안의 `EXPLAIN QUERY PLAN`(인메모리 DB, 실제 MIGRATIONS), localeCompare 벤치(2만 경로: 옵션 있음 1021ms · 인자 없음 55ms · 모듈 Collator 46ms), 루프 안 `db.prepare` 벤치(5000회 135ms vs 8ms), findPathConflict 5000×5000 = 117ms, expo-file-system 안드로이드 `downloadResumableStartAsync`(resumeData 는 pause 로만 생김).
집계: 수정 대상 34 · 2단계 22 · 3단계 1 · 중복 4 · 기각 11.

### §5a 수정 대상 (34)

서버 (10)
- **L1-1** `server/src/services/snapshots.ts` — listTrash 를 `FROM snapshots s CROSS JOIN snapshot_changes c ON c.snapshot_id = s.id JOIN users u …` 로 바꿔 저장소에서 출발하게 하고(지금은 `idx_snapchanges_blob (blob_hash=?)` 로 전 저장소의 삭제 변경을 훑는다), 세 번째 NOT EXISTS 를 `FROM snapshot_changes l INDEXED BY idx_snapchanges_path JOIN snapshots ls …` 로 바꾼다. 나머지 조건·정렬·LIMIT 은 그대로. 재작성안 계획: s=idx_snapshots_repo → c=PK(snapshot_id) → l=idx_snapchanges_path 확인. 시험: history.test 에 "저장소 둘에 각각 지운 파일 — 휴지통이 섞이지 않는다" 추가, 기존 휴지통 사례(삭제 후 재생성·이동 제외) 통과.
- **L1-2** `server/src/services/snapshots.ts` — 모듈 상단에 `const byKo = new Intl.Collator('ko', { numeric: true });` 를 두고 280-284행의 `localeCompare(…, 'ko', { numeric: true })` 두 곳을 `byKo.compare(a.name, b.name)`·`byKo.compare(a.path, b.path)` 로. downloads.ts:105 는 인자 없는 localeCompare 라 V8 이 기본 Collator 를 캐시해 빠르다(벤치 55ms) — 건드리지 않는다. 시험: files.test 에 '2.txt'·'10.txt' 를 올려 목록이 [2.txt, 10.txt] 순서인 사례 추가.
- **L1-3** `server/src/services/snapshots.ts` — readEntry 의 과거 시점 분기(117행)에서 readManifest 를 부르지 말고: readManifest 와 같은 재귀 CTE 로 head→목표 체인을 얻고(마지막이 목표가 아니면 같은 오류), 목표를 뺀 스냅샷들을 **오래된 것(깊은 것)부터** `SELECT prev_blob_hash, prev_size, prev_mime_type, prev_updated_at FROM snapshot_changes WHERE snapshot_id = ? AND path = ?` 로 찾아 첫 행이 나오면 prev_blob_hash 가 null 이면 undefined, 아니면 prev_* 로 EntryRow 를 만든다. 하나도 없으면 head 의 `repo_files` 한 행(없으면 undefined). 시험: history.test 에 같은 경로를 추가·수정·삭제·재추가한 스냅샷 여럿을 쌓고 모든 스냅샷·경로에서 `readEntry(db,s,p)` 와 `readManifest(db,s).get(p)` 가 같은지 대조.
- **L2-1** `server/src/services/proposals.ts` — findConflicts 에서 `readManifest(db, baseSnapshotId)` 를 지우고 `baseHash = change.base_blob_hash` 를 쓴다(제안 생성 때 base_snapshot_id 와 같은 head 의 manifest 에서 채운 값 — routes/proposals.ts:60·77·98·129). base===head 단락과 시그니처는 그대로(호출부 무수정). 비싼 쪽(부모 체인 되감기)만 없어진다. 시험: proposals.test 에 "제안 뒤 스냅샷 여러 개(관련 없는 파일·같은 파일) — conflicts 가 예전과 같다" 추가, 기존 충돌 사례 통과.
- **L2-11** `server/src/services/proposals.ts` — blobBelongsToRepo 의 두 문장을 `WeakMap<Db, { uploaded: Statement; referenced: Statement }>` 캐시로 한 번만 prepare. (files.ts:215 는 이미 루프 밖, routes/proposals.ts:107 은 최대 200회라 제외 — 지적의 그 부분은 과장.) 시험: commit·proposals 기존 테스트 통과.
- **L2-10** `server/src/routes/proposals.ts` — (a)만: 146행을 `base.size + addCount - deleteCount > MAX_FILES_PER_REPO` 로(deleteCount = op==='delete' 수) — 병합(357행)의 결과 수 검사와 맞춘다. (b) 용량 절대치 판정은 §5b. 시험: proposals.test 에 writeSnapshot 으로 한도까지 채운 뒤(505행 사례 방식) "추가 1 + 삭제 1 제안은 201" 추가.
- **L1-8** `server/src/routes/repos.ts` — readCursor 에서 before·beforeId 중 하나만 왔거나 before 가 정수가 아니면 `badRequest('before·beforeId 값이 올바르지 않습니다.')` 를 던진다(제안 목록 204행과 같은 태도). 앱은 늘 둘 다 보내고(client.ts:444-466), MCP 도구는 beforeId 가 선택이라(mcp/src/tools.ts:36-37) 지금은 조용히 첫 페이지를 다시 준다. 시험: history.test 에 `?before=123` 만 → 400 추가.
- **L1-10** `server/src/routes/files.ts` — parseRange 에서 startText·endText 가 둘 다 있고 `Number(endText) < Number(startText)` 면(잘라내기 전 값으로) `null`(전체 200)을 돌려준다. RFC 9110 §14.1.1 은 last-pos < first-pos 를 문법 오류로 보고 "MUST ignore". `bytes=100-` 의 416(transfer.test:226)은 그대로. 시험: transfer.test 에 `bytes=5-2` → 200·전체 본문 추가.
- **L2-6** `server/src/routes/files.ts`(117·464행) + `server/src/routes/uploads.ts`(170행) — 같은 SQL 세 곳의 `ON CONFLICT(hash) DO NOTHING` 을 `ON CONFLICT(hash) DO UPDATE SET created_at = excluded.created_at` 로(같은 줄 기계적 교체, repo_blobs 는 그대로). blobs.created_at 은 GC 유예에만 쓰인다(gc.ts:52). 시험: gc.test 에 "/blobs 로 올린 blob 을 유예보다 늙힌 뒤 같은 내용을 다시 올리면 GC 가 남긴다" 추가.
- **L2-12** `server/src/lib/storage.ts` — 쓰는 곳이 없는 `writeBuffer`(164-172)·`read`(179-181)를 지운다(grep: server·mcp 에 호출 없음). 시험: typecheck.

앱 (24)
- **U2-3** `app/src/api/client.ts` — RequestOptions 에 `timeoutMs?: number` 를 더해 `REQUEST_TIMEOUT_MS` 대신 `options.timeoutMs ?? REQUEST_TIMEOUT_MS` 를 쓰고, completeUpload 는 `timeoutMs: 10 * 60_000` 을 넘긴다(서버가 최대 2GB 를 다시 해시한다 — storage.ts:147-158, 기본 한도 config.ts:185). 시험: typecheck, test:e2e(6-transfer).
- **U1-6** `app/src/state/auth.tsx` — noServerError() 가 `new ApiError(0, 'internal', '들어갈 서버를 먼저 골라 주세요.')` 를 돌려주게 한다(client.ts:165 와 같은 문구·모양). 그러면 login·signup·reset-password 의 `err instanceof ApiError ? err.message` 가 그대로 보인다. 화면 파일은 안 고친다. status 0 을 특별 취급하는 곳은 transfer.ts:131 뿐이라 영향 없음. 시험: typecheck, test:e2e.
- **U3-1** `app/app/repo/[repoId]/new-proposal.tsx` — 제출 버튼(407-413) 바로 위에 이유 한 줄: `!title.trim() ? '제목을 입력하면 올릴 수 있습니다.' : staged.length === 0 ? '파일을 담거나 지울 파일을 골라야 올릴 수 있습니다.' : null` 을 Caption 으로(버튼 글자 불변). disabled 조건은 U3-4 대로. 시험: typecheck(e2e 에 이 화면 없음).
- **U3-4** `app/app/repo/[repoId]/new-proposal.tsx` — 제출 버튼 disabled 를 `staged.length === 0 || !title.trim() || uploading || preparing` 로. 시험: typecheck.
- **U3-2** `app/app/repo/[repoId]/new-proposal.tsx` — 69행 hasDraft 에 `|| uploading || preparing` 를 더한다(첫 파일을 담는 중에 뒤로 가도 확인). 나간 뒤 업로드를 끊는 것은 TransferControl 에 확인 없는 abort 가 없어 U2-1(3단계) 몫. 시험: typecheck.
- **U3-3** `app/app/repo/[repoId]/new-proposal.tsx` — `submittingRef` 를 두고 submit 에서 setSubmitting 과 함께 세우고 내린다. beforeRemove 리스너에서 `submittedRef` 검사 다음에 `if (submittingRef.current) { event.preventDefault(); return; }`(대화상자 없이 막기) — 제출 응답 뒤 replace 가 다른 화면을 바꾸지 않게. 시험: typecheck.
- **U3-5** `app/app/repo/[repoId]/new-proposal.tsx` — 129행: 실패가 1개면 지금 문구, 여러 개면 `${failures.length}개를 담지 못했습니다 — ` + 앞 3개 `${이름}: ${message}` 를 ', ' 로 + 남으면 ` 외 N개`. 시험: typecheck.
- **U3-7** `app/app/proposal/[proposalId].tsx` — run() 의 catch 에서 `if (err instanceof ApiError && err.status === 409) state.refresh();` — 충돌·이미 처리됨 뒤 conflicts·mergeable·status 를 새로 받는다. 시험: typecheck, test:e2e.
- **U3-9** `app/app/proposal/[proposalId].tsx` — 충돌 카드 Caption(168-171)을 `user?.id === proposal.author.id` 일 때만 지금 문구로, 아니면 '이 제안을 만든 뒤 아래 파일이 저장소에서 바뀌었거나, 이름이 겹치는 파일·폴더가 생겼습니다. 작성자가 최신 내용으로 다시 제안해야 반영할 수 있습니다.' 로. e2e 에 이 문구 없음(grep). 시험: typecheck.
- **U3-11** `app/app/repo/[repoId]/proposals.tsx` — 104행 `state.loading && !state.data` 를 `state.loading` 으로 — 필터를 바꾸면(deps 변경 → run('initial')) 이전 필터 목록 대신 Loading. 포커스 새로고침은 refreshing 이라 목록이 그대로 남는다. 시험: test:e2e(12-lists).
- **U3-14** `app/app/repo/[repoId]/members.tsx` — 멤버 행 버튼 셋(274-294)에 `disabled={busy !== null || leaving}`, changeRole·transferOwnership·removeMember 맨 앞에 `if (busy) return;`, 저장소 삭제·나가기 Button 에 `disabled={busy !== null}`. 라벨 불변. 시험: test:e2e.
- **U3-15** `app/app/repo/[repoId]/members.tsx` — 소유자 분기의 '저장소 삭제' 버튼 아래에 `<Caption>소유자는 저장소에서 나갈 수 없습니다. 나가려면 먼저 다른 멤버를 소유자로 지정하세요.</Caption>`(서버 문구 routes/repos.ts:167 과 같은 뜻). 시험: typecheck, test:e2e.
- **U3-16** `app/app/settings.tsx` — `signingOut` 상태: signOut 에서 확인 뒤 true, `try { await logout(); } finally { setSigningOut(false); }`, 맨 앞 `if (signingOut) return;`. 288행 로그아웃 Button 에 `loading={signingOut}`. 시험: test:e2e.
- **U1-9** `app/app/repo/[repoId]/invites.tsx` — 273-279 상태 Caption 사슬에서 '회수됨' 다음에 `invite.maxUses !== null && invite.useCount >= invite.maxUses ? '횟수 모두 사용'` 을, 그 다음(기한 표시 앞)에 `!invite.active && 만료 아님 ? '발급자 권한 없음'` 을 넣는다(server/src/routes/invites.ts:38-44 isActive 의 네 사유와 맞춘다). 시험: test:e2e(7-invite-link).
- **U1-10** `app/app/server.tsx` — save() 에서 target 을 정한 뒤·주소 바꾸기 확인 전에 `if (servers.some((e) => e.id !== editing?.id && serverUrl(e) === target)) { setError('이미 목록에 있는 주소입니다.'); return; }`(auth.tsx:441-443 과 같은 판정·문구). 시험: test:e2e(1-server-list).
- **U1-13** `app/app/reset-password.tsx` — login.tsx:99 처럼 `<PendingInviteNote action="로그인" />` 를 폼 위에 둔다(재설정이 끝나면 로그인 상태가 되므로 '로그인하면' 문구가 맞다 — InviteSummary.tsx 의 action 타입은 그대로). 시험: typecheck.
- **U2-8** `app/app/repo/[repoId]/index.tsx` — download() 맨 앞에 `if (busyPath !== null) return;`(검색 결과 행도 이 함수를 부른다). 행 disabled 는 넣지 않는다. 시험: test:e2e(6-transfer).
- **U2-11** `app/app/repo/[repoId]/index.tsx` — 파일 RenameRow(606-613)에 `hint="전체 경로입니다. 앞의 폴더 부분을 지우면 맨 위로 옮겨집니다."` 를 준다(폴더 행 527행과 같은 방식). 성공 토스트는 O3. 시험: typecheck, test:e2e.
- **U2-13** `app/app/repo/[repoId]/index.tsx` — `const treeFresh = !state.loading && tree?.path === path;` 를 두고 upload() 맨 앞 가드에 `|| !treeFresh`, '파일 올리기' disabled 를 `preparing || !treeFresh` 로(splitUnchanged·덮어쓰기 확인이 tree.files 를 쓴다 — 212-223행. 폴더를 옮긴 직후 옛 폴더 기준으로 "이미 올라가 있음" 판정을 해 조용히 건너뛸 수 있다. uploadFolder 는 listRepoFolder 로 새로 받으므로 제외). 시험: test:e2e(6-transfer·11-restore).
- **U2-18** `app/app/repo/[repoId]/index.tsx` — 377-381행에서 snapshotId 가 있으면 '파일 N개'·용량 Caption 을 그리지 않는다(멤버 수는 그대로) — repo.fileCount·totalSize 는 head 값이다. 시험: test:e2e(11-restore).
- **U2-15** `app/app/repo/[repoId]/compare.tsx` — 171행을 toFolder 면 지금 문구, 아니면 `notifySuccess(`${files.length}개 받기를 시작했습니다.`, '브라우저의 내려받기 목록에서 확인하세요.')` 로. `!toFolder && !signal.aborted` 면 `setSelected(new Set())`. 시험: test:e2e(9-compare).
- **U2-16** `app/app/repo/[repoId]/compare.tsx` — 233행 문구를 `isEditor ? '반영하지 못했습니다.' : '제안을 만들지 못했습니다.'` 로, 224행 notifyError 에 `failures.slice(0, 3).map((f) => `${f.item.path}: ${f.message}`).join('\n')` 를 둘째 인자로. 준비 중 busy 는 제외. 시험: test:e2e(9-compare).
- **U2-17** `app/app/repo/[repoId]/history.tsx` — index.tsx:103-113 과 같은 `firstFocus` ref + `useFocusEffect`(첫 포커스는 건너뛰고 `state.refresh()`)를 더한다(휴지통에서 되돌리고 돌아오면 headId·목록 갱신). 시험: test:e2e(11-restore).
- **U2-19** `app/app/repo/[repoId]/versions.tsx` — 135-138 Subtitle 끝에 ' 옮기거나 이름을 바꾼 파일은 옮긴 뒤의 버전만 보입니다.' 를 덧붙인다(snapshots.ts:358-361 주석 그대로). 시험: typecheck.

### §5b 2단계 (22)

- **L2-3** — findPathConflict 가 호출마다 manifest 전체를 훑는 것은 사실(5000×5000 = 117ms, 동기 트랜잭션 안). 접두 색인을 만들려면 snapshots.ts·files.ts(246·346)·services/proposals.ts(156)를 함께 바꿔야 한다(색인 API 결정). 제안 중 "move 는 대상 `to` 하나만 검사" 는 틀렸다 — 지금은 기존 폴더로 합쳐 옮기기를 허용하는데(`b/x` 만 검사) `b` 하나만 보면 기존 폴더 `b` 가 있을 때 막힌다.
- **L2-4** — 직접 업로드가 413/409 로 실패하면 blob 파일이 남는 것은 사실이나 gc.ts:119-121 sweepOrphanFiles 가 이 경우를 명시적으로 줍는다. 인라인 삭제를 더하면 L2-5 경합이 한 곳 더 생긴다 → L2-5 와 함께 "인라인 삭제 vs GC 에만 맡기기" 정책 결정(files.ts·uploads.ts). files.ts:442 의 "GC 가 없으므로" 주석은 낡았다.
- **L2-5** — isNewBlob 판정(files.ts:443, uploads.ts:159)과 실패 시 remove 사이에 같은 해시를 다른 요청이 커밋하면 행만 남는다. 창은 좁지만 실재. 해시별 잠금 또는 인라인 삭제 폐지 결정(L2-4 와 한 묶음).
- **L2-7** — completeSession 이 세션 파일을 다시 읽어 해시한다(storage.ts:147-158). 조각마다 해시를 잇는 방식은 truncate·재전송(appendChunk 127행)과 재시작에 깨져 설계가 필요하고, complete 를 멱등으로(결과 hash 를 잠시 보관) 만드는 안과 비교해야 한다. 클라이언트 쪽 시간 초과는 U2-3 으로 먼저 완화.
- **L2-9** — 열람자가 세션을 여러 개 열면 startUpload 의 한도 검사(uploads.ts:93)가 완료분만 세어 세션 파일로 디스크를 채울 수 있다. 세션 크기 예약·열린 세션 수 상한은 정책 결정. 편집자 면제는 uploads.ts:22-23 에 의도로 적혀 있다(/blobs 와의 불일치는 결정 사항).
- **L2-10(b)** — 한도를 낮춘 뒤 삭제만 하는 commit·병합도 413(files.ts:248, routes/proposals.ts:360). "총량이 늘지 않으면 통과" 는 files.ts·routes/proposals.ts 두 곳의 정책 변경. (a)는 §5a 에서 세었고 여기서는 세지 않는다.
- **U3-6** — 같은 경로를 두 번 담으면 제출 때에야 알린다. addFiles 에서 겹칠 때 "교체" 와 "건너뛰기" 중 무엇을 할지 결정 필요(삭제로 담은 경로에 올리면 수정으로 바뀌는 문제 포함).
- **U3-8** — 성공 뒤 `state.refresh()`(void)를 기다리지 않고 action 을 풀어 옛 status 로 버튼이 잠깐 살아난다. 고치려면 useAsync.refresh 가 Promise 를 돌려주거나 setData 를 내놓아야 한다(useAsync.ts + 화면).
- **U3-13** — `/proposals/mine` 은 limit 기본 50·next 없음(routes/proposals.ts:238-259). next 를 더하는 것은 응답 모양 변경 + API_LEVEL + my-proposals.tsx useMorePages.
- **U1-1** — 링크→로그인→참여 뒤 스택이 `[repo]` 하나가 되는 것은 사실(index.tsx:28 Redirect·join.tsx:153·167·229 replace). 참여 뒤 이동을 dismissAll→repos→push 로 모으는 것은 join.tsx·index.tsx·signup 흐름과 e2e 7-invite-link 에 걸친 이동 설계.
- **U1-2** — 참여 실패 뒤 출구가 없는 것은 사실. 「내 저장소로」 새 버튼(새 라벨)과 409 뒤 preview 처리 결정이 필요하다.
- **U1-3** — 못 쓰는 초대(400/404/409)에도 PendingInviteNote·부제가 "참여를 이어 갑니다". clearPendingInvite 시점을 바꾸는 것은 invite-link.ts·InviteSummary.tsx·join.tsx 에 걸친다.
- **U1-4** — pending 초대가 서버와 묶이지 않는다. `{code, serverUrl}` 로 바꾸는 것은 invite-link.ts·index.tsx·login.tsx·join.tsx 변경(+ 순수 함수로 빼면 app/test).
- **U1-5** — 서버 추가 취소·연결 실패 뒤 handledServer 가 true 로 남아 재시도가 없고(join.tsx:64·73·80), 화면은 지금 서버로 조회한다. "이 초대는 Y 서버의 것" 안내(새 문구·버튼)와 재시도 흐름 결정.
- **U1-11** — 형식이 틀린 주소에서 두 버튼이 이유 없이 꺼지는 것은 사실. 상시 안내를 넣으면 입력 중(예: "192.")에도 깜빡인다 — 언제 보일지(blur 뒤 등) 결정.
- **U2-2** — status 0 재시도가 약 31초(1+2+4+8+15)뿐이고 finally 의 cancelUpload 가 세션을 지운다(transfer.ts:131-153). 재시도 창·오프라인이면 남은 파일 중단은 2단계 결정, 세션을 기억해 다른 시도에서 이어 가는 것은 U2-1 의 저장소 이동과 함께(3단계 쪽).
- **U2-4** — 폴더·파일 이름 충돌·파일 수·용량이 커밋에서야 드러난다(files.ts:246-248). 올리기 전 검사는 전체 목록(또는 새 API)이 필요하고, 실패 문구 "올린 N개는 반영되지 않았습니다" 는 그와 함께 정한다.
- **U2-5** — pickFolder 가 5000개에서 조용히 자른다(files.ts:64·98). truncated 를 돌려주려면 files.ts 반환 모양 + index.tsx·compare 호출부. 기존 파일 수 합산도 U2-4 사전 검사와 함께.
- **U2-7** — 100% 뒤 complete·commit 동안 「멈추기」가 효과 없다(transfer.ts:145-146 뒤에는 signal 을 안 본다). "마무리하는 중" 단계는 UploadProgress 모양(transfer.ts)·TransferProgress.tsx 두 파일과 새 문구.
- **U2-9** — 안드로이드 받기에 onProgress 를 안 넘긴다(index.tsx:294, versions·trash). 진행 UI 를 세 화면에 더하고 PC 앱 will-download IPC(DesktopBridge·protocol·preload·main)까지.
- **U2-10** — 확인: 안드로이드 `downloadResumableStartAsync` 는 resumeData 가 있을 때만 Range 를 붙이고(FileSystemLegacyModule.kt:681-682) resumeData 는 pauseAsync 로만 생긴다 → 오류 뒤 resumeAsync 는 처음부터. 파일 길이를 resumeData 로 새 작업을 만들면 되지만 zip(/dl archive)은 Range 를 무시해 200 전체를 이어 붙여 망가진다 — 파일만 이어받기·206 확인 설계 필요(files.ts·local-folder.ts). 최소한 files.ts:165-174 주석은 틀렸다.
- **U2-12** — refresh 일시 실패 때 `state.error` 분기가 받아 둔 목록을 지운다(index.tsx:367, history·versions·trash·proposals 같은 모양). useAsync 를 바꿀지(refresh 실패는 토스트) 화면마다 "data 있으면 목록 + 오류" 로 할지 결정.
- **U2-14** — 직접 고른 파일에도 크기·수정시각 휴리스틱으로 건너뛴다(transfer-plan.ts:34-45). 건너뛴 사실은 알린다(index.tsx:217·233). 직접 고른 파일에는 끌지, "그래도 올리기" 를 둘지 결정.

### §5c 3단계 (1)

- **U2-1** — 전송 상태가 화면(index.tsx:76·compare.tsx)에 있어 RepoNav replace·뒤로가기로 언마운트되면 진행률·멈추기가 사라지고 업로드는 계속, 돌아오면 다시 올릴 수 있으며, compare 의 열람자 경로는 끝난 뒤 `router.push('/proposal/…')`(compare.tsx:226)로 다른 화면을 가로챈다. 전송을 화면 밖 스토어로 옮기는 구조 변경. U3-2 의 "나가면 abort"·U2-2 의 세션 이어 가기도 여기서.

### §5d 중복 (4)

- **U3-12** — U2-12 와 같은 뿌리(새로고침 실패가 목록을 지움). 앞부분(포커스 새로고침이 펼친 페이지를 버림)은 useMorePages.ts:21-25 주석대로 의도된 동작.
- **U1-7** — O3(조용한 성공, join.tsx 참여 포함)과 중복.
- **U1-8** — O3(invites.tsx 초대 만들기 조용한 성공)과 중복.
- **U2-6** — O3 과 같은 정책 문제(index.tsx:180 `items.length > 1` 은 의도적 생략). 토스트를 늘리면 e2e 의 단일 파일 올리기 흐름에서 토스트가 버튼을 가리는지도 함께 봐야 한다.

### §5e 기각 (11)

- **L1-4** — 지적자 스스로 "지금은 둠"(1000 스냅샷 0.8ms). 고칠 것이 없다.
- **L1-5** — head 하위 폴더 목록 4-6ms(3500 파일). 과거 시점은 어차피 manifest 가 필요해 분기만 늘어난다. 비용 대비 이득 없음.
- **L1-6** — `GET /repos` 1+4N 은 같은 프로세스 SQLite 의 µs 단위 PK·COUNT 질의이고 N 은 한 사람의 저장소 수. `, r.id` 동률 정렬은 같은 ms 에 만든 저장소의 순서를 바꿀 수 있어(newId 는 무작위) 이득 없이 테스트 위험만 있다.
- **L1-7** — zip 링크의 manifest 확인은 sendArchive(downloads.ts:103)도 어차피 만든다. blobs.has 순차 await 는 파일당 fs.access 한 번으로 수천 개 내려받기 시간에 비해 무시할 만하다.
- **L1-9** — 정확히 limit 개 남을 때 빈 페이지 요청 한 번. limit+1 로 바꾸면 history·versions·events·proposals 네 곳의 next 의미가 바뀐다(proposals.test:656-657 이 next 값을 고정). 비용 무시할 만함.
- **L2-2** — 라우트의 manifest 는 writeSnapshot 전에 수정되므로(files.ts:147 등) 그대로 current 로 넘길 수 없고 복사본이 필요하다 — 복사 비용이 SELECT 한 번과 비슷하다. writeSnapshot 시그니처를 모든 호출부에서 바꿀 이유가 없다.
- **L2-8** — completeSession 실패 뒤 세션 행이 남아도 앱은 finally 에서 늘 cancelUpload 를 부르고(transfer.ts:152) GC 가 멈춘 세션을 치운다(gc.ts:93-100). 재시도로 500 이 반복되는 클라이언트가 없다.
- **U3-10** — 열린 제안에서 현재본 크기·내용이 base 와 다르거나 head 에서 지워진 경우는 정의상 그 경로가 conflicts 에 든다(services/proposals.ts:177-184) — 충돌 카드가 이미 그 경로를 나열한다. 충돌이 없으면 head = base 라 표시가 맞다.
- **U3-17** — 전제가 틀렸다. status 0 이면 settings.tsx:115 가 ApiError 의 메시지("서버에 연결할 수 없습니다…"/"서버 응답이 없습니다…", client.ts:194-213)를 보이지 "바꾸지 못했습니다" 가 아니다. 응답만 잃은 경우의 뒤이은 401 은 새 비밀번호로 다시 로그인하면 끝나는 드문 경우.
- **U1-12** — server-list.ts:3-10 주석대로 목록을 스택 맨 아래로 여는 것은 보호 라우트와 엇갈리지 않게 하려는 의도된 설계. push 로 바꾸면 그 불변식이 깨진다. 잃는 것은 입력한 아이디·비밀번호뿐.
- **U2-20** — 검색 결과는 query 가 있을 때만 그려지므로(index.tsx:476) 폴더를 열려면 검색어를 비워야 한다. 마지막 검색어를 되살리려면 새 UI(되돌아가기 버튼)가 필요하고 얻는 것이 작다.

## §5f 비판 Sonnet 반론 (2026-11-02)
코드·테스트·e2e 를 대조했다. 아래 두 건만 이견, 나머지 §5a 는 동의 — 불안하다던 L1-3·L2-1·L2-6·U2-13·U3-11 은 확인 결과 안전하다(근거 말미). §5e 기각 11건·§5b/§5c 분류도 동의(U3-17·U1-12 기각 근거는 client.ts:194-213·settings.tsx:115·server-list.ts:3-10 로 재확인).
- **U1-10** (Opus: 수정 대상 → 주장: 수정 대상 유지, 단 조건을 `editing && urlChanged` 로 좁힐 것) — 제시된 `servers.some((e) => e.id !== editing?.id && serverUrl(e) === target)` 은 서버 **추가** 화면(`editing` 없음)에서도 `e.id !== undefined` 가 항상 참이라 같은 주소를 추가하면 오류가 된다. 지금 동작은 오류가 아니라 기존 항목 재사용 + 이름만 갱신(auth.tsx:417-424 saveServer 의 `existing` 분기)이다. 오류는 수정 화면에서 주소를 바꿀 때만 맞다(auth.tsx:441-444 와 같은 조건 `urlChanged`, server.tsx:54 의 `urlChanged = !editing || …` 이므로 `editing &&` 를 따로 붙여야 한다).
- **U2-15** (Opus: 수정 대상 → 주장: 문구만 바꾸고 `setSelected(new Set())` 은 빼거나 `repo:` 키만 지우도록) — e2e/specs/9-compare.mjs:93-105 가 웹에서 받기(3개) 직후 탭을 「내 폴더에만」으로 옮겨 「모두 고르기」를 누르고 「고른 2개 저장소에 올리기」를 누른다. 받는 루프는 마지막 anchor.click 뒤 400ms 를 더 자고(compare.tsx:160) 나서 `setProgress(null)`(168)을 하는데, 그때까지 버튼은 busy 로 disabled(compare.tsx:481)라 e2e 의 클릭은 busy 가 풀리기를 기다린다. 제안대로 같은 시점에 `setSelected(new Set())` 을 하면 e2e 가 방금 고른 local: 선택이 함께 지워져 버튼이 「올릴 파일을 고르세요」(compare.tsx:475)로 남아 테스트가 시간 초과로 실패한다. 탭을 바꾸면 이미 선택이 비워지므로(compare.tsx:75-78) 얻는 것도 작다. 비우려면 함수형 업데이트로 `repo:` 키만 걸러낸다.
- 동의 근거(요약): L1-3 호출부 셋이 모두 `snapshotBelongsTo` 로 거른 뒤 부르고(downloads.ts:49·73, files.ts:384) 실제로 하나의 체인만 걷으므로 같은 오류 계약 유지 — 단 구현 때 readManifest 의 `!target → 빈 Map`(snapshots.ts:58)과 같은 가드를 둘 것. L2-1 `base_blob_hash` 는 제안 생성 때 head manifest 에서 채우고(routes/proposals.ts:77·98·129) 어디서도 갱신하지 않아 base 재구성과 같다. L2-6 의 `isNewBlob` 은 `changes` 가 아니라 앞선 SELECT 로 정해지므로(files.ts:443-446, uploads.ts:159-160) DO UPDATE 로 바꿔도 인라인 삭제 판정이 변하지 않는다. U2-13·U3-11·U3-14·U3-15 는 e2e 가 `isDisabled`/부분 문자열 `getByText` 로 해당 버튼·문구를 보지 않고(grep) 클릭은 자동 대기라 안전. U3-11 은 필터를 바꾸면 useAsync 의 initial 실행과 useFocusEffect 의 refresh 가 겹쳐도 마지막 요청이 끝날 때까지 loading 이 유지된다.

## §5g Opus 재판정 (이견 2건, 2026-11-02)

- **U1-10** — 반론 채택. 수정 대상 유지, 조건을 `editing && urlChanged && servers.some((e) => e.id !== editing.id && serverUrl(e) === target)` 로 좁힌다. 추가 화면의 같은 주소는 지금처럼 기존 항목 재사용(auth.tsx:417-424)이 맞다.
- **U2-15** — 반론 채택. 문구만 바꾼다(`toFolder` 가 아니면 "N개 받기를 시작했습니다" + "브라우저의 내려받기 목록에서 확인하세요"). `setSelected(new Set())` 은 넣지 않는다 — e2e 9-compare:93-105 가 받기 직후 탭을 옮겨 새로 고르고, 탭이 바뀌면 선택은 이미 비워진다(compare.tsx:75-78).
- 반론에서 덧붙은 구현 조건: **L1-3** 은 readManifest 와 같은 `!target`(없는 스냅샷) 가드를 둔다.
- 그 밖의 §5a·§5b·§5c·§5d·§5e 는 반론 없음 — Opus 판정대로 확정. 수정 대상 34건.

## §6 1.5단계 수정 결과 (2026-11-02)

Sonnet 수정자 6기(파일이 겹치지 않게: S1 snapshots.ts · S2 제안 서비스·라우트·repos 라우트 · S3 files·uploads·storage · A1 계정·서버·초대 ·
A2 제안·멤버 화면 · A3 파일·비교·이력 화면)가 §5a 34건을 고쳤다 — 고침 34, 실패 0, 2단계 올림 0. 버튼 글자·accessibilityLabel 은 그대로.
- 새 비활성/로딩 상태: 「파일 올리기」(폴더 목록이 최신일 때만), 「제안 올리기」(담는 중), 멤버 행 버튼·「저장소 삭제」·「나가기」(작업 중), 「로그아웃」(loading).
  e2e 가 누르는 것은 「파일 올리기」·「로그아웃」뿐이고 둘 다 활성을 기다리는 클릭이다.
- 동작이 바뀐 서버 응답: `history`·`files/versions` 의 커서를 하나만 주면 400(L1-8) — 앱은 늘 둘 다 보낸다. docs/API.md 반영, MCP 의 `list_history`·
  `list_file_versions` 도 하나만 주면 오류로 알린다(전에는 조용히 첫 페이지).
- 새 시험: `server/test/snapshots-read.test.ts`(휴지통 옛 SQL 과 대조·저장소 간 섞임·정렬·readEntry 를 모든 시점×경로로 readManifest 와 대조),
  `server/test/cursor.test.ts`, proposals(스냅샷이 쌓여도 같은 충돌 판정·가득 찬 저장소의 추가1+삭제1), gc(옛 미참조 blob 재업로드), transfer(`bytes=5-2`).
  로직 수정의 시험은 수정 전 코드에서 실패함을 수정자가 확인했다(L2-1 은 동작 불변이라 양쪽 통과).
- Opus 샘플링: snapshots.ts diff 를 직접 읽음 — readEntry 의 재귀 CTE 가 목표 직후의 첫 변경의 prev_* 를 고르고 체인 끊김 오류 계약도 같다.

검사: `npm run check:sync` 통과, `npm run typecheck`(server·app·desktop·mcp) 통과, `npm test` 278개(서버 217·앱 47·mcp 14) 통과,
`npm run test:e2e` 228개 통과. 남은 것: §5b 2단계 22건, §5c 3단계 1건(U2-1).

## §7 2단계 — 초대 흐름(U1-1~U1-5) 비판 Sonnet 반론 (2026-11-02)
코드만 읽고 대조했다(e2e·빌드는 돌리지 않았다). 설계 1(서버 키)·5(OtherServerInvite)·6(e2e 추가분)은 동의 — 서버 키는 `servers.find(serverUrl===target)`·`saveServer({url:target})`·`serverUrl(activeServer)` 가 같은 문자열을 돌려주고(auth.tsx:413-421), 같은 오리진 웹은 양쪽 모두 `''` 라 어긋나지 않는다. `switchServer` 는 `checkServer` 를 `enter` 보다 먼저 던지므로(auth.tsx:395-398) 실패해도 로딩 전환 없이 JoinScreen 이 살아 있어 「그 서버로 들어가기」 재시도가 된다. 자동 참여(`shouldAutoJoin`)는 SignInFirst 가 같은 (code,server) 로 다시 불러도 `seen` 을 보존하고(pending-invite.ts `same`), 두 e2e 흐름 모두 유지된다. 아래 세 건만 이견.
- **설계 2: `replace('/repos')` + `push` (웹 history)** — 큐(`routingQueue.run`, routingQueue.js:22-40)는 순서대로 dispatch 하지만 세 동작이 한 effect 에서 한 번에 처리돼 `state` 이벤트는 한 번만 나올 수 있다. 웹 URL 동기화(expo-router/build/fork/useLinking.js:315-330)는 이전 상태와 새 상태의 **스택 길이 차**만 본다: `[join]`→`[repos, repo]` 는 delta +1 이라 `history.push` 하나뿐이고 브라우저 기록은 `[/join, /repo/<id>]` 가 된다 — 뒤로 가면 `/repos` 가 아니라 `/join?code=…`(방금 쓴 초대)로 간다. `[repos, join]`→`[repos, repo]` 는 delta 0 이라 `replaceState`, 이때 `replace('/repos')` 는 이미 밑에 있는 목록을 새 route key 로 다시 띄워(목록 재조회) 얻는 것이 없다. 추가한 e2e(7-invite-link.mjs `page.goBack()` → `**/repos`)가 새로 빌드해 실제로 녹색인지가 이 우려의 유일한 판정자이고, 녹색이 아니면 설계가 틀린 것이다. 녹색이어도 시험된 모양은 `[join]` 하나뿐이다. → 주장: 새 빌드로 7-invite-link 를 먼저 확인하고, 안 맞으면 `replace` 와 `push` 사이를 한 틱(`setTimeout(…, 0)`) 띄우거나 `canDismiss()` 로 밑이 비었을 때만 `replace('/repos')` 를 하게 줄인다. 안드로이드 뒤로가기/헤더 뒤로는 `test:android` 로 따로 봐야 한다(e2e 는 브라우저 기록만 본다).
- **설계 3: 「내 저장소로」 를 `!router.canGoBack()` 일 때만** — 가입 경로는 스택이 `[join]` 이 아니다. SignInFirst 가 `router.push('/signup')`(join.tsx:281 `go`)으로 `[join(옛), signup]` 을 만들고, 가입 뒤 `router.replace('/')`(signup.tsx:35)→ index 의 `<Redirect>` 가 `[join(옛), join(새)]` 를 만든다. 새 참여 화면은 `canGoBack() === true` 라 버튼이 안 뜨고, 헤더 뒤로(또는 안드로이드 뒤로)는 **옛 참여 화면**으로 간다 — 로그인된 상태로 다시 포커스돼 `useFocusEffect`(join.tsx:124)가 같은 코드를 또 조회한다. 미리보기를 못 본 경우(옛 서버 401 → 자동 참여 안 됨)나 참여가 안 되는 경우 사용자가 이 복제 화면에 갇힌다. `openJoinedRepo` 의 `dismissAll` 은 참여가 **성공했을 때만** 이 스택을 걷는다. 또 `router.canGoBack()` 은 렌더 때 한 번 읽는 값이라(router.js:96-109, 구독 없음) 스택이 바뀌어도 다시 그려지지 않는다. → 주장: 버튼은 `!canGoBack() || params.code`(링크로 들어온 화면)일 때 보이게 하고, `onPress` 는 `replace` 만이 아니라 `if (router.canDismiss()) router.dismissAll(); router.replace('/repos')` 로 해서 옛 참여 화면도 같이 걷는다. 이 모양(가입 → 자동 참여 아님)을 e2e 에 하나 더한다.
- **설계 4: `usePendingInvitePreview` 의 `unusable` 이 고정** — 훅은 `code` 가 바뀌어도 `preview`·`error`·`unusable` 을 되돌리지 않는다(InviteSummary.tsx:46-69, effect 가 `setX` 로 덮기만 하고 처음에 비우지 않는다). 못 쓰는 초대로 SignInFirst 가 떠 있는 동안 다른 링크가 같은 `/join` 에 들어오면(앱이 켜진 채 새 `listup://join?...` 탭 — 같은 route 라 화면이 재사용된다) `unusable` 이 `true` 로 남아 새 코드도 `if (code && !unusable) setPendingInvite(…)`(join.tsx:275, 280)에서 건너뛰어지고 「이 초대는 쓸 수 없습니다」가 계속 뜬다. 이전에는 없던 막다른 길이다(그 전에는 오류 문구만 낡았다). → 주장: effect 맨 앞에서 `setPreview(null); setError(null); setUnusable(false)`(와 `!code` 일 때도)를 하거나, `unusable` 을 `error` 가 난 코드와 함께(`unusableCode === code`) 저장해 현재 코드와 비교한다.

### §7 Opus 판정과 결과 (2026-11-02)

- **설계 2** — 반론 채택(이미 반영). e2e 가 같은 것을 잡았다: 가입 경로에서 브라우저 뒤로가기가 `/signup` 밑에 남은 옛 `/join` 으로 갔다.
  `openJoinedRepo` 에서 dismissAll 을 빼고, 뒤로 갈 곳이 있으면 `replace('/repo/<id>')` 만, 스택 첫 화면이면 `replace('/repos')` 뒤 다음 차례에 `push`.
- **설계 3** — 반론 채택(이미 반영). SignInFirst 의 「가입하기」를 로그인처럼 `replace('/signup')` 으로 — 참여 화면이 밑에 남지 않아 가입 경로도 `[join]` 하나가 된다.
  `canGoBack()` 를 렌더 때 읽는 것은 그대로 둔다(이 화면은 busy·error 로 자주 다시 그려지고, 스택이 바뀌는 것은 화면이 바뀔 때다).
- **설계 4** — 반론 채택. `usePendingInvitePreview` 가 `code` 가 바뀌면 preview·error·unusable 을 먼저 지운다.

바꾼 파일: `app/app/join.tsx`, `app/app/index.tsx`, `app/src/lib/invite-link.ts`, `app/src/components/InviteSummary.tsx`, 새 `app/src/lib/pure/pending-invite.ts`(+ `app/test/pending-invite.test.ts` 6건, 수정 전에는 모듈이 없어 실패),
`e2e/specs/7-invite-link.mjs`(참여 뒤 뒤로가기 → `/repos`, 회수된 초대 링크 → 로그인 전에 "쓸 수 없습니다"·로그인 화면에 "이어 갑니다" 없음).
새 버튼: 「내 저장소로」(참여 화면이 스택 첫 화면일 때), 「그 서버로 들어가기」·「처음 화면으로」(다른 서버의 초대). 기존 버튼 글자는 그대로.
- **재검토 (고친 뒤의 작업 트리, 같은 날)** — 위 세 건은 모두 해소됐다. (설계 2) `dismissAll` 을 없애고 `canGoBack()` 이면 `replace` 하나, 아니면 `replace('/repos')` + 다음 차례 `push` 로 바꿨다 — 큐가 FIFO 이고 `replace` 의 상태 갱신이 `useSyncExternalStore` 로 동기 렌더·effect 까지 끝난 뒤에 타이머가 돌므로(routingQueue.js:22-40) 순서가 지켜지고, 웹은 `[join]`→`[repos]`(delta 0, replaceState)→`[repos, repo]`(delta +1, pushState)로 갈라져 기록이 맞다. (설계 3) 가입도 `replace` 가 돼 `[join, join]` 복제가 생기지 않는다(login.tsx:143 의 「가입」 `Link` 와 비밀번호 재설정은 로그인 화면 위에 얹히지만 `Stack.Protected` 가 로그인되면 걷는다). 「내 저장소로」 의 `canGoBack()` 은 이제 스택이 `[join]` 하나인 경우만 가르면 되므로 렌더 시점 읽기로 충분하다. (설계 4) 훅이 코드가 바뀔 때 `preview`·`error`·`unusable` 을 비운다(InviteSummary.tsx:50-55). 남은 이견 없음. 참고로만: `setTimeout(…, 0)` 은 "그 전에 replace 가 처리됐다" 는 가정에 기댄다 — e2e(7-invite-link, 14-onboarding)가 웹에서 확인했고 안드로이드는 `test:android` 로 한 번 보면 된다.


---

# 3단계 — 전송 신뢰성 (2026-11-02)

대상: U2-1(구조)·U2-2·U2-7·U2-9·U3-2·U2-4·U2-5·U2-10·L2-7. 기준점: v1.9.0(`77005aa`, test 284·e2e 232).
절차: **Fable 계획** → 비판 Sonnet 반론 → Fable 확정(사용자 결정 포함) → **Opus 수정**(단계별 커밋) → Fable 최종 검수. Fable 은 반복 루프에 넣지 않는다.

## §8 Fable 계획

**요약.** 전송(올리기·받기)의 진행률·AbortController 를 화면 밖 모듈 스토어(`toast.ts` 패턴)로 옮기고 루트의 `TransferHost` 하나가 그린다.
그 위에 끊김에도 세션을 기억해 이어 올리기, "마무리하는 중" 단계, 올리기 전 충돌·한도 검사, 안드로이드 파일 진짜 이어받기(zip·iOS 는 정직한 문구),
PC 앱 will-download 진행률, 서버 조각별 해시 이어 계산 + complete 멱등을 얹는다.

**설계 요점**
- 스토어 `app/src/lib/transfer-store.ts`: `runTransfer({kind, repoId, label, cancelMessage, owner?, task(report, signal)})` → `{id, promise, abort}`, `cancelTransfer`, `abortAllTransfers`, `useTransfers(repoId)` → `{jobs, active, finishedSeq}`.
  job 은 `progress.phase: 'sending'|'finishing'|'committing'`. 같은 저장소에 upload job 이 있으면 `runTransfer` 가 던진다(중복 방지). `finishedSeq[repoId]` 로 화면이 목록을 다시 읽는다.
  `owner:'screen'`(new-proposal)은 화면이 사라질 때 확인 없이 abort(beforeRemove 가 이미 물음). `client.ts setApiTarget` 에 `onApiTargetChange` — 서버가 바뀌거나 토큰이 null 이면 `abortAllTransfers`.
- `app/src/components/TransferHost.tsx` 를 `_layout.tsx` 의 `<ToastHost />` 위에(아래쪽 오버레이). `TransferProgress.tsx` 는 `useTransferControl` 제거, `{job}` props, **aria-label 은 `${label} ${percent}%` 고정**(e2e `/^올리는 중/`).
  멈추기는 `canCancel(progress)` 일 때만; finishing 은 `서버에서 마무리하는 중`, committing 은 `반영하는 중`/`제안 만드는 중`.
- pure `app/src/lib/pure/transfer-report.ts`: `canCancel`, `phaseLabel`, `describeUploadOutcome`(e2e 문구 `멈췄습니다 — N/3개 올림` 그대로), `describeCommitFailure`.
- 화면: index(progress·transfer state 삭제, `useTransfers`, finishedSeq 로 refresh), compare(두 control 삭제, 열람자 `router.push` 는 `navigation.isFocused()` 일 때만), new-proposal(`owner:'screen'`).
- 이어 올리기: 재시도 창을 시간으로(5분, 대기 1·2·4·8·15·15…초), 넘으면 `TransferOffline`. `finally` 의 `cancelUpload` 는 **사용자 멈춤·4xx 만**(10-polish:92 가 멈춤 때 DELETE 기대).
  pure `upload-sessions.ts`(`sessionKey(baseUrl, repoId, source)` = name|size|lastModified, desktop 은 root/relativePath|size; remember/forget/prune 20h·200개) + 저장 `app/src/lib/upload-sessions.ts`(AsyncStorage).
  시작할 때 기억된 id 로 `getUpload` → 이어 감, 404 면 새로. `uploadMany` 는 offline 이면 나머지를 "연결이 끊겨 보내지 못했습니다" 로 넣고 멈춤. complete 가 0/타임아웃이면 창 안에서 다시 complete.
- 서버(L2-7): `BlobStore.hashers` Map — 연속 조각이면 이어 갱신, 조각 실패면 삭제, complete 는 bytes===size 면 digest 아니면 전체 재해시(폴백). `uploads.ts` 에 complete 결과 10분 캐시(같은 사용자면 같은 `{blob}` 201).
  `GET /health` 에 `maxRepoBytes`. **API_LEVEL 6**(REQUIRED 는 2 그대로).
- 사전 검사: pure `upload-check.ts` `checkUploadPlan({items, existing(전체 recursive 목록|null), fileCount, totalSize, maxFiles, maxRepoBytes|null})` → `{conflicts, tooMany, tooBig}`(서버 findPathConflict·manifestBytes 와 같은 규칙).
  `pickFolder` 는 `{sources, truncated}`. 충돌·한도면 올리지 않고 토스트. 커밋 실패 문구 "올린 N개는 반영되지 않았습니다".
- 안드로이드 받기: `downloadToCache` 공통 함수, 시도마다 링크 새로 발급, 재개는 `createDownloadResumable(url, uri, {headers: If-Range "<hash>"}, cb, String(partialBytes))` 새 작업 + **206 일 때만 받아들임**(네이티브는 append 하고 상태 코드를 안 본다 — FileSystemLegacyModule.kt:681-682·718·946).
  pure `download-resume.ts` `planAttempt` — archive·iOS·partial 0 → restart, 재개 뒤 200 → restart, attempt≥4 → give-up. 받기 3화면(index·versions·trash)을 `runTransfer` 로. 틀린 주석(files.ts:170, local-folder.ts:159) 수정.
- PC 앱: `DesktopBridge.downloads?`(선택 필드) — shared·protocol·preload·main 4곳, 새 `desktop/src/downloads.ts` 가 `will-download` 에서 `showSaveDialog` 를 직접 부르고 updated/done 을 방송. TransferHost 가 그 목록도 그린다.

**단계(커밋)**
1. `feat(server)`: 조각별 해시·complete 멱등·health maxRepoBytes — API_LEVEL 6. 시험: transfer.test(조각 3개 해시, 409 재전송 뒤 해시, complete 두 번, health), 새 storage.test(실패 스트림 뒤 폴백, 새 인스턴스로 complete — `rehashed` 플래그로 단언).
2. `feat(app)`: 전송 스토어·TransferHost·마무리 단계(U2-1·U2-7·U3-2). 시험: transfer-report.test, e2e 10-polish ③(올리는 중 탭 이동 → 진행 유지 → 돌아오면 버튼 disabled → POST /uploads 중복 없음 → 끝나면 목록 저절로 갱신). test:desktop(웹 재빌드 후).
3. `fix(app)`: 끊겨도 세션 기억해 이어 올리기(U2-2). 시험: upload-sessions.test, e2e 6-transfer(새로고침 뒤 같은 파일 → 첫 PUT offset>0·POST 0번, 끊김 중 DELETE 없음).
4. `feat(app)`: 올리기 전 충돌·수·용량 검사(U2-4·U2-5). 시험: upload-check.test, e2e 6-transfer(파일↔폴더 충돌 → 토스트·PUT 0번).
5. `fix(app)`: 안드로이드 받기 진행률·멈추기·파일 이어받기, zip·iOS 는 처음부터(U2-9·U2-10). 시험: download-resume.test, 안드로이드 수동 점검.
6. `feat(desktop)`: will-download 진행률·멈추기·폴더 열기. 시험: e2e/desktop.mjs(showSaveDialog 바꿔치기).
마무리: v1.10.0(노트·version:set), README·ARCHITECTURE·API.md, TODO 완료, REFACTOR.md 결과.

**사용자 결정(Fable 이 올림)**: ① API_LEVEL 6 상향(권장) vs 필드만 ② TransferHost 루트 오버레이(권장) vs 화면 안 카드 ③ 재시도 창 5분·기억 20시간·저장소당 동시 업로드 1개 ④ new-proposal 을 나가면 확인 뒤 abort(담은 blob 은 GC 몫).
**범위 밖**: 여러 파일 동시 업로드, 앱이 죽은 뒤 자동 재개, zip Range, 클라이언트 해시로 전송 건너뛰기, new-proposal 사전 검사, L2-8·L2-9, 받기 결과 패널(U2-6).
**검수 기준**: 화면 3곳에 전송 state·AbortController 없음, U2-1 재현 e2e, status 0 에 cancelUpload 없음, 마무리 중 멈추기 없음·aria 고정, new-proposal 언마운트 abort, checkUploadPlan 이 서버 판정과 같은 사례에 같은 답·충돌 시 PUT 0번, `resumeAsync()` 호출 없음·206 검사, DesktopBridge 4곳 일치, storage 시험이 이어 계산·폴백 둘 다, check:sync·문서 일치, 회귀(test·e2e·desktop).

## §8a 비판 Sonnet 반론 (2026-11-02)
- **sessionKey = name|size|lastModified (U2-2)** — 서버는 offset 만 본다(uploads.ts:121 `offset !== row.received`, 내용 검증 없음). 그런데 desktop 소스에는 mtime 이 아예 없다(`folders.ts:57` 가 `{relativePath,size}` 만, `UploadSource` desktop 변형 client.ts:275, transfer-plan.ts:36 도 undefined 취급) → 계획의 `root/relativePath|size` 는 "같은 크기로 고친 파일"을 옛 세션에 이어 붙여 **조용히 틀린 blob** 을 만든다(completeSession 은 이어 붙은 그대로 해시, 클라이언트가 못 알아챔). 웹 키도 폴더 올리기에서 `a/x.txt`·`b/x.txt`(크기·mtime 같은 복사본)가 충돌한다(name 은 basename, files.ts:100-106 relativePath 따로). → 주장: 키에 relativePath 포함, desktop 목록(`folders.list`)에 mtimeMs 추가(DesktopBridge 4곳 규칙 대상), lastModified 가 없거나 0 이면 이어 올리기 안 함(새로). 기억 항목에 `size`·첫 조각 sha256 을 같이 적어 이어 가기 전에 대조하면 더 안전.
- **기억한 세션이 404 일 때만 새로 (U2-2)** — 세션 파일만 사라진 경우(GC/크래시 사이) `appendChunk` 의 `fsp.truncate`(storage.ts:127)가 ENOENT → 500 이고 DB `received` 는 그대로라, 기억된 id 는 20시간 동안 매번 같은 500 으로 실패한다. → 주장: 이어 가기로 얻은 세션에서 첫 조각이 4xx/5xx(409 received 응답 제외)로 실패하면 forget 하고 새 세션으로 한 번 더. `upload.size !== source.size` 도 새로.
- **서버 조각별 해시 (L2-7)** — 계획대로 "조각 실패면 hasher 삭제" 하면 끊김 재시도(status 0 → 같은 offset 재전송, appendChunk 가 truncate 후 다시 씀, storage.ts:137-141)가 일어난 파일은 **전부 전체 재해시로 폴백**한다 = L2-7 이 문제 삼은 바로 그 불안정한 회선의 큰 파일. 또 서버 재시작·`removeSession`/GC 청소(gc.ts:97-99)에서 Map 항목이 안 지워지면 누수. → 주장: 조각마다 `hasher.copy()` 로 시험 해시를 만들어 성공 때만 교체(실패하면 이전 상태 유지, `hashedBytes===offset` 일 때만 이어 감), removeSession·GC·complete 끝에서 항목 삭제. 더 줄이려면 이 증분 해시는 **빼고** 10분 complete 캐시만으로 U2-3/L2-7 의 실제 증상(타임아웃 뒤 재시도 404)을 막는 안도 있다 — 2GB SHA-256 은 SSD 에서 수 초라 복잡도 대비 이득이 작다. 사용자 결정 거리.
- **complete 10분 캐시 (L2-7)** — 캐시 조회가 `requireSession`(uploads.ts:69-78, 행이 지워진 뒤엔 404) 앞에서 일어나야 하므로 키는 (uploadId, userId) 로 하고, 조회 때 `requireAccess(row.repo_id, user.id)` 를 다시 해야 한다(10분 안에 멤버 제거·저장소 삭제 가능). 성공(`record()` 통과)한 뒤에만 넣을 것(quotaError 경로 uploads.ts:166-168 는 안 넣음). blob GC 는 `created_at` 유예(gc.ts:52, 상단 주석)라 10분 캐시와 충돌 없음 — 확인함. 더 큰 구멍: 재시도가 진행 중 complete 와 겹치면 `busy` → **409**(uploads.ts:153)인데 계획은 "0/타임아웃이면 다시 complete" 뿐 → 주장: 409(`received===size` 인데 busy)도 창 안에서 재시도로 취급.
- **TransferHost·루트 오버레이 / 화면 밖에서 끝나는 작업 (U2-1)** — e2e 쪽은 대체로 안전하다: 탭은 위쪽(RepoNav.tsx:42-48), progressbar 이름 `/^올리는 중/`·`detached` 대기(10-polish:79,90,100, 6-transfer:77,81, 11-restore:157)는 job 이 끝나면 사라지면 통과, 토스트 클릭(10-polish:107)은 그때 job 이 없다. 단 `getByRole('progressbar')` 는 strict 모드라 TransferHost 가 한 저장소의 job 을 둘 이상(올리기+받기) 동시에 그리면 위 줄들이 깨진다 → 주장: 호스트는 **현재 화면의 저장소 job 만**, 올리기·받기 동시에 progressbar 둘이 안 되게(받기는 role 대신 텍스트, 또는 한 카드로 합침) 하고 ToastHost 와 같은 fixed 영역에서 겹치지 않게 쌓는다(Toast.tsx:36-44 `box-none`·zIndex 1000). 진짜 위험은 따로 있다: 화면이 사라진 뒤 끝나는 작업이 `router.push`·`refresh()`·`setState`(compare.tsx:226-242)를 부른다. `navigation.isFocused()` 는 언마운트된 화면 객체라 믿을 수 없다 → 주장: 화면은 마운트 ref 로 막고, 화면이 없으면 push 대신 "제안을 만들었습니다" 토스트만(후속 이동 없음). 같은 저장소 중복 `runTransfer` 가 던질 때(compare·new-proposal·index 어디서든) 호출부마다 토스트로 받는 공통 처리도 계획에 없다.
- **단계 2 크기 (순서)** — 스토어+호스트+화면 3곳+new-proposal+`onApiTargetChange`+마무리 단계가 한 커밋이다. 중간에 깨지지는 않지만 e2e 실패 원인을 가르기 어렵다. → 주장: 2a(스토어·호스트·index·new-proposal, U2-1 e2e), 2b(compare·마무리 단계 U2-7)로 나눠 각각 녹색으로. 단계 3(`finally` 조건 변경)은 2 뒤, 단계 4 는 health `maxRepoBytes` 없으면 null 처리라 1 과 독립, 단계 6 은 2 의 호스트에 의존 — 나머지 순서는 그대로 괜찮다. (API_LEVEL 6: CLAUDE.md 표의 "호환 안 깨는 기능 추가"에 해당, e2e 3-version 은 mock health 라 영향 없음 — 이의 없음.)
- **안드로이드 If-Range 의 해시 출처 (U2-10)** — 계획의 `If-Range "<hash>"` 는 처음 시도가 **실패**하면 응답 헤더가 없어 얻을 수 없다(`DownloadLink` 는 `{url, expiresAt}` 뿐, shared/index.ts:570; 헤더는 성공 결과의 `result.headers`, Kt:954-955 에만). 헤더 없이 Range 만 보내면 그사이 바뀐 파일의 뒷부분을 붙인다(서버는 If-Range 없으면 그냥 206, files.ts:562-565). → 주장: 해시는 호출 화면이 이미 아는 값(목록의 blobHash, versions·trash 의 해시)을 `target` 에 실어 넘기고, 모르면(archive 포함) 이어받기 안 함. 네이티브 쪽 주장은 확인함: Range 는 resumeData 있을 때만(Kt:681-683), headers 는 그 뒤 추가(684-689), append(`FileOutputStream(file,isResume)` 946), status 는 결과에만 있고 본문은 상태와 무관하게 써진다(943-957) → 206 검사·200/4xx 시 파일 삭제 후 처음부터가 필수라는 계획이 맞다.
- **안드로이드 멈추기 (U2-9, 단계 5)** — 받기를 멈추는 길은 `pauseAsync` 뿐이고 이는 `call.cancel()` 해서 `downloadAsync` 가 **undefined 로 resolve**(Kt:714, 962-964)한다. 지금 코드는 `!result` 를 "파일을 받지 못했습니다"로 처리(files.ts:175) → 멈춤이 실패로 보인다. 이미 끝난 작업에 pauseAsync 하면 "No download object available" 로 던진다(Kt:707-708). → 주장: `planAttempt` 에 cancelled 결과를 넣고(undefined && signal.aborted), pauseAsync 는 try/catch, 멈춘 뒤 부분 파일 삭제.
- **PC 앱 will-download 에서 showSaveDialog 직접 호출 (단계 6)** — Electron 은 `setSavePath` 를 핸들러 안에서 **동기로** 부르지 않으면 자기 저장 대화상자를 연다(electron.d.ts:8295-8300, `preventDefault` 는 다운로드 취소 13057-13063). 핸들러에서 비동기 `showSaveDialog` 를 await 하면 대화상자가 둘 뜬다. → 주장: `item.setSaveDialogOptions({defaultPath,…})` 로 기본 대화상자를 쓰고 updated/done 만 방송. e2e 는 환경변수 시험 훅에서 `setSavePath` 를 동기 호출하는 쪽이 바꿔치기보다 쉽다.
- **범위 (U2-10·U2-9 안드로이드, 단계 5·6)** — 단계 5 는 CI 에서 안 돌고 자동 시험이 pure 판정(download-resume.test)뿐이며 단계 6 은 `desktop` 4곳 규칙+실제 Electron 이 필요하다. 1~4 는 데이터 손상·상태 유실(high) 해결이고 5~6 은 med 편의 기능이다. → 주장: v1.10.0 을 1~4(+마무리)로 내고 5·6 은 별도 릴리즈로 미루는 쪽을 권한다(미루지 않으면 `test:android` 를 단계 5 검수 기준에 넣을 것). 사용자 결정 거리.

## §8b Fable 확정 (2026-11-02)

사용자 결정: v1.10.0 은 단계 1~4(+마무리), 5·6(안드로이드 받기 진행률·이어받기, PC will-download)은 다음 릴리즈. 증분 해시 + complete 캐시 유지. TransferHost 루트 오버레이. API_LEVEL 6. 기본값: 재시도 창 5분, 세션 기억 20h, 저장소당 동시 업로드 1개, new-proposal 나가면 확인 뒤 abort.

### §8a 반론 판정
1. **sessionKey** — 채택. 키에 `relativePath ?? name` 포함, `lastModified` 가 없거나 0 이면 기억·이어 가기 안 함(desktop 소스는 `LocalFileEntry`·`UploadSource` 에 `mtimeMs`/`lastModified` 를 더해야 이어 간다 — 아래 규칙). 첫 조각 sha256 대조는 기각: 서버 `getUpload` 의 `name`·`size` 대조 + mtime 으로 충분하고(splitUnchanged 와 같은 수준의 휴리스틱), 네이티브에서 조각을 한 번 더 읽는 비용이 붙는다.
2. **404 일 때만 새로** — 채택. 이어 간 세션의 첫 요청이 409(received 동봉) 이외의 4xx/5xx 면 forget 하고 새 세션으로 한 번 더. `upload.size !== source.size || upload.name !== source.name` 도 새로.
3. **hasher.copy()** — 채택(사용자가 내게 맡긴 결정). 조각마다 `copy()` 로 시험 해시, pipeline 성공 때만 교체 → 끊김 재전송 뒤에도 이어 계산이 살아 폴백이 드물다. `removeSession`(GC 가 이 경로를 씀 gc.ts:99)·`completeSession` 끝에서 Map 삭제. "증분 해시를 빼자" 는 기각(사용자 결정).
4. **complete 캐시 키·접근 검사·409** — 채택 전부. 키 `uploadId`, 값에 `userId`·`repoId`, 조회 때 `user.id` 일치 + `requireAccess(repoId, user.id, 'viewer')`. `record()` 성공 뒤에만 넣는다. 클라이언트는 complete 의 409 도 재시도 대상: `details.received < size` 면 조각 루프로 복귀(offset=received), 아니면(busy) 창 안에서 다시 complete.
5. **오버레이 progressbar 하나·마운트 ref** — 채택. 호스트는 **카드 하나**(가장 최근 running job)만 그리고 나머지는 `외 N개 진행 중` 캡션 → `getByRole('progressbar')` 가 늘 1개. `navigation.isFocused()` 대신 `mountedRef`. 중복 `runTransfer` 는 스토어가 토스트를 띄우고 `TransferBusy` 를 던지며, 호출부는 `instanceof TransferBusy` 면 조용히 return(공통 처리는 스토어 안에 둔다). "현재 화면의 저장소 job 만" 은 기각 — 오버레이의 목적(저장소 밖에서도 보임)과 어긋난다.
6. **단계 2 를 2a/2b** — 채택.
7. **If-Range 해시 출처** — 일부 채택(이미 §8 계획이 호출 화면의 `blobHash` 를 넘기게 했다). 추가: 해시를 모르면(archive·SearchResults 등) 이어받기 안 함. 단계 5 로 미룸.
8. **안드로이드 멈추기(pauseAsync 가 undefined resolve)** — 채택. 단계 5 로 미룸: `planAttempt` 에 cancelled, pauseAsync try/catch, 부분 파일 삭제.
9. **will-download 는 setSaveDialogOptions** — 채택. 단계 6 으로 미룸: `setSaveDialogOptions` + 환경변수 시험 훅으로 `setSavePath` 동기 호출.
10. **범위(5·6 미루기)** — 채택(사용자 결정).

### 확정 규칙

**sessionKey** (`app/src/lib/pure/upload-sessions.ts`)
```
key = `${baseUrl}\n${repoId}\n${relativePath ?? name}\n${size}\n${lastModified}`   (경로는 NFC)
lastModified 가 undefined 또는 0 → 키 없음(null) → 기억하지 않고 이어 가지도 않는다.
desktop 소스: UploadSource desktop 변형에 `lastModified?: number` 추가, LocalFileEntry 에 `mtimeMs?: number` 추가(shared), desktop/src/folders.ts:57 이 `stat.mtimeMs` 를 같이 돌려주고 local-folder.ts:81 이 옮겨 담는다. 1.9 PC 앱(mtime 없음)에서는 자연히 이어 가지 않는다. preload·protocol 은 바뀌지 않는다(엔트리 모양만).
항목 = { uploadId, at }. prune: at < now − 20h 또는 200개 초과(오래된 것부터). forget: complete 성공, 4xx(409 received 제외), 사용자 멈춤, 이어 간 세션의 첫 요청 실패.
```
**이어 가기 절차** (`transfer.ts uploadInChunks`)
```
id = remembered(key) → getUpload(id):
  200 이고 name·size 일치 → 그 세션, offset = received, resumed = true
  그 밖(404·불일치·오류) → forget, startUpload 새로
resumed 이고 첫 PUT/complete 가 409(received) 외 4xx/5xx → forget → startUpload 새로(한 번), resumed=false
status 0 → 5분 창(1·2·4·8·15·15…초, abort 가능) 안에서 getUpload 로 received 를 물어 계속; 창을 넘기면 TransferOffline(세션·기억 유지)
complete: status 0/타임아웃 → 창 안에서 다시 complete; 409 details.received<size → 조각 루프로; 409 busy → 창 안에서 다시 complete
finally 의 cancelUpload: signal.aborted 이거나 4xx 실패일 때만(TransferOffline·status 0·5xx 는 남긴다)
```
**complete 캐시** (`server/src/routes/uploads.ts`)
```
recentlyCompleted: Map<uploadId, { userId, repoId, blob, at }>, TTL 10분(조회·삽입 때 만료분 정리)
POST /uploads/:id/complete 맨 앞: hit && hit.userId === user.id → requireAccess(db, hit.repoId, user.id, 'viewer') → 201 {blob}
삽입은 record() 가 던지지 않고 돌아온 뒤에만(quotaError 경로 제외)
```
**hasher** (`server/src/lib/storage.ts`)
```
hashers: Map<id, { hasher: Hash; bytes: number }>; createSession 이 {createHash('sha256'), 0} 등록
appendChunk: entry && entry.bytes === offset 이면 trial = entry.hasher.copy(), counter 가 trial.update; pipeline 성공 → entry = { hasher: trial, bytes: offset+received }; 실패 → entry 그대로(이전 상태 유지). entry 없거나 bytes≠offset 이면 추적 안 함(hashers.delete)
completeSession: entry && entry.bytes === size → digest, rehashed=false; 아니면 전체 재해시, rehashed=true. 끝에 hashers.delete. removeSession 도 delete. 반환 { hash, size, rehashed }
```
**오버레이·언마운트** (`TransferHost.tsx`, 화면)
```
호스트: jobs 중 가장 최근 running 1개만 TransferProgress 로(progressbar 1개), 나머지 수는 캡션. job 이 없으면 아무것도 안 그림(detached). ToastHost 바로 위, 같은 fixed/absolute 영역, pointerEvents box-none.
화면: mountedRef(useEffect cleanup 에서 false). await promise 뒤 router.push/replace·setState·state.refresh 는 mountedRef.current 일 때만. 토스트는 항상(토스트 스토어는 화면 밖).
목록 갱신: index 는 useTransfers(repoId).finishedSeq 변화 → state.refresh()(첫 렌더 건너뜀). 열람자 compare 가 언마운트된 채 끝나면 "제안 #N 을 만들었습니다" 토스트만.
중복: runTransfer 가 같은 repoId 에 upload job 이 있으면 notify('이미 올리는 중입니다.') 뒤 TransferBusy throw; 호출부는 instanceof TransferBusy 면 return.
```

### 최종 단계 (v1.10.0)

**1. `feat(server)`: 조각별 해시 이어 계산·complete 10분 캐시·health maxRepoBytes — API_LEVEL 6**
- 파일: `server/src/lib/storage.ts`, `server/src/routes/uploads.ts`, `server/src/app.ts:203-214`, `shared/index.ts`(HealthResponse `maxRepoBytes?`, API_LEVEL 6 + 수준 목록 주석), `docs/API.md`(서버 상태 표·나눠 올리기 절·apiLevel), `docs/ARCHITECTURE.md:68-70`.
- 서버 테스트 `server/test/transfer.test.ts`: ① 조각 3개 hash === sha256 ② 틀린 offset 409 뒤 재전송해도 hash 일치 ③ complete 두 번 → 같은 blob 201, 다른 사용자는 404, 멤버에서 빠지면 403/404 ④ health.maxRepoBytes === 하니스 값. 새 `server/test/storage.test.ts`(BlobStore 직접): 중간에 터지는 스트림 → 같은 offset 재전송 → complete `rehashed:false` 해시 일치(copy 경로), 새 인스턴스로 complete → `rehashed:true` 해시 일치(폴백), removeSession 뒤 Map 비어 있음.
- 완료 기준: `npm test`(server)·`check:sync`·앱 변경 없이 6-transfer 통과.

**2a. `feat(app)`: 전송 스토어·TransferHost — index·new-proposal (U2-1·U3-2)**
- 파일: 새 `app/src/lib/transfer-store.ts`, 새 `app/src/lib/pure/transfer-report.ts`(`describeUploadOutcome`·`canCancel`·`phaseLabel` — 2a 에서는 sending 만 쓰더라도 함수는 여기서 완성), 새 `app/src/components/TransferHost.tsx`, `app/src/components/TransferProgress.tsx`(`useTransferControl` 제거, `{job}`, aria-label `${label} ${percent}%` 고정), `app/app/_layout.tsx:100-104`, `app/src/api/client.ts`(`onApiTargetChange`), `app/app/repo/[repoId]/index.tsx`, `new-proposal.tsx`, `docs/ARCHITECTURE.md` 구조 블록.
- compare.tsx 는 이 커밋에서 `useTransferControl` 이 없어지므로 **최소 수정**(스토어로 옮기되 라벨·흐름은 그대로) — 2b 가 마무리 단계·mountedRef 를 얹는다. 대안으로 2a 에서 훅을 남겨 두면 TransferHost 와 화면 카드가 함께 그려져 progressbar 가 둘이 되니 그렇게 하지 않는다.
- pure 테스트 `app/test/transfer-report.test.ts`: `멈췄습니다 — 0/3개 올림`/`1/3개 올림` 본문 두 갈래, failures 3+`외 N건 더`, `3개 올렸습니다 — 추가 2 · 수정 1`, `바뀐 파일이 없습니다.`, 1개 성공은 null, `canCancel`(sending 참·마지막 finishing 거짓·중간 finishing 참·committing 거짓).
- e2e `10-polish.mjs` ③: 조각 1.5초 지연 → 올리기 시작 → 「변경 이력」 탭 → progressbar 유지 → 「파일」 탭 → 「파일 올리기」 disabled → `POST /api/repos/:id/uploads` 3번뿐 → 끝나면 클릭 없이 `c.txt 내려받기` 등장. ④ new-proposal: 「파일 담기」로 조각 지연 중 뒤로 → 「버리기」 → 이후 PUT 요청 없음.
- 완료 기준: typecheck·`npm test`·`test:e2e` 전부·`test:desktop`(웹 재빌드 뒤).

**2b. `feat(app)`: compare 를 스토어로·마무리 단계·언마운트 가드 (U2-1 compare·U2-7)**
- 파일: `compare.tsx`(mountedRef, 열람자 push 가드, 받기 루프도 runTransfer), `transfer.ts`(UploadProgress `phase`, finishing/committing report 3곳), `transfer-report.ts`(`describeCommitFailure` 자리만), `TransferHost.tsx`(phase 라벨·멈추기 숨김).
- e2e `9-compare.mjs`: 열람자 흐름 그대로(waitForURL) + 편집자 올리기 뒤 토스트 `2개를 올렸습니다.`. `10-polish` 는 그대로 통과해야 함(마무리 단계는 조각 지연 중이라 sending).
- 완료 기준: typecheck·`npm test`·`test:e2e`·`test:desktop`.

**3. `fix(app)`: 끊겨도 세션을 지우지 않고 기억해 이어 올리기 (U2-2)**
- 파일: `transfer.ts`(위 절차), 새 `app/src/lib/pure/upload-sessions.ts`, 새 `app/src/lib/upload-sessions.ts`(AsyncStorage `listup.uploadSessions`), `transfer-report.ts`(offline 문구 `연결이 끊겼습니다 — N/M개 올림` + `연결되면 같은 파일을 다시 올리세요. 받은 데서 이어 갑니다.`), `app/src/api/client.ts:275`(desktop `lastModified?`), `shared/index.ts:663-666`(`mtimeMs?`), `desktop/src/folders.ts:57`, `app/src/lib/local-folder.ts:81`, `docs/API.md:219-237`, `docs/ARCHITECTURE.md:71-72`, README 전송 문구, 구조 블록.
- pure 테스트 `app/test/upload-sessions.test.ts`: 키에 relativePath·size·mtime 모두 반영(하나라도 다르면 다른 키, `a/x.txt`≠`b/x.txt`), mtime 없음·0 → null, prune 20h·200개, remember/forget, NFC.
- e2e `6-transfer.mjs`: ① 12MB, PUT 1.5초 지연, PUT 2개 뒤 `page.reload()`(dialog accept 있음) → 같은 파일 다시 → 첫 PUT 이 `offset=0` 아님·POST /uploads 0번·해시 일치 ② PUT 을 계속 abort 하는 5초 동안 DELETE /api/uploads 없음 → 풀면 완료 ③ 기억된 세션의 첫 PUT 을 500 으로 바꿔치기 → DELETE 뒤 새 POST /uploads 가 나가고 완료.
- 완료 기준: 위 e2e + 기존 6-transfer:87-105·10-polish:92 통과, `test:desktop`(folders.ts 변경).

**4. `feat(app)`: 올리기 전에 이름 충돌·파일 수·용량 검사 (U2-4·U2-5)**
- 파일: 새 `app/src/lib/pure/upload-check.ts`, `files.ts`(pickFolder → `{sources, truncated}`), `client.ts`(`getServerLimits` → `{maxUploadBytes, maxRepoBytes|null}`, setApiTarget 에서 캐시 비움), `index.tsx`(withinLimit 뒤 preflight: recursive 전체 목록 실패/`!tree.recursive` 면 existing null), `compare.tsx`(repoFiles+repo 로), `transfer-report.ts`(`describeCommitFailure` — `반영하지 못했습니다 — 올린 N개는 반영되지 않았습니다.` + 서버 메시지 + conflicts 3개), README, 구조 블록.
- pure 테스트 `app/test/upload-check.test.ts`: 파일 `a` vs `a/b.txt`, 폴더 `a/` vs 파일 `a`, 새 항목끼리 `x`·`x/y`, 덮어쓰기는 충돌 아님, 수 한도(4999+2), 용량(덮어쓰는 크기 차감), `maxRepoBytes:null` → tooBig 없음, `existing:null` → conflicts 빈 배열, NFD→NFC.
- e2e `6-transfer.mjs`: 파일 `충돌` 생성 뒤 폴더 `충돌/안.txt` 올리기 → `이름이 겹쳐 올릴 수 없습니다` 토스트·PUT 0번·이력 수 그대로.
- 완료 기준: `npm test`·`test:e2e`.

**마무리** `chore: v1.10.0`: `npm run version:set -- 1.10.0`, `docs/releases/v1.10.0.md`, README 「무엇을 할 수 있나」, TODO.md(항목 3 → 완료 절, 5·6 은 남은 일로 "안드로이드 받기 진행률·이어받기 / PC will-download" 신설), REFACTOR.md §9 결과.

### 최종 검수 체크리스트
1. 화면 3곳에 `useState<UploadProgress>`·`useTransferControl`·`AbortController` 없음; `TransferProgress.tsx` 에 훅 없음; 전송 상태는 `transfer-store.ts` 에만.
2. 10-polish ③④, 6-transfer ①②③·충돌, 9-compare 가 녹색이고 기존 228 단언이 모두 그대로(이름 바꾼 것 없음: `파일 올리기`·`폴더 올리기`·`멈추기`·`내려받기`·`progressbar /^올리는 중/`·`멈췄습니다 — N/3개 올림`·`'사진' 은(는) 모두 이미 올라가 있습니다.`·확인창 `이미 올라가 있는 2개는 건너뜁니다`).
3. `transfer.ts` finally: status 0·5xx·TransferOffline 에 `cancelUpload` 없음, 멈춤·4xx 에만(코드 + e2e DELETE 유무).
4. sessionKey 가 relativePath·size·mtime 을 모두 쓰고 mtime 없으면 null; 이어 간 세션의 첫 실패 → forget → 새 세션 한 번.
5. 호스트는 progressbar 를 한 번에 하나만 그린다; job 이 끝나면 카드가 사라진다(완료는 토스트); 화면의 push/replace/refresh/setState 는 mountedRef 뒤에만.
6. 마무리 단계: 마지막 조각 뒤·커밋 중 멈추기 버튼 없음, aria-label 접두 그대로.
7. 서버: storage.test 가 copy 경로(`rehashed:false`)와 폴백(`rehashed:true`) 둘 다, removeSession/complete 뒤 Map 비어 있음; complete 캐시는 사용자·접근 검사, record 성공 뒤에만 삽입; API_LEVEL 6·docs/API.md·shared 주석 일치, REQUIRED 는 2.
8. `checkUploadPlan` 사례가 `server/test/files.test.ts` 의 이름 겹침 사례와 짝; 충돌 시 PUT 0번; `tree.recursive` 없거나 `maxRepoBytes` 없으면 그 검사만 생략.
9. `check:sync` 통과(구조 블록 새 파일: transfer-store·TransferHost·pure/transfer-report·pure/upload-sessions·upload-sessions·pure/upload-check), ARCHITECTURE 전송 절·README 문구가 실제 동작(세션 20h 기억, 5분 창)과 일치, 릴리즈 노트.
10. 회귀 순서: `check:sync` → `typecheck` → `npm test` → `test:e2e` → `--web` 재빌드 → `test:desktop`.
