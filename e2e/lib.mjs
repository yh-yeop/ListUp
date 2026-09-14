/** 스펙들이 같이 쓰는 도우미. */

/** 서버 API 를 브라우저 밖에서 부른다 — 준비 단계(가입, 다른 기기에서 비밀번호 변경 등). */
export async function api(base, path, body, token) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 페이지에서 자주 찾는 요소들. */
export function screen(page) {
  return {
    /** 보이는 입력칸. 웹 스택은 이전 화면을 DOM 에 숨겨 두므로 보이는 것만. */
    inputs: () => page.locator('input:visible'),
    listIntro: () => page.getByText('들어갈 서버를 고릅니다', { exact: false }),
    card: (title) => page.getByRole('button', { name: `${title} 서버로 들어가기` }),
    cardSettings: (title) => page.getByRole('button', { name: `${title} 서버 설정` }),
    /** 저장소 목록 화면의 "○○ 님으로 로그인됨" (목록 카드의 같은 문구와 구분하려 정확히 일치). */
    onRepos: (who) => page.getByText(`${who} 님으로 로그인됨`, { exact: true }),
    visibleCount: (locator) => locator.filter({ visible: true }).count(),
    store: () => page.evaluate(() => JSON.parse(localStorage.getItem('listup.servers') ?? 'null')),
    path: () => new URL(page.url()).pathname,
    openSettings: async () => {
      await page.getByLabel('내 정보').click();
      await page.getByRole('button', { name: '로그아웃' }).waitFor();
    },
    openServerList: async () => {
      await page.getByLabel('내 정보').click();
      await page.getByRole('button', { name: '서버 목록 열기' }).click();
      await page.getByText('들어갈 서버를 고릅니다', { exact: false }).waitFor();
    },
  };
}

/** 서버 추가 폼에서 주소를 넣고 연결 확인까지. */
export async function fillServerForm(page, label, url) {
  const s = screen(page);
  await page.getByRole('button', { name: '서버 추가' }).click();
  await page.getByRole('button', { name: '연결 확인' }).waitFor();
  await s.inputs().nth(0).fill(label);
  await s.inputs().nth(1).fill(url);
  await page.getByRole('button', { name: '연결 확인' }).click();
  await page.getByText('연결을 확인했습니다', { exact: false }).waitFor();
}

/** 가입 화면을 채워 가입하고 저장소 목록까지. */
export async function signupInApp(page, name, email, password) {
  const s = screen(page);
  await page.getByText('회원가입').click();
  await page.getByRole('button', { name: '가입하고 시작하기' }).waitFor();
  await s.inputs().nth(0).fill(name);
  await s.inputs().nth(1).fill(email);
  await s.inputs().nth(2).fill(password);
  await page.getByRole('button', { name: '가입하고 시작하기' }).click();
  await s.onRepos(name).waitFor();
}
