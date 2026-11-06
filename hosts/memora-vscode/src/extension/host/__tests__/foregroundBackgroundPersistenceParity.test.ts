/**
 * E4 批 4 · 前后台一致性「真机盘上判据」
 *
 * 背景：批 4 曾用结构论证（宿主对持久化零决策 / 写盘在内核无前后台分支）说明
 * 「同一操作在显示 / 非显示会话下持久化结果相同」。那是推理，不是判据。本文件把它
 * 落成真机断言：**真内核 Agent + 真文件系统 + 真宿主 chatPanel.runFlow（含
 * `BackgroundFlowGate`）**，同一会话同一内容跑两次，只改「该会话是否处于面板当前显示」，
 * 然后逐项比对盘上产物。
 *
 * 判据口径（两次运行除显示状态外一切相同）：
 *  - 显示状态 = chatPanel 的 `_currentSessionId`（生产唯一判据点，`BackgroundFlowGate.isBackground`）
 *  - 一次操作 = 一轮对话：stub provider 首轮吐 `write_file`（界内相对路径）+ 次轮吐最终文本
 *  - 比对面 = 「界内写出的文件字节」+「会话引用的轮内容（归一化后整对象）」
 *
 * ⚠️ 归一化只抹掉天然不同的东西：roundId、ISO 时间戳、两次临时工作区绝对路径、真实墙钟耗时
 * `durationMs`（两次运行不可能相等，不属「持久化内容」）。其余内容面（用户文本 / 助手文本 /
 * 工具名与参数 / 工具结果摘要 / 过程事件类型与顺序 / seq / 状态 / refCount）一律不做替换。
 *
 * 附带判据：后台运行时 chatPanel **确实**走了后台分支（`runtime.liveBuffer` 仍建立，
 * 但投递被闸挡），否则两次运行可能都走前台，测试会假绿。
 */
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { Agent, setLogger, type LlmChunk, type LlmProvider } from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import { ProviderStore } from '../../providers/providerStore.js';
import { MemoraChatViewProvider } from '../../../webview/panels/chatPanel.js';
import { WorkspaceSessionViewLoader } from '../sessionViewLoader.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

