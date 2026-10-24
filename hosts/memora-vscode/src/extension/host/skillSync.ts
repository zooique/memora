/**
 * 技能启停同步（宿主侧唯一实现）
 *
 * 为什么下沉到 host/ 而不是留在 extension.ts：
 *   「配置变更监听」与「Memora: 重载技能与角色包」命令**共用同一实现**。命令逻辑外置到
 *   `extension/commands/` 后，若让命令模块反向 import `extension.ts` 就会形成循环依赖
 *   （extension.ts → commands/* → extension.ts），故把这一块共享能力下沉到 host/。
 *
 * 消费面（两个，缺一即「只刷一半」）：
 *   ① 装配期注入：`getOrCreateAgent` 读 {@link readDisabledSkills} 喂内核；
 *   ② 运行期同步：配置变更监听 + 重载命令调 {@link syncDisabledSkills}。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraSettingsViewProvider } from '../../webview/panels/settingsPanel.js';

/**
 * 读取「禁用的技能名」配置（技能启停，**唯一读取点**）
 *
 * 三处消费共用本函数：① 装配期注入；② 配置变更监听；③ 手动重载命令。
 * 各自内联 `getConfiguration` 会让**键名与默认值**在三个地方各存一份，改一处漏两处。
 *
 * ⚠️ 真源是内核 `disabledNames`（本函数只负责把配置取出来喂给它）；宿主不自存副本、
 * UI 不另读本配置 —— 否则 `reloadConfig` 重设后两源分叉，出现「UI 说已禁用、实际仍生效」。
 */
export function readDisabledSkills(): string[] {
  return vscode.workspace.getConfiguration('memora').get<string[]>('disabledSkills', []);
}

/**
 * 技能启停同步：把宿主配置的禁用集喂给内核 + 刷新**两条** UI 消费通道。
 *
 * 单一实现 —— 配置变更监听与「Memora: 重载技能与角色包」命令共用，防两处各写一份。
 *
 * 消费通道必须枚举完整（缺一即「只刷一半」，血的教训）：
 *   ① 对话区技能下拉 + chip 标注 → `chatProvider.refreshSkillList()`
 *   ② 设置页技能卡片（「已禁用」徽章 + health） → `settingsProvider.refreshSkillList()`
 *
 * 内核侧 `setDisabledSkills` 为纯内存 clear+add（幂等、无 IO），故本函数可安全重复调用。
 *
 * @param agent 已装配的 Agent（内核侧持有 skills 管理器）
 * @param chatProvider 对话视图提供者（技能下拉 / chip 的刷新入口）
 * @param settingsProvider 设置视图提供者（技能卡片的刷新入口）
 */
export function syncDisabledSkills(
  agent: Agent,
  chatProvider: MemoraChatViewProvider,
  settingsProvider: MemoraSettingsViewProvider,
): void {
  // 禁用集每次重读配置：调用点既有「用户刚改配置」，也有「命令重载」，读缓存会让后者同步到旧值
  agent.skills?.setDisabledSkills(readDisabledSkills());
  chatProvider.refreshSkillList();
  // 设置页刷新为异步（含逐项 health 校验）：显式接住 rejection —— 刷新失败只影响设置页
  // 展示（下次打开设置页会重新加载），不得冒泡成未处理异常打断调用方
  void settingsProvider.refreshSkillList().catch((err) => {
    console.warn('Memora 技能清单刷新（设置页）失败', err);
  });
}
