/**
 * 托管模式 v0 · 切片 0：主控会话工具接线验收
 *
 * 判据（两条，缺一不可）：
 *   ① 装配标记为真的会话：工具面里**有** `list_work_sessions`，且能真的调到自身元数据；
 *   ② 普通会话（标记缺省 / 显式 false）：工具面里**没有**该工具（「不存在」而不是「报错」）。
 *
 * 为什么走真实 `assembleAgent`：注册点若放错位置（init 之前 / 只在某条分支里）或参数没被
 * 真正消费，只有端到端装配能红——直接调 `registerWorkSessionTools` 只能证明函数自身能跑。
 */
// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { assembleAgent } from '../assemble.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { LIST_WORK_SESSIONS_TOOL_NAME, SEND_TO_SESSION_TOOL_NAME } from '../workSessionTools.js';
import type {
  HostedDispatchResult,
  HostedInputDispatcher,
  SendToSessionResult,
} from '../workSessionTools.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

// 装配链间接 import 了 tracer / searchEngines（模块级 import vscode），本测试不触真实 VS Code API：
// 最小替身只让模块可解析，被测路径只用得到 l10n 的键面回填（与 hostIntegration 同款替身语义）。
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, index) => String(args[Number(index)] ?? m)),
  },
}));

/** 播种的「主控自身」会话标识（工具返回值里必须能找到它） */
const SESSION_ID = '2026-11-14-orchestrator-probe';
/** 播种的会话标题（displayName 优先链的验证输入） */
const SESSION_TITLE = '主控探针会话';
/** 播种的最后更新时间（固定值，避免依赖当前时钟） */
const SESSION_UPDATED_AT = '2026-11-14T08:00:00.000Z';
/** 播种的「目标会话」标识（派发用例的目标；与主控自身区分开） */
const TARGET_SESSION_ID = '2026-11-14-target-probe';
/** 装配期注入的发送者名（断言工具原样交给派发回调，而不是自造字面量） */
const SENDER_NAME = '派发探针';

/**
 * 播种角色包目录（真实 `assembleAgent` 的 init 必须能扫描到角色包）
 *
 * @param projectPath 临时工作区路径
 * @returns 装配用的 configDir
 */
