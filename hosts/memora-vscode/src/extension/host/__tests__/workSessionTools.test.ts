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
import {
  CREATE_SESSION_TOOL_NAME,
  LIST_ROLE_PACKS_TOOL_NAME,
  LIST_WORK_SESSIONS_TOOL_NAME,
  SEND_TO_SESSION_TOOL_NAME,
} from '../workSessionTools.js';
import type {
  CreateSessionResult,
  HostedDispatchResult,
  HostedInputDispatcher,
  HostedSessionCreator,
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
 * 主控工具依赖（可只覆盖其中一项，其余给最小可用替身）
 *
 * 装配层要求「四件齐全」才注册 send / create：任一缺失都按依赖不全降级，
 * 所以用例必须显式给出整体依赖盒，而不是逐个塞第二个参数。
 */
interface HostedDeps {
  /** 派发回调（缺省 = 直接受理） */
  dispatch?: HostedInputDispatcher;
  /** 建会话回调（缺省 = 返回固定 sid/title） */
  createSession?: HostedSessionCreator;
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
    // 四件套同批注入：只传其中一部分时装配层按「依赖不全」不注册 send / create
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
  it('参数只认 { rolePack?, title, text }：未知键 / 空白标题一律 E_ARGS，且不触建会话', async () => {
    const createSession = vi.fn(async (): Promise<CreateSessionResult> => ({
      ok: true,
      sid: '2026-11-14-new',
      title: '不该出现',
    }));
    const probe = await assembleProbe(true, { createSession });
    try {
      // 未知键：键集只允许三枚（缺 title / text 由内核执行器按 schema 先拦）
      expect(await executeCreate(probe, { title: 't', text: 'x', mode: 'managed' })).toMatchObject({
        ok: false,
        code: 'E_ARGS',
      });
      // 空白标题：trim 后为空，不收
      expect(await executeCreate(probe, { title: '   ', text: 'x' })).toMatchObject({
        ok: false,
        code: 'E_ARGS',
      });
      expect(createSession).not.toHaveBeenCalled();
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
      expect(
        await executeCreate(probe, { rolePack: '资料员', title: '调研会话', text: '先读 README' }),
      ).toEqual({ ok: true, sid: '2026-11-14-created', title: '调研会话' });
      // 发送者名必须是装配期注入值：工具内写死字面量会让本断言转红
      expect(createSession).toHaveBeenCalledWith(
        SESSION_ID,
        '资料员',
        '调研会话',
        '先读 README',
        SENDER_NAME,
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
      await executeCreate(probe, { title: '默认包会话', text: '开始' });
      expect(createSession).toHaveBeenCalledWith(
        SESSION_ID,
        undefined,
        '默认包会话',
        '开始',
        SENDER_NAME,
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
      expect(await executeCreate(probe, { title: 't', text: 'x' })).toMatchObject({
        ok: false,
        code: 'E_HOST',
      });
    } finally {
      await disposeProbe(probe);
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
