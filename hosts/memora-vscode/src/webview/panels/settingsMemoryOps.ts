/**
 * 记忆写操作（删除 / 恢复 / 永久删除 / 清空回收站 / 内联编辑 / 清理过期）
 *
 * **为什么外置**：`settingsPanel.ts` 贴着 eslint `max-lines` 上限（只降不升），而记忆写操作
 * 是本页最大的一块「线性增长域」（每条都是确认框 + 单点写 + 回推 + 刷新三件套）。外置后
 * 面板只留一行委派，后续给记忆加操作不再消耗面板行预算。
 *
 * 职责边界：**只做写与回推，不碰 DOM、不持有面板状态**。宿主的加载器（列表 / 回收站 /
 * 治理统计）由调用方以只读能力注入，避免本模块反向依赖面板类，也避免绕过单一加载路径
 * 另写一份查询。
 */
import * as vscode from 'vscode';
const { l10n } = vscode; // 可见文案 l10n（英文源键 → 当前 UI 语言；收据见判据⑨键面守卫）
import type { Agent, MemoryInspector } from '@zooique/memora';
import { MEMORY_RECYCLE_RETENTION_DAYS } from '../../shared/constants.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
// 模态确认框唯一入口（禁自开 showWarningMessage + modal: true）
import { confirmModal } from '../../extension/host/ui/confirmModal.js';
// 内核错误文本的宿主投影（保持与其它通知同源，不在这里另造一句）
import { toNoticeText } from '../../extension/host/noticeText.js';

/**
 * 记忆写操作所需的宿主能力
 *
 * 只暴露「取内核句柄 + 回推 + 刷新」三类能力：写操作不需要知道面板怎么渲染，也不需要
 * 知道消息怎么序列化——那些留在调用方，本模块只负责「改数据 + 说结果」。
 */
export interface MemoryOpsContext {
  /** 取记忆检查器（Agent 未就绪 ⇒ undefined，各操作据此回推「未就绪」而不是抛） */
  ensureMemory(): Promise<MemoryInspector | undefined>;
  /** 取 Agent（清空/清理需要 agent.memory，与 ensureMemory 同源但保留 Agent 层判据） */
  ensureAgent(): Promise<Agent | undefined>;
  /** 回推消息给 webview（序列化与可见性判定在面板侧） */
  post(msg: ExtensionToWebviewMessage): void;
  /** 刷新记忆列表（首屏 + 分页数据） */
  loadMemory(): Promise<void>;
  /** 刷新回收站列表 */
  loadRecycle(): Promise<void>;
  /** 刷新治理统计 */
  loadGovernance(): Promise<void>;
}

/**
 * 删除单条记忆（memory_delete）
 *
 * 软删除：弹确认框后调 agent.memory.writeDelete(id)（进入回收站，可恢复），
 * 完成后推送 memory_deleted + 刷新记忆列表与治理统计。取消确认不推送。
 */
export async function deleteMemoryOp(ctx: MemoryOpsContext, id: string): Promise<void> {
  const memory = await ctx.ensureMemory();
  if (!memory) {
    ctx.post({
      type: 'memory_deleted',
      ok: false,
      id,
      message: l10n.t('The Agent is not ready; cannot delete the memory'),
    });
    return;
  }
  const confirmed = await confirmModal({
    message: l10n.t(
      'Delete this memory? It moves to the recycle bin and can be restored at any time.',
    ),
    confirmLabel: l10n.t('Delete'),
  });
  if (!confirmed) return;
  try {
    memory.writeDelete(id);
    ctx.post({ type: 'memory_deleted', ok: true, id });
    await ctx.loadMemory();
    await ctx.loadGovernance();
  } catch (err) {
    ctx.post({ type: 'memory_deleted', ok: false, id, message: toNoticeText(err) });
  }
}

/**
 * 恢复单条记忆（memory_restore）
 *
 * 调 agent.memory.writeRestore(id) 从回收站恢复，完成后推送 memory_restored + 刷新
 * 记忆列表与治理统计；webview 收到 ok 后自行重新拉取回收站列表（若展开）。
 */
export async function restoreMemoryOp(ctx: MemoryOpsContext, id: string): Promise<void> {
  const memory = await ctx.ensureMemory();
  if (!memory) {
    ctx.post({
      type: 'memory_restored',
      ok: false,
      id,
      message: l10n.t('The Agent is not ready; cannot restore the memory'),
    });
    return;
  }
  try {
    memory.writeRestore(id);
    ctx.post({ type: 'memory_restored', ok: true, id });
    await ctx.loadMemory();
    await ctx.loadGovernance();
  } catch (err) {
    ctx.post({ type: 'memory_restored', ok: false, id, message: toNoticeText(err) });
  }
}

/**
 * 永久删除回收站单条记忆（memory_purge）
 *
 * 弹确认框后调 agent.memory.writePurge(id) 物理删除（不可恢复），完成后推送 memory_purged
 * + 刷新回收站/记忆列表/治理统计。
 */
