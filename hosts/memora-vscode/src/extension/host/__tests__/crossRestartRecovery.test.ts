/**
 * G21 跨重启恢复校验 — 端到端（宿主真实持久层 + 内核自动恢复）
 *
 * 验证链路（模拟「进程崩溃 / 用户关闭插件后再次打开」）：
 *   实例 A：init → createCheckpoint → pause（检查点经 flushCheckpoint 实时落盘到 .memora/sessions.json）
 *           → close（flushOnShutdown 兜底窄窗口）
 *   进程重启模拟：实例 B 全新 Agent，共享同一磁盘 WorkspaceSessionStore
 *           → init() 自动 loadPersistedCheckpoint() + restoreFromCheckpoint()
 *           → 断言状态机恢复为 paused、检查点目标 / schemaVersion 不丢、resume 可闭合。
 *
 * 设计纪律：
 *   - 使用 StubProvider（不触发任何 LLM 调用），免 API Key，可在 CI 离线跑。
 *   - 用真实宿主 WorkspaceSessionStore（JSON 落盘），而非 mock，实锤「落盘 ↔ 跨重启自动恢复」闭环。
 *   - SessionManager 在 index.ts 仅作 type 导出，故本测试用双 Agent 实例（而非裸 SessionManager）。
 *
 * 运行（在 hosts/memora-vscode 下）：
 *   node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/extension/host/__tests__/crossRestartRecovery.test.ts
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 宿主模块可能间接依赖 vscode，mock 之（不引入真实 VS Code 运行时）
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }), fsPath: '/mock' },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
  },
  EventEmitter: vi.fn(),
}));

import { Agent, type LlmProvider, type LlmChunk } from '@zooique/memora';
import { WorkspaceStorage } from '../workspaceStorage.js';
import { WorkspaceSessionStore } from '../sessionStore.js';

/**
 * 免 API Key 的桩 LLM：仅满足 LlmProvider 契约，本测试不触发任何 chat 调用
 * （跨重启恢复路径无需模型响应，restoreFromCheckpoint 不调用 provider）。
 */
class StubProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  // eslint-disable-next-line require-yield
  async *chat(_messages: unknown[], _opts?: unknown): AsyncIterable<LlmChunk> {
    // 空实现：恢复校验不依赖模型输出
  }
}

function makeStubProvider(): LlmProvider {
  return new StubProvider() as unknown as LlmProvider;
}

/** 播种最小 role-pack 骨架（persona + rules 目录），让 init() 能正常加载 */
function seedConfig(configDir: string): void {
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nid: persona:default\nsource: persona\nname: 默认人格\nscore: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

describe('G21 跨重启恢复校验（真实 WorkspaceSessionStore + 内核自动恢复）', () => {
  let tmpDir: string;
  let configDir: string;
  let memoraDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-g21-'));
    configDir = join(tmpDir, 'config');
    memoraDir = join(tmpDir, '.memora');
    seedConfig(configDir);
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('实例 A 暂停落盘 → 实例 B 跨重启自动恢复 paused 态与检查点上下文', async () => {
    // ── 实例 A：建立检查点并软暂停，落盘 ──
    const storeA = new WorkspaceSessionStore(tmpDir);
    storeA.load();
    const storageA = new WorkspaceStorage(tmpDir);
    storageA.load();

    const a = new Agent({
      projectPath: tmpDir,
      dataDir: memoraDir,
      configDir,
      provider: makeStubProvider(),
      storage: storageA,
      sessionStore: storeA,
      permission: 'owner',
      allowedPaths: [tmpDir],
    });
    await a.init();

    a.createCheckpoint('跨重启续跑目标');
    const paused = a.pause('重启前手动暂停', 'user');
    expect(paused).toBe(true);
    expect(a.sessionManager!.status).toBe('paused');
    await a.close();

    // ── 落盘实锤：磁盘 .memora/sessions.json 含 paused 检查点 ──
    const filePath = join(memoraDir, 'sessions.json');
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
      checkpoints?: Record<string, string>;
    };
    const cpEntries = Object.values(raw.checkpoints ?? {});
    expect(cpEntries.length).toBeGreaterThan(0);
    const saved = JSON.parse(cpEntries[0]!) as {
      status: string;
      currentGoal?: string;
      schemaVersion?: number;
    };
    expect(saved.status).toBe('paused');
    expect(saved.currentGoal).toBe('跨重启续跑目标');
    // SSOT 纪律：检查点必须带 schemaVersion（未来兼容，不可无版本落盘）
    expect(typeof saved.schemaVersion).toBe('number');

    // ── 模拟进程重启：全新 Agent 实例共享同一磁盘 store ──
    const storeB = new WorkspaceSessionStore(tmpDir);
    storeB.load();
    const storageB = new WorkspaceStorage(tmpDir);
    storageB.load();

    const b = new Agent({
      projectPath: tmpDir,
      dataDir: memoraDir,
      configDir,
      provider: makeStubProvider(),
      storage: storageB,
      sessionStore: storeB,
      permission: 'owner',
      allowedPaths: [tmpDir],
    });
    await b.init(); // 关键：init() 应自动 loadPersistedCheckpoint + restoreFromCheckpoint

    // 恢复后状态机应为 paused（而非默认 running）→ 证明跨重启恢复生效
    expect(b.sessionManager!.status).toBe('paused');
    const restored = b.getCheckpoint();
    expect(restored).not.toBeNull();
    expect(restored!.status).toBe('paused');
    expect(restored!.currentGoal).toBe('跨重启续跑目标');
    expect(typeof restored!.schemaVersion).toBe('number');

    // 恢复链路闭合：resume 可解除暂停回到 running
    expect(b.resume()).toBe(true);
    expect(b.sessionManager!.status).toBe('running');

    await b.close();
  });
});
