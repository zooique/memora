// 冒烟脚本（npm run smoke）：真 MCP Client 走 stdio 往返，验证只读切片可用性
// 重点验收：取代过滤（hasActiveSuperseder）语义是否正确
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createNodeSqliteStorage } from '@zooique/memora';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const db = join(tmpdir(), `memora-smoke-${Date.now()}`);
mkdirSync(join(db, '.memora'), { recursive: true });

const now = new Date().toISOString();
const iso = (s) => new Date(Date.parse(now) + s * 1000).toISOString();
const memories = [
  {
    id: 'round-summary:s1:r1',
    name: '旧摘要（应被取代 → 不可召回）',
    content: '这是被新摘要取代的旧结论 关键词X',
    source: 'round-summary',
    createdAt: iso(0),
    accessedAt: iso(0),
    supersededBy: 'round-summary:s1:r2',
  },
  {
    id: 'round-summary:s1:r2',
    name: '新摘要（当前版本）',
    content: '这是最新版结论 关键词X',
    source: 'round-summary',
    createdAt: iso(1),
    accessedAt: iso(1),
  },
  {
    id: 'round-summary:s2:r1',
    name: '悬空取代（目标不存在 → 回退为当前版本，应可见）',
    content: '这是悬空指针摘要 关键词X',
    source: 'round-summary',
    createdAt: iso(2),
    accessedAt: iso(2),
    supersededBy: 'round-summary:gone:r9',
  },
  {
    id: 'work-projection:proj-a',
    name: '作品概要',
    content: '这是作品投影内容 关键词X',
    source: 'work-projection',
    createdAt: iso(3),
    accessedAt: iso(3),
  },
];
// 用**内核写实现**建 fixture（不再手写 JSON）：与真实写宿主同一套 parseMemory 校验，
// 顺带验证「内核写 → MCP 只读」这条跨进程链路的存储格式兼容性。
const storage = createNodeSqliteStorage(join(db, '.memora', 'memories.db'));
for (const memory of memories) storage.upsert(memory);
storage.close();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', '--db', db],
  cwd: process.cwd(),
});
const client = new Client({ name: 'memora-smoke', version: '1.0.0' });

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

await client.connect(transport);

const listed = await client.listTools();
const names = listed.tools.map((t) => t.name).sort();
check('tools/list 返回 4 个工具', names.length === 4, names.join(', '));

const srcs = await client.callTool({ name: 'list_memory_sources', arguments: {} });
const srcText = srcs.content[0].text;
console.log('--- list_memory_sources ---\n' + srcText);
const parsed = JSON.parse(srcText);
const total = parsed.totalCurrent;
check('总数应为 3（4 条中旧摘要被取代而剔除）', total === 3, `totalCurrent=${total}`);

const search = await client.callTool({
  name: 'search_memories',
  arguments: { query: '关键词X' },
});
const searchText = search.content[0].text;
console.log('--- search_memories ---\n' + searchText);
const res = JSON.parse(searchText);
const ids = res.results.map((r) => r.id).sort();
check('被取代的旧摘要不可召回', !ids.includes('round-summary:s1:r1'), `召回=${ids.join(',')}`);
check('悬空取代者回退为当前版本（应可见）', ids.includes('round-summary:s2:r1'));
check('新摘要可见', ids.includes('round-summary:s1:r2'));

const byId = await client.callTool({
  name: 'get_memory_by_id',
  arguments: { id: 'round-summary:s1:r1' },
});
check('按 id 取被取代条目 → found:false', !JSON.parse(byId.content[0].text).found);

const full = await client.callTool({
  name: 'get_memory_by_id',
  arguments: { id: 'work-projection:proj-a' },
});
check(
  '按 id 取正常条目返回全文',
  JSON.parse(full.content[0].text).found &&
    JSON.parse(full.content[0].text).memory.content.includes('作品投影'),
);

const emptyQuery = await client.callTool({ name: 'search_memories', arguments: { query: '' } });
check('空 query 按最近使用返回（不报错）', JSON.parse(emptyQuery.content[0].text).returned === 3);

// SDK client 对服务端报错是「抛 McpError」而非返回 isError —— 按真实客户端语义断言
let threw = null;
try {
  await client.callTool({ name: 'search_memories', arguments: { query: 'x', limit: -1 } });
} catch (e) {
  threw = e;
}
check(
  '非法 limit → 服务端报错并回传可读原因',
  threw !== null && String(threw.message).includes('limit 必须是正整数'),
  threw === null ? '未抛错（不符预期）' : threw.message,
);

await client.close();
console.log(failures === 0 ? '\n=== 冒烟全绿 ===' : `\n=== 冒烟失败 ${failures} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
