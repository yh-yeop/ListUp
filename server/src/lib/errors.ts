import type { ApiErrorCode } from '@listup/shared';

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  internal: 500,
};

/** 클라이언트에 그대로 전달해도 되는 에러. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError('bad_request', message, details);
export const unauthorized = (message = '로그인이 필요합니다.') =>
  new ApiError('unauthorized', message);
export const forbidden = (message = '권한이 없습니다.') => new ApiError('forbidden', message);
export const notFound = (message = '대상을 찾을 수 없습니다.') => new ApiError('not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new ApiError('conflict', message, details);
export const tooLarge = (message: string) => new ApiError('payload_too_large', message);
