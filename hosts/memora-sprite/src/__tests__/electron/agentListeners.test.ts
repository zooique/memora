/**
 * Agent 监听器测试
 *
 * 覆盖范围：
 * - setupConfigSuggestionListener：H1 配置建议回调注册 + 窗口可见性检查 + IPC 推送
 * - setupWriteConfirmationListener：M1 写入确认回调 + 30 秒超时保护 + 渲染进程响应
 * - setupAuditListener：M2 审计日志回调 + AuditManager.record
 *
 * Mock 策略：
 * - memora.safeSetTimeout/clearSafeTimeout：vi.fn() 透传到原生 setTimeout/clearTimeout，
 *   使 vi.useFakeTimers() 能统一控制定时器生命周期
 * - memora.logger：通过 setLogger 注入 mockLogger，捕获日志调用
 * - Agent：仅含 config/security 属性的 mock 对象（as Agent 单层断言）
 * - WindowManager：getFullWindow 返回 mock BrowserWindow
 * - AuditManager：record 方法用 vi.fn() 捕获
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Agent,
  ConfigSuggestion,
  ConfigSuggestionHandler,
  WriteConfirmationInfo,
  WriteConfirmationRequest,
  AuditEvent,
  AuditListener,
  ILogger,
} from 'memora';
import { setLogger, clearSafeTimeout } from 'memora';
import { MAIN_TO_RENDERER_CHANNELS } from '../../electron/ipc/channels.js';
import {
  setupConfigSuggestionListener,
  setupWriteConfirmationListener,
  setupAuditListener,
} from '../../electron/agentListeners.js';
import type { AgentListenerDeps } from '../../electron/agentListeners.js';
import type { WindowManager } from '../../electron/windows/windowManager.js';
import type { AuditManager } from '../../sprite/audit/auditManager.js';

// ─── Mock memora 模块 ────────────────────────────────────
// 仅覆盖 safeSetTimeout/clearSafeTimeout（透传到原生 setTimeout/clearTimeout），
// 保留 logger/setLogger 原实现，使 setLogger(mockLogger) 能注入到 agentListeners.ts
vi.mock('memora', async (importOriginal) => {
  // importOriginal 返回完整模块，spread 后覆盖定时器相关函数
  const actual = await importOriginal();
  return {
    ...actual,
    // 透传到原生 setTimeout，使 vi.useFakeTimers() 能统一控制定时器
    safeSetTimeout: vi.fn((cb: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(cb, ms),
    ),
    clearSafeTimeout: vi.fn((id: ReturnType<typeof setTimeout> | null): void => {
      if (id !== null) clearTimeout(id);
    }),
  };
});

// ─── Mock Logger（捕获日志调用） ─────────────────────────
const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ─── Mock BrowserWindow 工厂 ─────────────────────────────

/** Mock BrowserWindow 结构（含可见性检查 + webContents.send） */
interface MockWindow {
  isDestroyed: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
}

/**
 * 创建 mock BrowserWindow
 * @param opts 可见性选项（默认可见 + 未销毁 + 未最小化）
 */
function createMockWindow(opts?: {
  destroyed?: boolean;
  visible?: boolean;
  minimized?: boolean;
}): MockWindow {
  return {
    isDestroyed: vi.fn(() => opts?.destroyed ?? false),
    isVisible: vi.fn(() => opts?.visible ?? true),
    isMinimized: vi.fn(() => opts?.minimized ?? false),
    webContents: { send: vi.fn() },
  };
}

// ─── Mock Agent 工厂 ─────────────────────────────────────

/** Mock Agent 工具包（含 agent 引用 + 回调获取器） */
interface MockAgentBundle {
  agent: Agent;
  config: { onConfigSuggestion: ReturnType<typeof vi.fn> };
  security: {
    onWriteConfirmation: ReturnType<typeof vi.fn>;
    onAudit: ReturnType<typeof vi.fn>;
  };
  /** 获取通过 onConfigSuggestion 注册的回调 */
  getConfigHandler: () => ConfigSuggestionHandler | null;
  /** 获取通过 onWriteConfirmation 注册的回调 */
  getWriteHandler: () => WriteConfirmationRequest | null;
  /** 获取通过 onAudit 注册的监听器 */
  getAuditListener: () => AuditListener | null;
}

/**
 * 创建 mock Agent（含 config/security 属性，捕获注册的回调）
 * 使用闭包存储回调引用，避免外部直接访问内部状态
 */
