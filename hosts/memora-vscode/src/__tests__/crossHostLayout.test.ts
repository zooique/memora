/**
 * 跨宿主数据布局契约 —— VS Code 写宿主 与 memora-mcp 只读宿主必须指向同一个库文件
 *
 * ## 为什么需要这条测试
 * 内核按 ADR-002 **不感知**数据目录布局（只收全长 dbPath），于是路径由各宿主自己拼。
 * 这留下一个结构性风险：同一事实（库在哪）有两处定义，改一侧文件名、另一侧会**静默读空**——
 * 正是 2026-10-18 `HOST-ALIGN-1` P0-B 的成因。文档约定拦不住它，只有能红的判据能拦。
 *
 * ## 为什么加载 mcp 的构建产物而不是源码
 * 宿主 `tsconfig.json` 的 `rootDir: "src"` 不允许跨包 import 源码（TS6059/TS6307）。
 * 产物级契约是 monorepo 的标准做法；为防「测的是陈旧 dist」，先断言产物不旧于源码。
 *
 * ## 四条断言的分工（缺一不可）
 * ① **两侧一致**：`new ReadOnlyFileStore(ws).path === resolveHostMemoryDbPath(ws)`
 *    —— 抓「单侧漂移」；
 * ② **布局锚定**：路径必须以 `.memora/memories.db` 结尾
 *    —— 抓「两侧一起改错」（一致但不兼容存量库，①会误绿）；
 * ③ **目录本尊一致**（HOST-DATA-DIR-1 扩面）：vscode 单点 `resolveProjectDataDir(ws)`
 *    必须等于 mcp 库路径的父目录 —— `attachments/` 等新子目录直接挂在本尊下，先钉目录再谈子目录；
 * ④ **目录锚定**：数据目录必须等于 `<ws>/.memora` —— 抓「两侧一起把目录改名」
 *    （存量 sessions/rounds/memories 全家不随改名蒸发）。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataDir } from '../extension/host/projectDataDir.js';
import { resolveHostMemoryDbPath } from '../extension/host/memoryStorage.js';

/** 本文件位于 `hosts/memora-vscode/src/__tests__`，上跳三级即 `hosts/` */
const HOSTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MCP_ROOT = join(HOSTS_DIR, 'memora-mcp');
const MCP_SOURCE = join(MCP_ROOT, 'src', 'readOnlyFileStore.ts');
const MCP_DIST = join(MCP_ROOT, 'dist', 'readOnlyFileStore.js');

/** mcp 产物对外形状（只取契约需要的最小面，不复制其类型定义） */
interface McpReadOnlyFileStoreCtor {
  new (workspacePath: string): { path: string };
}

describe('跨宿主数据布局契约（vscode 写 ↔ mcp 只读）', () => {
  let McpStore: McpReadOnlyFileStoreCtor;

  beforeAll(async () => {
    expect(
      existsSync(MCP_DIST),
      `mcp 产物缺失：${MCP_DIST}\n先跑 cd hosts/memora-mcp && npm run build`,
    ).toBe(true);

    // 产物必须不旧于源码：否则断言的是历史行为，属于「因错误的原因通过」
    const srcMtime = statSync(MCP_SOURCE).mtimeMs;
    const distMtime = statSync(MCP_DIST).mtimeMs;
    expect(
      distMtime,
      'mcp 产物早于源码（dist 陈旧）——先重新 build，否则本契约测的是旧行为',
    ).toBeGreaterThanOrEqual(srcMtime);

    const mod = (await import(pathToFileURL(MCP_DIST).href)) as {
      ReadOnlyFileStore: McpReadOnlyFileStoreCtor;
    };
    McpStore = mod.ReadOnlyFileStore;
  });

  it('同一工作区：两侧解析出同一个记忆库绝对路径', () => {
    // 用含空格与中文的路径，顺带证明两侧都没有做「只接受 ASCII」的隐式假设
    const workspace = join('F:', 'tmp', 'work space', '项目甲');
    expect(new McpStore(workspace).path).toBe(resolveHostMemoryDbPath(workspace));
  });

  it('布局锚定：库必须位于 <工作区>/.memora/memories.db', () => {
    // 这条不是重复实现，而是把「存量库在哪」变成显式契约：
    // 两侧若一起改名（一致但不兼容），上一条会绿，本条会红。
    expect(resolveHostMemoryDbPath(join('F:', 'ws'))).toBe(
      join('F:', 'ws', '.memora', 'memories.db'),
    );
  });

  it('目录本尊：vscode 单点 === mcp 库路径的父目录（两宿主同一数据目录）', () => {
    // mcp 侧无 dataDir API，其库路径的 dirname 即它心中的数据目录——
    // 这里把「目录一致」从库路径推导出来，attachments/ 等新子目录都挂在本尊下，先钉目录再谈子目录。
    const ws = join('F:', 'tmp', 'work space', '项目乙');
    expect(dirname(new McpStore(ws).path)).toBe(resolveProjectDataDir(ws));
  });

  it('目录锚定：数据目录必须等于 <工作区>/.memora（防两侧一起改名）', () => {
    // 与库锚定同理：目录级契约显式化，存量数据（sessions/rounds/memories 全家）不随改名蒸发。
    expect(resolveProjectDataDir(join('F:', 'ws'))).toBe(join('F:', 'ws', '.memora'));
  });
});
