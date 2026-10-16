import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import type { MoveItem } from '../lib/move';
import { useTheme } from '../theme';

/** 끌어다 놓기에 싣는 자료의 종류 — OS 에서 끌어온 파일 등 다른 것은 받지 않는다. */
const DRAG_TYPE = 'application/x-listup-items';

/**
 * 끌어다 놓기로 옮기기(웹·PC 앱). drag 를 주면 끌 수 있고, onDrop 을 주면 놓을 수 있다. 폰에서는 감싸기만 한다.
 * react-native-web 의 View 는 DOM 요소라, 브라우저의 drag 이벤트를 직접 단다.
 */
export function DragDrop({
  children,
  drag,
  onDrop,
  style,
}: {
  children: ReactNode;
  /** 끌기 시작할 때 실을 것(고른 것이 있으면 그것 전부). */
  drag?: () => MoveItem[];
  onDrop?: (items: MoveItem[]) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const ref = useRef<View>(null);
  const [over, setOver] = useState(false);
  // 이벤트는 한 번만 달고, 최신 콜백은 ref 로 읽는다.
  const latest = useRef({ drag, onDrop });
  latest.current = { drag, onDrop };
  const canDrag = !!drag;
  const canDrop = !!onDrop;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = ref.current as unknown as HTMLElement | null;
    if (!el || (!canDrag && !canDrop)) return;
    const accepts = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes(DRAG_TYPE);

    const onDragStart = (event: DragEvent) => {
      const items = latest.current.drag?.() ?? [];
      if (!event.dataTransfer || items.length === 0) return;
      event.stopPropagation();
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(items));
      event.dataTransfer.setData('text/plain', items.map((item) => item.path).join('\n'));
      event.dataTransfer.effectAllowed = 'move';
    };
    const onDragOver = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = 'move';
      setOver(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
      setOver(false);
    };
    const onDropEvent = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      try {
        const items = JSON.parse(event.dataTransfer!.getData(DRAG_TYPE)) as MoveItem[];
        if (Array.isArray(items) && items.length > 0) latest.current.onDrop?.(items);
      } catch {
        // 알 수 없는 자료 — 무시한다.
      }
    };

    if (canDrag) {
      el.draggable = true;
      el.addEventListener('dragstart', onDragStart);
    }
    if (canDrop) {
      el.addEventListener('dragover', onDragOver);
      el.addEventListener('dragleave', onDragLeave);
      el.addEventListener('drop', onDropEvent);
    }
    return () => {
      el.draggable = false;
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDropEvent);
    };
  }, [canDrag, canDrop]);

  return (
    <View
      ref={ref}
      style={[
        style,
        over ? { backgroundColor: colors.accentSoft, outlineColor: colors.accent, outlineStyle: 'solid', outlineWidth: 2 } as ViewStyle : null,
      ]}
    >
      {children}
    </View>
  );
}
