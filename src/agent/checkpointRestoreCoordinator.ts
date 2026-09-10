/**
 * Agent 检查点恢复协议 — 恢复时「召回什么 / 注入什么 / 预判什么」
 *
 * 职责：
 *   - warmRecall：温记忆按需召回（以 mainGoal/currentGoal 查询早期上下文，合并资源槽 + 注入 loop）
 *   - reinject：契约重注入（角色 persona / 技能 / 规则，恢复后 system prompt 与暂停前一致）
 *   - restore：完整恢复编排（热窗口载入 → 温记忆召回 → 契约重注入）
 * 注：原 shouldGenerateTaskTable（任务表预判，event 路径专属）已随 composer 剪枝移除。
 *
 * 设计原则：
 *   - 只依赖 Agent 注入的稳定能力（deps），不反向依赖 Agent 私有状态（与 ContextPreparer 同构）
 *   - 恢复协议单一真理源：恢复时每一步的领域逻辑在本类唯一实现
 *   - Agent 门面保留编排动作（autoResumeIfPaused 并发锁 + 状态机翻转）与公开 API 委托
 *   - 事件发射（memoryRecalled / rolePackSwitched）经 emit 回调由 Agent 承接
 */

import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { SessionManager } from '@/agent/managers/sessionManager.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import { recall, touchScores } from '@/memory/recall.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { ITracer } from '@/agent/tracer.js';
import type { SessionCheckpoint } from '@/agent/types.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { AGENT_EVENTS, type AgentEventName } from '@/utils/eventEmitter.js';
import { DEFAULT_MIN_FALLBACK } from '@/utils/recallDefaults.js';
import { logger } from '@/logging/logger.js';

/**
 * 检查点恢复协议的依赖注入接口（Agent 稳定能力的窄面）
 *
 * 边界：只传 Agent 的稳定能力（组件引用 / 配置 / 事件发射 / 生命周期回调），
 * 不传可变私有状态；生命周期回调（工具暴露 / 前缀刷新）由 Agent 注入。
 */
export interface CheckpointRestoreDeps {
  /** 会话管理器（热窗口载入 / 资源槽合并） */
  sessionManager: SessionManager;
  /** 消息历史（与恢复上下文对齐） */
  history: MessageHistory;
  /** AgentLoop（系统消息注入：温记忆 / 任务表提示） */
  loop: AgentLoop;
  /** 懒取项目记忆索引（requirePctx.index 等价物） */
  getIndex: () => IMemoryStorage;
  /** 角色包管理器（角色契约重注入；可为 null） */
  rolePackManager: RolePackManager | null;
  /** 宿主可观测性 / 存储 / 文案配置 */
  config: {
    /** 可观测性 Tracer（可选） */
    tracer: ITracer | null;
    /** 向量存储（可选，提供时启用语义召回） */
    vectorStore: IVectorStore | null;
    /** 召回排除的 source 列表 */
    recallExcludeSources: string[] | undefined;
  };
  /** 事件发射（桥接到 Agent 强类型 emit） */
  emit: (event: AgentEventName, data: unknown) => void;
  /** 角色包激活后应用工具暴露面（Agent 生命周期回调） */
  applyRolePackToolExposure: () => void;
  /** 角色包激活后刷新 loop 前缀（Agent 生命周期回调） */
  refreshRolePackPrefixOnLoop: () => void;
}

/**
 * 检查点恢复协议协调器
 *
 * 承载恢复会话时的完整领域协议：热窗口载入、温记忆按需召回、契约重注入。
 * Agent.restoreFromCheckpoint 保留为公开 API 委托本类。
 */
export class CheckpointRestoreCoordinator {
  /** 依赖注入集合（Agent 稳定能力窄面） */
  private readonly deps: CheckpointRestoreDeps;

  constructor(deps: CheckpointRestoreDeps) {
    this.deps = deps;
  }

