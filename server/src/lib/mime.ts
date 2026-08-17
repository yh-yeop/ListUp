import { extName } from '@listup/shared';

const BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp',
};

export const DEFAULT_MIME = 'application/octet-stream';

/**
 * 확장자로 MIME 을 정한다.
 * 업로더가 보낸 Content-Type 은 신뢰하지 않는다 — 다운로드 시 브라우저가
 * 실행 가능한 타입으로 해석하는 것을 막기 위해 화이트리스트만 사용한다.
 */
export function mimeForPath(filePath: string): string {
  return BY_EXT[extName(filePath)] ?? DEFAULT_MIME;
}

/** 미리보기로 그대로 열어도 안전한 타입인지 (아니면 attachment 로 내려준다). */
export function isInlineSafe(mimeType: string): boolean {
  if (mimeType === 'image/svg+xml') return false; // SVG 안에 스크립트가 들어갈 수 있다
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType === 'application/pdf' ||
    mimeType === 'text/plain'
  );
}
