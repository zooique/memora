/**
 * 会话级角色包：落盘 → 重启读回 → 实际写工具仍被拒（方案 A 回归）
 *
 * 背景（为什么必须实测）：方案 A 把角色选择从「用户级全局激活态」改为「随会话文件落盘」。
 * 这条一旦只写不读（或读回没注入装配链），**重启后每个会话都回兜底包**——用户在「只读项目
 * 顾问」会话里的安全预期静默失效（兜底包带写权限）。因此本文件的判据不是「meta 里有字段」，
 * 而是：
 *   ① 新进程（新存储实例 + load）读回名字 → 注入 `activeRolePack` → 真 Agent 激活该包；
 *   ② 用**实际写工具调用**证明只读闸仍生效（`run_code` 被 blocked，盘上无产物）；
 *   ③ 另一会话不受影响（各自读回各自的包）；
 *   ④ 包名解析不到 → 装配不崩、回落兜底包，且产出的 UI 消息**指名**原包与新角色（不许静默）。
 */
import { describe, it, expect, vi } from 'vitest';

// 回落提示文案走 vscode.l10n（宿主侧本地化器）：默认语言下 t() 原样返回英文源键并填占位符
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Agent,
  todayDate,
  type AgentChunk,
  type LlmChunk,
  type LlmProvider,
  type Round,
} from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import { createLocalCodeExecutor } from '../codeExecutor.js';
import { readSessionRolePackName, sessionRolePackFallbackNotice } from '../sessionRolePack.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 被测只读角色包的显示名（manifest.name，激活按此名寻址） */
const READONLY_PACK = '只读项目顾问';
/** 内核兜底包名（seedPacks 播种 + 装配无匹配时落在它上面） */
const FALLBACK_PACK = 'memora助手';
/** 另一个会话自己选的包（证明会话隔离，不是「都有值」就算过） */
const OTHER_PACK = '默认助手';

/**
 * 只调用一次 `run_code` 的 stub provider
 *
 * 按「是否已回填工具结果」判定轮次（内核会先拿 provider 做会话命名/摘要，按序号推会错发）。
 */
class SingleToolProvider {
  readonly name = 'session-role-pack-stub';
  /** 必须为 true：本测试要走的 run_code 路径依赖工具调用能力（否则内核不会下发工具集） */
  readonly supportsToolCalling = true;
  /** 无图片消费面 */
  readonly supportsVision = false;

  /** @param code 首个工具轮要执行的 node 代码（写标记文件） */
  constructor(private readonly code: string) {}

  /**
   * @param messages 当前上下文消息（role==='tool' = 工具结果已回填）
   * @param opts 本次下发的载荷（含工具集）
   */
  async *chat(
    messages: Array<{ role: string; content?: string }>,
    opts?: { tools?: Array<{ function?: { name?: string } }> },
  ): AsyncIterable<LlmChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const hasTools = (opts?.tools ?? []).length > 0;
    if (!hasToolResult && hasTools) {
      yield { content: '我尝试写文件。' };
      yield {
        toolCalls: [
          {
            id: 'call_run_code',
            type: 'function' as const,
            function: {
              name: 'run_code',
              arguments: JSON.stringify({ language: 'node', code: this.code }),
            },
          },
        ],
        finishReason: 'tool_calls',
      };
      return;
    }
    yield { content: '完成。', finishReason: 'stop' };
  }
}

/**
 * 播种角色包（与既有宿主测试同形态）：兜底包名 + 另一个会话用的包 + 真实只读包
 *
 * @param configDir Agent 配置目录
 */
