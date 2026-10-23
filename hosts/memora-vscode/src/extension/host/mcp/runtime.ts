/**
 * MCP 运行时编排 — 配置 → 连接 → 映射 → 注册 →（list_changed 整换）→ 停机注销
 *
 * 这是宿主侧 MCP 的**唯一入口**（assemble 启动、deactivate 停机都只调本文件），
 * 连接与映射的细节分别落在 connectionManager / toolRegistry。
 *
 * 失败语义（刻意如此）：
 *   - 单个 server 连不上/握手失败 → 只记日志、该 server 零工具，**不阻断 Agent 装配**；
 *   - server 运行中断线 → 注销它的全部工具（不留僵尸工具让模型调死连接）；
 *   - 用户配置非法（缺 name/command、重名）→ 跳过该条并告警，不猜意图；
 *   - list_changed 重取失败 → 保留原注册集（没拿到新清单就动注册面 = 无据之变）。
 */
import type { Agent, ILogger } from '@zooique/memora';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { McpConnection, type McpServerConfig } from './connectionManager.js';
import { parseAllowlist, type McpToolAllowlist } from './policy.js';
import {
  buildToolBindings,
  registerServerTools,
  unregisterServerTools,
  type McpToolBinding,
  type ToolRegistrar,
} from './toolRegistry.js';

/** 单个 server 的运行态（停机/断线注销所需的最小信息） */
interface RunningServer {
  /** 连接实例（持有子进程） */
  connection: McpConnection;
  /** 注册面（停机时按它注销；与注册时同一实例） */
  registrar: ToolRegistrar;
  /** 已注册工具的派生缓存（注销按名删除；list_changed 整换后原地更新） */
  bindings: McpToolBinding[];
}

/** 运行态集合（模块级单例，与宿主 agentPromise/currentAgent 的单例口径一致） */
let running: Map<string, RunningServer> | null = null;

/**
 * MCP 工具总量收敛阈值（方案 §10 S5 行）
 *
 * 依据：工具过多显著伤选择准确率（50/200/740 把手的实测 → 95%/→20%）。本阈值只
 * **提示**（logger.warn），不拦截——硬上限与检索式加载是 S5 的后续项，未拍板前
 * 不做静默丢弃（静默少注册工具 = 模型少能力，比多注册更难排查）。
 */
export const MAX_TOTAL_MCP_TOOLS = 64;

/** 总量提示去重状态（回落阈值下方即重置，下次越界再提示） */
let budgetWarned = false;

/**
 * 总量提示判定（纯函数，便于单测）
 *
 * @param total 当前已注册的 MCP 工具总数
 * @param alreadyWarned 是否已提示过（且未回落）
 */
export function shouldWarnToolBudget(total: number, alreadyWarned: boolean): boolean {
  return total > MAX_TOTAL_MCP_TOOLS && !alreadyWarned;
}

/** 重算总量并按需提示（装配后 / 整换后 / 断线注销后调用） */
function noteToolCount(logger?: ILogger): void {
  const total = running
    ? [...running.values()].reduce((sum, server) => sum + server.bindings.length, 0)
    : 0;
  if (shouldWarnToolBudget(total, budgetWarned)) {
    budgetWarned = true;
    logger?.warn(
      `[MCP] 已注册工具共 ${total} 个，超过建议上限 ${MAX_TOTAL_MCP_TOOLS}：` +
        '工具过多会显著降低选择准确率，可停用部分 server 收敛（方案 §10 S5）',
    );
  } else if (total <= MAX_TOTAL_MCP_TOOLS) {
    budgetWarned = false;
  }
}

/**
 * `startMcpServers` 的装配期注入（allowlist 必填，日志与版本可选）
 */
export interface StartMcpOptions {
  /**
   * 免确认 allowlist 原值（`memora.mcpToolAllowlist`，用户设置）
   *
   * 原值传入、本函数内解析（parseAllowlist，fail-closed：读不到合法值 = 空集
   * = 全部逐次确认）；解析一次后按原名寻址下穿给每个工具的档位计算。
   * **必填**：没有「不传 = 某默认档」的路径——忘了传就是编译错，不靠运行时兜底。
   */
  allowlist: readonly string[];
  /** 内核日志（缺省不记） */
  logger?: ILogger;
  /** 扩展版本（写进 MCP clientInfo，仅供 server 遥测） */
  clientVersion?: string;
}

/**
 * 校验一条配置是否可启动
 *
 * @param config 用户配置项
 * @returns 不可用原因；可用时返回 null
 */
