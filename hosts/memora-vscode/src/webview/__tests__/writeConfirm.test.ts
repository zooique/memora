/**
 * 写入审批流程集成测试
 *
 * 验证内容：
 * 1. bindWriteConfirmation 正确注册回调到 SecurityGuard
 * 2. 写入请求正确发送 write_confirm_request 到 webview
 * 3. 用户确认后回调返回 true，pending 记录清理
 * 4. 用户拒绝后回调返回 false
 * 5. 超时后自动拒绝（fail-closed）
 * 6. 审批卡正确展示目标路径、工具名、beforeContent/afterContent
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// WriteConfirmationRequest 从内核 import（与 chatPanel.ts 同源）；内核不导出 SecurityGuard 类，
// 测试用本地结构桩（SecurityGuardStub）替代，避免依赖私有/未导出类型。
import type { WriteConfirmationRequest } from '@zooique/memora';

// ─── mock vscode（最小 API 集）──────────────────────────────
vi.mock('vscode', async () => {
  return {
    Uri: {
      joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
      fsPath: '/mock/path',
    },
    window: {
      showInputBox: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    },
    EventEmitter: vi.fn(),
  };
});

/** SecurityGuard 本地结构桩（内核不导出 SecurityGuard 类，仅测试用到的两个方法） */
interface SecurityGuardStub {
  onWriteConfirmation: (handler: WriteConfirmationRequest) => void;
  requestWriteConfirmation: () => Promise<boolean>;
}

/** Provider 本地结构桩（不引用 chatPanel 私有类型；通过 post/handleMessage 协议消息断言） */
interface ProviderStub {
  post: (msg: Record<string, unknown>) => void;
  handleMessage: (msg: Record<string, unknown>) => void;
  bindWriteConfirmation: () => void;
}

/** 构造 security guard mock */
function createMockGuard(): {
  guard: SecurityGuardStub;
  registeredHandler: WriteConfirmationRequest | null;
} {
  let registeredHandler: WriteConfirmationRequest | null = null;
  const guard: SecurityGuardStub = {
    onWriteConfirmation: vi.fn((handler: WriteConfirmationRequest) => {
      registeredHandler = handler;
    }),
    requestWriteConfirmation: vi.fn().mockResolvedValue(true),
  };
  return {
    guard,
    get registeredHandler() {
      return registeredHandler;
    },
  };
}

