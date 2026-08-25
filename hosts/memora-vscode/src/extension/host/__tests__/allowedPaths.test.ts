/**
 * G8 allowedPaths 动态管理 — 运行时热更新校验（宿主真实持久层 + 内核 SecurityGuard）
 *
 * 验证链路（不重启 Agent 的前提下动态管理白名单）：
 *   装配 Agent 时 allowedPaths = [projectPath, extra]
 *     → agent.security.assertPathAllowed(extra 内文件) 通过
 *     → 运行时 agent.security.setAllowedPaths([another])
 *         · 旧 extra 立即失效（断言抛「越界」）
 *         · 新 another 立即生效（断言通过）
 *         · 基准根 projectPath 仍放行（基准根不可被移除，D5）
 *     → 黑名单对额外目录内敏感文件仍拦截（白名单非绕过黑名单通行证）
 *
 * 设计纪律：
 *   - StubProvider 免 API Key，CI 离线可跑。
 *   - 直接构造 Agent（SessionManager 仅 type 导出），复用 G21 双实例脚手架。
 *   - 宿主测试跑 **built kernel**（@zooique/memora → dist），落地前须先 `npm run build`。
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

/** 免 API Key 的桩 LLM：仅满足 LlmProvider 契约，不触发任何 chat 调用 */
class StubProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  // eslint-disable-next-line require-yield
  async *chat(_messages: unknown[], _opts?: unknown): AsyncIterable<LlmChunk> {}
}

function makeStubProvider(): LlmProvider {
  return new StubProvider() as unknown as LlmProvider;
}

/** 播种最小 role-pack 骨架（persona 目录），让 init() 能正常加载 */
function seedConfig(configDir: string): void {
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nid: persona:default\nsource: persona\nname: 默认人格\nscore: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

describe('G8 allowedPaths 动态管理（运行时热更新 + 基准根不丢 + 黑名单仍生效）', () => {
  let tmpDir: string;
  let configDir: string;
  let memoraDir: string;
  let extraDir: string;
  let anotherDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-g8-'));
    configDir = join(tmpDir, 'config');
    memoraDir = join(tmpDir, '.memora');
    extraDir = mkdtempSync(join(tmpdir(), 'memora-g8-extra-'));
    anotherDir = mkdtempSync(join(tmpdir(), 'memora-g8-another-'));
    seedConfig(configDir);
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(extraDir, { recursive: true, force: true });
    rmSync(anotherDir, { recursive: true, force: true });
  });

  it('运行时 setAllowedPaths 应热更新活体 Agent 的白名单（旧项失效 / 新项生效 / 基准根不丢）', async () => {
    const store = new WorkspaceSessionStore(tmpDir);
    store.load();
    const storage = new WorkspaceStorage(tmpDir);
    storage.load();

    const agent = new Agent({
      projectPath: tmpDir,
      dataDir: memoraDir,
      configDir,
      provider: makeStubProvider(),
      storage,
      sessionStore: store,
      permission: 'owner',
      // 装配时仅含基准根 + 一项额外目录
      allowedPaths: [tmpDir, extraDir],
    });
    await agent.init();

    const guard = agent.security;
    expect(guard).not.toBeNull();

    // 额外目录初始可用
    expect(() => guard!.assertPathAllowed(join(extraDir, 'notes.md'))).not.toThrow();

    // 基准根（projectPath）始终可用
    expect(() => guard!.assertPathAllowed(join(tmpDir, 'src', 'index.ts'))).not.toThrow();

    // ── 运行时热更新：切换到 another，移除 extra ──
    guard!.setAllowedPaths([anotherDir]);

    // 新目录立即生效
    expect(() => guard!.assertPathAllowed(join(anotherDir, 'docs.md'))).not.toThrow();
    // 旧目录立即失效（越界）
    expect(() => guard!.assertPathAllowed(join(extraDir, 'notes.md'))).toThrow(/越界/);
    // 基准根仍不可被移除
    expect(() => guard!.assertPathAllowed(join(tmpDir, 'src', 'index.ts'))).not.toThrow();

    // ── 清空额外项：仅留基准根 ──
    guard!.setAllowedPaths([]);
    expect(() => guard!.assertPathAllowed(join(anotherDir, 'docs.md'))).toThrow(/越界/);
    expect(() => guard!.assertPathAllowed(join(tmpDir, 'src', 'index.ts'))).not.toThrow();

    await agent.close();
  });

  it('黑名单对额外目录内敏感文件仍强制拦截', async () => {
    const store = new WorkspaceSessionStore(tmpDir);
    store.load();
    const storage = new WorkspaceStorage(tmpDir);
    storage.load();

    const agent = new Agent({
      projectPath: tmpDir,
      dataDir: memoraDir,
      configDir,
      provider: makeStubProvider(),
      storage,
      sessionStore: store,
      permission: 'owner',
      allowedPaths: [tmpDir, extraDir],
    });
    await agent.init();

    const guard = agent.security;
    expect(guard).not.toBeNull();
    // 额外目录内若含 .env，仍应被黑名单拦截（白名单非绕过黑名单的通行证）
    expect(() => guard!.assertPathAllowed(join(extraDir, '.env'))).toThrow(/黑名单/);

    await agent.close();
  });
});
