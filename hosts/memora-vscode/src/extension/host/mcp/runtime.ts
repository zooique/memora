/**
 * MCP 运行时编排 — 配置 → 连接 → 映射 → 注册 →（list_changed 整换 / 配置热更差分）→ 停机注销
 *
 * 这是宿主侧 MCP 的**唯一入口**（assemble 启动、deactivate 停机、配置热更都只调本文件），
 * 连接与映射的细节分别落在 connectionManager / toolRegistry。
 *
 * 失败语义（刻意如此）：
 *   - 单个 server 连不上/握手失败 → 只记日志、该 server 零工具，**不阻断 Agent 装配**；
 *   - server 运行中断线 → 注销它的全部工具（不留僵尸工具让模型调死连接）；
 *   - 用户配置非法（缺 name/command、重名）→ 跳过该条并告警，不猜意图；
 *   - list_changed 重取失败 → 保留原注册集（没拿到新清单就动注册面 = 无据之变）；
 *   - 配置热更（切片 4）：按 name 差分——未变的不动（不打断进行中调用）、变更的
 *     **先停后起**、删除/停用的停、allowlist 变的只重算档位（连接不动）。
 */
import type { Agent, ILogger } from '@zooique/memora';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { McpConnection, type McpServerConfig } from './connectionManager.js';
import { isPlainObject } from './json.js';
import { parseAllowlist, type McpToolAllowlist } from './policy.js';
import {
  buildToolBindings,
  registerServerTools,
  unregisterServerTools,
  type McpToolBinding,
  type ToolRegistrar,
} from './toolRegistry.js';

/** 单个 server 的运行态（停机/断线注销/热更差分所需的最小信息） */
interface RunningServer {
  /** server 名（配置里的 name；运行态的寻址键） */
  readonly name: string;
  /** 连接实例（持有子进程） */
  connection: McpConnection;
  /** 注册面（停机时按它注销；与注册时同一实例） */
  readonly registrar: ToolRegistrar;
  /** 已注册工具的派生缓存（注销按名删除；list_changed 整换 / allowlist 热更后原地更新） */
  bindings: McpToolBinding[];
  /** 接入时的配置原值（热更差分判「变没变」用；运行期不改） */
  readonly config: McpServerConfig;
  /** 接入时生效的 allowlist（list_changed 整换按它重算档位；allowlist 热更后原地更新） */
  allowKeys: McpToolAllowlist;
}

/** 运行态集合（模块级单例，与宿主 agentPromise/currentAgent 的单例口径一致） */
let running: Map<string, RunningServer> | null = null;

/** 当前生效的 allowlist（热更差分判「allowlist 变没变」的基线；停机时置空） */
let activeAllowKeys: McpToolAllowlist | null = null;

/** 配置热更串行链（两个配置键同时变 / 用户连改多次 ⇒ 差分不交错） */
let hotReloadChain: Promise<void> = Promise.resolve();

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

/** 重算总量并按需提示（装配后 / 整换后 / 断线注销后 / 热更后调用） */
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
  /** 连接工厂（测试注入假连接；生产缺省 `new McpConnection`。与 applyMcpConfigChange 同口径） */
  connect?: McpConnectionFactory;
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
 * 把用户配置收敛为「可启动集」（首装与热更共用的单点）
 *
 * 三条规则与首装历史口径一致：非法配置（缺 name/command）跳过并告警；`enabled:
 * false` 不启动（静默——用户显式停用，不该每次激活都告警）；重名**先到先得**
 * （工具名前缀按 server 名派生，后到的会与先到的撞名 → 直接跳过更诚实）。
 *
 * @param configs 用户配置原值
 * @param logger 告警通道（缺省不记）
 * @returns name → 配置（保序：配置顺序即启动顺序）
 */
function indexValidConfigs(
  configs: readonly McpServerConfig[],
  logger?: ILogger,
): Map<string, McpServerConfig> {
  const valid = new Map<string, McpServerConfig>();
  for (const config of configs) {
    const problem = configProblem(config);
    if (problem) {
      logger?.warn(`[MCP] 跳过非法配置（${problem}）：${JSON.stringify(config)}`);
      continue;
    }
    if (config.enabled === false) continue;
    if (valid.has(config.name)) {
      logger?.warn(`[MCP] server 名重复，跳过后者：${config.name}`);
      continue;
    }
    valid.set(config.name, config);
  }
  return valid;
}