export async function purgeMemoryOp(ctx: MemoryOpsContext, id: string): Promise<void> {
  const memory = await ctx.ensureMemory();
  if (!memory) {
    ctx.post({
      type: 'memory_purged',
      ok: false,
      id,
      message: l10n.t('The Agent is not ready; cannot permanently delete the memory'),
    });
    return;
  }
  const confirmed = await confirmModal({
    message: l10n.t('Permanently delete this memory? This cannot be undone.'),
    confirmLabel: l10n.t('Delete permanently'),
  });
  if (!confirmed) return;
  try {
    memory.writePurge(id);
    ctx.post({ type: 'memory_purged', ok: true, id });
    // 刷新回收站 + 列表（可能删的是活跃记忆外的回收条目，仅 count/回收站变化）
    await ctx.loadRecycle();
    await ctx.loadGovernance();
  } catch (err) {
    ctx.post({ type: 'memory_purged', ok: false, id, message: toNoticeText(err) });
  }
}

/**
 * 清空回收站（memory_recycle_clear）
 *
 * 弹确认框后遍历 listDeleted() 逐个 writePurge 物理删除全部软删记忆（不可恢复），
 * 完成后推送 memory_recycle_cleared + 刷新回收站/治理统计。
 */
export async function clearRecycleOp(ctx: MemoryOpsContext): Promise<void> {
  const memory = await ctx.ensureMemory();
  if (!memory) {
    ctx.post({
      type: 'memory_recycle_cleared',
      ok: false,
      count: 0,
      message: l10n.t('The Agent is not ready; cannot empty the recycle bin'),
    });
    return;
  }
  // 空回收站：无需确认，直接回报 0
  // 取全部（不传 limit）——本函数把 deleted 同时用作「删除操作集合」与「上报条数」，
  // 任何截断都会造成部分清理 + 谎报条数（deleted 条数即上报 count，须取全量，不能传上限）。
  const deleted = memory.listDeleted();
  if (deleted.length === 0) {
    ctx.post({ type: 'memory_recycle_cleared', ok: true, count: 0 });
    return;
  }
  const confirmed = await confirmModal({
    message: l10n.t(
      'Empty the recycle bin? {0} memories will be permanently deleted. This cannot be undone.',
      deleted.length,
    ),
    confirmLabel: l10n.t('Empty recycle bin'),
  });
  if (!confirmed) return;
  try {
    for (const m of deleted) memory.writePurge(m.id);
    ctx.post({ type: 'memory_recycle_cleared', ok: true, count: deleted.length });
    await ctx.loadRecycle();
    await ctx.loadGovernance();
  } catch (err) {
    ctx.post({ type: 'memory_recycle_cleared', ok: false, count: 0, message: toNoticeText(err) });
  }
}

/**
 * 编辑单条记忆内容（memory_edit，内联编辑）
 *
 * read-modify-write：经 agent.memory.getById(id) 取真实 Memory，仅改 content 并标记
 * isModified（人工修改），writeUpsert 落盘（保留 accessedAt/metadata 等字段，避免从
 * 损失性 DTO 重建丢字段）。完成后推送 memory_edited + 刷新记忆列表与治理统计。
 */
export async function editMemoryOp(
  ctx: MemoryOpsContext,
  id: string,
  content: string,
): Promise<void> {
  const memory = await ctx.ensureMemory();
  if (!memory) {
    ctx.post({
      type: 'memory_edited',
      ok: false,
      id,
      message: l10n.t('The Agent is not ready; cannot edit the memory'),
    });
    return;
  }
  const existing = memory.getById(id);
  if (!existing) {
    ctx.post({
      type: 'memory_edited',
      ok: false,
      id,
      message: l10n.t('The memory does not exist or has been deleted'),
    });
    return;
  }
  try {
    memory.writeUpsert({ ...existing, content, isModified: true });
    ctx.post({ type: 'memory_edited', ok: true, id });
    await ctx.loadMemory();
    await ctx.loadGovernance();
  } catch (err) {
    ctx.post({ type: 'memory_edited', ok: false, id, message: toNoticeText(err) });
  }
}

/**
 * 清理过期软删除记忆（governance_cleanup）
 *
 * 破坏性操作：弹确认框后调 agent.memory.writePurgeExpired(保留期前) 永久删除，
 * 完成后刷新治理统计与记忆列表（与 memora.cleanupMemories 命令同语义、同保留期常量）。
 */
export async function runCleanupOp(ctx: MemoryOpsContext): Promise<void> {
  const agent = await ctx.ensureAgent();
  if (!agent?.memory) {
    ctx.post({
      type: 'governance_result',
      ok: false,
      message: l10n.t('The Agent is not ready; cannot clean up memories'),
      action: 'cleanup',
    });
    return;
  }
  const confirmed = await confirmModal({
    message: l10n.t(
      'Memories soft-deleted more than {0} days ago will be permanently deleted. This cannot be undone.',
      MEMORY_RECYCLE_RETENTION_DAYS,
    ),
    confirmLabel: l10n.t('Confirm cleanup'),
  });
  if (!confirmed) return;
  try {
    const cutoff = new Date(Date.now() - MEMORY_RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = agent.memory.writePurgeExpired(cutoff);
    ctx.post({
      type: 'governance_result',
      ok: true,
      message: l10n.t('Cleaned up {0} expired memories', purged),
      action: 'cleanup',
    });
    await ctx.loadGovernance();
    await ctx.loadMemory();
  } catch (err) {
    ctx.post({
      type: 'governance_result',
      ok: false,
      message: toNoticeText(err),
      action: 'cleanup',
    });
  }
}
