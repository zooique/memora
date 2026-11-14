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
import { SOURCE_LABELS } from '@zooique/memora';
import type { Agent } from '@zooique/memora';
import { assembleAgent } from '../assemble.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import {
  buildMemorySummaryFacts,
  CREATE_SESSION_TOOL_NAME,
  LIST_ROLE_PACKS_TOOL_NAME,
  LIST_WORK_SESSIONS_TOOL_NAME,
  PAUSE_WORK_SESSION_TOOL_NAME,
  READ_MEMORY_SUMMARY_TOOL_NAME,
  RESUME_WORK_SESSION_TOOL_NAME,
  SEND_TO_SESSION_TOOL_NAME,
  STOP_WORK_SESSION_TOOL_NAME,
} from '../workSessionTools.js';
import type {
  CreateSessionResult,
  HostedDispatchResult,
  HostedInputDispatcher,
  HostedSessionCreator,
  HostedSessionPauser,
  HostedSessionResumer,
  HostedSessionStopper,
  SendToSessionResult,
  SessionHistoryFacts,
} from '../workSessionTools.js';
// 状态判别联合与生产同源（清单项断言不手抄字符串）
import type { WorkbenchJobStatus } from '../../../shared/workbenchDto.js';
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
/** 播种的目标会话角色包名（清单项 rolePack 的正例输入） */
const TARGET_ROLE_PACK = '资料员';
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
  /** 探针会话库（范围声明用例直接播种 `declaredPaths`） */
  sessionStore: WorkspaceSessionStore;
}

/**
 * 主控工具依赖（可只覆盖其中一项，其余给最小可用替身）
 *
 * 装配层要求「调用方 id + 发送者名」才注册 list：缺项时 list 仍在，但状态 / 归属
 * 只能是 unreadable / unknown（宁可说不知道，也不冒充空闲）。
 */
interface HostedDeps {
  /** 派发回调（缺省 = 直接受理） */
  dispatch?: HostedInputDispatcher;
  /** 建会话回调（缺省 = 返回固定 sid/title） */
  createSession?: HostedSessionCreator;
  /** 停止回调（缺省 = 报告停到了活） */
  stopSession?: HostedSessionStopper;
  /** 暂停回调（缺省 = 报告申请已受理） */
  pauseSession?: HostedSessionPauser;
  /** 恢复回调（缺省 = 报告续跑已启动） */
  resumeSession?: HostedSessionResumer;
  /** 状态读口（缺省 = 一律 completed，便于断言清单形态） */
  readStatus?: (sessionId: string) => WorkbenchJobStatus;
  /** 创建者账本（缺省 = 空账本） */
  agentCreated?: (orchestratorId: string) => readonly string[];
  /** 历史重建（缺省 = 读全了且没有创建记录） */
  readHistory?: (orchestratorId: string) => SessionHistoryFacts;
}

/**
 * 播种用户级 / 项目级角色包目录（各一个包）
 *
 * 只为验证 `list_role_packs` 的来源标记：内置包来自 configDir，用户包 / 项目包
 * 必须由这两个目录真实加载，来源层判定才有输入（否则三条都会被判成内置）。
 *
 * @param projectPath 临时工作区路径
 * @returns 两个额外角色包目录
 */
function seedRolePackDirs(projectPath: string): {
  userRolePacksDir: string;
  projectRolePacksDir: string;
} {
  const userRolePacksDir = join(projectPath, 'user-role-packs');
  const projectRolePacksDir = join(projectPath, 'project-role-packs');
  for (const [dir, name] of [
    [userRolePacksDir, '我的助手'],
    [projectRolePacksDir, '项目助手'],
  ] as const) {
    const packDir = join(dir, name);
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      JSON.stringify({ name, displayName: name, strategy: {} }),
      'utf-8',
    );
    writeFileSync(join(packDir, 'persona.md'), '你是播种出来的角色包。', 'utf-8');
  }
  return { userRolePacksDir, projectRolePacksDir };
}

/**
 * 起一个真实装配的探针 Agent
 *
 * @param orchestratorSession 主控标记（undefined = 调用方完全不传该键）
 * @param hosted 主控工具依赖盒（传入 = 连同调用方 id / 发送者名一起注入；缺项用替身补齐）
 * @returns 探针（Agent + 存储）
 */
