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
