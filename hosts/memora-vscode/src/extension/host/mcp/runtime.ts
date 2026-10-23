/**
 * MCP 运行时编排 — 配置 → 连接 → 映射 → 注册，以及停机时的注销与进程收割
 *
 * 这是宿主侧 MCP 的**唯一入口**（assemble 启动、deactivate 停机都只调本文件），
 * 连接与映射的细节分别落在 connectionManager / toolRegistry。
 *
 * 失败语义（刻意如此）：
 *   - 单个 server 连不上/握手失败 → 只记日志、该 server 零工具，**不阻断 Agent 装配**；
 *   - server 运行中断线 → 注销它的全部工具（不留僵尸工具让模型调死连接）；
 *   - 用户配置非法（缺 name/command、重名）→ 跳过该条并告警，不猜意图。
 */
import type { Agent, ILogger } from '@zooique/memora';
import { McpConnection, type McpServerConfig } from './connectionManager.js';
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
  /** 已注册工具的派生缓存（注销按名删除） */
  bindings: McpToolBinding[];
}

/** 运行态集合（模块级单例，与宿主 agentPromise/currentAgent 的单例口径一致） */
let running: Map<string, RunningServer> | null = null;

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
 * @param logger 内核日志（缺省不记）
 * @param clientVersion 扩展版本（写进 MCP clientInfo，仅供 server 遥测）
 */
export async function startMcpServers(
  agent: Agent,
  configs: readonly McpServerConfig[],
  logger?: ILogger,
  clientVersion?: string,
): Promise<void> {
  // 无配置 = 完全不碰内核工具集（零行为变化）
  if (configs.length === 0) return;

  await stopMcpServers();

  const registrar = agent.tools;
  if (!registrar) {
    logger?.warn('[MCP] Agent 工具执行器不可用，跳过 MCP 服务器装配');
    return;
  }

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
      const { bindings, skipped } = buildToolBindings(config.name, tools);
      for (const item of skipped) {
        logger?.warn(`[MCP:${config.name}] 工具「${item.toolName}」已跳过：${item.reason}`);
      }
      registerServerTools(registrar, bindings, (originalName, args) =>
        connection.callTool(originalName, args),
      );
      // 断线即注销：传输层主动 close 时不触发（McpConnection 用 closing 标记过滤）
      connection.onClosed = () => {
        unregisterServerTools(registrar, bindings);
        state.delete(config.name);
      };
      state.set(config.name, { connection, registrar, bindings });
      logger?.info(`[MCP] server「${config.name}」已接入，注册工具 ${bindings.length} 个`);
    } catch (err) {
      // 单点失败不影响其余 server，也不阻断 Agent 装配（宿主其余功能照常）
      logger?.warn(`[MCP] server「${config.name}」接入失败：${String(err)}`);
      await connection.close().catch(() => undefined);
    }
  });

  await Promise.all(starts);
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
