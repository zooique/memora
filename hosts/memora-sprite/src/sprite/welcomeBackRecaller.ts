/**
 * WelcomeBackRecaller — 欢迎回来记忆召回（方向 A：遗忘召回）
 *
 * 独立模块，职责单一：
 *   长时间离开（&gt;= 1 小时）后回来时，取离开期间产生的新记忆，
 *   构造摘要后通过 proactiveEngine.addNotice('recalled', summary) 注入主动提示队列。
 *
 * 设计要点：
 *   - 由 PresenceController.handlePresent 在 checkPending 之前触发，
 *     这样 checkPending 能一并消费召回事件
 *   - 记忆选取策略：取 50 条 → 按 createdAt 过滤出离开期间的记忆 → 取前 5 条
 *   - 零 LLM 调用，纯模板拼接
 *   - 召回失败不影响后续 checkPending（错误隔离）
 *
 * 与 perceptionCoordinator.getCrossSessionContext 的选取范式相似（都先取 50 再按时间过滤），
 * 但时间窗口语义不同——此处是"离开期间"，getCrossSessionContext 是"gapMs + 2h"。
 * 不强行提取公共方法，因两处时间窗口语义不可统一。
 */
import type { Memory } from 'memora';
import { logger } from 'memora';
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from './constants.js';

/**
 * 记忆列表查询器签名
 *
 * 抽象为接口类型，避免 WelcomeBackRecaller 直接依赖 Agent 全部 API。
 * 实际由 Sprite 注入 `(limit) => agent.memory.list(limit)`。
 */
export type MemoryLister = (limit: number) => Memory[];

/**
 * 召回通知注入器签名
 *
 * 用于将构造好的摘要注入主动提示队列。
 * 参数对齐 ProactiveEngine.addNotice(type, summary, isMilestone, priority)，
 * 实际由 Sprite 注入 `(type, summary, isMilestone?, priority?) => proactiveEngine.addNotice(...)`。
 */
export type RecallNotifier = (
  type: 'recalled' | 'suggestion',
  summary: string,
  isMilestone?: boolean,
  priority?: 'normal' | 'high' | 'critical',
) => void;

/**
 * WelcomeBackRecaller 构造依赖
 */
export interface WelcomeBackRecallerDeps {
  /** 记忆列表查询器（注入 agent.memory.list） */
  listMemories: MemoryLister;
  /** 召回通知注入器（注入 proactiveEngine.addNotice） */
  notifyRecall: RecallNotifier;
}

/**
 * 欢迎回来记忆召回器
 *
 * 使用方式：
 *   const recaller = new WelcomeBackRecaller(deps);
 *   recaller.recall(awayDurationMs);  // 在 PresenceController.onWelcomeBack 回调中调用
 */
export class WelcomeBackRecaller {
  private readonly deps: WelcomeBackRecallerDeps;

  constructor(deps: WelcomeBackRecallerDeps) {
    this.deps = deps;
  }

  /**
   * 欢迎回来记忆召回
   *
   * 取 50 条活跃记忆（按 score 降序），再按 createdAt 过滤出离开期间产生的新记忆。
   * 离开期间的判定：createdAt >= (now - awayDurationMs)，即离开开始之后创建的记忆。
   *
   * @param awayDurationMs 离开时长（毫秒），必定 >= WELCOME_BACK_THRESHOLD_MS（由调用方保证）
   */
  recall(awayDurationMs: number): void {
    try {
      // 取 50 条活跃记忆（按 score 降序），再按 createdAt 过滤出离开期间产生的新记忆
      const now = Date.now();
      const awaySinceMs = now - awayDurationMs;
      const allMemories = this.deps.listMemories(50);
      const recentMemories = allMemories
        .filter((m) => {
          const createdMs = new Date(m.createdAt).getTime();
          return createdMs >= awaySinceMs;
        })
        .slice(0, 5);

      // 离开期间无新记忆则不提示（避免提示无关的旧记忆）
      if (recentMemories.length === 0) {
        logger.debug({ awayDurationMs }, '离开期间无新记忆，跳过召回');
        return;
      }

      // 构造时长描述（分钟/小时/天），复用 constants.ts 时间常量（DRY）
      // [SYNC-PERCEPTION-COORDINATOR] perceptionCoordinator.getCrossSessionContext 有相似的时长格式化，
      // 两处语义不同（此处是"离开时长"，彼处是"对话间隔"），不强行提取公共方法
      const minutes = Math.round(awayDurationMs / MS_PER_MINUTE);
      const durationText =
        awayDurationMs < MS_PER_HOUR
          ? `${minutes} 分钟`
          : awayDurationMs < MS_PER_DAY
            ? `${Math.round(awayDurationMs / MS_PER_HOUR)} 小时`
            : `${Math.round(awayDurationMs / MS_PER_DAY)} 天`;

      // 构造摘要：时长 + 数量 + 前 3 个 name（提升信息量）
      // 第一人称文案：体现精灵主动感知（presenceController 检测离开 + 记忆系统主动归档）
      const names = recentMemories
        .map((m) => m.name)
        .filter((n) => n.length > 0)
        .slice(0, 3);
      const nameList = names.length > 0 ? `（${names.join('、')}）` : '';
      const summary = `我注意到你离开了 ${durationText}，期间我整理了 ${recentMemories.length} 条新记忆${nameList}`;

      // 注入主动提示队列，type='recalled' 由 buildPrompt 专属分支处理
      this.deps.notifyRecall('recalled', summary);

      logger.info(
        { awayDurationMs, memoryCount: recentMemories.length, names },
        '欢迎回来记忆召回已注入',
      );
    } catch (err) {
      // 召回失败不影响后续 checkPending（错误隔离，与 PresenceController 的 try/catch 双重保护）
      logger.warn({ err, awayDurationMs }, '欢迎回来记忆召回失败');
      this.deps.notifyRecall(
        'suggestion',
        '欢迎回来时记忆召回失败，部分近期记忆可能未捕获',
        false,
        'high',
      );
    }
  }
}