function createMockAgent(): MockAgentBundle {
  // 捕获注册的回调（闭包变量）
  let configHandler: ConfigSuggestionHandler | null = null;
  let writeHandler: WriteConfirmationRequest | null = null;
  let auditListener: AuditListener | null = null;

  const config = {
    onConfigSuggestion: vi.fn((h: ConfigSuggestionHandler) => {
      configHandler = h;
    }),
  };
  const security = {
    onWriteConfirmation: vi.fn((h: WriteConfirmationRequest | null) => {
      writeHandler = h;
    }),
    onAudit: vi.fn((l: AuditListener) => {
      auditListener = l;
      return () => {}; // onAudit 返回 unsubscribe 函数
    }),
  };

  return {
    agent: { config, security } as Agent,
    config,
    security,
    getConfigHandler: () => configHandler,
    getWriteHandler: () => writeHandler,
    getAuditListener: () => auditListener,
  };
}

// ─── Mock Deps 工厂 ──────────────────────────────────────

/** Mock Deps 工具包（含 deps + pendingWriteConfirmations + windowManager） */
interface MockDepsBundle {
  deps: AgentListenerDeps;
  pendingWriteConfirmations: Map<string, (confirmed: boolean) => void>;
  windowManager: WindowManager;
}

/**
 * 创建 mock AgentListenerDeps
 * @param mockWindow getFullWindow 返回的窗口（null 模拟窗口未创建）
 */
function createMockDeps(mockWindow: MockWindow | null): MockDepsBundle {
  const pendingWriteConfirmations = new Map<string, (confirmed: boolean) => void>();
  const windowManager = {
    getFullWindow: vi.fn(() => mockWindow),
  } as WindowManager;
  const deps: AgentListenerDeps = { windowManager, pendingWriteConfirmations };
  return { deps, pendingWriteConfirmations, windowManager };
}

// ─── 测试数据 ─────────────────────────────────────────────

/** 测试用配置建议 */
const SUGGESTION: ConfigSuggestion = {
  type: 'rule',
  name: '代码风格',
  content: '使用 2 空格缩进',
  confidence: 0.85,
  source: '对话提取',
};

/** 测试用写入确认请求 */
const WRITE_INFO: WriteConfirmationInfo = {
  targetPath: '/test/file.ts',
  tool: 'write_file',
  description: '写入 100 字符到 file.ts',
  permission: 'owner',
  needsConfirm: true,
};

/** 测试用审计事件 */
const AUDIT_EVENT: AuditEvent = {
  type: 'path-allow',
  path: '/test/file.ts',
  tool: 'read_file',
  timestamp: '2026-01-01T00:00:00.000Z',
};

// ─── 公共 setup/teardown ─────────────────────────────────

beforeEach(() => {
  // 清除所有 mock 调用记录（保留实现）
  vi.clearAllMocks();
  // 注入 mockLogger（同一实例，不触发覆盖警告）
  setLogger(mockLogger);
});

afterEach(() => {
  // 恢复真实定时器（防止 fake timers 泄漏到其他测试）
  vi.useRealTimers();
});

// ─── setupConfigSuggestionListener ───────────────────────

