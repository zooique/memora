/**
 * 会话历史运维动作（删除 / 移入留存 / 移回 + manual 归档嫁接）——从 chatPanel 外置
 * （HOST-SPLIT-1 行数闸门；判据与文案随函数搬走，面板只做依赖注入，不新增第二份口径）
 *
 * 三个动作的共同点：都会改写**非当前会话**的会话文件 ⇒ 一次性短锁（拿 → 写 → 放）；
 * 当前会话由面板长持有锁，`oneShotLock` 判据保证不重复拿/放（重复放会误伤长锁）。
 * 面板侧只保留同名薄包装（既有测试与 webview 消息分派按方法名直达）。
 */
import { getSessionDisplayName, splitSessionId } from '@zooique/memora';
import { confirmModal } from '../../extension/host/ui/confirmModal.js';
import type { HostSessionStore } from '../../extension/host/sessionStore.js';

/** 目标会话正被另一个窗口持有时的统一提示（创建 / 切换 / 分叉 / 历史动作共用一句） */
export const SESSION_HELD_NOTICE =
  '该会话正在另一个窗口中使用。请先在那边的窗口切换或关闭它，再重试。';

/** 面板注入的能力（全部直连既有实现；本模块不持有面板状态） */
export interface SessionHistoryDeps {
  /** 会话存储（锁 / 归档 / 删除的唯一真源） */
  store: HostSessionStore;
  /**
   * 目标会话是否正在生成（缺省 = 当前会话）
   *
   * ⚠️ 必须按**目标会话**判（E4 批 2）：后台会话可以在别的会话正在显示时继续跑流，
   * 只判当前会话会让「删除/归档一个后台仍在流式写盘的会话」被放行——实例随即被关闭，
   * 流在写盘中途炸掉（且锁被提前还回去，另一窗口可接管后写冲突）。
   */
  isStreaming: (sessionId?: string) => boolean;
  /** 当前打开的会话 id（判「是否需一次性短锁」与「拒删当前会话」） */
  currentSessionId: () => string;
  /** 面板通知通道 */
  notify: (level: 'info' | 'error', message: string) => void;
  /** 重推历史列表 */
  pushList: () => void;
  /** 删除会话后联动软删记忆摘要 */
  softDeleteMemories: (removedIds: string[]) => void;
  /** 当前归档模式（Agent 未装配 ⇒ undefined） */
  archiveMode: () => string | undefined;
  /** 请求内核归档（fire-and-forget，成败走既有事件） */
  requestArchive: (date: string, session: string) => Promise<void>;
}

/**
 * 删除指定历史会话（历史浮层垃圾桶触发）
 *
 * 危险操作确认走 confirmModal（唯一入口，与 delete_turn 同强度确认）。
 * 当前会话不进历史记录（设计收敛），正常不会删除到当前会话；防御性保护：若目标是
 * 当前会话则拒绝 + 提示（防未来 UI 变动误删当前会话导致空窗）。
 *
 * @param sessionId 目标会话标识（YYYY-MM-DD-sessionName）
 */
export async function deleteSessionAction(
  deps: SessionHistoryDeps,
  sessionId: string,
): Promise<void> {
  // 运行时守卫（SSOT：与 newSession/switchToSession 同源「目标会话 streaming」，禁止运行中改会话结构）
  if (deps.isStreaming(sessionId)) {
    deps.notify('info', '生成中，请稍候再删除会话');
    return;
  }
  const meta = deps.store.getSessionMeta(sessionId);
  const title = getSessionDisplayName(meta) || sessionId;
  const confirmed = await confirmModal({
    message: `确定删除会话「${title}」？此操作不可恢复。`,
    confirmLabel: '删除',
  });
  if (!confirmed) return;
  if (sessionId === deps.currentSessionId()) {
    deps.notify('info', '当前会话不在历史记录，无法删除');
    return;
  }
  // 一次性写（短持有）：删除会重写/移除会话文件，另一个窗口正在用时必须拒绝
  if (!(await deps.store.acquireSessionLock(sessionId))) {
    deps.notify('info', SESSION_HELD_NOTICE);
    return;
  }
  try {
    // 联动：整删会话 → 被回收 Round（引用归零）的轮次摘要软删进回收站
    // （脱钩溯源，可恢复为独立记忆）。分叉共享轮由 deleteSession 返回值天然排除——
    // 不影响仍在使用的关联会话记忆。会话级路标存于 SessionMeta，随本调用一并删除。
    const removedIds = deps.store.deleteSession(sessionId);
    deps.softDeleteMemories(removedIds);
    // 删除成功给用户可见反馈，与「当前会话无法删除」提示对称
    deps.notify('info', '会话已删除');
  } catch (err) {
    // 删除失败不阻塞（重推列表仍可用），但需记录 + 给用户可见提示（SSOT 不藏错）
    console.warn('Memora 删除会话记录失败', err);
    deps.notify('error', '删除会话失败，请稍后重试');
  } finally {
    // 目标必不是当前会话（上方已拦），短持有锁用完即还
    deps.store.releaseSessionLock(sessionId);
  }
  deps.pushList();
}