function configProblem(config: McpServerConfig): string | null {
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    return '缺少 name';
  }
  if (typeof config.command !== 'string' || config.command.trim().length === 0) {
    return '缺少 command';
  }
  return null;
}

/**
 * 启动全部启用的 MCP server，并把发现的工具注册进内核
 *
 * 幂等：先停掉上一轮连接再起（热重载路径不会叠出两套工具）。
 *
 * @param agent 已 init 的内核 Agent（工具注册面 = agent.tools）
 * @param configs 用户配置（`memora.mcpServers`）
 * @param options allowlist + 日志 + 客户端版本（见 StartMcpOptions）
 */
export async function startMcpServers(
  agent: Agent,
  configs: readonly McpServerConfig[],
  options: StartMcpOptions,
): Promise<void> {
  const { allowlist, logger, clientVersion } = options;

  // 无配置 = 完全不碰内核工具集（零行为变化）。
  // ⚠️ 此早退位于停旧连接之前：当前激活期只装配一次、无热更路径，故不漏停；
  // 切片 4 做配置热更（含清空配置）必须改为「先停后起」，勿直接复用本早退。
  if (configs.length === 0) return;

  await stopMcpServers();

  const registrar = agent.tools;
  if (!registrar) {
    logger?.warn('[MCP] Agent 工具执行器不可用，跳过 MCP 服务器装配');
    return;
  }

  // allowlist 在此解析一次（fail-closed 语义见 policy.ts），按原名寻址下穿
  const allowKeys = parseAllowlist(allowlist);

  const state = new Map<string, RunningServer>();
  running = state;

  // 重名配置：先到先得（工具名前缀按 server 名派生，后到的会与先到的撞名 → 直接跳过更诚实）
  const seenNames = new Set<string>();
  const starts = configs.map(async (config) => {
    const problem = configProblem(config);
    if (problem) {
      logger?.warn(`[MCP] 跳过非法配置（${problem}）：${JSON.stringify(config)}`);
      return;
    }
    if (config.enabled === false) return; // 停用档：不拉起、不注册（等价于工具不存在）
    if (seenNames.has(config.name)) {
      logger?.warn(`[MCP] server 名重复，跳过后者：${config.name}`);
      return;
    }
    seenNames.add(config.name);

    const connection = new McpConnection(config, logger, clientVersion);
    try {
      const tools = await connection.connect();
      const { bindings, skipped } = buildToolBindings(config.name, tools, allowKeys);
      for (const item of skipped) {
        logger?.warn(`[MCP:${config.name}] 工具「${item.toolName}」已跳过：${item.reason}`);
      }
      registerServerTools(registrar, bindings, (originalName, args) =>
        connection.callTool(originalName, args),
      );
      const entry: RunningServer = { connection, registrar, bindings };
      state.set(config.name, entry);
      // 断线即注销：传输层主动 close 时不触发（McpConnection 用 closing 标记过滤）。
      // ⚠️ 从 state 读当前 bindings，不闭包捕获注册时那份——list_changed 整换会换集，
      // 捕获旧集会在「换过之后再断线」时漏注销新工具（僵尸工具）
      connection.onClosed = () => {
        const current = state.get(config.name);
        if (current) unregisterServerTools(current.registrar, current.bindings);
        state.delete(config.name);
        noteToolCount(logger);
      };
      // list_changed → 守卫合并的重同步（整换 + 原地更新运行态 bindings）
      connection.onToolsChanged = createResyncGuard(async () => {
        const current = state.get(config.name);
        if (!current) return; // 已断开/停机：没有重同步对象
        const fresh = await resyncServerTools(
          config.name,
          connection,
          registrar,
          current.bindings,
          allowKeys,
          logger,
        );
        const latest = state.get(config.name);
        if (!latest) return; // 重同步期间又断了：新集已随断线注销，勿写回
        latest.bindings = fresh;
        noteToolCount(logger);
      });
      logger?.info(`[MCP] server「${config.name}」已接入，注册工具 ${bindings.length} 个`);
    } catch (err) {
      // 单点失败不影响其余 server，也不阻断 Agent 装配（宿主其余功能照常）
      logger?.warn(`[MCP] server「${config.name}」接入失败：${String(err)}`);
      await connection.close().catch(() => undefined);
    }
  });

  await Promise.all(starts);

  // 装配完成后结算一次总量（收敛提示只在这里与整换后出现，不随每次注册刷）
  noteToolCount(logger);
}