/**
 * 按键排序的稳定序列化（配置差分判「变没变」用）
 *
 * 不能直接 `JSON.stringify(a) === JSON.stringify(b)`：用户编辑 settings.json 后
 * 键序可能变而语义没变，按序比较会误判「配置变了」⇒ 白重启一次连接（打断该
 * server 进行中的调用）。排序后只剩语义差异。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 两条配置是否语义相同（稳定序列化相等） */
function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** 两个 allowlist 集合是否相等（热更差分：不同才对 kept server 重算档位） */
function allowSetsEqual(a: McpToolAllowlist | null, b: McpToolAllowlist): boolean {
  if (a === null || a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

/** 连接工厂（测试注入假连接；生产缺省 `new McpConnection`——与 resyncServerTools 的注入模式同源） */
export type McpConnectionFactory = (
  config: McpServerConfig,
  logger?: ILogger,
  clientVersion?: string,
) => McpConnection;

/** `startOneServer` 的上下文（一台 server 启动所需的全部注入） */
interface StartOneServerContext {
  registrar: ToolRegistrar;
  allowKeys: McpToolAllowlist;
  /** 运行态表（启动成功即写入；断线/整换回调也按它寻址） */
  state: Map<string, RunningServer>;
  logger?: ILogger;
  clientVersion?: string;
  /** 连接工厂（缺省真连接） */
  connect?: McpConnectionFactory;
}

/** 注销 + 关闭一台运行中的 server（停机/停一台/热更抢占收尾共用的单点） */
async function disposeEntry(entry: RunningServer): Promise<void> {
  unregisterServerTools(entry.registrar, entry.bindings);
  await entry.connection.close().catch(() => undefined);
}

/**
 * 收尾一整张运行态表（热更被停机/重装配抢占时用）
 *
 * 与 stopMcpServers 的分工：那个先摘 `running` 再逐个关（面向外部停机语义）；
 * 这个关的是**被抢占的那一张表**（模块 `running` 已指向别处或为 null），防本轮
 * 热更启的连接在停机后继续跑（孤儿子进程）。
 */
async function disposeState(state: Map<string, RunningServer>): Promise<void> {
  for (const entry of state.values()) {
    await disposeEntry(entry);
  }
  state.clear();
}

/**
 * 启动一台 server（首装与热更共用的单点）
 *
 * 失败只影响自己：连不上/握手失败/注册撞名（含循环中途撞名——撤掉已注册的前几个）
 * 都只记日志并关连接，该 server 零工具，不阻断装配、不影响其余 server。
 */
async function startOneServer(config: McpServerConfig, ctx: StartOneServerContext): Promise<void> {
  const { registrar, allowKeys, state, logger, clientVersion, connect } = ctx;
  const connection = connect
    ? connect(config, logger, clientVersion)
    : new McpConnection(config, logger, clientVersion);
  try {
    const tools = await connection.connect();
    const { bindings, skipped } = buildToolBindings(config.name, tools, allowKeys);
    for (const item of skipped) {
      logger?.warn(`[MCP:${config.name}] 工具「${item.toolName}」已跳过：${item.reason}`);
    }
    // 注册失败（跨 server 派生名撞名）由 registerServerTools 内部自清理（撤本次
    // 成功的前几个）后抛错 ⇒ 外层只负责关连接 + 记日志；清理边界在注册单点，
    // 不在此按 bindings 全量撤（会误删别家同名工具）
    registerServerTools(registrar, bindings, (originalName, args) =>
      connection.callTool(originalName, args),
    );
    state.set(config.name, {
      name: config.name,
      connection,
      registrar,
      bindings,
      config,
      allowKeys,
    });
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
      // 按运行态的**当前** allowKeys 重算档位：allowlist 热更后这里必须看到新值
      const fresh = await resyncServerTools(
        config.name,
        connection,
        registrar,
        current.bindings,
        current.allowKeys,
        logger,
      );
      const latest = state.get(config.name);
      if (!latest) {
        // 重同步期间断开/停机：onClosed 注销的是它当时看到的旧集，**刚注册的
        // 新集不在其中** ⇒ 这里补注销，勿留僵尸工具（该 server 的语义 = 零工具）
        unregisterServerTools(registrar, fresh);
        return;
      }
      latest.bindings = fresh;
      noteToolCount(logger);
    });
    logger?.info(`[MCP] server「${config.name}」已接入，注册工具 ${bindings.length} 个`);
  } catch (err) {
    // 单点失败不影响其余 server，也不阻断 Agent 装配（宿主其余功能照常）
    logger?.warn(`[MCP] server「${config.name}」接入失败：${String(err)}`);
    await connection.close().catch(() => undefined);
  }
}

