import { randomBytes } from 'node:crypto';
import { INVITE_ALPHABET, INVITE_CODE_LENGTH } from '@listup/shared';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * 정렬 가능한 짧은 ID. 앞 8자는 시간(base36), 뒤는 난수.
 * 같은 밀리초에 생성돼도 난수 부분으로 충돌을 피한다.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(8, '0');
  return `${prefix}_${time}${randomChars(10)}`;
}

function randomChars(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

/** 사람이 옮겨 적을 수 있는 초대 코드 (혼동 문자 제외). */
export function newInviteCode(): string {
  // 모듈로 편향을 없애려 알파벳 크기 배수를 넘는 바이트는 버린다.
  const limit = Math.floor(256 / INVITE_ALPHABET.length) * INVITE_ALPHABET.length;
  let out = '';
  while (out.length < INVITE_CODE_LENGTH) {
    for (const byte of randomBytes(INVITE_CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
      if (out.length === INVITE_CODE_LENGTH) break;
    }
  }
  return out;
}