/**
 * 把会话移入留存区（历史浮层「移入留存」触发）——**只改显示分组，数据一字不动**
 *
 * 与删除的三点刻意差异（勿互相靠拢，靠拢即造伤）：
 *   ① **无 modal 确认**：移入留存完全可逆（Round 文件、引用计数、内容全部不变），
 *      对它弹「此操作不可恢复」是撒谎——删除才配这个确认强度；
 *   ② **不减引用、不删任何文件**：引用归零会让启动清扫（`sweepOrphans`）把 Round 当孤儿
 *      物理删除，与「留存 = 保住记忆溯源的原文」的立项目的正好相反；
 *   ③ **给可见反馈**：改位是不可见的动作，没有反馈用户不知道发生了什么（静默改位 =
 *      「点了没反应」的观感）。
 *
 * **manual 模式顺带触发会话归档**（用户拍板嫁接 · 2026-10-19）：`archiveMode = manual`
 * 时自动归档被内核关掉（离场不生成摘要），设置的承诺「仅手动触发时生成」需要宿主给入口——
 * 嫁接到本按钮（用户「这个会话我处理完了」的既有手势）。
 *
 * @param sessionId 目标会话标识（YYYY-MM-DD-sessionName）
 */
export async function archiveSessionAction(
  deps: SessionHistoryDeps,
  sessionId: string,
): Promise<void> {
  // 运行时守卫（与 newSession/switchToSession/deleteSession 同源「目标会话 streaming」）
  if (deps.isStreaming(sessionId)) {
    deps.notify('info', '生成中，请稍后再整理会话');
    return;
  }
  // 一次性写（短持有）：归档会重写会话文件。当前会话已长持有锁，不再重复拿/放
  const oneShotLock = sessionId !== deps.currentSessionId();
  if (oneShotLock && !(await deps.store.acquireSessionLock(sessionId))) {
    deps.notify('info', SESSION_HELD_NOTICE);
    return;
  }
  try {
    if (!deps.store.archiveSession(sessionId)) {
      // 归档返回 false 的两种情形：会话不存在 / 已在留存区——都无需打扰，仅低强度提示
      deps.notify('info', '该会话已在留存区');
      return;
    }
    // manual 模式顺带触发会话归档（fire-and-forget，成败走既有事件；full 模式零动作）
    const archiveTriggered = triggerManualArchive(deps, sessionId);
    deps.notify(
      'info',
      // 触发了才提摘要：未触发（full 模式）时文案与改动前**一字不差**（不打扰既有用户）
      archiveTriggered
        ? '已移入留存区 · 已顺带请求会话摘要更新（内容未变则跳过）'
        : '已移入留存区（会话内容保留，可随时移回）',
    );
    deps.pushList();
  } finally {
    if (oneShotLock) deps.store.releaseSessionLock(sessionId);
  }
}

/**
 * manual 模式下「移入留存区」顺带触发会话归档（用户拍板嫁接 · 2026-10-19）
 *
 * 四条定案（改前必读，均属判据/边界，勿顺手改）：
 *   ① **模式门控**：仅 `archiveMode === 'manual'` 触发。full 模式零动作——自动归档已在离场
 *      时跑过，再点按钮重复调 LLM 等于给既有用户加成本与时延（**带伤**，不做）。
 *   ② **防重判据不在宿主**：传 `{ skipIfUnchanged: true }` 交内核 `SessionArchiver`
 *      单点判断（消息数快照）。宿主**不**自查「summary 是否存在」——那判据更粗，会把
 *      「归档后又聊了新内容、本该刷新」的摘要永久挡掉（防重 ≠ 防更新）。
 *   ③ **fire-and-forget**：成败走既有 `sessionArchived`（重拉列表 → 悬停 tooltip 落摘要）
 *      / `archiveFailed`（notice）事件，不阻塞点击；防重跳过 = 静默（无浪费亦无噪音）。
 *   ④ **重复点击到不了这里**：留存幂等（`archiveSession` 返回 false）已在调用方早退；
 *      「移出再移入」由 ② 的快照挡住。
 *
 * 术语：本模块的「留存」= 视图分组标记（本地/可逆/不动数据）；「归档」= 会话摘要生成
 * （LLM/可失败/写 SessionMeta）。二者**同词不同义**，注释与文案不得混用。
 *
 * @returns 是否触发了归档（false = full 模式 / Agent 未就绪 / 会话标识非法）
 */
export function triggerManualArchive(deps: SessionHistoryDeps, sessionId: string): boolean {
  if (deps.archiveMode() !== 'manual') return false;
  const { date, session } = splitSessionId(sessionId);
  if (!date || !session) return false;
  void deps.requestArchive(date, session).catch((err) => {
    // 内核 ArchiveCoordinator 已吞掉归档内部异常并发 archiveFailed 事件；此处兜的是
    // 更外层的失败（如 Agent 未初始化时 assertInitialized 抛错）——不藏错，给用户可见提示
    console.warn('Memora 手动归档触发失败', err);
    deps.notify('error', '会话摘要归档失败：Agent 未就绪');
  });
  return true;
}

/**
 * 把会话移回归属列表（留存区条目「移回」触发）——归档的逆操作
 *
 * 同样只改显示分组：不存在「数据恢复」这一说（数据从头到尾没动过）。
 *
 * @param sessionId 目标会话标识（YYYY-MM-DD-sessionName）
 */
export async function restoreSessionAction(
  deps: SessionHistoryDeps,
  sessionId: string,
): Promise<void> {
  if (deps.isStreaming(sessionId)) {
    deps.notify('info', '生成中，请稍后再整理会话');
    return;
  }
  // 一次性写（短持有）：与归档同判据（改会话文件即需归属）
  const oneShotLock = sessionId !== deps.currentSessionId();
  if (oneShotLock && !(await deps.store.acquireSessionLock(sessionId))) {
    deps.notify('info', SESSION_HELD_NOTICE);
    return;
  }
  try {
    if (!deps.store.unarchiveSession(sessionId)) {
      return; // 本就不在留存区：无变化即无反馈（避免为幂等动作刷提示）
    }
    deps.notify('info', '已移回会话记录');
    deps.pushList();
  } finally {
    if (oneShotLock) deps.store.releaseSessionLock(sessionId);
  }
}
