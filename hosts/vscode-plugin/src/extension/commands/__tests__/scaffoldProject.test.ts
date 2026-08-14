/**
 * scaffoldProject 命令测试
 *
 * 覆盖：
 *   - 前置校验：无活动编辑器 / 非 markdown / 空文档 / 无工作区
 *   - 正常流程：chat 流式消费 → 结果写新文档 → 分栏打开
 *   - 取消流程：流内 aborted chunk / 进度按钮取消（signal.aborted 抛 AbortError）→ 不落结果文档 + 提示已取消
 *   - 异常流程：chat 抛非取消错误 → 错误提示
 *
 * 与 reviewDocument 测试同构（两命令为同一薄壳模式），mock 策略一致：
 * vi.mock('vscode') 可编程假模块 + getAgent 注入 fake Agent。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import { scaffoldProjectCommand } from '../scaffoldProject.js';

/**
 * vscode mock（vi.mock 工厂 hoisted 执行，需在此定义完整命名空间）
 *
 * 可编程点：
 *   - window.activeTextEditor：按用例赋值 mock 编辑器
 *   - workspace.getWorkspaceFolder / fs.writeFile：mock 返回值 / 调用断言
 *   - _triggerCancel()：触发进度 token 的取消回调（模拟用户点进度窗口取消按钮）
 */
const vscodeMock = vi.hoisted(() => {
  // 进度 token：保存最近一次取消回调，供 _triggerCancel 编程触发
  let onCancel: (() => void) | null = null;
  const token = {
    onCancellationRequested: (cb: () => void) => {
      onCancel = cb;
    },
  };
  return {
    window: {
      activeTextEditor: null as unknown,
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      withProgress: vi.fn(),
      showTextDocument: vi.fn(),
    },
    workspace: {
      getWorkspaceFolder: vi.fn(),
      fs: { writeFile: vi.fn() },
      openTextDocument: vi.fn(),
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    // 枚举：命令 withProgress / writeScaffoldResult 引用
    ProgressLocation: { Notification: 'notification' },
    ViewColumn: { Beside: 'beside' },
    _token: token,
    _triggerCancel: () => onCancel?.(),
  };
});

vi.mock('vscode', () => vscodeMock);

/** 构造一个 markdown 活动编辑器 */
function makeEditor(docText: string, fileName = '/proj/design.md'): unknown {
  return {
    document: { languageId: 'markdown', getText: () => docText, fileName },
  };
}

/** 构造 fake Agent：chat 为可控 async generator（依次 yield chunks） */
function makeAgent(chunks: Array<{ type: string; content?: string }>): { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async function* (_input: string, _signal?: AbortSignal) {
    for (const c of chunks) yield c;
  });
  return { chat } as unknown as { chat: ReturnType<typeof vi.fn> };
}

/** 构造生成中挂起的 fake Agent：yield 半截文本后 await gate，放行后按 signal 状态抛错或续产出 */
function makePausableAgent(): {
  chat: ReturnType<typeof vi.fn>;
  release: () => void;
  markAborted: () => void;
} {
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const state = { aborted: false };

  const chat = vi.fn(async function* (_input: string, signal?: AbortSignal) {
    yield { type: 'text', content: '骨架进度…' };
    await gate;
    if (state.aborted || signal?.aborted) {
      const err = new Error('aborted') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    }
    yield { type: 'text', content: '完成清单…' };
  });

  return {
    chat,
    release: () => releaseGate?.(),
    markAborted: () => {
      state.aborted = true;
    },
  };
}