// 宿主 chatPanel 构造 / resolveWebviewView 的 vscode 消费面（与 chatPanelSessionAgents 同款）
vi.mock('vscode', async () => ({
  env: { language: 'zh-cn' },
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    file: (p: string) => ({ fsPath: p, toString: () => p }),
    fsPath: '/mock/path',
  },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    state: { focused: true },
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

/** 被操作的目标会话（两次运行都用它） */
const TARGET_SESSION = '2026-11-06-parity';
/** 「非显示」运行时的当前显示会话（只作对照基准，不参与落盘） */
const OTHER_SESSION = '2026-11-06-other';
/** 界内写出的文件（相对项目根） */
const WRITE_PATH = 'notes/out.md';
/** 一次操作的固定内容：文件正文 */
const FILE_CONTENT = '# 前后台一致性\n同一操作的同一内容。\n';
/** 一次操作的固定内容：用户输入 */
const USER_INPUT = '请把这段内容写到 notes/out.md';
/** 最终回答文本（固定，便于逐字节比对） */
const FINAL_TEXT = '已写入 notes/out.md。';

/**
 * 确定性两轮 Provider：首轮要求写文件，次轮给最终回答。
 *
 * 内核只把 LlmProvider 作 type 导出（不能 extends），故用类 + `as unknown as LlmProvider`
 * （与 `multiInstanceSharedProject.test.ts` 同款写法）。
 */
class ToolCallProvider {
  /** Provider 名（日志/标题生成可见） */
  readonly name = 'parity-stub';

  /**
   * @param messages 对话消息（只在「是否已回填工具结果」上判读）
   * @param opts 调用选项（工具集是「本轮是否允许写文件」的判据）
   */
  async *chat(
    messages: Array<{ role: string; content?: string }>,
    opts?: { tools?: Array<{ function?: { name?: string } }> },
  ): AsyncIterable<LlmChunk> {
    // 判据不能靠调用序号：内核会先调 provider 做会话命名 / 摘要（不带工具集），
    // 按序号推会把工具轮错发给它们（实测：文件从未写出）。改用「工具集 + 是否已回填工具结果」：
    // 带 write_file 且尚无 tool 消息 ⇒ 本请求就是执行轮；否则（命名/摘要/收尾/自审查）给终文本。
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const hasWriteTool = (opts?.tools ?? []).some((t) => t.function?.name === 'write_file');
    if (!hasToolResult && hasWriteTool) {
      yield { content: '我先写入文件。' };
      yield {
        toolCalls: [
          {
            id: 'call_write_1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: WRITE_PATH, content: FILE_CONTENT }),
            },
          },
        ],
        finishReason: 'tool_calls',
      };
      return;
    }
    yield { content: FINAL_TEXT, finishReason: 'stop' };
  }
}

/**
 * 播种角色包目录（与内核 `agent.test.ts` / `multiInstanceSharedProject.test.ts` 同形态）
 *
 * @param configDir 宿主配置目录（Agent 的 `configDir`）
 */
function seedRolePacks(configDir: string): void {
  const defaultDir = join(configDir, 'role-packs', '默认助手');
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(
    join(defaultDir, 'manifest.json'),
    JSON.stringify({ name: '默认助手', displayName: '默认助手', strategy: {} }),
    'utf-8',
  );
  writeFileSync(join(defaultDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  // 兜底契约包（单链：无 activePack 注入时落兜底包，非 items[0]）
  const fallbackDir = join(configDir, 'role-packs', 'memora助手');
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(
    join(fallbackDir, 'manifest.json'),
    JSON.stringify({ name: 'memora助手', formatVersion: '1.0.0' }),
    'utf-8',
  );
  writeFileSync(join(fallbackDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  mkdirSync(join(configDir, 'skills'), { recursive: true });
}

/** 天然不同的字段名（比较前整值替换为占位符，仅这些，不含内容字段） */
const VOLATILE_KEYS = new Set([
  'createdAt',
  'completedAt',
  'updatedAt',
  'timestamp',
  'ts',
  'startedAt',
  'finishedAt',
  'startTime',
  'endTime',
  // 真实墙钟耗时：两次运行必然不同，不属「持久化内容」；除它之外内容面一律照比
  'durationMs',
]);

/**
 * 归一化一次运行的盘上产物（只抹标识，不抹内容）
 *
 * @param value 原始值（轮对象 / JSON 值）
 * @param projectPath 本次临时工作区根（替换为 `<ROOT>`，两次运行路径必然不同）
 * @param roundId 本轮 ID（替换为 `<ROUND>`）
 */
function scrub(value: unknown, projectPath: string, roundId: string): unknown {
  if (typeof value === 'string') {
    return (
      value
        .split(projectPath)
        .join('<ROOT>')
        .split(projectPath.replace(/\\/g, '/'))
        .join('<ROOT>')
        .split(roundId)
        .join('<ROUND>')
        // ISO 时间戳（RoundMessage.timestamp / createdAt 等）
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>')
    );
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, projectPath, roundId));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = VOLATILE_KEYS.has(k) ? '<TS>' : scrub(v, projectPath, roundId);
    }
    return out;
  }
  return value;
}

/** 一次运行的结果（供两次比对与人工可见的实际对比输出） */
interface RunResult {
  /** 界内写出的文件字节（UTF-8；不存在为 null） */
  fileBytes: string | null;
  /** 会话文件里的 roundIds 长度 */
  roundCount: number;
  /** 会话引用的轮对象（已归一化；null = 没落盘） */
  round: unknown;
  /** 本会话运行态的 live 缓冲是否建立过（后台分支仍执行到 consumeFlow 的附带判据） */
  hadLiveBuffer: boolean;
  /** 面板本轮实际投递过的消息类型（显示状态分支的实测证据） */
  postedTypes: string[];
}

/**
 * 以指定显示状态跑一次「同一操作」
 *
 * @param mode 'foreground' = 目标会话正被面板显示；'background' = 面板显示另一个会话
 */
async function runOnce(mode: 'foreground' | 'background'): Promise<RunResult> {
  const projectPath = makeTempDir('memora-fbparity-');
  const configDir = join(projectPath, 'config');
  seedRolePacks(configDir);
  mkdirSync(join(projectPath, 'notes'), { recursive: true });

  // 宿主真实 store（与内核注入同一实例：生产装配形态）
  const roundStore = new WorkspaceRoundStore(projectPath);
  roundStore.load();
  const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
  sessionStore.load();
  // 对照基准会话必须先真实存在（后台模式面板显示它，等价于用户切到该会话）
  sessionStore.createSession({
    sessionId: OTHER_SESSION,
    displayName: OTHER_SESSION,
    updatedAt: '2026-11-06T10:00:00.000Z',
    messageCount: 0,
  });

  const storage = createHostMemoryStorage(projectPath);
  const agent = new Agent({
    projectPath,
    dataDir: resolveProjectDataDir(projectPath),
    configDir,
    provider: new ToolCallProvider() as unknown as LlmProvider,
    // manual：不引入后台摘要 LLM 调用的时序噪声（落盘与显示状态无关是本判据的前提）
    archiveMode: 'manual',
    permission: 'owner',
    allowedPaths: [projectPath],
    storage,
    sessionStore,
    roundStore,
  });
  await agent.init();
  await agent.sessionManager!.switchToSession(TARGET_SESSION);

  const secrets = {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as vscode.SecretStorage;
  const panel = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    sessionStore,
    new ProviderStore(secrets) as never,
    projectPath,
  );
  // 视图替身：收集投递类型——这是「两次运行确实走了不同显示状态分支」的实测证据
  // （`postTurnUpdate` 在后台早退，前台必发 `turn_update`；不是推导）
  const postedTypes: string[] = [];
  const view = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      cspSource: 'mock-csp',
      postMessage: (msg: { type?: string }) => {
        if (msg?.type) postedTypes.push(msg.type);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    onDidDispose: () => ({ dispose: () => {} }),
  };
  panel.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken,
  );

  // 生产注入：过程事件落盘目标（不注入则宿主侧 processEvents 落盘整条路径零覆盖，判据有洞）
  panel.setRoundStore(roundStore);

  // 真实运行态：把目标会话实例挂进面板投影表，并决定「谁在显示」
  const cast = panel as unknown as {
    _agent?: Agent;
    _currentSessionId: string;
    _sessionAgents: Map<string, Agent>;
    _viewLoader: unknown;
    runtimeFor(sessionId?: string): { liveBuffer?: unknown };
    runFlow(
      factory: (signal: AbortSignal) => AsyncGenerator<UnknownChunk>,
      seed?: undefined,
      sessionId?: string,
    ): Promise<void>;
  };
  cast._sessionAgents.set(TARGET_SESSION, agent);
  cast._agent = agent;
  cast._viewLoader = new WorkspaceSessionViewLoader(roundStore, sessionStore);
  cast._currentSessionId = mode === 'foreground' ? TARGET_SESSION : OTHER_SESSION;

  // 附带判据证据（全部**实测**）：live 缓冲是否真的建立（后台流仍执行到 consumeFlow）
  let hadLiveBuffer = false;
  /**
   * 生产流入口的包装：只在 chunk 边界采样运行态，不改动流本身
   *
   * @param signal runFlow 传入的中断信号
   */
  const wrapped = async function* (signal: AbortSignal): AsyncGenerator<UnknownChunk> {
    for await (const chunk of agent.chat(USER_INPUT, signal)) {
      if (cast.runtimeFor(TARGET_SESSION).liveBuffer !== undefined) hadLiveBuffer = true;
      yield chunk;
    }
  };

  // 生产入口：runFlow（含 BackgroundFlowGate.run(sessionId, ...) + consumeFlow）
  await cast.runFlow((signal) => wrapped(signal), undefined, TARGET_SESSION);

  // ── 读盘（真文件，不经 store API，避免「读内存假象」） ──
  const absWrite = join(projectPath, WRITE_PATH);
  let fileBytes: string | null = null;
  try {
    fileBytes = readFileSync(absWrite, 'utf8');
  } catch {
    fileBytes = null; // 缺失即 null，比对面直接暴露「后台没落盘」
  }
  const sessionFile = join(
    resolveProjectDataDir(projectPath),
    'sessions',
    `${encodeURIComponent(TARGET_SESSION)}.json`,
  );
  const sessionData = JSON.parse(readFileSync(sessionFile, 'utf8')) as { roundIds?: string[] };
  const roundIds = sessionData.roundIds ?? [];
  const firstRoundId = roundIds[0] ?? '';
  let round: unknown = null;
  if (firstRoundId) {
    round = JSON.parse(
      readFileSync(
        join(resolveProjectDataDir(projectPath), 'rounds', `${firstRoundId}.json`),
        'utf8',
      ),
    );
  }

  await agent.close();
  // SQLite 连接由 storage 持有，显式关闭避免临时目录清理时 EBUSY（不影响判据）
  (storage as unknown as { close?: () => void }).close?.();

  return {
    fileBytes,
    roundCount: roundIds.length,
    round: round === null ? null : scrub(round, projectPath, firstRoundId),
    hadLiveBuffer,
    postedTypes,
  };
}

/** consumeFlow 只消费 AgentChunk 的判别字段；本文件用宽形态避免与内核类型重复声明 */
type UnknownChunk = { type: string; [k: string]: unknown };

describe('E4 批 4 · 前后台一致性（真机盘上判据）', () => {
  afterEach(() => {
    setLogger(undefined);
  });

  it('同一会话同一操作：显示 / 非显示两次运行的落盘产物一致', async () => {
    const foreground = await runOnce('foreground');
    const background = await runOnce('background');

    // 实际对比结果原样输出（不是只给结论：两次快照 + 比对项）
    console.log('[parity] 显示运行 fileBytes =', JSON.stringify(foreground.fileBytes));
    console.log('[parity] 非显示运行 fileBytes =', JSON.stringify(background.fileBytes));
    console.log(
      '[parity] 显示运行 roundCount =',
      foreground.roundCount,
      'background =',
      background.roundCount,
    );
    console.log('[parity] 显示运行 round =', JSON.stringify(foreground.round));
    console.log('[parity] 非显示运行 round =', JSON.stringify(background.round));

    // ① 显示状态分支确实不同（实测证据 = 生产投递行为，不是推导）：
    //    前台 `postTurnUpdate` 生效 ⇒ 必有 turn_update；后台该投影整批早退 ⇒ 必无
    expect(foreground.postedTypes).toContain('turn_update');
    expect(background.postedTypes).not.toContain('turn_update');
    console.log('[parity] 显示运行投递 =', foreground.postedTypes.join(','));
    console.log('[parity] 非显示运行投递 =', background.postedTypes.join(','));
    // ② 后台分支确实执行到 consumeFlow（live 缓冲建立），只是投递被闸挡
    expect(foreground.hadLiveBuffer).toBe(true);
    expect(background.hadLiveBuffer).toBe(true);

    // ③ 界内文件：存在且字节相同
    expect(foreground.fileBytes).not.toBeNull();
    expect(background.fileBytes).toBe(foreground.fileBytes);
    expect(foreground.fileBytes).toBe('# 前后台一致性\n同一操作的同一内容。\n');

    // ④ 会话文件里的轮：数量与轮内容整对象相同（已归一化标识）
    expect(foreground.roundCount).toBe(1);
    expect(background.roundCount).toBe(1);
    expect(foreground.round).not.toBeNull();
    expect(background.round).toEqual(foreground.round);
  }, 180_000);
});
