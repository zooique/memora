#!/usr/bin/env node
/**
 * memora-mcp CLI 入口 —— 把本机 .memora 记忆库以只读方式暴露给其他本地 agent
 *
 * 只读切片：只做「检索 + 读取」，不提供写能力。写路径待内核补齐受治理写 API 后再上。
 * 设计参见 `docs/方案-服务端MCP宿主-memora-mcp-20261015.md`。
 */
import { MemoraError } from '@zooique/memora';
import { ReadOnlyFileStore, type StoreProbe } from './readOnlyFileStore.js';
import { serve } from './server.js';

/** ⚠ 须与 package.json#version 同步（无兜底读取机制，改动时两处同改） */
const VERSION = '0.1.0';

const USAGE = `memora-mcp v${VERSION} — 把本地 .memora 记忆库通过 MCP 协议暴露给其他 agent（只读）

用法：
  memora-mcp --db <工作区目录>

参数：
  --db <path>   工作区根目录（其下须含 .memora/memories.db，由 Memora VS Code 插件创建）
                默认使用当前工作目录
  -h, --help    显示本帮助

前置条件：
  Node ≥22.13（使用内置 node:sqlite）
  工作区须先用 Memora VS Code 插件（≥1.101）打开过一次（建库 / 迁移旧 JSON）

暴露的工具（全部只读）：
  search_memories         关键词检索记忆摘要
  get_memory_by_id        按 id 取记忆全文
  get_memories_by_source  按来源标签批量取摘要
  list_memory_sources     列出所有来源标签及条目数

接入方式（以 Claude Code 为例）：
  claude mcp add memora -- npx -y @zooique/memora-mcp --db /path/to/workspace
`;

function parseArgs(argv: string[]): { db: string; help: boolean } {
  let db = process.cwd();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    // noUncheckedIndexedAccess 下 argv[i] 为 string | undefined；
    // 归一化为 '' 而非跳过——空串不匹配任何分支，等价于 no-op，且让下方比较一律在 string 类型内进行
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--db') {
      const next = argv[i + 1];
      if (next !== undefined) {
        db = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith('--db=')) {
      db = arg.slice('--db='.length);
    }
  }
  return { db, help };
}

async function main(): Promise<void> {
  const { db, help } = parseArgs(process.argv.slice(2));
  if (help) {
    // help 场景不会建立 MCP 会话，此时 stdout 仍是普通 CLI 输出，安全
    console.log(USAGE);
    return;
  }

  const store = new ReadOnlyFileStore(db);
  let probe: StoreProbe;
  try {
    probe = store.probe();
  } catch (err) {
    // 可操作错误（库不存在 / 环境不支持）：打印成因与建议，不打堆栈——这是用户要读的，不是开发者要看的
    if (err instanceof MemoraError) {
      console.error(`[memora-mcp] 启动失败：\n${err.format()}`);
      process.exit(1);
    }
    throw err;
  }

  // 诊断一律走 stderr：stdout 被 MCP stdio 传输占用
  console.error(
    `[memora-mcp] v${VERSION} 记忆库就绪：${probe.dbPath}` +
      `（当前 ${probe.totalCurrent} 条 / 已被取代 ${probe.superseded} 条 / 回收站 ${probe.deleted} 条）`,
  );
  if (probe.totalCurrent === 0) {
    // 路径已在上行打印：空库不再往「--db 写错了」上引——那会把用户带向错误方向
    console.error(
      '[memora-mcp] 警告：库已打开，但没有当前版本记忆——确认 Memora 插件已在该工作区产生过记忆',
    );
  }

  await serve(store, VERSION);
}

main().catch((err: unknown) => {
  console.error(`[memora-mcp] 启动失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
