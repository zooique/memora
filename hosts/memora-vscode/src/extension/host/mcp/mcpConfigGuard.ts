/**
 * MCP 配置判据（语法合法性 + 可启动集收敛）
 *
 * **为什么单独成文件**：`runtime.ts` 贴 eslint `max-lines` 1000 的硬闸门；而这两个函数是
 * **纯判据**（不碰运行态、不碰连接），被三个地方共用——启动（`startMcpServers`）、热更
 * （`applyConfigChangeInner`）、设置面板保存（`mcpServerOps`）。判据和编排放一个文件时，
 * 面板为了复用一句校验不得不 import 整个运行时（连带 MCP SDK 进 webview 风险）；拆开后
 * 依赖方向变成「面板 → 判据」，不再反向依赖运行时。
 *
 * **判据只到语法层**：「命令在不在 PATH 里 / 路径指向什么」属于可执行性，归
 * `commandProbe.ts`（要碰文件系统）。两层分开的理由：语法判据要能在 webview 侧复用，
 * 不能带 I/O；可执行性判据只在宿主侧跑。
 */
import type { ILogger } from '@zooique/memora';
import type { McpServerConfig } from './connectionManager.js';

/**
 * server 名的**唯一**归一化点（trim；非字符串一律为空）
 *
 * **为什么必须单点**（2026-10-24 实测的 P1）：name 同时充当三样东西——运行态表的键、
 * `appliedConfigs` 的查找键、工具名前缀 `mcp__<server>__<tool>` 的 `<server>`。原先
 * 「写侧用原名、读侧 `trim()`」两边各归一化一半，`{name:"fs "}` 的实际结果是：
 * 连接**建立成功**（`connectCount=1`），状态面却查不到这个键 ⇒ 面板显示「启动失败」，
 * 并给出「可能被重名规则跳过」这句与事实无关的原因。用户会去排查一台好服务器。
 *
 * 归一化只动**内存副本**，不改写用户配置：`indexValidConfigs` 返回的是 `{...config}`
 * 派生的可启动集，落盘原值由 `appliedConfigs` / 面板 DTO 各自保留（面板 DTO 走同一函数，
 * 所以显示与寻址一致）。
 *
 * @param raw 配置里的 name（可能不是字符串）
 * @returns 归一化后的名；非法 = 空串（调用方按「缺 name」处理）
 */
export function normalizeServerName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 校验一条配置的**语法**是否完整（能不能进运行时）
 *
 * **导出理由（判据单点）**：设置面板的「保存」校验与启动侧的跳过判据必须是同一句
 * （`mcpServerOps` 直接复用本函数）。各写一份 = 面板能存进一条永远起不来的配置，
 * 或者反过来挡住一条合法配置——两种都是判据散点。
 *
 * 注意：名字/命令的**前后空白**在这里判为空（`'  '` 算缺），但不会帮你 trim 后写回——
 * 归一化不是判据的职责，见 {@link normalizeServerName}。
 *
 * @param config 用户配置项
 * @returns 不可用原因；可用时返回 null
 */
export function configProblem(config: McpServerConfig): string | null {
  if (normalizeServerName(config.name).length === 0) {
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
 * 三条规则与首装历史口径一致：非法配置（缺 name/command）跳过并告警；`enabled: false`
 * 不启动（静默——用户显式停用，不该每次激活都告警）；重名**先到先得**
 * （工具名前缀按 server 名派生，后到的会与先到的撞名 → 直接跳过更诚实）。
 *
 * **键与下传的 config.name 都取 {@link normalizeServerName}**：运行态表、失败表、状态面
 * 三处寻址同一个键。返回的是派生副本（`name` 已归一化），用户落盘配置不被改写。
 * 归一化后 `"fs"` 与 `"fs "` 算重名——这正是先到先得要覆盖的情形（原先两者键不同，
 * 都会启动，但状态面只显示一条，另一条成了看不见的幽灵子进程）。
 *
 * @param configs 用户配置原值
 * @param logger 告警通道（缺省不记）
 * @returns name → 配置（保序：配置顺序即启动顺序）
 */
export function indexValidConfigs(
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
    const name = normalizeServerName(config.name);
    if (valid.has(name)) {
      logger?.warn(`[MCP] server 名重复，跳过后者：${name}`);
      continue;
    }
    valid.set(name, { ...config, name });
  }
  return valid;
}
