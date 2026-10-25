/**
 * MCP 配置读取（vscode 耦合层 · 唯一读取点）
 *
 * 与 `host/mcp/` 下各模块的分界：那些是纯逻辑（零 vscode 依赖、可单测）；本文件读
 * VS Code 用户设置，是配置进宿主 MCP 运行时的唯一入口。**装配期**（getOrCreateAgent）
 * 与**热更**（activate 内的 onDidChangeConfiguration）都走这里，禁两处各写一份
 * getConfiguration（判据散点）。
 *
 * 只认**用户级**设置（package.json 里 `scope: "application"`）：工作区级 `.mcp.json`
 * 可被他人提交进仓库，等于让任意仓库自动拉起任意命令——**已定案不开放**，不是暂缓
 * （方案-MCP工具接入 §4.4「配置来源与授权边界」；重开须先改该章判据）。
 *
 * 生效语义（切片 4 起）：改完**即时生效**——onDidChangeConfiguration 按 name 差分
 * 增量启停（未变的不动、变更的先停后起、删除的停），allowlist 变更只重算档位，
 * 均无需重载窗口；Agent 未装配时不变更（下次装配按新配置注入，不懒装配）。
 */
import * as vscode from 'vscode';
import type { McpServerConfig } from './host/mcp/connectionManager.js';

/**
 * 配置键（与 `package.json` contributes 同名）
 *
 * 读（本文件）与写（`webview/panels/mcpServerOps.ts`）共用这两个常量：键名写错在写入侧
 * 不会报错、只会静默写到不存在的键上——两处各抄一份字面量就是这种事的前置条件。
 */
export const MCP_SERVERS_KEY = 'mcpServers';
/** 免确认白名单键 */
export const MCP_ALLOWLIST_KEY = 'mcpToolAllowlist';

/**
 * 读取 MCP 服务器配置（**唯一读取点**；装配、热更与设置面板的状态推送共用同一来源）
 *
 * **形态收窄在读取点做一次**：用户把 `mcpServers` 手写成对象/字符串（JSON 合法、形状不对）
 * 时，`get()` 会原样返回该值。收窄放这里而不是每个消费方各写一遍——散点判据的经典形态是
 * 「装配侧拦住了、面板侧没拦住」，表现就是「一个坏配置把设置页卡在『加载中…』」。
 * ⚠ 代价如实登记：非法形态被当作「没配置」（静默），面板暂无「配置格式不对」这一态。
 *
 * @returns 配置数组（非数组/缺省一律空数组，本函数不抛）
 */
export function readMcpServers(): McpServerConfig[] {
  const raw = vscode.workspace.getConfiguration('memora').get<unknown>(MCP_SERVERS_KEY, []);
  return Array.isArray(raw) ? (raw as McpServerConfig[]) : [];
}

/**
 * 读取 MCP 工具免确认 allowlist（**唯一读取点**）
 *
 * 键格式 / 原名寻址 / fail-closed 见 `host/mcp/policy.ts`；变更热更（只重算档位、
 * 不重连）见 `host/mcp/runtime.ts` 的 applyMcpConfigChange。
 */
export function readMcpToolAllowlist(): string[] {
  const raw = vscode.workspace.getConfiguration('memora').get<unknown>(MCP_ALLOWLIST_KEY, []);
  // 同一收窄口径（非数组 = 空集 ⇒ 全部每次确认，fail-closed 方向不受影响）
  return Array.isArray(raw) ? (raw as string[]) : [];
}