async function assembleProbe(orchestratorSession?: boolean, hosted?: HostedDeps): Promise<Probe> {
  const projectPath = makeTempDir('memora-work-session-');
  const configDir = seedConfigDir(projectPath);
  // 用户 / 项目角色包目录：来源标记用例的真实输入（内置包在 configDir 里）
  const { userRolePacksDir, projectRolePacksDir } = seedRolePackDirs(projectPath);
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
    // 托管来源：与代理开的子会话同形（归属判定不能只看 origin，见 projectCreatedBy）
    origin: 'hosted',
    // 会话记录的角色包（清单项的 rolePack 取自这个既有字段，不是装配兜底值）
    activeRolePackName: TARGET_ROLE_PACK,
  });
  const storage = createHostMemoryStorage(projectPath);
  const agent = await assembleAgent({
    projectPath,
    configDir,
    // 与生产同形：内置 / 用户 / 项目三层目录都注入（来源判定才有三档输入）
    userRolePacksDir,
    projectRolePacksDir,
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
    // 依赖盒：调用方 id / 发送者名 + 状态归属读口；派发 / 建会话缺项时装配层降级
    ...(hosted === undefined
      ? {}
      : {
          orchestratorSessionId: SESSION_ID,
          orchestratorSenderName: SENDER_NAME,
          dispatchHostedInput:
            hosted.dispatch ??
            (async (): Promise<HostedDispatchResult> => ({ ok: true, accepted: true })),
          createHostedSession:
            hosted.createSession ??
            (async (_calling, _rolePack, title) => ({ ok: true, sid: '2026-11-14-new', title })),
          stopHostedSession:
            hosted.stopSession ??
            (async (): Promise<{ ok: true; stopped: boolean }> => ({ ok: true, stopped: true })),
          pauseHostedSession:
            hosted.pauseSession ??
            (async (): Promise<{ ok: true; paused: boolean; already: boolean }> => ({
              ok: true,
              paused: true,
              already: false,
            })),
          resumeHostedSession:
            hosted.resumeSession ??
            (async (): Promise<{ ok: true; resumed: boolean }> => ({ ok: true, resumed: true })),
          readHostedStatus:
            hosted.readStatus ?? ((): WorkbenchJobStatus => ({ kind: 'completed' })),
          hostedAgentCreated: hosted.agentCreated ?? ((): readonly string[] => []),
          readHostedHistory:
            hosted.readHistory ??
            ((): SessionHistoryFacts => ({
              coverage: 'complete',
              children: [],
              totalRounds: 0,
              scannedRounds: 0,
            })),
        }),
  });
  return { agent, storage, sessionStore };
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
    // 传空依赖盒 = 装配层注入完整读口（状态 / 归属），与生产同形
    const probe = await assembleProbe(true, {});
    try {
      const tools = probe.agent.tools;
      expect(tools).not.toBeNull();
      // ① 工具面真的多了一个（模型可见）
      expect(tools!.list.map((t) => t.name)).toContain(LIST_WORK_SESSIONS_TOOL_NAME);

      // ② 真的能跑：返回 JSON 信封，且包含播种的自身元数据（状态 + 归属）
      const raw = await tools!.execute(LIST_WORK_SESSIONS_TOOL_NAME, '{}');
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        coverage: string;
        scan: { totalRounds: number; scannedRounds: number; truncated: boolean };
        sessions: {
          sid: string;
          title: string;
          updatedAt: string;
          status: WorkbenchJobStatus;
          createdBy: string;
          rolePack: string | null;
        }[];
      };
      expect(parsed.ok).toBe(true);
      // 历史读全、调用方在清单里 ⇒ 覆盖状态不能含糊
      expect(parsed.coverage).toBe('complete');
      expect(parsed.scan).toEqual({ totalRounds: 0, scannedRounds: 0, truncated: false });
      expect(parsed.sessions).toContainEqual({
        sid: SESSION_ID,
        title: SESSION_TITLE,
        // 没有归档过摘要 ⇒ null（绝不拿标题 / 空串冒充）
        summary: null,
        updatedAt: SESSION_UPDATED_AT,
        // 缺省读口 = completed（用例只验接线；状态推导由 shared/sessionStatus 单测覆盖）
        status: { kind: 'completed' },
        // 普通会话（无 hosted 来源标记）= 用户自己建的
        createdBy: 'user',
        // 该会话没有记录角色包 ⇒ null（不是空串，也不是种子里的默认包「默认助手」）
        rolePack: null,
      });
      // 有记录的角色包如实带出（取 SessionMeta.activeRolePackName，只读不落盘）
      expect(parsed.sessions.find((s) => s.sid === TARGET_SESSION_ID)?.rolePack).toBe(
        TARGET_ROLE_PACK,
      );
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('状态读不到时如实标 unreadable，绝不当成空闲（不是 queued / completed）', async () => {
    // 最危险的一条：读不到若表现成「没在跑」，代理会重复派活、重复花钱。
    const probe = await assembleProbe(true, {
      readStatus: () => ({ kind: 'unreadable' }),
    });
    try {
      const raw = await probe.agent.tools!.execute(LIST_WORK_SESSIONS_TOOL_NAME, '{}');
      const parsed = JSON.parse(raw) as {
        sessions: { sid: string; status: WorkbenchJobStatus }[];
      };
      const own = parsed.sessions.find((session) => session.sid === SESSION_ID);
      expect(own?.status).toEqual({ kind: 'unreadable' });
      // 明确钉住「不能冒充」的两个空闲语义
      expect(own?.status.kind).not.toBe('queued');
      expect(own?.status.kind).not.toBe('completed');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('归档摘要原样进清单；没归档的会话是 null，不拿标题冒充（判据 1 数据面）', async () => {
    const probe = await assembleProbe(true, {});
    try {
      // 只给目标会话播种归档摘要：另一条（主控自身）保持「从未归档」
      probe.sessionStore.updateSessionMeta(TARGET_SESSION_ID, {
        summary: '把托管会话工具接到宿主装配面，并补了范围门禁。',
      });
      const raw = await probe.agent.tools!.execute(LIST_WORK_SESSIONS_TOOL_NAME, '{}');
      const parsed = JSON.parse(raw) as {
        sessions: { sid: string; title: string; summary: string | null }[];
      };
      const target = parsed.sessions.find((s) => s.sid === TARGET_SESSION_ID);
      expect(target?.summary).toBe('把托管会话工具接到宿主装配面，并补了范围门禁。');
      const own = parsed.sessions.find((s) => s.sid === SESSION_ID);
      expect(own?.summary).toBeNull();
      // 负例：null 绝不能是标题（标题 ≠ 摘要）
      expect(own?.summary).not.toBe(own?.title);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('历史只读了一部分时，覆盖状态如实降级，来源不明标 unknown', async () => {
    const probe = await assembleProbe(true, {
      // 账本为空（模拟重启后）+ 历史截断：托管来源的目标会话无法确认是谁开的
      agentCreated: () => [],
      readHistory: () => ({
        coverage: 'partial',
        children: [],
        totalRounds: 120,
        scannedRounds: 60,
      }),
    });
    try {
      const raw = await probe.agent.tools!.execute(LIST_WORK_SESSIONS_TOOL_NAME, '{}');
      const parsed = JSON.parse(raw) as {
        coverage: string;
        scan: { totalRounds: number; scannedRounds: number; truncated: boolean };
        sessions: { sid: string; createdBy: string }[];
      };
      expect(parsed.coverage).toBe('partial');
      expect(parsed.scan).toEqual({ totalRounds: 120, scannedRounds: 60, truncated: true });
      // 托管来源 + 账本没记 + 历史没扫到 ⇒ 不知道，不猜「用户」也不猜「代理」
      expect(parsed.sessions.find((s) => s.sid === TARGET_SESSION_ID)?.createdBy).toBe('unknown');
      // 用户来源（无 hosted 标记）不依赖历史，仍可确定
      expect(parsed.sessions.find((s) => s.sid === SESSION_ID)?.createdBy).toBe('user');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('停自己开的活：走注入的停止回调，并回传停止前的真实状态', async () => {
    /** 停止回调收到的 (调用方, 目标) */
    const calls: [string, string][] = [];
    const probe = await assembleProbe(true, {
      // 账本命中 = 代理开的（与工作台同一真源）
      agentCreated: () => [TARGET_SESSION_ID],
      readStatus: () => ({ kind: 'running' }),
      stopSession: async (calling, target) => {
        calls.push([calling, target]);
        return { ok: true, stopped: true };
      },
    });
    try {
      const raw = await probe.agent.tools!.execute(
        STOP_WORK_SESSION_TOOL_NAME,
        JSON.stringify({ sid: TARGET_SESSION_ID }),
      );
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        stopped: boolean;
        status: WorkbenchJobStatus;
      };
      expect(parsed).toEqual({ ok: true, stopped: true, status: { kind: 'running' } });
      // 停止只传会话 id；不传轮 id ⇒ 停止前由面板实时读实例，不存在「拿过期轮去停」
      expect(calls).toEqual([[SESSION_ID, TARGET_SESSION_ID]]);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('用户自己建的会话：代理不许停（E_DENIED，且不触发停止回调）', async () => {
    /** 是否调用过停止回调 */
    let stopped = false;
    const probe = await assembleProbe(true, {
      // SESSION_ID 无 hosted 标记 = 用户自己建的
      stopSession: async () => {
        stopped = true;
        return { ok: true, stopped: true };
      },
    });
    try {
      const raw = await probe.agent.tools!.execute(
        STOP_WORK_SESSION_TOOL_NAME,
        JSON.stringify({ sid: SESSION_ID }),
      );
      const parsed = JSON.parse(raw) as { ok: boolean; code: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('E_DENIED');
      expect(stopped).toBe(false);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('无法确认归属（托管来源但账本没记）→ E_DENIED，不猜着停', async () => {
    let stopped = false;
    const probe = await assembleProbe(true, {
      // 账本为空、历史读全但没有这条创建记录 ⇒ createdBy=unknown
      stopSession: async () => {
        stopped = true;
        return { ok: true, stopped: true };
      },
    });
    try {
      const raw = await probe.agent.tools!.execute(
        STOP_WORK_SESSION_TOOL_NAME,
        JSON.stringify({ sid: TARGET_SESSION_ID }),
      );
      const parsed = JSON.parse(raw) as { ok: boolean; code: string };
      expect(parsed.code).toBe('E_DENIED');
      expect(stopped).toBe(false);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('状态已收场 / 读不到：不调停止回调（stopped=false 或 E_UNREADABLE）', async () => {
    /** 已收场时是否调用过停止回调 */
    let settledCalls = 0;
    let status: WorkbenchJobStatus = { kind: 'completed' };
    const probe = await assembleProbe(true, {
      agentCreated: () => [TARGET_SESSION_ID],
      readStatus: () => status,
      stopSession: async () => {
        settledCalls += 1;
        return { ok: true, stopped: true };
      },
    });
    try {
      // 已收场：如实说没停到，不调停止回调
      const settled = JSON.parse(
        await probe.agent.tools!.execute(
          STOP_WORK_SESSION_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID }),
        ),
      ) as { ok: boolean; stopped: boolean; status: WorkbenchJobStatus };
      expect(settled).toEqual({ ok: true, stopped: false, status: { kind: 'completed' } });
      expect(settledCalls).toBe(0);
      // 读不到：拒绝停止，绝不猜「它没在跑」
      status = { kind: 'unreadable' };
      const unreadable = JSON.parse(
        await probe.agent.tools!.execute(
          STOP_WORK_SESSION_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID }),
        ),
      ) as { ok: boolean; code: string };
      expect(unreadable.ok).toBe(false);
      expect(unreadable.code).toBe('E_UNREADABLE');
      expect(settledCalls).toBe(0);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('停止前的状态是当场重读的，不复用清单里的旧快照', async () => {
    /** 可变状态（模拟清单之后活又跑起来了） */
    let status: WorkbenchJobStatus = { kind: 'completed' };
    /** 是否真的调用停止 */
    let stopped = false;
    const probe = await assembleProbe(true, {
      agentCreated: () => [TARGET_SESSION_ID],
      readStatus: () => status,
      stopSession: async () => {
        stopped = true;
        return { ok: true, stopped: true };
      },
    });
    try {
      // 先 list：此时快照里是 completed
      const list = JSON.parse(
        await probe.agent.tools!.execute(LIST_WORK_SESSIONS_TOOL_NAME, '{}'),
      ) as { sessions: { sid: string; status: WorkbenchJobStatus }[] };
      expect(list.sessions.find((s) => s.sid === TARGET_SESSION_ID)?.status).toEqual({
        kind: 'completed',
      });
      // 之后目标又跑起来了：stop 必须按**当下**状态判，而不是拿清单旧快照说「已收场」
      status = { kind: 'running' };
      const stoppedRaw = JSON.parse(
        await probe.agent.tools!.execute(
          STOP_WORK_SESSION_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID }),
        ),
      ) as { ok: boolean; stopped: boolean; status: WorkbenchJobStatus };
      expect(stoppedRaw).toEqual({
        ok: true,
        stopped: true,
        status: { kind: 'running' },
      });
      expect(stopped).toBe(true);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it.each([
    ['缺省', undefined],
    ['显式 false（撤销后按 self 重装的等效输入）', false],
  ] as const)(
    '普通会话（%s）的工具面里没有任何主控工具（list / send / create / role packs），即使依赖齐全',
    async (_label, flag) => {
      // 依赖齐全也照旧不注册：唯一判据是装配期标记，不靠「依赖缺失」兜底——
      // 撤销（mode → self）后重装必须让两只工具同时消失，而不是只剩 list
      const dispatch = vi.fn(async (): Promise<HostedDispatchResult> => ({
        ok: true,
        accepted: true,
      }));
      const probe = await assembleProbe(flag, { dispatch });
      try {
        const tools = probe.agent.tools;
        expect(tools).not.toBeNull();
        // 暴露面没有
        const exposed = tools!.list.map((t) => t.name);
        expect(exposed).not.toContain(LIST_WORK_SESSIONS_TOOL_NAME);
        expect(exposed).not.toContain(SEND_TO_SESSION_TOOL_NAME);
        expect(exposed).not.toContain(CREATE_SESSION_TOOL_NAME);
        expect(exposed).not.toContain(LIST_ROLE_PACKS_TOOL_NAME);
        // 定义面也没有：证明不是「注册了但被白名单藏起来」
        const defined = tools!.allToolDefinitions.map((t) => t.name);
        expect(defined).not.toContain(LIST_WORK_SESSIONS_TOOL_NAME);
        expect(defined).not.toContain(SEND_TO_SESSION_TOOL_NAME);
        expect(defined).not.toContain(CREATE_SESSION_TOOL_NAME);
        expect(defined).not.toContain(LIST_ROLE_PACKS_TOOL_NAME);
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
    const probe = await assembleProbe(true, { dispatch });
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
    const probe = await assembleProbe(true, { dispatch });
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
    const probe = await assembleProbe(true, { dispatch });
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
    const probe = await assembleProbe(true, { dispatch });
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
    const probe = await assembleProbe(true, { dispatch });
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

  it('主控但缺建会话 / 派发依赖 ⇒ send 与 create 都不注册（list 仍在）', async () => {
    // 只传主控标记、不传依赖四件套：宁可不注册，也不注册一个永远失败的空壳
    const probe = await assembleProbe(true);
    try {
      const tools = probe.agent.tools;
      const names = tools!.list.map((t) => t.name);
      expect(names).toContain(LIST_WORK_SESSIONS_TOOL_NAME);
      expect(names).not.toContain(SEND_TO_SESSION_TOOL_NAME);
      expect(names).not.toContain(CREATE_SESSION_TOOL_NAME);
      expect(names).not.toContain(LIST_ROLE_PACKS_TOOL_NAME);
      const defined = tools!.allToolDefinitions.map((t) => t.name);
      expect(defined).not.toContain(SEND_TO_SESSION_TOOL_NAME);
      expect(defined).not.toContain(CREATE_SESSION_TOOL_NAME);
      expect(defined).not.toContain(LIST_ROLE_PACKS_TOOL_NAME);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
});

/**
 * 调一次 `create_session` 并解析返回 JSON
 *
 * @param probe 探针（真实装配的 Agent）
 * @param args 工具参数对象
 * @returns 解析后的结果（成功 / 失败联合；失败码含工具层自判的 `E_ARGS`）
 */
async function executeCreate(
  probe: Probe,
  args: Record<string, unknown>,
): Promise<CreateSessionResult | { ok: false; code: string; message: string }> {
  const raw = await probe.agent.tools!.execute(CREATE_SESSION_TOOL_NAME, JSON.stringify(args));
  return JSON.parse(raw) as CreateSessionResult | { ok: false; code: string; message: string };
}

describe('托管 v0 · create_session（工具层）', () => {
  it('参数只认 { rolePack?, title, text, paths }：未知键 / 空白标题一律 E_ARGS，且不触建会话', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-new',
      title: '不该出现',
    }));
    const probe = await assembleProbe(true, { createSession });
    try {
      // 未知键：键集只允许四枚（缺 title / text / paths 由内核执行器按 schema 先拦）
      expect(
        await executeCreate(probe, {
          title: 't',
          text: 'x',
          mode: 'managed',
          paths: ['docs'],
        }),
      ).toMatchObject({
        ok: false,
        code: 'E_ARGS',
      });
      // 空白标题：trim 后为空，不收
      expect(
        await executeCreate(probe, { title: '   ', text: 'x', paths: ['docs'] }),
      ).toMatchObject({
        ok: false,
        code: 'E_ARGS',
      });
      // paths 给空数组 = 没声明范围：同样拒（范围是开活前置，不许省）
      expect(await executeCreate(probe, { title: 't', text: 'x', paths: [] })).toMatchObject({
        ok: false,
        code: 'E_ARGS',
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('paths 在 schema 里是必填项（不能靠 handler 兜：执行器先按 schema 拦）', async () => {
    const probe = await assembleProbe(true, {});
    try {
      // 从运行时定义面读（与模型看到的是同一份），不复制一份字面量在本文件里
      const definition = probe.agent.tools!.allToolDefinitions.find(
        (entry) => entry.name === CREATE_SESSION_TOOL_NAME,
      );
      expect(definition).toBeDefined();
      expect(definition?.parameters.required).toContain('paths');
      const paths = (definition?.parameters.properties as Record<string, { type?: string }>).paths;
      expect(paths?.type).toBe('array');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('角色包缺失 ⇒ E_ROLE_PACK，绝不复用 E_NOT_FOUND', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: false,
      code: 'E_ROLE_PACK',
      message: '角色包不存在或不可用：不存在的包',
    }));
    const probe = await assembleProbe(true, { createSession });
    try {
      const result = await executeCreate(probe, {
        rolePack: '不存在的包',
        title: '调研',
        text: '读一下仓库',
        paths: ['docs'],
      });
      expect(result).toMatchObject({ ok: false, code: 'E_ROLE_PACK' });
      // 语义分离：模型看到 E_NOT_FOUND 会去换 sid，而这里该换的是角色包名
      expect((result as { code: string }).code).not.toBe('E_NOT_FOUND');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('受理：调用方 / 角色包 / 标题 / 首轮 / 注入的发送者名五件原样交给建会话回调，返回 sid + title', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-created',
      title: '调研会话',
    }));
    const probe = await assembleProbe(true, { createSession });
    try {
      const accepted = await executeCreate(probe, {
        rolePack: '资料员',
        title: '调研会话',
        text: '先读 README',
        paths: ['docs'],
      });
      // 成功回执必须带「核清了多少」：本例历史读口是空账本且读全 ⇒ complete、无 note
      expect(accepted).toMatchObject({ ok: true, sid: '2026-11-14-created', title: '调研会话' });
      expect(accepted).toMatchObject({
        scopeCheck: { coverage: 'complete', unscopedRunning: 0 },
      });
      expect((accepted as { scopeCheck: { note?: string } }).scopeCheck.note).toBeUndefined();
      // 发送者名必须是装配期注入值：工具内写死字面量会让本断言转红。
      // 第六参 = 已规范化的范围声明（随创建写进会话元数据）
      expect(createSession).toHaveBeenCalledWith(
        SESSION_ID,
        '资料员',
        '调研会话',
        '先读 README',
        SENDER_NAME,
        ['docs'],
      );
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('rolePack 省略 ⇒ 回调收到 undefined（让宿主既有解析链决定默认包）', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-created',
      title: '默认包会话',
    }));
    const probe = await assembleProbe(true, { createSession });
    try {
      await executeCreate(probe, { title: '默认包会话', text: '开始', paths: ['docs'] });
      expect(createSession).toHaveBeenCalledWith(
        SESSION_ID,
        undefined,
        '默认包会话',
        '开始',
        SENDER_NAME,
        ['docs'],
      );
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('建会话回调抛错 ⇒ 工具不抛，回 E_HOST（宿主故障不得冒名角色包 / 会话不存在）', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => {
      throw new Error('装配失败');
    });
    const probe = await assembleProbe(true, { createSession });
    try {
      expect(await executeCreate(probe, { title: 't', text: 'x', paths: ['docs'] })).toMatchObject({
        ok: false,
        code: 'E_HOST',
      });
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
});

describe('托管 v0 · create_session 范围门禁（判据 4）', () => {
  it('与元数据里在跑活的声明重叠 ⇒ E_SCOPE_CONFLICT，回 sid + 撞在哪，且不触建会话', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-blocked',
      title: '不该出现',
    }));
    const probe = await assembleProbe(true, {
      createSession,
      readStatus: (sid) =>
        sid === '2026-11-14-scoped' ? { kind: 'running' } : { kind: 'completed' },
    });
    try {
      // 声明真源 = 会话元数据（不是历史轮次）：播种一条带声明且在跑的活
      probe.sessionStore.createSession({
        sessionId: '2026-11-14-scoped',
        displayName: '改内核',
        updatedAt: SESSION_UPDATED_AT,
        messageCount: 0,
        origin: 'hosted',
        declaredPaths: ['src/agent'],
      });
      const result = await executeCreate(probe, {
        title: '新活',
        text: '也改内核',
        // 目录祖先关系：src/agent 与 src/agent/loop.ts 重叠
        paths: ['src/agent/loop.ts'],
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'E_SCOPE_CONFLICT',
        conflicts: [
          {
            sid: '2026-11-14-scoped',
            title: '改内核',
            declared: 'src/agent',
            requested: 'src/agent/loop.ts',
          },
        ],
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('声明整仓撞上在跑活即拒；核得清时回执 complete 且不带 note', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-fresh',
      title: '新活',
    }));
    const probe = await assembleProbe(true, {
      createSession,
      readStatus: (sid) =>
        sid === '2026-11-14-scoped' ? { kind: 'running' } : { kind: 'completed' },
    });
    try {
      probe.sessionStore.createSession({
        sessionId: '2026-11-14-scoped',
        displayName: '写文档',
        updatedAt: SESSION_UPDATED_AT,
        messageCount: 0,
        origin: 'hosted',
        declaredPaths: ['docs'],
      });
      // 整仓声明与任何在跑活都重叠 ⇒ 拒（整仓 = 自愿独占）
      expect(
        await executeCreate(probe, { title: '第三条', text: '全仓', paths: ['.'] }),
      ).toMatchObject({
        ok: false,
        code: 'E_SCOPE_CONFLICT',
        conflicts: [{ sid: '2026-11-14-scoped', declared: 'docs', requested: '.' }],
      });
      // 不重叠：放行，回执写清「核清了」（无 note）
      const accepted = (await executeCreate(probe, {
        title: '另一块',
        text: '改别的',
        paths: ['src/other'],
      })) as { ok: boolean; scopeCheck: { coverage: string; note?: string } };
      expect(accepted.ok).toBe(true);
      expect(accepted.scopeCheck.coverage).toBe('complete');
      expect(accepted.scopeCheck.note).toBeUndefined();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('已收场的活不占范围（completed 不拦新活）', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-fresh',
      title: '新活',
    }));
    const probe = await assembleProbe(true, {
      createSession,
      readStatus: () => ({ kind: 'completed' }),
    });
    try {
      probe.sessionStore.createSession({
        sessionId: '2026-11-14-done',
        displayName: '旧活',
        updatedAt: SESSION_UPDATED_AT,
        messageCount: 0,
        origin: 'hosted',
        declaredPaths: ['src/agent'],
      });
      expect(
        await executeCreate(probe, { title: '新活', text: '改文档', paths: ['docs'] }),
      ).toMatchObject({ ok: true, sid: '2026-11-14-fresh' });
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('状态读不到不算空闲：unknown 状态按「占着」处理，拒绝同范围开活', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-should-not-exist',
      title: '不该出现',
    }));
    const probe = await assembleProbe(true, {
      createSession,
      readStatus: () => ({ kind: 'unreadable' }),
    });
    try {
      probe.sessionStore.createSession({
        sessionId: '2026-11-14-unknown',
        displayName: '状态不明',
        updatedAt: SESSION_UPDATED_AT,
        messageCount: 0,
        origin: 'hosted',
        declaredPaths: ['docs'],
      });
      expect(
        await executeCreate(probe, { title: '新活', text: '改文档', paths: ['docs/b.md'] }),
      ).toMatchObject({ ok: false, code: 'E_SCOPE_CONFLICT' });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('范围上线前开的老活在跑 ⇒ partial + note 说清「核不清」，且不把整仓包装成安全建议', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-partial',
      title: '新活',
    }));
    const probe = await assembleProbe(true, {
      createSession,
      // 老会话：历史里认得出是主控开的，但元数据没有声明（范围功能上线前创建）
      readHistory: () => ({
        coverage: 'complete',
        children: [{ sessionId: '2026-11-13-legacy', title: '旧活' }],
        totalRounds: 3,
        scannedRounds: 3,
      }),
      readStatus: (sid) =>
        sid === '2026-11-13-legacy' ? { kind: 'running' } : { kind: 'completed' },
    });
    try {
      const result = (await executeCreate(probe, {
        title: '新活',
        text: '改文档',
        paths: ['docs'],
      })) as {
        ok: boolean;
        scopeCheck: { coverage: string; unscopedRunning: number; note?: string };
      };
      expect(result.ok).toBe(true);
      expect(result.scopeCheck.coverage).toBe('partial');
      expect(result.scopeCheck.unscopedRunning).toBe(1);
      expect(result.scopeCheck.note).toContain('没有声明记录');
      // 整仓只作为「自愿独占」的事实出现，不作为「安全做法」推荐
      expect(result.scopeCheck.note).toContain('自愿独占');
      expect(result.scopeCheck.note).not.toContain('绝对安全');
      // 降级告知 ≠ 撞上了：不能被读成冲突码
      expect(result).not.toHaveProperty('code');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('历史读不到 ⇒ 无法确认有没有老活在跑，回执明说「核不清」', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-unreadable',
      title: '新活',
    }));
    const probe = await assembleProbe(true, {
      createSession,
      readHistory: () => ({
        coverage: 'unreadable',
        children: [],
        totalRounds: 0,
        scannedRounds: 0,
      }),
      readStatus: () => ({ kind: 'completed' }),
    });
    try {
      const result = (await executeCreate(probe, {
        title: '新活',
        text: '改文档',
        paths: ['docs'],
      })) as { ok: boolean; scopeCheck: { coverage: string; note?: string } };
      expect(result.ok).toBe(true);
      expect(result.scopeCheck.coverage).toBe('unreadable');
      expect(result.scopeCheck.note).toContain('历史读不到');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
});

describe('托管 v0 · read_memory_summary（判据 5 记忆收口）', () => {
  it('返回会话级摘要 / 关键主题 / 最近轮摘要，且只认 { sid }（roundId 等未知键 E_ARGS）', async () => {
    const probe = await assembleProbe(true, {});
    try {
      // 会话级摘要与主题 = 归档时写给 SessionMeta 的既有字段
      probe.sessionStore.updateSessionMeta(TARGET_SESSION_ID, {
        summary: '托管会话工具接线完成。',
        keyTopics: ['托管', '会话工具'],
      });
      // 轮摘要 = 记忆库 round-summary 条目（sessionName 为顶层归属字段）
      probe.storage.upsert({
        id: `round-summary:${TARGET_SESSION_ID}:round-1`,
        content: '第一轮结论',
        source: SOURCE_LABELS.ROUND_SUMMARY,
        name: '轮次摘要 round-1',
        createdAt: '2026-11-14T08:00:00.000Z',
        accessedAt: '2026-11-14T08:00:00.000Z',
        summaryType: 'fact',
        sessionName: TARGET_SESSION_ID,
        roundId: 'round-1',
      });
      probe.storage.upsert({
        id: `round-summary:${TARGET_SESSION_ID}:round-2`,
        content: '第二轮结论',
        source: SOURCE_LABELS.ROUND_SUMMARY,
        name: '轮次摘要 round-2',
        createdAt: '2026-11-14T09:00:00.000Z',
        accessedAt: '2026-11-14T09:00:00.000Z',
        summaryType: 'decision',
        sessionName: TARGET_SESSION_ID,
        roundId: 'round-2',
      });
      const raw = await probe.agent.tools!.execute(
        READ_MEMORY_SUMMARY_TOOL_NAME,
        JSON.stringify({ sid: TARGET_SESSION_ID }),
      );
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        summary: string | null;
        keyTopics: string[] | null;
        coverage: string;
        rounds: { roundId: string; summaryType: string; summary: string }[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.summary).toBe('托管会话工具接线完成。');
      expect(parsed.keyTopics).toEqual(['托管', '会话工具']);
      expect(parsed.coverage).toBe('complete');
      // 降序：最新的 round-2 在前
      expect(parsed.rounds.map((round) => round.roundId)).toEqual(['round-2', 'round-1']);
      expect(parsed.rounds[0]).toMatchObject({ summaryType: 'decision', summary: '第二轮结论' });

      // 窄工具不暴露 roundId：多一个键就拒，不让它长出 trace_summary 的入口
      const rejected = JSON.parse(
        await probe.agent.tools!.execute(
          READ_MEMORY_SUMMARY_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID, roundId: 'round-1' }),
        ),
      ) as { ok: boolean; code: string };
      expect(rejected.ok).toBe(false);
      expect(rejected.code).toBe('E_ARGS');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('未知会话 ⇒ E_NOT_FOUND（与「没有摘要」分开）', async () => {
    const probe = await assembleProbe(true, {});
    try {
      const parsed = JSON.parse(
        await probe.agent.tools!.execute(
          READ_MEMORY_SUMMARY_TOOL_NAME,
          JSON.stringify({ sid: '2026-11-14-not-exist' }),
        ),
      ) as { ok: boolean; code: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('E_NOT_FOUND');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('没归档过摘要 ⇒ summary / keyTopics 为 null、rounds 为空数组，coverage 仍 complete', async () => {
    const probe = await assembleProbe(true, {});
    try {
      const parsed = JSON.parse(
        await probe.agent.tools!.execute(
          READ_MEMORY_SUMMARY_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID }),
        ),
      ) as {
        ok: boolean;
        summary: string | null;
        keyTopics: string[] | null;
        rounds: unknown[];
        coverage: string;
      };
      expect(parsed.ok).toBe(true);
      // 「没有」= null / 空数组，不是标题、不是伪造内容
      expect(parsed.summary).toBeNull();
      expect(parsed.keyTopics).toBeNull();
      expect(parsed.rounds).toEqual([]);
      // 读全了但没有条目 ⇒ complete（与下面的 unreadable 区分）
      expect(parsed.coverage).toBe('complete');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
  it('记忆库读不到 ⇒ coverage=unreadable，不冒充「没有轮摘要」', () => {
    // 纯投影单测：memories=null 是「读不到」，与空数组（确实没有）必须分开
    expect(buildMemorySummaryFacts({ title: '探针会话', memories: null })).toEqual({
      title: '探针会话',
      summary: null,
      keyTopics: null,
      rounds: [],
      coverage: 'unreadable',
    });
  });
});

describe('托管 v0 · 主控 deny 原始 trace_summary（判据 5 的另一半）', () => {
  it('主控装配里 trace_summary 不可见；普通会话照旧可见', async () => {
    const orchestrator = await assembleProbe(true, {});
    try {
      const exposed = orchestrator.agent.tools!.list.map((tool) => tool.name);
      // 只注册窄工具而原始工具仍暴露 = 没做；这里钉住「宽的确实关了」
      expect(exposed).not.toContain('trace_summary');
      expect(exposed).toContain(READ_MEMORY_SUMMARY_TOOL_NAME);
    } finally {
      await disposeProbe(orchestrator);
    }
    const self = await assembleProbe(undefined);
    try {
      const exposed = self.agent.tools!.list.map((tool) => tool.name);
      // 自助会话不受影响（deny 只作用于主控这一次装配）
      expect(exposed).toContain('trace_summary');
      expect(exposed).not.toContain(READ_MEMORY_SUMMARY_TOOL_NAME);
    } finally {
      await disposeProbe(self);
    }
  }, 120_000);
});

describe('托管 v0 · list_role_packs（工具层）', () => {
  it('从内核 listMeta 直读：内置 / 用户 / 项目三档来源都能标出来，不二次过滤', async () => {
    const probe = await assembleProbe(true, {});
    try {
      const raw = await probe.agent.tools!.execute(LIST_ROLE_PACKS_TOOL_NAME, '{}');
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        packs: { name: string; displayName?: string; source: string }[];
      };
      expect(parsed.ok).toBe(true);
      // 三个播种包全在（内置来自 configDir，用户 / 项目来自各自目录）
      expect(parsed.packs).toHaveLength(3);
      expect(parsed.packs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '默认助手', source: 'builtin' }),
          expect.objectContaining({ name: '我的助手', source: 'user' }),
          expect.objectContaining({ name: '项目助手', source: 'project' }),
        ]),
      );
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
});

describe('托管 v0 · pause / resume（判据 6 成对开放）', () => {
  it('两个工具必须同时存在；参数只接受 { sid }', async () => {
    const probe = await assembleProbe(true, {});
    try {
      const exposed = probe.agent.tools!.list.map((tool) => tool.name);
      // 成对：只给暂停 = 把子会话停在代理自己解不开的状态
      expect(exposed).toContain(PAUSE_WORK_SESSION_TOOL_NAME);
      expect(exposed).toContain(RESUME_WORK_SESSION_TOOL_NAME);
      const rejected = JSON.parse(
        await probe.agent.tools!.execute(
          PAUSE_WORK_SESSION_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID, roundId: 'round-1' }),
        ),
      ) as { ok: boolean; code: string };
      expect(rejected.code).toBe('E_ARGS');
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('归属门禁与 stop 同一套：用户建的会话 / 无法确认 ⇒ E_DENIED，不调宿主回调', async () => {
    const paused = vi.fn<HostedSessionPauser>(async () => ({
      ok: true,
      paused: true,
      already: false,
    }));
    const resumed = vi.fn<HostedSessionResumer>(async () => ({ ok: true, resumed: true }));
    const probe = await assembleProbe(true, {
      pauseSession: paused,
      resumeSession: resumed,
      readStatus: () => ({ kind: 'running' }),
    });
    try {
      // TARGET 会话 origin=hosted 但账本 / 历史都没有创建记录 ⇒ 归属 unknown，不能放行
      for (const tool of [PAUSE_WORK_SESSION_TOOL_NAME, RESUME_WORK_SESSION_TOOL_NAME]) {
        const parsed = JSON.parse(
          await probe.agent.tools!.execute(tool, JSON.stringify({ sid: TARGET_SESSION_ID })),
        ) as { ok: boolean; code: string };
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe('E_DENIED');
      }
      expect(paused).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('自己开的会话：暂停走 requestPause 回调；恢复只走 paused 目标（等回答的暂停不恢复）', async () => {
    const paused = vi.fn<HostedSessionPauser>(async () => ({
      ok: true,
      paused: true,
      already: false,
    }));
    // 预置两次状态查询：暂停前 running，恢复前 waiting（paused 在工作台投影里就是 waiting）
    const statuses: WorkbenchJobStatus[] = [{ kind: 'running' }, { kind: 'waiting' }];
    const resumed = vi.fn<HostedSessionResumer>(async () => ({ ok: true, resumed: false }));
    const probe = await assembleProbe(true, {
      pauseSession: paused,
      resumeSession: resumed,
      // 账本认领：与 workbench.childrenOf 同一真源形态（本进程创建者记录）
      agentCreated: () => [TARGET_SESSION_ID],
      readStatus: () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!),
    });
    try {
      const pauseResult = JSON.parse(
        await probe.agent.tools!.execute(
          PAUSE_WORK_SESSION_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID }),
        ),
      ) as { ok: boolean; paused: boolean };
      expect(pauseResult).toEqual(expect.objectContaining({ ok: true, paused: true }));
      expect(paused).toHaveBeenCalledWith(SESSION_ID, TARGET_SESSION_ID);

      const resumeResult = JSON.parse(
        await probe.agent.tools!.execute(
          RESUME_WORK_SESSION_TOOL_NAME,
          JSON.stringify({ sid: TARGET_SESSION_ID }),
        ),
      ) as { ok: boolean; resumed: boolean; note?: string };
      expect(resumeResult.ok).toBe(true);
      // 宿主读实例发现是「等用户回答」，如实回未恢复，不代答
      expect(resumeResult.resumed).toBe(false);
      expect(resumeResult.note).toBeTruthy();
      expect(resumed).toHaveBeenCalledWith(SESSION_ID, TARGET_SESSION_ID);
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);

  it('状态读不到 ⇒ E_UNREADABLE（不猜着暂停 / 恢复）', async () => {
    const paused = vi.fn<HostedSessionPauser>(async () => ({
      ok: true,
      paused: true,
      already: false,
    }));
    const resumed = vi.fn<HostedSessionResumer>(async () => ({ ok: true, resumed: true }));
    const probe = await assembleProbe(true, {
      pauseSession: paused,
      resumeSession: resumed,
      agentCreated: () => [TARGET_SESSION_ID],
      readStatus: () => ({ kind: 'unreadable' }),
    });
    try {
      for (const tool of [PAUSE_WORK_SESSION_TOOL_NAME, RESUME_WORK_SESSION_TOOL_NAME]) {
        const parsed = JSON.parse(
          await probe.agent.tools!.execute(tool, JSON.stringify({ sid: TARGET_SESSION_ID })),
        ) as { ok: boolean; code: string };
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe('E_UNREADABLE');
      }
      expect(paused).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();
    } finally {
      await disposeProbe(probe);
    }
  }, 120_000);
});
