/**
 * Agent 就绪守卫（自 `chatPanel.getAgentOrWarn` 外置）
 *
 * 为什么外置：聊天面板已贴有效行上限，这段「取实例 → 懒装配 → 仍没有就提示」的
 * 分支逻辑与面板自身的状态无关，只是对「当前实例 + 装配入口」两个闭包的编排。
 *
 * 语义保持不变：未装配时先尝试 `ensure`，仍取不到才提示一次并返回 undefined
 * （调用方必须 fail-closed，不得拿 undefined 继续写）。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';

/**
 * 取当前 Agent，必要时触发一次懒装配
 *
 * @param current 读当前实例（未装配返回 undefined）
 * @param ensure 装配入口（可异步；失败由调用方既有错误路径处理）
 * @returns 可用的 Agent；装配后仍没有则为 undefined（已提示用户）
 */
export async function requireAgent(
  current: () => Agent | undefined,
  ensure: () => Promise<void>,
): Promise<Agent | undefined> {
  // 快路径：已装配直接返回，不付装配成本
  if (current()) return current();
  await ensure();
  const agent = current();
  if (!agent) {
    // 提示语是既有键（本函数只是搬家，不新增文案面）
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Memora: Agent is not ready; retry shortly'),
    );
    return undefined;
  }
  return agent;
}
