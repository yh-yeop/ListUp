import type { FastifyRequest } from 'fastify';
import { badRequest, unauthorized } from './errors.ts';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** onRequest 훅에서 채워진다. 토큰이 없거나 무효면 null. */
    user: AuthUser | null;
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** 본문이 객체인지 확인하고 좁혀준다. */
export function body(req: FastifyRequest): Record<string, unknown> {
  const value = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('요청 본문이 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  source: Record<string, unknown>,
  key: string,
  { max, label }: { max: number; label: string },
): string {
  const raw = source[key];
  if (typeof raw !== 'string') throw badRequest(`${label}을(를) 입력해 주세요.`);
  const value = raw.trim();
  if (value.length === 0) throw badRequest(`${label}을(를) 입력해 주세요.`);
  if (value.length > max) throw badRequest(`${label}은(는) ${max}자 이내여야 합니다.`);
  return value;
}

export function optionalString(
  source: Record<string, unknown>,
  key: string,
  { max, label }: { max: number; label: string },
): string {
  const raw = source[key];
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw badRequest(`${label} 형식이 올바르지 않습니다.`);
  const value = raw.trim();
  if (value.length > max) throw badRequest(`${label}은(는) ${max}자 이내여야 합니다.`);
  return value;
}

export function query(req: FastifyRequest): Record<string, unknown> {
  return (req.query ?? {}) as Record<string, unknown>;
}

export function queryString(req: FastifyRequest, key: string): string | undefined {
  const raw = query(req)[key];
  return typeof raw === 'string' ? raw : undefined;
}

export function queryInt(req: FastifyRequest, key: string, fallback: number, max: number): number {
  const raw = queryString(req, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
