import { useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTransfers } from '../lib/transfer-store';
import { radius, spacing } from '../theme';
import { TransferProgress } from './TransferProgress';

/** 웹은 화면을 스크롤해도 창 아래에 붙어 있게(ToastHost 와 같다). */
const FIXED_ON_WEB = Platform.OS === 'web' ? ({ position: 'fixed' } as unknown as object) : null;

/**
 * 진행 중인 전송 카드 — 화면 아래쪽에 떠서 저장소 밖으로 나가도 남는다. 루트 레이아웃에 하나만 둔다.
 *
 * 카드는 하나만 그린다(가장 최근에 시작한 전송). 여럿이면 나머지는 「외 N개 진행 중」 으로만 — e2e 의
 * `getByRole('progressbar')` 가 늘 하나를 찾게. 전송이 없으면 아무것도 그리지 않는다(끝나면 카드가 사라지고
 * 결과는 토스트로 알린다).
 *
 * children 에는 ToastHost 를 넣는다. 토스트가 카드를 덮지 않도록 카드 높이만큼 위로 올려 쌓는다.
 * 둘 다 pointerEvents box-none 이라 빈 곳은 아래 화면의 버튼이 그대로 눌린다.
 */
export function TransferHost({ children }: { children?: ReactNode }) {
  const { jobs } = useTransfers();
  const insets = useSafeAreaInsets();
  const [cardHeight, setCardHeight] = useState(0);
  const job = jobs.length > 0 ? jobs[jobs.length - 1] : null;
  const lift = job && cardHeight > 0 ? cardHeight + spacing.sm : 0;

  return (
    <>
      {job ? (
        <View
          pointerEvents="box-none"
          onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
          style={[styles.host, FIXED_ON_WEB, { bottom: insets.bottom + spacing.lg }]}
        >
          <View style={styles.card}>
            <TransferProgress job={job} footnote={jobs.length > 1 ? `외 ${jobs.length - 1}개 진행 중` : undefined} />
          </View>
        </View>
      ) : null}
      {/*
        토스트 자리. 웹의 ToastHost 는 position: fixed 라 부모를 무시하므로 transform 으로 이 상자를
        기준 상자로 만든다(fixed 는 transform 이 있는 조상을 기준으로 놓인다). 들어 올리는 양만 바뀐다.
      */}
      <View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, FIXED_ON_WEB, styles.toasts, { bottom: lift, transform: [{ translateY: 0 }] }]}
      >
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    // 토스트(1000) 바로 아래 — 겹칠 일은 없지만 겹치면 토스트가 위다.
    zIndex: 999,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  toasts: {
    zIndex: 1000,
  },
});