describe('scaffoldProjectCommand', () => {
  beforeEach(() => {
    // 重置 mock 状态，避免用例间污染
    vi.mocked(vscodeMock.window.showErrorMessage).mockReset();
    vi.mocked(vscodeMock.window.showInformationMessage).mockReset();
    vi.mocked(vscodeMock.window.showTextDocument).mockReset();
    vi.mocked(vscodeMock.workspace.fs.writeFile).mockReset();
    vi.mocked(vscodeMock.workspace.openTextDocument).mockReset();
    vi.mocked(vscodeMock.workspace.getWorkspaceFolder).mockReset();
    // withProgress 默认：同步执行 task，token 用共享 mock token
    vi.mocked(vscodeMock.window.withProgress).mockImplementation(
      async (_opts: unknown, task: (p: unknown, t: unknown) => unknown) =>
        task({ report: vi.fn() }, vscodeMock._token),
    );
    vscodeMock.window.activeTextEditor = null;
  });

  it('无活动编辑器 → 提示先打开 Markdown 文档', async () => {
    vscodeMock.window.activeTextEditor = null;
    await scaffoldProjectCommand(vi.fn());
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('请先打开一个 Markdown'),
    );
  });

  it('非 markdown 文档 → 提示先打开 Markdown 文档', async () => {
    vscodeMock.window.activeTextEditor = {
      document: { languageId: 'typescript', getText: () => 'x', fileName: '/proj/a.ts' },
    };
    await scaffoldProjectCommand(vi.fn());
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('请先打开一个 Markdown'),
    );
  });

  it('空文档 → 提示无可生成的设计内容', async () => {
    vscodeMock.window.activeTextEditor = makeEditor('   ');
    await scaffoldProjectCommand(vi.fn());
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('当前文档为空'),
    );
  });

  it('无工作区 → 提示先打开工作区', async () => {
    vscodeMock.window.activeTextEditor = makeEditor('# 设计');
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    await scaffoldProjectCommand(vi.fn());
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('请先打开一个工作区'),
    );
  });

  it('正常流程 → chat 携带 AbortSignal 消费文本 → 结果写新文档并打开', async () => {
    vscodeMock.window.activeTextEditor = makeEditor('# 设计文档', '/proj/design.md');
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/workspace' } });
    const agent = makeAgent([{ type: 'text', content: 'src/' }, { type: 'text', content: 'README.md' }]);
    const getAgent = vi.fn(async () => agent as unknown as Agent);

    await scaffoldProjectCommand(getAgent);

    // 按工作区路径装配 Agent
    expect(getAgent).toHaveBeenCalledWith('/workspace');
    // chat 收到 AbortSignal（进度窗口取消通道）
    expect(agent.chat).toHaveBeenCalledTimes(1);
    const [, signal] = agent.chat.mock.calls[0] as [string, AbortSignal];
    expect(signal).toBeInstanceOf(AbortSignal);
    // 文本被拼接写入骨架生成报告，并打开
    expect(vscodeMock.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const writeArgs = vscodeMock.workspace.fs.writeFile.mock.calls[0] as [unknown, Buffer];
    expect(writeArgs[1].toString('utf8')).toContain('src/README.md');
    expect(vscodeMock.window.showTextDocument).toHaveBeenCalledTimes(1);
    // 正常完成不提示错误
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('取消（流内 aborted chunk）→ 不写结果文档 + 提示已取消', async () => {
    vscodeMock.window.activeTextEditor = makeEditor('# 设计文档', '/proj/design.md');
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/workspace' } });
    // 生成部分文本后内核 yield aborted（用户取消，内核主路径）
    const agent = makeAgent([{ type: 'text', content: 'src/' }, { type: 'aborted' }]);
    const getAgent = vi.fn(async () => agent as unknown as Agent);

    await scaffoldProjectCommand(getAgent);

    // 取消时不落盘（避免空/半截报告）
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('已取消'),
    );
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('取消（进度按钮 → signal.aborted → provider 抛 AbortError）→ 按取消处理', async () => {
    vscodeMock.window.activeTextEditor = makeEditor('# 设计文档', '/proj/design.md');
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/workspace' } });
    const agent = makePausableAgent();
    const getAgent = vi.fn(async () => agent as unknown as Agent);

    // 启动命令：chat 停在生成中（gate 挂起）
    const run = scaffoldProjectCommand(getAgent);
    // 用户点击进度窗口取消按钮 → token 回调 → controller.abort() → signal.aborted
    vscodeMock._triggerCancel();
    agent.markAborted();
    // 放行 chat：检测 signal.aborted → 抛 AbortError
    agent.release();
    await run;

    // 取消时不落盘 + 提示已取消（而非错误）
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('已取消'),
    );
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('chat 抛非取消错误 → 错误提示且不落盘', async () => {
    vscodeMock.window.activeTextEditor = makeEditor('# 设计文档', '/proj/design.md');
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/workspace' } });
    const agent = makeAgent([]);
    // chat 抛非取消错误（如工具调用失败）
    agent.chat.mockImplementationOnce(async function* () {
      throw new Error('写文件失败');
    });
    const getAgent = vi.fn(async () => agent as unknown as Agent);

    await scaffoldProjectCommand(getAgent);

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('骨架生成失败'),
    );
    expect(vscodeMock.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});