  /**
   * 温记忆按需召回（恢复协议步骤③）
   *
   * 以 mainGoal/currentGoal 查询，从温记忆（归档 recall）召回窗口外早期上下文，
   * 合并进资源槽（memories + context）并注入 loop 的 system message，让恢复后感知暂停前完整上下文。
   * 召回失败静默降级，仅记日志，不影响热窗口恢复与契约重注入。
   *
   * `minFallback` 显式传参（2026-09-10 P1-B）：恢复场景有意保留保底，见调用点注释。
   *
   * @param checkpoint 会话检查点
   */
  async warmRecall(checkpoint: SessionCheckpoint): Promise<void> {
    const { deps } = this;
    // 以 mainGoal/currentGoal 拼接为查询条件
    const query = [checkpoint.mainGoal, checkpoint.currentGoal]
      .filter((s) => s && s.trim().length > 0)
      .join(' ');

    if (!query.trim()) {
      logger.debug('温记忆按需召回：mainGoal/currentGoal 均为空，跳过');
      return;
    }

    try {
      // 热窗口互斥排除（与 contextPreparer 对称）：恢复时热窗口（HOT_MEMORY_MAX_ROUNDS 轮）
      // 正文已载入 loop，其 round-summary 不应再被温召回二次注入（装配时间线互斥，防止重复）
      const recentRoundIds = new Set(
        deps.history.getRecentRoundIds(AGENT_CONSTANTS.HOT_MEMORY_MAX_ROUNDS),
      );

      const recalledMemories = await recall(
        deps.getIndex(),
        query,
        {
          limit: AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT,
          // 显式传参（2026-09-10 P1-B）：恢复场景**有意保留保底**，不依赖 recall.ts 的隐式默认——
          // 恢复时 LLM 无工具调用机会，语义零命中会直接丢失任务连续性 → 宁滥勿缺。
          minFallback: DEFAULT_MIN_FALLBACK,
          vectorStore: deps.config.vectorStore ?? undefined,
          excludeSources: deps.config.recallExcludeSources,
          // 会话窗口标识与写入侧 sessionName 同源同值（restoreFromCheckpoint 已 loadSessionMessages 同步），
          // 保证恢复的早期上下文在当前会话窗口优先（round-summary 层级 L1）
          sessionId: deps.history.currentSessionName,
          // 前置互斥排除：热窗口已注入轮次的 round-summary 不重复召回
          excludeRoundIds: recentRoundIds,
        },
      );

      if (recalledMemories.length === 0) {
        logger.debug({ query }, '温记忆按需召回：无相关记忆');
        return;
      }

      // 与正常工具命中路径（memoryInspector/searchHybrid）对称：召回命中的温记忆做 touch 持久化，
      // 仅刷新 accessedAt（接受度曲线「被想起即刷新」），不 +score——§5.2 只 touch 不 +score 定案。
      // 恢复路径低频（恢复一次），fire-and-forget 不阻塞恢复读路径。
      void touchScores(
        deps.getIndex(),
        recalledMemories.map((m) => m.id),
      ).catch((err: unknown) => {
        logger.warn({ query, err }, '温记忆召回 touch 持久化失败');
      });

      // 将召回的温记忆 ID 去重合并到资源槽 memories
      const sm = deps.sessionManager;
      const currentResource = sm.getCheckpoint()?.resource;
      if (currentResource) {
        const existingIds = new Set(currentResource.memories);
        const newIds = recalledMemories
          .map((m) => m.id)
          .filter((id) => !existingIds.has(id));
        if (newIds.length > 0) {
          sm.updateResource({
            ...currentResource,
            memories: [...currentResource.memories, ...newIds],
            // context 末尾追加温记忆召回摘要，标记召回来源
            context:
              currentResource.context +
              (currentResource.context ? '\n' : '') +
              `[温记忆召回: ${recalledMemories.map((m) => `${m.source}:${m.name || m.id}`).join(', ')}]`,
          });
        }
      }

      // 将温记忆注入为系统消息，让 Agent 感知暂停前的早期上下文
      const loop = deps.loop;
      const warmContext = recalledMemories
        .map((m) => `[${m.source}:${m.name || m.id}] ${m.content}`)
        .join('\n\n');
      loop.injectSystemMessage(
        `[恢复的早期上下文]\n以下为会话暂停前归档的早期上下文：\n\n${warmContext}`,
      );

      deps.emit(AGENT_EVENTS.memoryRecalled, {
        count: recalledMemories.length,
        query,
      });

      logger.info(
        { count: recalledMemories.length, query },
        '温记忆按需召回完成，已合并到资源槽并注入参考上下文',
      );
    } catch (err) {
      // 温记忆召回失败时静默降级：仅记录日志，不影响热窗口恢复和后续流程
      logger.warn({ err }, '温记忆按需召回失败（降级：仅恢复热窗口和契约）');
    }
  }

  /**
   * 契约重注入（恢复协议步骤④），确保恢复后 system prompt 与暂停前一致：
   * - 角色契约：按检查点角色切换 persona 并刷新 system prompt
   * - 规则契约：由 AgentLoop 的 bootstrap 机制自动注入，无需额外处理
   * 角色不存在静默降级（保持当前角色）。
   *
   * @param checkpoint 会话检查点
   */
  reinject(checkpoint: SessionCheckpoint): void {
    const { deps } = this;

    // 角色包契约重注入：按检查点角色名刷新系统 prompt
    if (deps.rolePackManager && checkpoint.role.name) {
      try {
        const prevName = deps.rolePackManager.activeName;
        if (prevName !== checkpoint.role.name) {
          // 角色包不存在时 activate 返回 false
          const success = deps.rolePackManager.activate(checkpoint.role.name);
          if (success) {
            deps.emit(AGENT_EVENTS.rolePackSwitched, {
              from: prevName,
              to: checkpoint.role.name,
            });
            deps.applyRolePackToolExposure();
          }
        }
        // 无论是否切换都刷新前缀，确保角色包 prompt 注入 loop
        deps.refreshRolePackPrefixOnLoop();
      } catch (err) {
        // 角色包不存在时静默降级：保持当前角色，仅记日志
        logger.warn(
          { err, roleName: checkpoint.role.name },
          '契约重注入：角色包切换失败，保持当前角色',
        );
      }
    }

    // 规则契约由 AgentLoop 的 bootstrapMemories 自动注入，无需额外处理

    logger.info({ role: checkpoint.role.name }, '契约重注入完成');
  }

  /**
   * 完整恢复会话（恢复协议主流程）：
   * ① 快照反序列化 + ② 热窗口载入（SessionManager）→ ③ 温记忆按需召回 → ④ 契约重注入；
   * 温记忆召回失败静默降级，仅恢复热窗口和契约，不影响继续对话。
   *
   * @param checkpoint 会话检查点
   * @returns 恢复的消息数量
   */
  async restore(checkpoint: SessionCheckpoint): Promise<number> {
    // ①② 快照反序列化 + 热窗口载入（SessionManager，async 需 await）
    const messageCount = await this.deps.sessionManager.restoreFromCheckpoint(checkpoint);

    // ③ 温记忆按需召回（以 mainGoal/currentGoal 查询早期上下文）
    await this.warmRecall(checkpoint);

    // ④ 契约重注入（persona/skill）
    this.reinject(checkpoint);

    logger.info(
      { sessionId: checkpoint.sessionId, messageCount },
      '检查点恢复协议完成（热窗口 + 温记忆 + 契约重注入）',
    );

    return messageCount;
  }
}
