/**
 * Memora Doc Review — VS Code 插件入口（ADR-VC-001 宿主）
 *
 * 职责：
 *   - 注册命令（委托到 commands/ 目录）
 *   - 懒加载装配 Agent（getOrCreateAgent）
 *
 * 结构（未来目录规划见 docs/directory-structure.md）：
 *   - commands/   命令处理器
 *   - host/       薄壳装配（注入 memora 内核）
 *   - skills/     Agent Skill 能力层
 *   - webview/    面板 UI（仅 postMessage）
 *   - shared/     extension ↔ webview 消息协议
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { assembleDocReviewAgent } from './host/assemble.js';
import { openDocReviewCommand } from './commands/openDocReview.js';
import { reviewDocumentCommand } from './commands/reviewDocument.js';

/** 懒加载的 Agent 单例（跨命令复用） */
let agentPromise: Promise<Agent> | null = null;

/** 获取（或创建）指定工作区的 Agent 实例 */
function getOrCreateAgent(projectPath: string): Promise<Agent> {
  if (!agentPromise) {
    agentPromise = assembleDocReviewAgent({ projectPath }).catch((err) => {
      // 装配失败则重置，下次命令重试
      agentPromise = null;
      throw err;
    });
  }
  return agentPromise;
}

/** 插件激活入口 */
export function activate(context: vscode.ExtensionContext): void {
  // 命令：打开设计文档打磨面板
  context.subscriptions.push(
    vscode.commands.registerCommand('memoraDocReview.open', () =>
      openDocReviewCommand(getOrCreateAgent),
    ),
  );

  // 命令：审阅当前文档自洽性（切片 B，复用 doc-review skill）
  context.subscriptions.push(
    vscode.commands.registerCommand('memoraDocReview.review', () =>
      reviewDocumentCommand(getOrCreateAgent),
    ),
  );
}

/** 插件停用入口 */
export function deactivate(): void {
  // Agent 由宿主持有；如需优雅关闭可在后续阶段补充 agent.close()
}
