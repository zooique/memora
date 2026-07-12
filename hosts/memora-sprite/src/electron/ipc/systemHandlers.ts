/**
 * 系统级 IPC 处理器
 *
 * 职责：
 *   1. 主动提示分发确认（PROACTIVE_PROMPT_SHOWN）
 *   2. 项目列表（PROJECTS_LIST，供专注模式选择器使用）
 *   3. 仪表盘数据聚合（DASHBOARD_GET，对齐 CLI /dashboard）
 *   4. 主题变更广播（THEME_CHANGED，同步浮动窗口主题）
 */

import { ipcMain } from 'electron';
import { logger, toError } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { throwingHandle } from './types.js';
import type { IpcContext } from './types.js';

/**
 * 注册系统级 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerSystemHandlers(ctx: IpcContext): void {
  // ─── 主动提示分发 ────────────────────────────────────────

  /** 渲染进程通知主动提示已显示，清除未读计数 */
  ipcMain.on(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN, () => {
    // 主动提示已显示，托盘切回 idle 状态
    ctx.trayManager?.setState('idle');
  });

  /**
   * Phase 2.1：用户接受了主动提示（点击"查看"按钮）
   *
   * 调用 Sprite.recordProactiveAccept() 记录接受事件，
   * 更新 ProactiveEngine 的接受率，重新推导情感基调（主动度提升）。
   */
  ipcMain.on(IPC_CHANNELS.PROACTIVE_ACCEPT, () => {
    ctx.sprite.recordProactiveAccept();
  });

  /**
   * Phase 2.1：用户拒绝/忽略了主动提示（点击"稍后"/关闭/静默/不再提醒）
   *
   * 调用 Sprite.recordProactiveReject() 记录拒绝事件，
   * 更新 ProactiveEngine 的连续拒绝计数（自适应冷却）。
   */
  ipcMain.on(IPC_CHANNELS.PROACTIVE_REJECT, () => {
    ctx.sprite.recordProactiveReject();
  });

  // ─── 项目管理（项目模式） ──────────────────────────

  /** 列出已注册项目（供 UI 专注模式选择器使用） */
  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () =>
    throwingHandle('获取项目列表失败', () => ({ projects: ctx.sprite.listProjects() })),
  );

  // ─── 仪表盘（UI 完整仪表盘） ──────────────────────

  /**
   * 获取完整仪表盘数据
   *
   * 对齐 CLI /dashboard 命令，提供：
   * - 记忆总数 + 按来源分组
   * - 累积事件数 + 主动提示阈值
   * - 已注册触发器列表
   * - 关联推荐记忆
   * - 记忆源健康诊断
   * - Agent 运行时指标（LLM/召回/工具/上下文/衰减）
   * - 已加载技能列表（消费内核 agent.skills.list）
   */
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_GET, () => {
    try {
      const data = ctx.sprite.dashboard();
      // 记忆源健康诊断（消费内核 sourceHealth()，为宿主提供每个 source 的质量指标）
      let sourceHealth = null;
      try {
        sourceHealth = ctx.sprite.sourceHealth();
      } catch (err) {
        // 降级：sourceHealth 不可用时仪表盘仍正常返回，debug 级别避免日志噪音
        logger.debug({ err: toError(err).message }, 'sourceHealth 获取失败，降级为 null');
      }
      // Agent 运行时指标（消费内核 agent.getMetrics()）
      let metrics = null;
      try {
        metrics = ctx.sprite.getMetrics();
      } catch (err) {
        // 降级：metrics 不可用时仪表盘仍正常返回，debug 级别避免日志噪音
        logger.debug({ err: toError(err).message }, 'metrics 获取失败，降级为 null');
      }
      // 已加载技能列表（消费内核 agent.skills.list）
      // 修复 TS18047：agent.skills 可能为 null，使用可选链 + 空数组降级
      const skills = ctx.agent.skills?.list.map((s) => ({
        name: s.name,
        keywords: s.keywords,
        description: s.description ?? '',
        layer: s.layer,
      })) ?? [];
      return {
        total: data.total,
        bySource: data.bySource,
        suggestions: data.suggestions,
        pendingNotices: ctx.sprite.pendingCount,
        proactiveThreshold: ctx.sprite.proactiveThreshold,
        registeredTriggers: ctx.sprite.registeredTriggers,
        sourceHealth,
        metrics,
        skills,
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '获取仪表盘数据失败' });
      // 主查询失败时显性抛出，让渲染层 loadDashboard 的 catch 触发 showToast
      // 避免返回空仪表盘让用户误以为"无数据"而非"加载失败"（§2：不吞异常返回空对象）
      throw error;
    }
  });

  /**
   * 获取感知数据快照（情感基调/默契度/对话上下文/模式洞察）
   *
   * UI 感知面板打开时主动调用，从当前记忆实时推导全量感知数据。
   * 无副作用：不 emit 事件、不注入 ProactiveEngine。
   */
  ipcMain.handle(IPC_CHANNELS.PERCEPTION_GET, () => {
    try {
      return ctx.sprite.getPerceptionSnapshot() ?? {};
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '获取感知数据失败' });
      return {};
    }
  });

  // ─── 启动摘要（迭代一：Welcome Back Digest） ────────────────

  /**
   * 获取启动摘要
   *
   * 聚合记忆/洞察/感知/衰减/健康数据，用于 Agent 就绪后展示欢迎卡片。
   * 返回 null 表示 Agent 未就绪，UI 应跳过摘要展示。
   */
  ipcMain.handle(IPC_CHANNELS.STARTUP_SUMMARY_GET, () => {
    try {
      return ctx.sprite.getStartupSummary();
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '获取启动摘要失败' });
      return null;
    }
  });

  // ─── 主题变更 ────────────────────────────────────────────

  /**
   * 主题变更通知
   *
   * 完整窗口切换主题后通知主进程，主进程广播到浮动窗口，
   * 确保两个窗口主题一致。
   */
  ipcMain.on(IPC_CHANNELS.THEME_CHANGED, (_event, theme: 'light' | 'dark') => {
    const floatWindow = ctx.windowManager.getFloatWindow();
    floatWindow?.broadcastTheme(theme);
  });

  // ─── 使用统计（AUDIT-5-3） ──────────────────────────────

  /** 导出使用统计 JSON 文件，返回文件路径。采集器未就绪时返回 null */
  ipcMain.handle(IPC_CHANNELS.USAGE_STATS_EXPORT, async () => {
    if (!ctx.usageStatsCollector) return null;
    try {
      return await ctx.usageStatsCollector.export();
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '导出使用统计失败' });
      return null;
    }
  });
}
