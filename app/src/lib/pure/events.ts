import { ROLE_LABEL, type RepoEvent } from '@listup/shared';

export interface EventLine {
  /** Ionicons 이름. */
  icon: 'folder-outline' | 'person-add-outline' | 'exit-outline' | 'person-remove-outline' | 'swap-horizontal-outline' | 'key-outline' | 'close-circle-outline' | 'help-circle-outline';
  text: string;
}

const who = (user: RepoEvent['actor']) => user?.displayName ?? '알 수 없는 사람';
const role = (event: RepoEvent) => (event.role ? ROLE_LABEL[event.role] : '');

/**
 * 활동 기록 한 줄을 사람이 읽는 문장으로. 서버가 앞으로 더할 종류를 이 앱이 모를 수 있으므로
 * 모르는 것은 "알 수 없는 활동"으로 보인다(목록이 깨지지 않게).
 */
export function describeEvent(event: RepoEvent): EventLine {
  switch (event.kind) {
    case 'repo_created':
      return { icon: 'folder-outline', text: `${who(event.actor)} 님이 저장소를 만들었습니다` };
    case 'member_joined':
      return {
        icon: 'person-add-outline',
        text: `${who(event.actor)} 님이 초대로 참여했습니다${event.role ? ` (${role(event)})` : ''}`,
      };
    case 'member_left':
      return { icon: 'exit-outline', text: `${who(event.actor)} 님이 나갔습니다` };
    case 'member_removed':
      return { icon: 'person-remove-outline', text: `${who(event.actor)} 님이 ${who(event.target)} 님을 내보냈습니다` };
    case 'role_changed':
      return {
        icon: 'swap-horizontal-outline',
        text: event.role
          ? `${who(event.actor)} 님이 ${who(event.target)} 님을 ${role(event)} 권한으로 바꿨습니다`
          : `${who(event.actor)} 님이 ${who(event.target)} 님의 권한을 바꿨습니다`,
      };
    case 'owner_transferred':
      return {
        icon: 'swap-horizontal-outline',
        text: `${who(event.actor)} 님이 ${who(event.target)} 님에게 소유권을 넘겼습니다`,
      };
    case 'invite_created':
      return {
        icon: 'key-outline',
        text: `${who(event.actor)} 님이 초대를 만들었습니다${event.role ? ` (${role(event)})` : ''}`,
      };
    case 'invite_revoked':
      return { icon: 'close-circle-outline', text: `${who(event.actor)} 님이 초대를 회수했습니다` };
    default:
      return { icon: 'help-circle-outline', text: '알 수 없는 활동' };
  }
}
