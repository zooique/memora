/**
 * MCP 配置读取（vscode 耦合层 · 唯一读取点）
 *
 * 与 `host/mcp/` 下各模块的分界：那些是纯逻辑（零 vscode 依赖、可单测）；本文件读
 * VS Code 用户设置，是配置进宿主 MCP 运行时的唯一入口。**装配期**（getOrCreateAgent）
 * 与**热更**（activate 内的 onDidChangeConfiguration）都走这里，禁两处各写一份
 * getConfiguration（判据散点）。
 *
 * 只认**用户级**设置（package.json 里 `scope: "application"`）：工作区级 `.mcp.json`
 * 可被他人提交进仓库，等于让任意仓库自动拉起任意命令，信任来源未拍板前不开放
 * （方案-MCP工具接入 §10「server 配置来源与信任」登记项）。
 *
 * 生效语义（切片 4 起）：改完**即时生效**——onDidChangeConfiguration 按 name 差分
 * 增量启停（未变的不动、变更的先停后起、删除的停），allowlist 变更只重算档位，
 * 均无需重载窗口；Agent 未装配时不变更（下次装配按新配置注入，不懒装配）。
 */
import * as vscode from 'vscode';
import type { McpServerConfig } from './host/mcp/connectionManager.js';

/** 读取 MCP 服务器配置（**唯一读取点**；装配与热更共用同一来源） */
export function readMcpServers(): McpServerConfig[] {
  return vscode.workspace.getConfiguration('memora').get<McpServerConfig[]>('mcpServers', []);
}

/**
 * 读取 MCP 工具免确认 allowlist（**唯一读取点**）
 *
 * 键格式 / 原名寻址 / fail-closed 见 `host/mcp/policy.ts`；变更热更（只重算档位、
 * 不重连）见 `host/mcp/runtime.ts` 的 applyMcpConfigChange。
 */
export function readMcpToolAllowlist(): string[] {
  return vscode.workspace.getConfiguration('memora').get<string[]>('mcpToolAllowlist', []);
}