/**
 * 启动全部启用的 MCP server，并把发现的工具注册进内核
 *
 * 幂等：**先停后起**（无配置也停——配置热更清空配置时漏停旧连接 = 僵尸子进程，
 * 方案 §10 配置热更登记行的实现约束；装配期 running 恒为 null，对首装零行为变化）。
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
  const { allowlist, logger, clientVersion, connect } = options;

  // 先停后起：见上方 JSDoc。无配置 = 停掉上一轮后完全不碰内核工具集（零行为变化）。
  await stopMcpServers();
  if (configs.length === 0) return;

  const registrar = agent.tools;
  if (!registrar) {
    logger?.warn('[MCP] Agent 工具执行器不可用，跳过 MCP 服务器装配');
    return;
  }

  // allowlist 在此解析一次（fail-closed 语义见 policy.ts），按原名寻址下穿
  const allowKeys = parseAllowlist(allowlist);

  const state = new Map<string, RunningServer>();
  running = state;
  activeAllowKeys = allowKeys;

  const valid = indexValidConfigs(configs, logger);
  await Promise.all(
    [...valid.values()].map((config) =>
      startOneServer(config, { registrar, allowKeys, state, logger, clientVersion, connect }),
    ),
  );

  // 装配完成后结算一次总量（收敛提示只在这里与整换/热更后出现，不随每次注册刷）
  noteToolCount(logger);
}

/**
 * 换一台 server 的注册集（list_changed 整换与 allowlist 热更共用的单点）
 *
 * **为什么整换（先全注销再全注册）而不是按原名增量 diff**：派生名
 * `mcp__<server>__<tool>` 带撞名后缀（`a-b` 与 `a.b` 清洗后同名 → 后者加 `_2`），
 * 后缀取决于**整个工具集合**——增删任一工具都可能让别的工具的派生名漂移（删掉
 * `a-b` 后，`a.b` 重新派生就是无后缀名）。增量 diff 按原名能对上「哪个工具没了」，
 * 但对不上「哪个工具的名字变了」，会留下漂移名或漏注销。整换把派生逻辑整体重跑
 * 一遍，天然无漂移；且注销与注册之间**无 await**（两个同步循环），对事件循环是
 * 原子替换，不存在「一半旧一半新」的中间态。
 *
 * 失败语义：注册撞名（跨 server 派生名冲突，内核 registerTool 拒重名）⇒ 撤新集、
 * 旧集原样写回并告警（保「注册面 ↔ 运行态」一致）。
 *
 * @param serverName server 名
 * @param tools 新清单（整换 = 重取的新集；allowlist 热更 = 缓存清单，档位不同集相同）
 * @param connection 连接（只用 callTool 转发，注入便于单测）
 * @param registrar 内核注册面
 * @param previous 当前已注册的绑定（整换的注销清单）
 * @param allowKeys 免确认 allowlist（按当前生效值解析后的集合）
 * @param logger 内核日志
 * @returns 新注册集
 */
async function swapServerTools(
  serverName: string,
  tools: readonly McpTool[],
  connection: Pick<McpConnection, 'callTool'>,
  registrar: ToolRegistrar,
  previous: readonly McpToolBinding[],
  allowKeys: McpToolAllowlist,
  logger?: ILogger,
): Promise<McpToolBinding[]> {
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
    // 跨 server 派生名撞名（registerTool 抛「工具已注册」）：失败的注册调用已内部
    // 自清理（撤它自己成功的前几个，**不碰**撞名的那个名——它 registered 在别家
    // 名下），这里只需把旧集原样写回（旧定义仍有效），保「注册面 ↔ 运行态」一致
    logger?.warn(`[MCP:${serverName}] 新工具集注册失败（${String(err)}），回滚到原注册集`);
    registerServerTools(registrar, previous, forward);
    return previous.slice();
  }
  return bindings;
}

