import { router } from 'expo-router';
import { Body, Button, Notice } from './ui';
import { clearAccountNotice, useAccountNotice } from '../lib/account-notice';
import { fontSize, monoFont } from '../theme';

/**
 * 로그인 직후 저장소 목록 맨 위의 계정 안내 — 재설정·가입 화면은 성공하면 보호 라우트가 바로 내려 그 화면에서
 * 알릴 수 없다(lib/account-notice.ts).
 * - 코드로 되찾았으면: 아이디(복구 코드로 찾았을 수 있다)와 남은 복구 코드.
 * - 막 가입했으면: 비밀번호를 잊을 때를 대비해 복구 코드를 만들어 두라고.
 */
export function AccountNoticeCard() {
  const recovered = useAccountNotice('recovered');
  const signedUp = useAccountNotice('signed-up');

  if (recovered) {
    const low = recovered.codesLeft !== null && recovered.codesLeft <= 2;
    return (
      <Notice
        tone="success"
        title="새 비밀번호로 들어왔습니다"
        onDismiss={() => clearAccountNotice('recovered')}
        actions={
          // 버튼 이름에 '만들기'를 쓰지 않는다 — 저장소 목록의 「만들기」(e2e 가 이름 일부로 찾는다)와 겹친다.
          low ? (
            <Button
              label="복구 코드 관리"
              icon="key-outline"
              variant="secondary"
              compact
              onPress={() => {
                clearAccountNotice('recovered');
                router.push('/settings');
              }}
            />
          ) : undefined
        }
      >
        <Body style={{ fontSize: fontSize.sm }}>
          아이디는 <Body style={{ fontFamily: monoFont, fontWeight: '700', fontSize: fontSize.sm }}>{recovered.loginId}</Body>{' '}
          입니다. 다른 기기의 로그인은 모두 끊겼습니다.
          {recovered.codesLeft !== null
            ? ` 남은 복구 코드는 ${recovered.codesLeft}개입니다.${low ? ' 새로 만들어 두세요.' : ''}`
            : ''}
        </Body>
      </Notice>
    );
  }

  if (signedUp) {
    return (
      <Notice
        tone="info"
        icon="key-outline"
        title="비밀번호를 잊을 때를 대비하세요"
        onDismiss={() => clearAccountNotice('signed-up')}
        actions={
          <Button
            label="복구 코드 관리"
            icon="key-outline"
            variant="secondary"
            compact
            onPress={() => {
              clearAccountNotice('signed-up');
              router.push('/settings');
            }}
          />
        }
      >
        이 서버에는 메일로 비밀번호를 되찾는 길이 없습니다. 복구 코드를 만들어 적어 두면, 잊어도 혼자 새 비밀번호를 정하고
        아이디도 찾을 수 있습니다.
      </Notice>
    );
  }

  return null;
}
