/**
 * 命令：记忆治理（查看统计 / 清理过期 / 手动垃圾回收）
 *
 * 宿主补齐 `agent.memory.*` 与 `agent.gcNow()` 的消费面；三条命令共用「先取 Agent、
 * 未就绪即提示」的同一壳，故归一个文件（拆成三个文件只会把同一句提示抄三遍）。
 *
 * ⚠ 术语消歧（2026-10-18）：本文件的「记忆治理」是**宿主产品概念**（面板展示活跃/回收站/
 * 来源分布/已被取代数），数据全部来自 `agent.memory.stats()` / `listDeleted()` / `list()`。
 * 它与内核那个已于 5.0.0 整链退役的 `agent.governance` **门面无关**，别再据旧注释去内核找它。
 *
 * 从 extension.ts 外置而来（零行为变更）。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { toNoticeText } from '../host/noticeText.js';
import { MEMORY_RECYCLE_RETENTION_DAYS } from '../../shared/constants.js';

/**
 * 查看记忆统计（agent.memory + agent.getMetrics()）
 *
 * @param tryGetAgent 取当前工作区 Agent（失败返 null）
 */
export async function memoryStatsCommand(tryGetAgent: () => Promise<Agent | null>): Promise<void> {
  const agent = await tryGetAgent();
  if (!agent) {
    vscode.window.showWarningMessage('Memora Agent 未就绪，无法查看记忆统计');
    return;
  }
  const mem = agent.memory;
  // 统计口径 SSOT = 内核 memory.stats()（total = 活跃数，bySource = 来源分布；走
  // sourceCountCache / getAllSources 增量缓存，精确且免全量列举）。若用 list(1000)
  // 自行聚合，superseded 与来源分布超 1000 条时双双低报（坑）。
  const stats = mem?.stats();
  const activeCount = stats?.total ?? 0;
  const deletedCount = mem?.listDeleted().length ?? 0;
  const sourceSummary =
    Object.entries(stats?.bySource ?? {})
      .map(([src, cnt]) => `${src}: ${cnt}`)
      .join(', ') || '—';
  vscode.window.showInformationMessage(
    `记忆统计：活跃 ${activeCount} 条，回收站 ${deletedCount} 条 | 来源分布：${sourceSummary}`,
  );
}

/**
 * 清理过期软删除记忆（agent.memory.writePurgeExpired()）
 *
 * @param tryGetAgent 取当前工作区 Agent（失败返 null）
 */
export async function cleanupMemoriesCommand(
  tryGetAgent: () => Promise<Agent | null>,
): Promise<void> {
  const agent = await tryGetAgent();
  if (!agent?.memory) {
    vscode.window.showWarningMessage('Memora Agent 未就绪，无法清理记忆');
    return;
  }
  // 确认对话框——防止误操作。不传显式「取消」：VS Code modal 自带系统级取消
  // （取消钮 / Esc / 关闭 X），再传会出现双取消；confirmed !== '确认清理' 已兼容 undefined
  const confirmed = await vscode.window.showWarningMessage(
    `将永久删除 ${MEMORY_RECYCLE_RETENTION_DAYS} 天前的软删除记忆，此操作不可撤销。`,
    { modal: true },
    '确认清理',
  );
  if (confirmed !== '确认清理') return;
  try {
    // 保留期 SSOT = shared/constants（与设置面板「清理过期」同源，改一处即两侧同步）
    const cutoff = new Date(Date.now() - MEMORY_RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = agent.memory.writePurgeExpired(cutoff);
    vscode.window.showInformationMessage(`已清理 ${purged} 条过期记忆`);
  } catch (err) {
    vscode.window.showErrorMessage(`清理失败：${toNoticeText(err)}`);
  }
}

/**
 * 立即执行孤儿 Round 垃圾回收（agent.gcNow() 手动触发入口）
 *
 * @param tryGetAgent 取当前工作区 Agent（失败返 null）
 */
export async function runGcCommand(tryGetAgent: () => Promise<Agent | null>): Promise<void> {
  const agent = await tryGetAgent();
  if (!agent) {
    vscode.window.showWarningMessage('Memora Agent 未就绪，无法执行垃圾回收');
    return;
  }
  try {
    const stats = agent.gcNow();
    vscode.window.showInformationMessage(
      `孤儿回收完成：扫描 ${stats.scanned} 个问答闭环，清理 ${stats.deleted} 个孤立 Round + ${stats.memoryCleaned} 条摘要`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(`垃圾回收失败：${toNoticeText(err)}`);
  }
}