/**
 * `list_changed` 重同步：整换一台 server 的注册集（P2）
 *
 * 重取失败 ⇒ 保留原注册集（清单没拿到就动注册面 = 无据之变）；换集语义（含撞名
 * 回滚）在 swapServerTools 单点，与 allowlist 热更共用。
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
  return swapServerTools(serverName, tools, connection, registrar, previous, allowKeys, logger);
}

/**
 * allowlist 热更：用新 allowlist 重算一台 server 全部工具的档位并整换（切片 4）
 *
 * 与 resyncServerTools 的唯一差别 = 清单来源：这里用连接的**缓存清单**
 * （`listTools()`）——工具集没变（用户只改了免确认名单），不该为此重取；档位
 * 定格在注册时（confirmPolicy 随 ToolDefinition 注册），故必须 removeTool +
 * registerTool 重注册（内核 registerTool 对已注册 custom 名抛「工具已注册」，
 * 不可覆盖重注册）。换集语义（原子替换 / 撞名回滚）复用 swapServerTools。
 *
 * @param serverName server 名
 * @param connection 连接（只用 listTools / callTool 两个方法，注入便于单测）
 * @param registrar 内核注册面
 * @param previous 当前已注册的绑定（注销清单）
 * @param allowKeys 新的免确认 allowlist（已解析）
 * @param logger 内核日志
 * @returns 新注册集（档位已按新 allowlist 定格）
 */