describe('setupConfigSuggestionListener', () => {
  it('config 为 null 时应记录 warn 并直接返回（不注册回调）', () => {
    // config 为 null 模拟 Agent 未初始化完成
    const mockAgent = { config: null, security: null } as Agent;
    const { deps } = createMockDeps(createMockWindow());

    setupConfigSuggestionListener(mockAgent, deps);

    // 验证 warn 日志包含 ConfigManager 未就绪
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ConfigManager 未就绪'),
    );
  });

  it('config 就绪时应调用 config.onConfigSuggestion 注册回调', () => {
    const bundle = createMockAgent();
    const { deps } = createMockDeps(createMockWindow());

    setupConfigSuggestionListener(bundle.agent, deps);

    expect(bundle.config.onConfigSuggestion).toHaveBeenCalledTimes(1);
    expect(bundle.config.onConfigSuggestion).toHaveBeenCalledWith(expect.any(Function));
  });

  it('注册成功后应记录 info 日志', () => {
    const bundle = createMockAgent();
    const { deps } = createMockDeps(createMockWindow());

    setupConfigSuggestionListener(bundle.agent, deps);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('配置建议回调已注册'),
    );
  });

  it('窗口可见时应通过 SUGGESTION_PUSH 通道推送建议', () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow({ visible: true });
    const { deps } = createMockDeps(mockWindow);

    setupConfigSuggestionListener(bundle.agent, deps);
    // 触发回调
    const handler = bundle.getConfigHandler()!;
    handler(SUGGESTION);

    // 验证 webContents.send 携带完整建议字段
    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH,
      {
        type: SUGGESTION.type,
        name: SUGGESTION.name,
        content: SUGGESTION.content,
        confidence: SUGGESTION.confidence,
        source: SUGGESTION.source,
      },
    );
  });

  it('窗口不可见（isVisible=false）时不应推送，应记录 info 日志', () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow({ visible: false });
    const { deps } = createMockDeps(mockWindow);

    setupConfigSuggestionListener(bundle.agent, deps);
    const handler = bundle.getConfigHandler()!;
    handler(SUGGESTION);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    // 验证 info 日志携带建议名称和类型
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: SUGGESTION.name, type: SUGGESTION.type }),
      expect.stringContaining('窗口不可见'),
    );
  });

  it('窗口已销毁（isDestroyed=true）时不应推送', () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow({ destroyed: true });
    const { deps } = createMockDeps(mockWindow);

    setupConfigSuggestionListener(bundle.agent, deps);
    const handler = bundle.getConfigHandler()!;
    handler(SUGGESTION);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('窗口最小化（isMinimized=true）时不应推送', () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow({ minimized: true });
    const { deps } = createMockDeps(mockWindow);

    setupConfigSuggestionListener(bundle.agent, deps);
    const handler = bundle.getConfigHandler()!;
    handler(SUGGESTION);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });
});

// ─── setupWriteConfirmationListener ──────────────────────

