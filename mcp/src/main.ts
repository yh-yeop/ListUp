import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListUpClient } from './client.ts';
import { checkServer, readConfig } from './config.ts';
import { createMcpServer, describeError } from './tools.ts';

/**
 * stdio MCP 서버 진입점 (`node mcp/bin/listup-mcp.mjs`).
 *
 * stdout 은 MCP 프로토콜 전용이다 — 사람에게 남기는 말은 모두 stderr 로. 토큰·비밀번호는 어디에도 찍지 않는다.
 */
const log = (message: string) => process.stderr.write(`[listup-mcp] ${message}\n`);

async function main(): Promise<void> {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const client = new ListUpClient(readConfig());

  const health = await client.health().catch((err: unknown) => {
    throw new Error(`서버에 연결할 수 없습니다 (${client.baseUrl}): ${describeError(err)}`);
  });
  const problem = checkServer(health);
  if (problem) throw new Error(problem);
  // 로그인 정보가 틀렸으면 도구를 부를 때가 아니라 지금 알린다.
  const me = await client.me();

  const server = createMcpServer(client, health, version);
  await server.connect(new StdioServerTransport());
  log(`${client.baseUrl} (서버 ${health.version}, 기능 수준 ${health.apiLevel}) 에 ${me.displayName} 로 연결했습니다.`);
}

main().catch((err: unknown) => {
  log(describeError(err));
  process.exit(1);
});
