/**
 * 脚本类快照扫描 · 上限守卫验收
 *
 * 验证 `scanWorkspaceTextFiles` 在 workspace 文本文件总字节超阈值时放弃内容快照、
 * 返回 null（调用方据此降级为「提示用户 git 核对」，避免大仓库同步扫描卡死
 * extension host）。用真实 tmpdir 构造文件布局（mock node:fs 对内置模块在本环境
 * 不生效，故走真实 IO；删除放宽 hook 超时以适配本沙箱 FS 删除慢）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

const h = vi.hoisted(() => ({ WS: '' }));

vi.mock('vscode', async () => ({
  Uri: { joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }), fsPath: '/mock/path' },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: h.WS } }];
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
  },
}));

const MB = 1024 * 1024;

function setup(): MemoraChatViewProvider {
  const dir = __dirname;
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  return new MemoraChatViewProvider({ fsPath: '/mock/uri' } as never, store, {} as never);
}

function resetWs(): void {
  rmSync(h.WS, { recursive: true, force: true });
  mkdirSync(h.WS, { recursive: true });
}
function writeFiles(count: number, sizeBytes: number, opts?: { nulAt?: number }): void {
  for (let i = 0; i < count; i++) {
    const buf = Buffer.alloc(sizeBytes, 'x');
    if (opts?.nulAt === i) buf[0] = 0; // 注入 NUL（二进制）
    writeFileSync(join(h.WS, `f${i}.ts`), buf);
  }
}

describe('scanWorkspaceTextFiles · 上限守卫降级', () => {
  let provider: MemoraChatViewProvider;
  beforeAll(() => {
    h.WS = mkdtempSync(join(tmpdir(), 'memora-ss-'));
  });
  afterAll(() => {
    rmSync(h.WS, { recursive: true, force: true });
  });
  /**
   * ⚠️ 两个清理钩子都显式放宽到 60s：本容器删除文件极慢（实测 501 个 = 99.6s），
   * 而本用例组为了逼近 64MB 上限必须造「32~33 个 2MB 文件」（单文件上限 2MB ⇒ 文件数下不来），
   * 一次清理就是 30+ 个文件 ⇒ 默认 10s 钩子超时是**结构性**的，不是断言失败。
   * 放宽的是**等待时间**，不是判据（断言一律不变）。
   */
  beforeEach(() => {
    provider = setup();
    resetWs();
  }, 60_000);
  afterEach(() => {
    rmSync(h.WS, { recursive: true, force: true });
  }, 60_000);

  it('正常目录 → 返回 Map（不降级）', () => {
    writeFiles(2, 100);
    const r = (provider as any).scanWorkspaceTextFiles();
    expect(r).toBeInstanceOf(Map);
    expect((r as Map<string, string>).size).toBe(2);
  });

  it('总字节超 64MB 阈值 → 返回 null（降级，避免卡死 extension host）', () => {
    writeFiles(33, 2 * MB); // 66MB（单文件 ≤2MB 计入）
    const r = (provider as any).scanWorkspaceTextFiles();
    expect(r).toBeNull();
  });

  /**
   * 判据边界：总量**恰好等于**上限时不降级（判据是 `>`，不是 `>=`）
   *
   * ⚠️ I/O 规模是本沙箱的硬约束：原「64×1MB 不降级 + 65×1MB 降级」要写 129MB、删 129 个文件
   * ——本容器删一个文件 ~200ms（实测 501 个 = 99.6s），光清理就远超默认 5s，全量并发下必超时
   * （失败形态是 timeout，AssertionError 计数为 0）。改为 **32×2MB = 恰好 64MB**：I/O 减半、
   * 语义等价；降级侧由上面「33×2MB → null」用例覆盖，两者合起来仍钉住 `>` 的两侧。
   */
  it(
    '判据边界精确：总量恰好等于 64MB 上限 → 不降级（判据是 > 不是 >=）',
    () => {
      writeFiles(32, 2 * MB); // 恰好 64MB
      expect((provider as any).scanWorkspaceTextFiles()).toBeInstanceOf(Map);
    },
    30_000,
  );

  it('IGNORED_DIRS（node_modules）不被扫描、不误触发降级', () => {
    mkdirSync(join(h.WS, 'node_modules'), { recursive: true });
    writeFileSync(join(h.WS, 'a.ts'), 'hello');
    const r = (provider as any).scanWorkspaceTextFiles();
    expect(r).toBeInstanceOf(Map);
    expect((r as Map<string, string>).size).toBe(1);
  });

  it('含 NUL 的二进制文件被跳过、不计入总字节（旧逻辑未破坏）', () => {
    writeFiles(31, MB, { nulAt: 0 }); // 1 个 NUL + 30 正常 = 30MB
    const r = (provider as any).scanWorkspaceTextFiles();
    expect(r).toBeInstanceOf(Map);
    expect((r as Map<string, string>).size).toBe(30);
  });
});
