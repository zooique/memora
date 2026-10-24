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
 * 校验一条配置的**语法**是否完整（能不能进运行时）
 *
 * **导出理由（判据单点）**：设置面板的「保存」校验与启动侧的跳过判据必须是同一句
 * （`mcpServerOps` 直接复用本函数）。各写一份 = 面板能存进一条永远起不来的配置，
 * 或者反过来挡住一条合法配置——两种都是判据散点。
 *
 * 注意：名字/命令的**前后空白**在这里判为空（`'  '` 算缺），但不会帮你 trim 后写回——
 * 归一化不是判据的职责（见台账「name 归一化不单点」）。
 *
 * @param config 用户配置项
 * @returns 不可用原因；可用时返回 null
 */
export function configProblem(config: McpServerConfig): string | null {
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
 * 三条规则与首装历史口径一致：非法配置（缺 name/command）跳过并告警；`enabled: false`
 * 不启动（静默——用户显式停用，不该每次激活都告警）；重名**先到先得**
 * （工具名前缀按 server 名派生，后到的会与先到的撞名 → 直接跳过更诚实）。
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
    if (valid.has(config.name)) {
      logger?.warn(`[MCP] server 名重复，跳过后者：${config.name}`);
      continue;
    }
    valid.set(config.name, config);
  }
  return valid;
}
