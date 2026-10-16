import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import { baseName, normalizePath, type DirEntry } from '@listup/shared';
import { ApiError, api } from '../api/client';
import { planMoveInto, type MoveItem } from '../lib/move';
import { fontSize, monoFont, radius, spacing, useTheme } from '../theme';
import { Body, Button, Caption, Divider, Input, Row, Subtitle } from './ui';
import { Breadcrumb } from './RepoNav';

/**
 * 옮길 곳 고르기 — 저장소의 폴더를 따라 들어가 "여기로"를 누른다. 새 폴더 이름을 넣으면 그 안으로(옮기면 생긴다).
 * 경로를 손으로 칠 필요가 없게. 고른 폴더 자신·그 안으로는 들어가지 못하게 막는다.
 */
export function MovePicker({
  repoId,
  items,
  startDir,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  repoId: string;
  /** 옮길 것. 비어 있으면 닫혀 있다. */
  items: MoveItem[];
  startDir: string;
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (targetDir: string) => void;
}) {
  const { colors } = useTheme();
  const visible = items.length > 0;
  const [dir, setDir] = useState(startDir);
  const [dirs, setDirs] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');

  // 열 때마다 지금 보던 폴더에서 시작한다.
  useEffect(() => {
    if (!visible) return;
    setDir(startDir);
    setCreated(new Set());
    setNewName('');
  }, [visible, startDir]);

  useEffect(() => {
    if (!visible) return;
    if (created.has(dir)) {
      setDirs([]);
      return;
    }
    let alive = true;
    setDirs(null);
    setError(null);
    api.listFiles(repoId, dir).then(
      ({ tree }) => alive && setDirs(tree.dirs),
      (err: unknown) => alive && setError(err instanceof ApiError ? err.message : '폴더를 불러오지 못했습니다.'),
    );
    return () => {
      alive = false;
    };
  }, [visible, repoId, dir, created]);

  const moving = useMemo(() => new Set(items.filter((item) => item.isFolder).map((item) => item.path)), [items]);
  const plan = planMoveInto(items, dir);

  function makeFolder() {
    const name = normalizePath(newName);
    if (!name || name.includes('/')) {
      setError('폴더 이름에는 / 를 쓸 수 없고 비워 둘 수 없습니다.');
      return;
    }
    const next = dir ? `${dir}/${name}` : name;
    setCreated((prev) => new Set(prev).add(next));
    setNewName('');
    setError(null);
    setDir(next);
  }

  // 닫혀 있으면 아예 그리지 않는다 — 웹의 Modal 은 닫혀도 남아 있을 수 있어, 화면의 경로 표시와 겹친다.
  if (!visible) return null;
  const what = items.length === 1 ? `'${baseName(items[0].path)}'` : `${items.length}개`;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.45)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: spacing.lg,
        }}
      >
        <View
          accessibilityRole="none"
          aria-label="옮길 곳 고르기"
          style={{
            width: '100%',
            maxWidth: 520,
            maxHeight: '90%',
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            padding: spacing.lg,
            gap: spacing.md,
          }}
        >
          <View style={{ gap: spacing.xs }}>
            <Subtitle style={{ color: colors.text, fontWeight: '600' }}>{what}를 어디로 옮길까요?</Subtitle>
            <Breadcrumb path={dir} onNavigate={setDir} />
          </View>

          <ScrollView style={{ flexGrow: 0, maxHeight: 320, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
            {dir ? (
              <FolderRow icon="arrow-up-outline" label="위 폴더로" onPress={() => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')} />
            ) : null}
            {dirs === null && !error ? (
              <View style={{ padding: spacing.lg }}>
                <ActivityIndicator color={colors.textMuted} />
              </View>
            ) : (
              (dirs ?? []).map((entry, index) => {
                const blocked = moving.has(entry.path);
                return (
                  <View key={entry.path}>
                    {index > 0 || dir ? <Divider /> : null}
                    <FolderRow
                      icon="folder"
                      label={entry.name}
                      note={blocked ? '옮기는 폴더' : `파일 ${entry.fileCount}개`}
                      disabled={blocked}
                      onPress={() => setDir(entry.path)}
                    />
                  </View>
                );
              })
            )}
            {dirs && dirs.length === 0 ? (
              <Caption style={{ padding: spacing.md }}>
                {created.has(dir) ? '새 폴더 — 옮기면 생깁니다.' : '안에 폴더가 없습니다.'}
              </Caption>
            ) : null}
          </ScrollView>

          <Row gap={spacing.sm}>
            <Input
              value={newName}
              onChangeText={setNewName}
              placeholder="새 폴더 이름"
              accessibilityLabel="새 폴더 이름"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={makeFolder}
              style={{ flex: 1 }}
            />
            <Button label="새 폴더" icon="add" variant="secondary" compact disabled={!newName.trim()} onPress={makeFolder} />
          </Row>

          {error ? <Caption style={{ color: colors.danger }}>{error}</Caption> : null}
          {!plan.ok ? (
            <Caption style={{ color: colors.warning }}>{plan.reason}</Caption>
          ) : (
            <Caption style={{ fontFamily: monoFont, fontSize: fontSize.xs }} numberOfLines={2}>
              → {dir ? `/${dir}` : '(맨 위)'}
            </Caption>
          )}

          <Row gap={spacing.sm} style={{ justifyContent: 'flex-end' }}>
            <Button label="취소" variant="ghost" onPress={onCancel} disabled={busy} />
            <Button label={confirmLabel} icon="arrow-redo-outline" onPress={() => onConfirm(dir)} disabled={!plan.ok} loading={busy} />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

function FolderRow({
  icon,
  label,
  note,
  disabled,
  onPress,
}: {
  icon: 'folder' | 'arrow-up-outline';
  label: string;
  note?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={icon === 'folder' ? `${label} 폴더로 들어가기` : label}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
      })}
    >
      <Ionicons name={icon} size={18} color={icon === 'folder' ? colors.accent : colors.textMuted} />
      <Body style={{ flex: 1 }} numberOfLines={1}>
        {label}
      </Body>
      {note ? <Caption>{note}</Caption> : null}
      {icon === 'folder' && !disabled ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} /> : null}
    </Pressable>
  );
}