function seedConfigDir(projectPath: string): string {
  const configDir = join(projectPath, 'config');
  const packDir = join(configDir, 'role-packs', '默认助手');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(
    join(packDir, 'manifest.json'),
    JSON.stringify({ name: '默认助手', displayName: '默认助手', strategy: {} }),
    'utf-8',
  );
  writeFileSync(join(packDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  // 技能目录：与生产一致（扫描容错，空目录亦可）
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  return configDir;
}

/**
 * 探针装配结果（Agent + 显式持有的记忆存储）
 *
 * 存储显式注入并单独关闭：Windows 下 SQLite 句柄释放晚于 `agent.close()` 会留下 EBUSY，
 * 临时目录清理报噪音（不失败，但会淹没真实告警）。
 */
interface Probe {
  /** 已 init 的 Agent */
  agent: Agent;
  /** 注入的记忆存储（所有权归本测试，收尾显式 close） */
  storage: ReturnType<typeof createHostMemoryStorage>;
}

/**
 * 起一个真实装配的探针 Agent
 *
 * @param orchestratorSession 主控标记（undefined = 调用方完全不传该键）
 * @param dispatch 派发回调（传入 = 连同调用方 id / 发送者名一起注入，send_to_session 才注册）
 * @returns 探针（Agent + 存储）
 */
async function assembleProbe(
  orchestratorSession?: boolean,
  dispatch?: HostedInputDispatcher,
): Promise<Probe> {
  const projectPath = makeTempDir('memora-work-session-');
  const configDir = seedConfigDir(projectPath);
  const roundStore = new WorkspaceRoundStore(projectPath);
  roundStore.load();
  const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
  sessionStore.load();
  // 播种一个会话元数据：它既是「工作区已知会话」，也是本用例里的「主控自身」
  sessionStore.createSession({
    sessionId: SESSION_ID,
    displayName: SESSION_TITLE,
    updatedAt: SESSION_UPDATED_AT,
    messageCount: 0,
  });
  // 再播种一个目标会话：派发用例的 sid 必须真实存在（存在性判据走 listSessionMetas）
  sessionStore.createSession({
    sessionId: TARGET_SESSION_ID,
    displayName: '目标探针会话',
    updatedAt: SESSION_UPDATED_AT,
    messageCount: 0,
  });
  const storage = createHostMemoryStorage(projectPath);
  const agent = await assembleAgent({
    projectPath,
    configDir,
    sessionStore,
    roundStore,
    storage,
    // 不引入后台摘要 LLM 调用与时序噪声
    archiveMode: 'manual',
    autoStartGc: false,
    // Provider 仅构造、不发起网络请求：填必填的环境变量形态即可
    env: {
      MEMORA_BASE_URL: 'http://127.0.0.1:1/v1',
      MEMORA_MODEL: 'work-session-probe',
      MEMORA_API_KEY: 'work-session-probe',
    } as NodeJS.ProcessEnv,
    ...(orchestratorSession === undefined ? {} : { orchestratorSession }),
    // 派发依赖三件套同批注入：只传其中一部分时装配层按「依赖不全」不注册 send_to_session
    ...(dispatch === undefined
      ? {}
      : {
          orchestratorSessionId: SESSION_ID,
          orchestratorSenderName: SENDER_NAME,
          dispatchHostedInput: dispatch,
        }),
  });
  return { agent, storage };
}

/**
 * 收尾：先关 Agent（停定时器 / 摘锁），再关注入的存储（释放 SQLite 句柄）
 *
 * @param probe 探针
 */
async function disposeProbe(probe: Probe): Promise<void> {
  await probe.agent.close().catch(() => undefined);
  // close 在接口里是可选能力（JSON 降级实现无句柄可关）
  probe.storage.close?.();
}

describe('托管 v0 · 切片 0：主控会话工具接线', () => {
  it('主控会话能调到 list_work_sessions，并拿到自身元数据', async () => {
    const probe = await assembleProbe(true);
    try {
      const tools = probe.agent.tools;
      expect(tools).not.toBeNull();
      // ① 工具面真的多了一个（模型可见）
      expect(tools!.list.map((t) => t.name)).toContain(LIST_WORK_SESSIONS_TOOL_NAME);

      // ② 真的能跑：返回 JSON 信封，且包含播种的自身元数据
      const raw = await tools!.execute(LIST_WORK_SESSIONS_TOOL_NAME, '{}');
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        sessions: { sid: string; title: string; updatedAt: string }[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.sessions).toContainEqual({
        sid: SESSION_ID,
        title: SESSION_TITLE,
        updatedAt: SESSION_UPDATED_AT,
      });
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it.each([
    ['缺省', undefined],
    ['显式 false', false],
  ] as const)(
    '普通会话（%s）的工具面里没有 list_work_sessions',
    async (_label, flag) => {
      const probe = await assembleProbe(flag);
      try {
        const tools = probe.agent.tools;
        expect(tools).not.toBeNull();
        // 暴露面没有
        expect(tools!.list.map((t) => t.name)).not.toContain(LIST_WORK_SESSIONS_TOOL_NAME);
        // 定义面也没有：证明不是「注册了但被白名单藏起来」
        expect(tools!.allToolDefinitions.map((t) => t.name)).not.toContain(
          LIST_WORK_SESSIONS_TOOL_NAME,
        );
      } finally {
        await disposeProbe(probe);
      }
    },
    120_000,
  );
});

/**
 * 调一次 `send_to_session` 并解析返回 JSON
 *
 * @param probe 探针（真实装配的 Agent）
 * @param args 工具参数对象（按执行器契约序列化成 JSON 字符串）
 * @returns 解析后的结果信封（码集见 `SendToSessionResult`，含工具层自判的 `E_ARGS`）
 */
async function executeSend(
  probe: Probe,
  args: Record<string, unknown>,
): Promise<SendToSessionResult> {
  const raw = await probe.agent.tools!.execute(SEND_TO_SESSION_TOOL_NAME, JSON.stringify(args));
  return JSON.parse(raw) as SendToSessionResult;
}

describe('托管 v0 · send_to_session 最小闭环（工具层）', () => {
  it('参数只认 { sid, text }：未知键 / 空白串一律 E_ARGS，且不触派发', async () => {
    // 派发回调不应被调用：参数不合法时必须在工具层就返回，不能把脏载荷交给宿主
    const dispatch = vi.fn(async (): Promise<HostedDispatchResult> => ({
      ok: true,
      accepted: true,
    }));
    const probe = await assembleProbe(true, dispatch);
    try {
      // 未知键：键集必须恰好两枚（缺必填键由内核执行器按 schema 先拦，到不了本 handler）
      expect(
        await executeSend(probe, { sid: TARGET_SESSION_ID, text: 'hi', extra: 1 }),
      ).toMatchObject({ ok: false, code: 'E_ARGS' });
      // text 只有空白：trim 后为空，同样不收
      expect(await executeSend(probe, { sid: TARGET_SESSION_ID, text: '   ' })).toMatchObject({
        ok: false,
        code: 'E_ARGS',
      });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('未知会话 ⇒ E_NOT_FOUND，且不触派发（存在性在工具层先判）', async () => {
    const dispatch = vi.fn(async (): Promise<HostedDispatchResult> => ({
      ok: true,
      accepted: true,
    }));
    const probe = await assembleProbe(true, dispatch);
    try {
      expect(await executeSend(probe, { sid: '2026-11-14-not-exist', text: 'hi' })).toMatchObject({
        ok: false,
        code: 'E_NOT_FOUND',
      });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('受理：调用方 id / 目标 sid / 原文 / 注入的发送者名四件原样交给派发回调', async () => {
    const dispatch = vi.fn(async (): Promise<HostedDispatchResult> => ({
      ok: true,
      accepted: true,
    }));
    const probe = await assembleProbe(true, dispatch);
    try {
      expect(await executeSend(probe, { sid: TARGET_SESSION_ID, text: '请看这个任务' })).toEqual({
        ok: true,
        accepted: true,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      // 发送者名必须是装配期注入值：工具内写死字面量会让本断言转红
      expect(dispatch).toHaveBeenCalledWith(
        SESSION_ID,
        TARGET_SESSION_ID,
        '请看这个任务',
        SENDER_NAME,
      );
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('派发层的业务失败码原样透传（工具层不改写 E_BUSY）', async () => {
    const dispatch = vi.fn(async (): Promise<HostedDispatchResult> => ({
      ok: false,
      code: 'E_BUSY',
      message: '目标会话正在运行，本条输入未发送。',
    }));
    const probe = await assembleProbe(true, dispatch);
    try {
      expect(await executeSend(probe, { sid: TARGET_SESSION_ID, text: 'hi' })).toMatchObject({
        ok: false,
        code: 'E_BUSY',
      });
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('派发回调抛错 ⇒ 工具不抛，回 E_HOST（宿主故障不得冒名「未知会话」）', async () => {
    const dispatch = vi.fn(async (): Promise<HostedDispatchResult> => {
      throw new Error('装配失败');
    });
    const probe = await assembleProbe(true, dispatch);
    try {
      // 码必须是 E_HOST：若仍映射成 E_NOT_FOUND，模型会误判「换个 sid 就能成」
      expect(await executeSend(probe, { sid: TARGET_SESSION_ID, text: 'hi' })).toMatchObject({
        ok: false,
        code: 'E_HOST',
      });
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('主控但缺派发依赖 ⇒ send_to_session 根本不注册（list 仍在）', async () => {
    // 只传主控标记、不传派发三件套：宁可不注册，也不注册一个永远失败的空壳
    const probe = await assembleProbe(true);
    try {
      const tools = probe.agent.tools;
      expect(tools!.list.map((t) => t.name)).toContain(LIST_WORK_SESSIONS_TOOL_NAME);
      expect(tools!.list.map((t) => t.name)).not.toContain(SEND_TO_SESSION_TOOL_NAME);
      expect(tools!.allToolDefinitions.map((t) => t.name)).not.toContain(SEND_TO_SESSION_TOOL_NAME);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
});