function seedPacks(configDir: string): void {
  const pairs: Array<[string, string]> = [
    [OTHER_PACK, JSON.stringify({ name: OTHER_PACK, displayName: OTHER_PACK, strategy: {} })],
    [FALLBACK_PACK, JSON.stringify({ name: FALLBACK_PACK, formatVersion: '1.0.0' })],
  ];
  for (const [dirName, manifest] of pairs) {
    const dir = join(configDir, 'role-packs', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), manifest, 'utf-8');
    writeFileSync(join(dir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  }
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  // 真实内置只读包整目录复制（不手写 strategy：测试构造的只读 ≠ 用户装的只读）
  cpSync(
    resolve(process.cwd(), '../../role-packs/readonly-advisor'),
    join(configDir, 'role-packs', 'readonly-advisor'),
    { recursive: true },
  );
}

/** 装配一个真 Agent（外部注入的存储单例由调用方/返回的 close 负责收尾） */
function makeAgent(args: {
  projectPath: string;
  configDir: string;
  sessionStore: WorkspaceSessionStore;
  roundStore: WorkspaceRoundStore;
  provider: LlmProvider;
  activeRolePack?: string;
}): { agent: Agent; close: () => void } {
  const storage = createHostMemoryStorage(args.projectPath);
  const agent = new Agent({
    projectPath: args.projectPath,
    dataDir: resolveProjectDataDir(args.projectPath),
    configDir: args.configDir,
    provider: args.provider,
    archiveMode: 'manual',
    permission: 'owner',
    allowedPaths: [args.projectPath],
    storage,
    sessionStore: args.sessionStore,
    roundStore: args.roundStore,
    codeExecutionProvider: createLocalCodeExecutor(),
    activeRolePack: args.activeRolePack,
  });
  return {
    agent,
    close: () => {
      agent.close();
      // 外部注入的存储不归 Agent 关闭（shutdown 所有权语义），测试自己收尾
      (storage as unknown as { close?: () => void }).close?.();
    },
  };
}

describe('会话级角色包：落盘 → 重启读回 → 只读闸仍生效', () => {
  it('重启后该会话仍是只读包，且实际写工具被拒（盘上无产物）', async () => {
    const projectPath = makeTempDir('memora-session-role-pack-');
    const configDir = join(projectPath, 'config');
    seedPacks(configDir);
    const marker = join(projectPath, 'LEAK_AFTER_RESTART.txt');

    // ── 阶段一：用户在该会话选了只读包（生产写点 = settingsPanel.activateRole → updateSessionMeta）
    const sessionId = '2026-11-07-sro';
    const store1 = new WorkspaceSessionStore(projectPath, new WorkspaceRoundStore(projectPath));
    store1.load();
    store1.createSession({ sessionId, updatedAt: '2026-11-07T10:00:00.000Z', messageCount: 0 });
    store1.updateSessionMeta(sessionId, { activeRolePackName: READONLY_PACK });
    // 同族保护：归档/命名等**部分写**（只带 summary，不碰角色字段）不得抹掉它是只读包的记录。
    // 显式 undefined 是最危险的形态（调用方把整份对象摊平传入），必须保留既有值。
    store1.updateSessionMeta(sessionId, { summary: '摘要已生成' });
    store1.updateSessionMeta(sessionId, { activeRolePackName: undefined });
    expect(readSessionRolePackName(store1, sessionId), '部分写把会话角色抹掉了').toBe(
      READONLY_PACK,
    );

    // ── 阶段二：模拟重启（全新存储实例从盘上 load，不共享任何内存）
    const roundStore2 = new WorkspaceRoundStore(projectPath);
    roundStore2.load();
    const store2 = new WorkspaceSessionStore(projectPath, roundStore2);
    store2.load();
    const requested = readSessionRolePackName(store2, sessionId);
    expect(requested, '会话文件没有读回角色包名 ⇒ 重启即回兜底包').toBe(READONLY_PACK);

    // ── 阶段三：按读回值装配（生产路径 = assembleAgentForSession）
    const { agent, close } = makeAgent({
      projectPath,
      configDir,
      sessionStore: store2,
      roundStore: roundStore2,
      provider: new SingleToolProvider(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`,
      ),
      activeRolePack: requested,
    });
    await agent.init();
    expect(agent.rolePackManager!.activeName, '装配后没激活只读包').toBe(READONLY_PACK);

    // 实际写工具调用（不是断言名字）：只读闸必须拦住，盘上不能出现产物
    const results: Array<Extract<AgentChunk, { type: 'tool_result' }>> = [];
    for await (const chunk of agent.chat('把这个内容写进项目。')) {
      if (chunk.type === 'tool_result') results.push(chunk);
    }
    expect(results, '未收到 run_code 的 tool_result').toHaveLength(1);
    expect(results[0]!.ok, 'run_code 竟然执行成功').toBe(false);
    expect(results[0]!.blocked, 'run_code 未被只读闸拦截').toBe(true);
    expect(existsSync(marker), `执行面写盘成功：${marker}`).toBe(false);

    close();
  }, 60_000);

  it('另一会话不受影响：各自读回各自的包并各自激活', async () => {
    const projectPath = makeTempDir('memora-session-role-pack-b-');
    const configDir = join(projectPath, 'config');
    seedPacks(configDir);

    const store1 = new WorkspaceSessionStore(projectPath, new WorkspaceRoundStore(projectPath));
    store1.load();
    store1.createSession({
      sessionId: '2026-11-07-sro',
      updatedAt: '2026-11-07T10:00:00.000Z',
      messageCount: 0,
    });
    store1.updateSessionMeta('2026-11-07-sro', { activeRolePackName: READONLY_PACK });
    store1.createSession({
      sessionId: '2026-11-07-sdef',
      updatedAt: '2026-11-07T09:00:00.000Z',
      messageCount: 0,
    });
    store1.updateSessionMeta('2026-11-07-sdef', { activeRolePackName: OTHER_PACK });

    const roundStore = new WorkspaceRoundStore(projectPath);
    roundStore.load();
    const store2 = new WorkspaceSessionStore(projectPath, roundStore);
    store2.load();

    expect(readSessionRolePackName(store2, '2026-11-07-sro')).toBe(READONLY_PACK);
    expect(readSessionRolePackName(store2, '2026-11-07-sdef')).toBe(OTHER_PACK);

    const { agent, close } = makeAgent({
      projectPath,
      configDir,
      sessionStore: store2,
      roundStore,
      provider: new SingleToolProvider('void 0;'),
      activeRolePack: readSessionRolePackName(store2, '2026-11-07-sdef'),
    });
    await agent.init();
    expect(agent.rolePackManager!.activeName, '会话 B 被别的会话的包串台').toBe(OTHER_PACK);
    close();
  }, 60_000);

  it('包名解析不到：装配不崩、回落兜底包，且 UI 消息指名原包与新角色', async () => {
    const projectPath = makeTempDir('memora-session-role-pack-gone-');
    const configDir = join(projectPath, 'config');
    seedPacks(configDir);

    const store1 = new WorkspaceSessionStore(projectPath, new WorkspaceRoundStore(projectPath));
    store1.load();
    store1.createSession({
      sessionId: '2026-11-07-sgone',
      updatedAt: '2026-11-07T10:00:00.000Z',
      messageCount: 0,
    });
    store1.updateSessionMeta('2026-11-07-sgone', { activeRolePackName: '已删除的角色包' });

    const roundStore = new WorkspaceRoundStore(projectPath);
    roundStore.load();
    const store2 = new WorkspaceSessionStore(projectPath, roundStore);
    store2.load();

    const requested = readSessionRolePackName(store2, '2026-11-07-sgone');
    const { agent, close } = makeAgent({
      projectPath,
      configDir,
      sessionStore: store2,
      roundStore,
      provider: new SingleToolProvider('void 0;'),
      activeRolePack: requested,
    });
    // 装配不崩（包没了也只是降级，不是启动失败）
    await agent.init();
    expect(agent.rolePackManager!.activeName).toBe(FALLBACK_PACK);

    // 可见提示：断言**实际产出的那条 UI 消息**（不是断言某个布尔为 true 或日志字符串）
    const notice = sessionRolePackFallbackNotice(
      store2,
      '2026-11-07-sgone',
      agent.rolePackManager!.activeName,
    );
    expect(notice).toEqual({
      type: 'notice',
      level: 'error',
      message: `The former role pack "已删除的角色包" is unavailable; using the default role "${FALLBACK_PACK}" instead.`,
    });
    close();
  }, 60_000);

  it('会话记录无角色字段（老会话）→ 装配走兜底、零提示（不写猜测值）', () => {
    const projectPath = makeTempDir('memora-session-role-pack-empty-');
    const roundStore = new WorkspaceRoundStore(projectPath);
    roundStore.load();
    const store = new WorkspaceSessionStore(projectPath, roundStore);
    store.load();
    store.createSession({
      sessionId: '2026-11-05-sold',
      updatedAt: '2026-11-05T10:00:00.000Z',
      messageCount: 0,
    });

    // 字段缺失 = 该会话从未选过角色 ⇒ undefined（不是空串、不是兜底包名）
    expect(readSessionRolePackName(store, '2026-11-05-sold')).toBeUndefined();
    // 没有请求 ⇒ 不是失败 ⇒ 不提示
    expect(sessionRolePackFallbackNotice(store, '2026-11-05-sold', FALLBACK_PACK)).toBeNull();
  });

  it('分叉继承父会话角色包：新存储实例读回子会话仍是只读包，run_code 实际被拒（N3）', async () => {
    const projectPath = makeTempDir('memora-session-role-pack-fork-');
    const configDir = join(projectPath, 'config');
    seedPacks(configDir);
    const marker = join(projectPath, 'LEAK_AFTER_FORK.txt');

    // ── 父会话：只读包 + 一个已完成轮（分叉点）
    const roundStore1 = new WorkspaceRoundStore(projectPath);
    roundStore1.load();
    const store1 = new WorkspaceSessionStore(projectPath, roundStore1);
    store1.load();
    // 内核 MessageHistory 的惰性初值 = `${todayDate()}-main`；分叉要求「当前会话」实体存在，
    // 故父会话直接用同一 id（不额外造第二个写点）
    const parentId = `${todayDate()}-main`;
    store1.createSession({
      sessionId: parentId,
      updatedAt: '2026-11-07T10:00:00.000Z',
      messageCount: 2,
    });
    store1.updateSessionMeta(parentId, { activeRolePackName: READONLY_PACK });
    const roundId = 'round-fork-parent-1';
    const round: Round = {
      id: roundId,
      userMessage: {
        id: `${roundId}-user`,
        role: 'user',
        content: '父会话的问题',
        timestamp: '2026-11-07T10:00:00.000Z',
      },
      assistantMessage: {
        id: `${roundId}-assistant`,
        role: 'assistant',
        content: '父会话的回答',
        timestamp: '2026-11-07T10:00:30.000Z',
      },
      status: 'complete',
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:30.000Z',
    };
    roundStore1.save(round);
    store1.setRoundIds(parentId, [roundId]);

    // ── 生产分叉入口（Agent.forkSession → SessionManager → MessageHistory.forkSession）
    const { agent: parentAgent, close: closeParent } = makeAgent({
      projectPath,
      configDir,
      sessionStore: store1,
      roundStore: roundStore1,
      provider: new SingleToolProvider('void 0;'),
      activeRolePack: READONLY_PACK,
    });
    await parentAgent.init();
    const fork = parentAgent.forkSession(roundId, 'child-fork');
    closeParent();
    const childId = `${fork.date}-${fork.newSession}`;

    // ── 模拟重启：全新存储实例从盘上 load（不复用任何内存）
    const roundStore2 = new WorkspaceRoundStore(projectPath);
    roundStore2.load();
    const store2 = new WorkspaceSessionStore(projectPath, roundStore2);
    store2.load();
    expect(readSessionRolePackName(store2, childId), '分叉没继承父会话角色包').toBe(READONLY_PACK);

    // ── 按读回值装配子会话 → 用实际写工具证明只读闸仍生效（名字断言不算）
    const { agent: childAgent, close: closeChild } = makeAgent({
      projectPath,
      configDir,
      sessionStore: store2,
      roundStore: roundStore2,
      provider: new SingleToolProvider(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`,
      ),
      activeRolePack: readSessionRolePackName(store2, childId),
    });
    await childAgent.init();
    const results: Array<Extract<AgentChunk, { type: 'tool_result' }>> = [];
    for await (const chunk of childAgent.chat('把这个内容写进项目。')) {
      if (chunk.type === 'tool_result') results.push(chunk);
    }
    expect(results, '未收到 run_code 的 tool_result').toHaveLength(1);
    expect(results[0]!.ok, '分叉后的 run_code 竟然执行成功').toBe(false);
    expect(results[0]!.blocked, '分叉后的 run_code 未被只读闸拦截').toBe(true);
    expect(existsSync(marker), `执行面写盘成功：${marker}`).toBe(false);
    closeChild();
  }, 60_000);
});

describe('接线守卫：extension.ts 两处注入不得丢失（该文件零测试覆盖，用源码锚定）', () => {
  const HOST_ROOT = join(__dirname, '..', '..', '..', '..');
  const extensionSrc = readFileSync(join(HOST_ROOT, 'src', 'extension', 'extension.ts'), 'utf8');

  it('装配前按会话读回名字并注入 activeRolePack（缺了 = 只写不读，重启即回兜底包）', () => {
    expect(extensionSrc).toContain(
      'options.activeRolePack = readSessionRolePackName(deps.sessionStore, sessionId)',
    );
  });

  it('设置面板拿到会话存储（缺了 = 切换只改内存，重启丢失）', () => {
    expect(extensionSrc).toContain('settingsProvider.setSessionStore(sessionStore)');
  });
});