export async function reapplyAllowlistToServer(
  serverName: string,
  connection: Pick<McpConnection, 'listTools' | 'callTool'>,
  registrar: ToolRegistrar,
  previous: readonly McpToolBinding[],
  allowKeys: McpToolAllowlist,
  logger?: ILogger,
): Promise<McpToolBinding[]> {
  return swapServerTools(
    serverName,
    connection.listTools(),
    connection,
    registrar,
    previous,
    allowKeys,
    logger,
  );
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
 * 同时清掉 allowlist 基线（无运行 server = 无生效档位，下次热更从零差分）。
 */
export async function stopMcpServers(): Promise<void> {
  const state = running;
  running = null;
  activeAllowKeys = null;
  if (!state) return;

  for (const entry of state.values()) {
    await disposeEntry(entry);
  }
  state.clear();
}

/**
 * `applyMcpConfigChange` 的热更注入
 */
export interface McpConfigChangeOptions {
  /**
   * 免确认 allowlist 原值（与 StartMcpOptions.allowlist 同口径：原值传入、内部解析一次）
   */
  allowlist: readonly string[];
  /** 内核日志（缺省不记） */
  logger?: ILogger;
  /** 扩展版本（重启 server 时写进 clientInfo） */
  clientVersion?: string;
  /** 连接工厂（测试注入假连接；生产缺省真连接） */
  connect?: McpConnectionFactory;
}

/**
 * 配置热更：按 name 差分应用 `memora.mcpServers` / `memora.mcpToolAllowlist` 变更（切片 4）
 *
 * 差分规则（方案 §10 配置热更登记行的落地）：
 *   - 新集有、旧集无 ⇒ 启动（首装同语义，失败只影响自己）；
 *   - 两边都有且配置**语义相同** ⇒ 不动（连接与进行中调用都不打断）；
 *   - 两边都有但配置变了 ⇒ **先停后起**（停旧连接再起新的——先起后停会短暂两套
 *     工具并存/派生名撞车）；
 *   - 旧集有、新集无（删除 / 停用 / 变非法）⇒ 停；
 *   - allowlist 变了（配置没变的 server）⇒ 连接不动，只 removeTool + registerTool
 *     重算档位（档位定格在注册时，见 reapplyAllowlistToServer）。
 *
 * 两条硬约束：
 *   1. **串行**：两个配置键同时变 / 用户连改多次，差分在同一模块级链上排队，
 *      不并发、不交错（并发差分会把注册面拧成半旧半新）；
 *   2. **不 resurrect**：热更在途时若发生停机/重装配（`running` 被抢走），
 *      本轮启的连接全部收尾关闭，不停机后留孤儿子进程。
 *
 * 未装配 Agent 时不懒装配——由调用方（extension.ts 的 runOnAssembledAgent）
 * 保证只在已装配时触发；下次装配本就会按新配置注入。
 *
 * @param agent 已 init 的内核 Agent（工具注册面 = agent.tools）
 * @param configs 新的用户配置原值（`memora.mcpServers`）
 * @param options allowlist 原值 + 日志 + 版本 + 连接工厂
 */
export function applyMcpConfigChange(
  agent: Agent,
  configs: readonly McpServerConfig[],
  options: McpConfigChangeOptions,
): Promise<void> {
  const run = hotReloadChain.then(() => applyConfigChangeInner(agent, configs, options));
  // inner 自行兜底错误（记日志、不抛出）⇒ 链不会被毒化，后续热更照常排队
  hotReloadChain = run;
  return run;
}

/** 热更差分主体（错误自吞：单条热更失败不该毒化串行链，也不该打断用户操作） */
async function applyConfigChangeInner(
  agent: Agent,
  configs: readonly McpServerConfig[],
  options: McpConfigChangeOptions,
): Promise<void> {
  const { allowlist, logger, clientVersion, connect } = options;
  try {
    const registrar = agent.tools;
    if (!registrar) {
      logger?.warn('[MCP] Agent 工具执行器不可用，跳过 MCP 配置热更');
      return;
    }

    const newKeys = parseAllowlist(allowlist);
    const allowChanged = !allowSetsEqual(activeAllowKeys, newKeys);
    const validNew = indexValidConfigs(configs, logger);

    const previous = running;
    const state = previous ?? new Map<string, RunningServer>();
    running = state;
    /** 配置没变、允许留下来的旧 server（allowlist 变了才需要对它们重算档位） */
    const kept: RunningServer[] = [];

    // ① 停：新可启动集里没有的（删除 / enabled:false / 变非法）
    for (const name of previous ? [...previous.keys()] : []) {
      if (validNew.has(name)) continue;
      await stopServerIn(state, name);
      if (running !== state) {
        await disposeState(state);
        return;
      }
    }

    // ② 起 / 换：新可启动集里的（未变不动；变了先停后起）
    for (const [name, config] of validNew) {
      const old = previous?.get(name);
      if (old && configsEqual(old.config, config)) {
        kept.push(old);
        continue;
      }
      if (old) await stopServerIn(state, name); // 先停后起
      await startOneServer(config, {
        registrar,
        allowKeys: newKeys,
        state,
        logger,
        clientVersion,
        connect,
      });
      if (running !== state) {
        await disposeState(state);
        return;
      }
    }

    // ③ allowlist 变了：只对「没重启过」的 server 重算档位（重启的已带新档位）。
    // 重算期间断线的（onClosed 已注销旧集）⇒ 补注销新集，勿留僵尸工具。
    if (allowChanged) {
      for (const entry of kept) {
        const fresh = await reapplyAllowlistToServer(
          entry.name,
          entry.connection,
          registrar,
          entry.bindings,
          newKeys,
          logger,
        );
        if (state.get(entry.name) === entry) {
          entry.bindings = fresh;
          // 同步 allowKeys：onToolsChanged 的整换按运行态 allowKeys 重派生档位，
          // 这里不更新 ⇒ 下一次 list_changed 会把档位退回热更前的旧值（免确认静默失效）
          entry.allowKeys = newKeys;
        } else {
          unregisterServerTools(registrar, fresh);
        }
        if (running !== state) {
          await disposeState(state);
          return;
        }
      }
    }

    activeAllowKeys = newKeys;
    noteToolCount(logger);
  } catch (err) {
    logger?.warn(`[MCP] 配置热更失败：${String(err)}`);
  }
}

/** 从指定运行态表停一台（摘除 + 注销 + 关闭；热更差分用，不读模块级 running） */
async function stopServerIn(state: Map<string, RunningServer>, name: string): Promise<void> {
  const entry = state.get(name);
  if (!entry) return;
  state.delete(name);
  await disposeEntry(entry);
}