/**
 * `list_changed` 重同步：整换一台 server 的注册集（P2）
 *
 * **为什么是整换（先全注销再全注册）而不是按原名增量 diff**：派生名
 * `mcp__<server>__<tool>` 带撞名后缀（`a-b` 与 `a.b` 清洗后同名 → 后者加 `_2`），
 * 后缀取决于**整个工具集合**——增删任一工具都可能让别的工具的派生名漂移（删掉
 * `a-b` 后，`a.b` 重新派生就是无后缀名）。增量 diff 按原名能对上「哪个工具没了」，
 * 但对不上「哪个工具的名字变了」，会留下漂移名或漏注销。整换把派生逻辑整体重跑
 * 一遍，天然无漂移；且注销与注册之间**无 await**（两个同步循环），对事件循环是
 * 原子替换，不存在「一半旧一半新」的中间态。
 *
 * 失败语义：重取失败 ⇒ 保留原注册集（清单没拿到就动注册面 = 无据之变）；注册
 * 撞名（跨 server 派生名冲突，内核 registerTool 拒重名）⇒ 回滚到原集并告警。
 *
 * @param serverName server 名
 * @param connection 连接（只用 refreshTools / callTool 两个方法，注入便于单测）
 * @param registrar 内核注册面
 * @param previous 当前已注册的绑定（整换的注销清单）
 * @param allowKeys 免确认 allowlist（与首装同一份解析结果）
 * @param logger 内核日志
 * @returns 新注册集；重取失败时返回原集副本（调用方应原样保留）
 */
export async function resyncServerTools(
  serverName: string,
  connection: Pick<McpConnection, 'refreshTools' | 'callTool'>,
  registrar: ToolRegistrar,
  previous: readonly McpToolBinding[],
  allowKeys: McpToolAllowlist,
  logger?: ILogger,
): Promise<McpToolBinding[]> {
  let tools: McpTool[];
  try {
    tools = await connection.refreshTools();
  } catch (err) {
    logger?.warn(`[MCP:${serverName}] 工具清单重取失败，保留原注册集：${String(err)}`);
    return previous.slice();
  }

  const { bindings, skipped } = buildToolBindings(serverName, tools, allowKeys);
  for (const item of skipped) {
    logger?.warn(`[MCP:${serverName}] 工具「${item.toolName}」已跳过：${item.reason}`);
  }
  const forward = (originalName: string, args: Record<string, unknown>): Promise<unknown> =>
    connection.callTool(originalName, args);

  unregisterServerTools(registrar, previous);
  try {
    registerServerTools(registrar, bindings, forward);
  } catch (err) {
    // 跨 server 派生名撞名（registerTool 抛「工具已注册」）：撤掉已写进去的新集，
    // 把旧集原样写回（旧定义仍有效），保「注册面 ↔ 运行态」一致
    logger?.warn(`[MCP:${serverName}] 新工具集注册失败（${String(err)}），回滚到原注册集`);
    unregisterServerTools(registrar, bindings);
    registerServerTools(registrar, previous, forward);
    return previous.slice();
  }
  return bindings;
}

/**
 * 创建重同步守卫：把并发/连续的通知合并成不重叠的几轮
 *
 * server 可能在一次批量变更里连发多条 `list_changed`（或server 实现有 bug 狂发）。
 * 直接每条都重取 = 并发多个 listTools + 交错整换（注册面被并发改写）。守卫语义：
 * 执行中到达的通知只记一个「待办」位，当前轮跑完若有待办再补一轮——**不丢通知**
 * （最后一轮一定反映最终状态），也**不并发**。
 *
 * @param run 一轮重同步（内部自行兜底错误，不对外抛）
 * @returns 通知回调（可直接挂到 connection.onToolsChanged）
 */
export function createResyncGuard(run: () => Promise<void>): () => void {
  let inFlight = false;
  let queued = false;
  return () => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        await run();
        while (queued) {
          queued = false;
          await run();
        }
      } finally {
        inFlight = false;
      }
    })().catch(() => undefined); // run 内部已兜底；双保险，防未处理拒绝
  };
}

/**
 * 停掉全部 MCP server：注销工具 + 关闭连接（子进程随之退出）
 *
 * deactivate 与「重新装配」都走这里；失败静默（退出路径不因清理失败卡住）。
 */
export async function stopMcpServers(): Promise<void> {
  const state = running;
  running = null;
  if (!state) return;

  for (const { connection, registrar, bindings } of state.values()) {
    unregisterServerTools(registrar, bindings);
    await connection.close().catch(() => undefined);
  }
  state.clear();
}
