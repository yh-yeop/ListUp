#!/usr/bin/env node
/**
 * ListUp MCP 서버 — MCP 클라이언트(Claude 등)의 설정에 `node <리포>/mcp/bin/listup-mcp.mjs` 로 등록한다.
 *
 * stdout 이 MCP 프로토콜 전용이라 `npm run`(머리말을 stdout 에 찍는다)을 거치지 않고, TypeScript 는 tsx 를
 * 여기서 직접 등록해 불러온다.
 */
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