describe('setupWriteConfirmationListener', () => {
  it('security 为 null 时应记录 warn 并直接返回', () => {
    const mockAgent = { config: null, security: null } as Agent;
    const { deps } = createMockDeps(createMockWindow());

    setupWriteConfirmationListener(mockAgent, deps);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SecurityGuard 未就绪'),
    );
  });

  it('security 就绪时应调用 security.onWriteConfirmation 注册回调', () => {
    const bundle = createMockAgent();
    const { deps } = createMockDeps(createMockWindow());

    setupWriteConfirmationListener(bundle.agent, deps);

    expect(bundle.security.onWriteConfirmation).toHaveBeenCalledTimes(1);
    expect(bundle.security.onWriteConfirmation).toHaveBeenCalledWith(expect.any(Function));
  });

  it('注册成功后应记录 info 日志', () => {
    const bundle = createMockAgent();
    const { deps } = createMockDeps(createMockWindow());

    setupWriteConfirmationListener(bundle.agent, deps);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('写入确认回调已注册'),
    );
  });

  it('needsConfirm=false 时应直接返回 true（不推送）', async () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow();
    const { deps } = createMockDeps(mockWindow);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    // needsConfirm=false 表示 owner 模式 + confirmWrites=false，无需弹窗
    const result = await handler({ ...WRITE_INFO, needsConfirm: false });

    expect(result).toBe(true);
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('窗口为 null 时应记录 warn 并返回 false', async () => {
    const bundle = createMockAgent();
    const { deps } = createMockDeps(null);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    const result = await handler(WRITE_INFO);

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: WRITE_INFO.targetPath }),
      expect.stringContaining('窗口不可用'),
    );
  });

  it('窗口已销毁时应记录 warn 并返回 false', async () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow({ destroyed: true });
    const { deps } = createMockDeps(mockWindow);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    const result = await handler(WRITE_INFO);

    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: WRITE_INFO.targetPath }),
      expect.stringContaining('窗口不可用'),
    );
  });

  it('needsConfirm=true + 窗口可用时应生成 requestId、存入 Map 并推送', async () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow();
    const { deps, pendingWriteConfirmations } = createMockDeps(mockWindow);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    // 不 await，让 Promise 保持 pending（等待渲染进程响应）
    const promise = handler(WRITE_INFO);

    // 验证 webContents.send 携带完整确认信息
    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION,
      expect.objectContaining({
        requestId: expect.stringMatching(/^wc-\d+-[a-z0-9]{6}$/),
        targetPath: WRITE_INFO.targetPath,
        tool: WRITE_INFO.tool,
        description: WRITE_INFO.description,
        permission: WRITE_INFO.permission,
        needsConfirm: true,
      }),
    );

    // 验证 pendingWriteConfirmations 存入了 resolver
    expect(pendingWriteConfirmations.size).toBe(1);

    // 清理：resolve promise 避免未处理 Promise 警告
    const sendCalls = mockWindow.webContents.send.mock.calls;
    const payload = sendCalls[0]![1] as { requestId: string };
    pendingWriteConfirmations.get(payload.requestId)!(true);
    await promise;
  });

  it('30 秒超时后应删除 Map、记录 warn 并 resolve(false)', async () => {
    vi.useFakeTimers();
    const bundle = createMockAgent();
    const mockWindow = createMockWindow();
    const { deps, pendingWriteConfirmations } = createMockDeps(mockWindow);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    const promise = handler(WRITE_INFO);

    // 超时前 Map 应有 1 条记录
    expect(pendingWriteConfirmations.size).toBe(1);

    // 推进 30 秒触发超时保护
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;

    expect(result).toBe(false);
    // 超时后应从 Map 删除
    expect(pendingWriteConfirmations.size).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: WRITE_INFO.targetPath }),
      expect.stringContaining('超时未响应'),
    );
  });

  it('渲染进程响应 true 时应 resolve(true) 并清理定时器', async () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow();
    const { deps, pendingWriteConfirmations } = createMockDeps(mockWindow);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    const promise = handler(WRITE_INFO);

    // 从 send 调用记录中提取 requestId
    const sendCalls = mockWindow.webContents.send.mock.calls;
    const payload = sendCalls[0]![1] as { requestId: string };
    // 模拟渲染进程响应用户点击"确认"
    pendingWriteConfirmations.get(payload.requestId)!(true);

    const result = await promise;

    expect(result).toBe(true);
    // clearSafeTimeout 应被调用以清理超时定时器
    expect(clearSafeTimeout).toHaveBeenCalled();
  });

  it('渲染进程响应 false 时应 resolve(false) 并清理定时器', async () => {
    const bundle = createMockAgent();
    const mockWindow = createMockWindow();
    const { deps, pendingWriteConfirmations } = createMockDeps(mockWindow);

    setupWriteConfirmationListener(bundle.agent, deps);
    const handler = bundle.getWriteHandler()!;

    const promise = handler(WRITE_INFO);

    const sendCalls = mockWindow.webContents.send.mock.calls;
    const payload = sendCalls[0]![1] as { requestId: string };
    // 模拟渲染进程响应用户点击"取消"
    pendingWriteConfirmations.get(payload.requestId)!(false);

    const result = await promise;

    expect(result).toBe(false);
    expect(clearSafeTimeout).toHaveBeenCalled();
  });
});

// ─── setupAuditListener ──────────────────────────────────

describe('setupAuditListener', () => {
  it('security 为 null 时应记录 warn 并直接返回', () => {
    const mockAgent = { config: null, security: null } as Agent;
    const mockAuditManager = { record: vi.fn() } as AuditManager;

    setupAuditListener(mockAgent, mockAuditManager);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SecurityGuard 未就绪'),
    );
  });

  it('security 就绪时应调用 security.onAudit 注册回调', () => {
    const bundle = createMockAgent();
    const mockAuditManager = { record: vi.fn() } as AuditManager;

    setupAuditListener(bundle.agent, mockAuditManager);

    expect(bundle.security.onAudit).toHaveBeenCalledTimes(1);
    expect(bundle.security.onAudit).toHaveBeenCalledWith(expect.any(Function));
  });

  it('注册成功后应记录 info 日志', () => {
    const bundle = createMockAgent();
    const mockAuditManager = { record: vi.fn() } as AuditManager;

    setupAuditListener(bundle.agent, mockAuditManager);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('审计日志回调已注册'),
    );
  });

  it('回调触发时应调用 activeAuditManager.record(event)', () => {
    const bundle = createMockAgent();
    const mockAuditManager = { record: vi.fn() } as AuditManager;

    setupAuditListener(bundle.agent, mockAuditManager);
    // 触发审计事件回调
    const listener = bundle.getAuditListener()!;
    listener(AUDIT_EVENT);

    expect(mockAuditManager.record).toHaveBeenCalledWith(AUDIT_EVENT);
  });
});