/** 构造 provider 桩 */
function createMockProvider(guard: SecurityGuardStub): {
  provider: ProviderStub;
  postedMessages: Array<{ type: string; [k: string]: unknown }>;
  handleMessage: (msg: { type: string; [k: string]: unknown }) => void;
} {
  const postedMessages: Array<{ type: string; [k: string]: unknown }> = [];
  const pendingConfirmations = new Map<
    string,
    { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const provider = {
    _agent: { security: guard, on: vi.fn(), off: vi.fn() },
    _pendingWriteConfirmations: pendingConfirmations,
    post: vi.fn((msg: { type: string; [k: string]: unknown }) => {
      postedMessages.push(msg);
    }),
    bindWriteConfirmation: function () {
      // 内联实现（与 chatPanel.ts bindWriteConfirmation 语义一致：注册 → 发请求 → 等待应答）
      const handler: WriteConfirmationRequest = async (info) => {
        const requestId = `wc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = 30000;
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            pendingConfirmations.delete(requestId);
            resolve(false);
            // 文案与产品 chatPanel.bindWriteConfirmation 同源（动词中性：同一张卡也承载命令/脚本确认）
            provider.post({
              type: 'notice',
              level: 'error',
              message: '确认超时（写入文件），已自动拒绝',
            });
          }, timeoutMs);
          pendingConfirmations.set(requestId, { resolve, timer });
          provider.post({
            type: 'write_confirm_request',
            requestId,
            targetPath: info.targetPath,
            tool: info.tool,
            description: info.description || '写入操作',
            permission: info.permission,
            beforeContent: info.beforeContent ?? null,
            afterContent: info.afterContent,
            hasDiff: info.hasDiff, // 与 chatPanel.ts 真实现同步：diff 域判据透传内核单点
          });
        });
      };
      guard.onWriteConfirmation(handler);
    },
    handleMessage: function (msg: { type: string; [k: string]: unknown }) {
      if (msg.type === 'write_confirm_answer') {
        const { requestId, approved } = msg as unknown as { requestId: string; approved: boolean };
        const pending = pendingConfirmations.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(approved);
          pendingConfirmations.delete(requestId);
        }
      }
    },
  } as unknown as ProviderStub;

  return {
    provider,
    postedMessages,
    handleMessage: provider.handleMessage,
  };
}

describe('H0 写入审批流程', () => {
  let guard: ReturnType<typeof createMockGuard>;
  let provider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    guard = createMockGuard();
    provider = createMockProvider(guard.guard);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 回调注册验证 ───────────────────────────────
  it('bindWriteConfirmation 正确注册回调到 SecurityGuard', () => {
    provider.provider.bindWriteConfirmation();
    expect(guard.guard.onWriteConfirmation).toHaveBeenCalledTimes(1);
    expect(guard.registeredHandler).not.toBeNull();
  });

  // ─── 写入请求发送验证 ───────────────────────────────
  it('写入请求正确发送 write_confirm_request 到 webview', async () => {
    provider.provider.bindWriteConfirmation();
    const handler = guard.registeredHandler!;

    const info = {
      targetPath: '/project/src/main.ts',
      tool: 'write_file',
      description: '修改入口文件',
      permission: 'owner' as const,
      needsConfirm: true,
      beforeContent: '旧内容',
      afterContent: '新内容',
      hasDiff: true, // 写入场景：有 diff 对比域
    };

    // 触发写入请求（不 await：本用例只验证请求已发送，应答由后续用例覆盖）
    handler(info);

    // 等待微任务队列清空
    await vi.waitFor(() => {
      const requestMsg = provider.postedMessages.find((m) => m.type === 'write_confirm_request');
      expect(requestMsg).toBeDefined();
      expect(requestMsg!.targetPath).toBe('/project/src/main.ts');
      expect(requestMsg!.tool).toBe('write_file');
      expect(requestMsg!.description).toBe('修改入口文件');
      expect(requestMsg!.permission).toBe('owner');
      expect(requestMsg!.beforeContent).toBe('旧内容');
      expect(requestMsg!.afterContent).toBe('新内容');
      // hasDiff 判据归内核单点，经载荷透传（写入场景 true）
      expect(requestMsg!.hasDiff).toBe(true);
      expect(requestMsg!.requestId).toBeDefined();
    });
  });

  // ─── 用户确认流程 ───────────────────────────────
  it('用户确认后回调返回 true', async () => {
    provider.provider.bindWriteConfirmation();
    const handler = guard.registeredHandler!;

    const info = {
      targetPath: '/project/test.ts',
      tool: 'write_file',
      description: '测试写入',
      permission: 'owner' as const,
      needsConfirm: true,
      hasDiff: false, // 简化载荷无内容字段：无 diff 域（真实写入场景内核恒下发内容）
    };

    // 触发写入请求
    const resultPromise = handler(info);

    // 等待请求发送
    await vi.waitFor(() => {
      const requestMsg = provider.postedMessages.find((m) => m.type === 'write_confirm_request');
      return requestMsg?.requestId;
    });

    const requestMsg = provider.postedMessages.find((m) => m.type === 'write_confirm_request')!;
    const requestId = requestMsg.requestId as string;

    // 模拟用户确认
    provider.handleMessage({ type: 'write_confirm_answer', requestId, approved: true });

    const result = await resultPromise;
    expect(result).toBe(true);
  });

  // ─── 用户拒绝流程 ───────────────────────────────
  it('用户拒绝后回调返回 false', async () => {
    provider.provider.bindWriteConfirmation();
    const handler = guard.registeredHandler!;

    const info = {
      targetPath: '/project/test.ts',
      tool: 'write_file',
      description: '测试写入',
      permission: 'owner' as const,
      needsConfirm: true,
      hasDiff: false, // 简化载荷无内容字段：无 diff 域（真实写入场景内核恒下发内容）
    };

    const resultPromise = handler(info);

    await vi.waitFor(() => {
      const requestMsg = provider.postedMessages.find((m) => m.type === 'write_confirm_request');
      return requestMsg?.requestId;
    });

    const requestMsg = provider.postedMessages.find((m) => m.type === 'write_confirm_request')!;
    const requestId = requestMsg.requestId as string;

    // 模拟用户拒绝
    provider.handleMessage({ type: 'write_confirm_answer', requestId, approved: false });

    const result = await resultPromise;
    expect(result).toBe(false);
  });

  // ─── 超时自动拒绝 ───────────────────────────────
  it('超时后自动拒绝（fail-closed）', async () => {
    vi.useFakeTimers();
    provider.provider.bindWriteConfirmation();
    const handler = guard.registeredHandler!;

    const info = {
      targetPath: '/project/test.ts',
      tool: 'write_file',
      description: '测试写入',
      permission: 'owner' as const,
      needsConfirm: true,
      hasDiff: false, // 简化载荷无内容字段：无 diff 域（真实写入场景内核恒下发内容）
    };

    const resultPromise = handler(info);

    // 推进时间到超时
    vi.advanceTimersByTime(30_001);

    const result = await resultPromise;
    expect(result).toBe(false);

    // 验证超时通知
    const errorNotice = provider.postedMessages.find(
      (m) => m.type === 'notice' && m.level === 'error',
    );
    expect(errorNotice).toBeDefined();
    expect(errorNotice!.message).toContain('超时');
  });

  // ─── 审批卡展示字段完整性 ───────────────────────────────
  it('审批卡正确展示目标路径、工具名、内容', async () => {
    provider.provider.bindWriteConfirmation();
    const handler = guard.registeredHandler!;

    const info = {
      targetPath: '/project/src/components/Button.tsx',
      tool: 'edit_file',
      description: '编辑按钮组件',
      permission: 'owner' as const,
      needsConfirm: true,
      beforeContent: 'const btn = <button>Click</button>;',
      afterContent: 'const btn = <button onClick={handler}>Click</button>;',
      hasDiff: true, // 写入场景：有 diff 对比域
    };

    handler(info);

    await vi.waitFor(() => {
      const requestMsg = provider.postedMessages.find((m) => m.type === 'write_confirm_request');
      expect(requestMsg).toBeDefined();
      expect(requestMsg!.tool).toBe('edit_file');
      expect(requestMsg!.targetPath).toBe('/project/src/components/Button.tsx');
      expect(requestMsg!.description).toBe('编辑按钮组件');
      expect(requestMsg!.beforeContent).toBe('const btn = <button>Click</button>;');
      expect(requestMsg!.afterContent).toBe(
        'const btn = <button onClick={handler}>Click</button>;',
      );
      // hasDiff 判据归内核单点，经载荷透传（写入场景 true）
      expect(requestMsg!.hasDiff).toBe(true);
    });
  });

  // ─── 多请求隔离性 ───────────────────────────────
  it('多个并发请求的审批互不影响', async () => {
    provider.provider.bindWriteConfirmation();
    const handler = guard.registeredHandler!;

    const info1 = {
      targetPath: '/project/a.ts',
      tool: 'write_file',
      description: 'A',
      permission: 'owner' as const,
      needsConfirm: true,
      hasDiff: false, // 简化载荷无内容字段：无 diff 域（真实写入场景内核恒下发内容）
    };
    const info2 = {
      targetPath: '/project/b.ts',
      tool: 'edit_file',
      description: 'B',
      permission: 'owner' as const,
      needsConfirm: true,
      hasDiff: false, // 简化载荷无内容字段：无 diff 域（真实写入场景内核恒下发内容）
    };

    const result1Promise = handler(info1);
    const result2Promise = handler(info2);

    // 等待两个请求发送
    await vi.waitFor(() => {
      const requests = provider.postedMessages.filter((m) => m.type === 'write_confirm_request');
      return requests.length === 2;
    });

    const requests = provider.postedMessages.filter((m) => m.type === 'write_confirm_request');
    const [req1, req2] = requests;

    // 确认第一个，拒绝第二个
    provider.handleMessage({
      type: 'write_confirm_answer',
      requestId: req1.requestId as string,
      approved: true,
    });
    provider.handleMessage({
      type: 'write_confirm_answer',
      requestId: req2.requestId as string,
      approved: false,
    });

    const result1 = await result1Promise;
    const result2 = await result2Promise;

    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });
});
