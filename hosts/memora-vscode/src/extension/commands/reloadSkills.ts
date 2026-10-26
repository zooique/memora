/**
 * 命令：重载技能与角色包（技能系统热重载入口）
 *
 * 技能是角色包作者的高频手改对象，此入口免去改/加技能文件后 Reload Window 才生效。
 *
 * 从 extension.ts 外置而来（零行为变更）：命令逻辑归本目录，入口只保留注册行。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { toNoticeText } from '../host/noticeText.js';
import { syncDisabledSkills } from '../host/skillSync.js';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraSettingsPanel } from '../../webview/panels/settingsPanel.js';

/**
 * 重载技能与角色包
 *
 * ⚠️ 忙碌态必须「分两次带 source」调用 —— 判据同源：agent.isBusy 读的正是内核
 * reloadConfig 守门用的同一个 chatLockManager.isBusy。
 *   内核在对话中**只暂存带 source 的请求**（agent.ts：「undefined（全量）不暂存——无具体来源，
 * 补执行语义不明」）⇒ 无参调用在对话中会把用户的重载请求**静默丢弃**
 * （既没重载、也没排队），此时提示「重载失败」不实（内核在守门处即返回，未尝试重载）（坑）。
 *   故空闲走一次全量；忙碌则分两次带 source 调用（两条都进 pendingConfigReload，
 * 由 flushPendingConfigReload 在 turn 结束后补执行），并如实告知「已提交」。
 *
 * @param tryGetAgent 取当前工作区 Agent（失败返 null，不抛错——命令侧统一提示「未就绪」）
 * @param chatProvider 对话视图提供者（技能清单刷新通道之一）
 * @param settingsProvider 设置面板提供者（技能清单刷新通道之一）
 */
export async function reloadSkillsCommand(
  tryGetAgent: () => Promise<Agent | null>,
  chatProvider: MemoraChatViewProvider,
  settingsProvider: MemoraSettingsPanel,
): Promise<void> {
  const agent = await tryGetAgent();
  if (!agent) {
    vscode.window.showWarningMessage('Memora Agent 未就绪，无法重载技能');
    return;
  }
  // 禁用集 + UI 同步（启停闭环）：配置变更本身已由 onDidChangeConfiguration 监听
  // 自动完成；此处保留为**幂等兜底**——reloadConfig 会重扫技能池（增删技能后清单变化），
  // 重设一次保证「手动重载后 UI 与内核一致」，且万一监听未触发仍有手动救济路径。
  syncDisabledSkills(agent, chatProvider, settingsProvider);
  if (agent.isBusy) {
    // allSettled：忙碌态两次调用都会以 chatBusyError 结束（守门发生在任何 IO 之前），
    // 属预期路径，不该冒泡成未处理异常。
    await Promise.allSettled([agent.reloadConfig('skill'), agent.reloadConfig('rolePack')]);
    // 措辞须对两种时序都成立：判据为真后锁可能瞬间释放（此时两次调用会真的立即生效）。
    vscode.window.showInformationMessage(
      '技能重载请求已提交；若对话仍在进行，将在对话空闲时自动生效',
    );
    return;
  }
  try {
    const result = await agent.reloadConfig();
    vscode.window.showInformationMessage(
      `技能已重载：全局技能 ${result.skill} 个 / 角色包技能 ${result.rolePack} 个`,
    );
  } catch (err) {
    vscode.window.showWarningMessage(`技能重载失败：${toNoticeText(err)}`);
  }
}
