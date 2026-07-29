/**
 * 系统级 IPC 处理器
 *
 * 职责：
 *   1. 主动提示分发确认（PROACTIVE_PROMPT_SHOWN）
 *   2. 项目列表（PROJECTS_LIST，供专注模式选择器使用）
 *   3. 仪表盘数据聚合（DASHBOARD_GET，对齐 CLI /dashboard）
 *   4. 主题变更广播（THEME_CHANGED，同步浮动窗口主题）
 *   5. 应用更新检查（CHECK_UPDATE，fetch GitHub Releases API + 版本比对）
 */

import { ipcMain, app, dialog, shell } from 'electron';
import { logger, toError } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS } from './channels.js';
import { throwingHandle, requireSprite, requireAgent } from './types.js';
import type { IpcContext } from './types.js';

/** 公开发布仓 owner（GitHub 用户名） */
const GH_OWNER = 'zooique';
/** 公开发布仓仓库名（只放 exe，不含源码） */
const GH_REPO = 'memora-sprite-releases';

/**
 * 语义化版本比较器（数值比较，非字符串比较）
 *
 * "0.10.0" > "0.9.0" 字符串比较会返回 false（漏报），必须用数值比较。
 * @param a 远程版本号（如 "1.5.0"）
 * @param b 本地版本号（如 "1.4.0"）
 * @returns a 是否严格大于 b
 */
function gtVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

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
    ctx.getSprite()?.recordProactiveAccept();
  });

  /**
   * Phase 2.1：用户拒绝/忽略了主动提示（点击"稍后"/关闭/静默/不再提醒）
   *
   * 调用 Sprite.recordProactiveReject() 记录拒绝事件，
   * 更新 ProactiveEngine 的连续拒绝计数（自适应冷却）。
   */
  ipcMain.on(IPC_CHANNELS.PROACTIVE_REJECT, () => {
    ctx.getSprite()?.recordProactiveReject();
  });

  // ─── 项目管理（项目模式） ──────────────────────────

  /** 列出已注册项目（供 UI 专注模式选择器使用） */
  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () =>
    throwingHandle('获取项目列表失败', () => ({ projects: requireSprite(ctx).listProjects() })),
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
      // 缓存 Sprite 实例：本 handler 内多次调用，统一取一次避免重复调用 getter
      const sprite = requireSprite(ctx);
      const data = sprite.dashboard();
      // 记忆源健康诊断（消费内核 sourceHealth()，为宿主提供每个 source 的质量指标）
      let sourceHealth = null;
      try {
        sourceHealth = sprite.sourceHealth();
      } catch (err) {
        // 降级：sourceHealth 不可用时仪表盘仍正常返回，debug 级别避免日志噪音
        logger.debug({ err: toError(err).message }, 'sourceHealth 获取失败，降级为 null');
      }
      // Agent 运行时指标（消费内核 agent.getMetrics()）
      let metrics = null;
      try {
        metrics = sprite.getMetrics();
      } catch (err) {
        // 降级：metrics 不可用时仪表盘仍正常返回，debug 级别避免日志噪音
        logger.debug({ err: toError(err).message }, 'metrics 获取失败，降级为 null');
      }
      // 已加载技能列表（消费内核 agent.skills.list）
      // agent.skills 可能为 null（Agent 未配置技能时），使用可选链 + 空数组降级
      const skills = requireAgent(ctx).skills?.list.map((s) => ({
        name: s.name,
        keywords: s.keywords,
        description: s.description ?? '',
        layer: s.layer,
      })) ?? [];
      return {
        total: data.total,
        bySource: data.bySource,
        suggestions: data.suggestions,
        pendingNotices: sprite.pendingCount,
        proactiveThreshold: sprite.proactiveThreshold,
        registeredTriggers: sprite.registeredTriggers,
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
   * 手动触发一次记忆衰减（L0 纯 score 递减）
   *
   * 衰减完成后内核自动触发 decayCompleted 事件，仪表盘会通过事件监听刷新指标。
   */
  ipcMain.handle(IPC_CHANNELS.MEMORY_DECAY_RUN, () => {
    try {
      requireSprite(ctx).triggerDecayRun();
      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '手动触发记忆衰减失败' });
      return { success: false, error: error instanceof Error ? error.message : '未知错误' };
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
      return requireSprite(ctx).getPerceptionSnapshot() ?? {};
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
      return requireSprite(ctx).getStartupSummary();
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

  /** 清除使用统计数据（AUDIT-5-4） */
  ipcMain.handle(IPC_CHANNELS.USAGE_STATS_CLEAR, async () => {
    const collector = ctx.usageStatsCollector;
    if (!collector) return;
    try {
      await collector.clear();
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '清除使用统计失败' });
    }
  });

  // ─── 应用更新检查 ────────────────────────────────────────

  /**
   * 检查应用更新
   *
   * 流程：fetch GitHub Releases API → 比对版本 → 有新版弹 dialog → 用户确认后打开下载页
   * - 公开仓 API 免鉴权（匿名限速 60 次/小时/IP，按钮触发足够）
   * - 无新版/请求失败时静默返回，不打扰用户
   * - 返回结果供 renderer 侧做 toast 反馈
   */
  ipcMain.handle(IPC_CHANNELS.CHECK_UPDATE, async () => {
    /** 当前应用版本（宿主 package.json version） */
    const appVersion = app.getVersion();
    try {
      // 10 秒超时保护：国内访问 api.github.com 可能很慢，避免按钮无限等待
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(
        `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`,
        { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'MemoraSprite' }, signal: controller.signal },
      );
      clearTimeout(timeoutId);
      // 404=尚无 Release；403=匿名限速；网络错误 → 静默返回，不打扰用户
      if (!res.ok) {
        logger.debug({ status: res.status }, '检查更新：API 请求未成功');
        return { hasUpdate: false, reason: 'no-release' };
      }
      const rel = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
      /** 远程版本号（去掉 v 前缀） */
      const remoteVer = String(rel.tag_name || '').replace(/^v/, '');
      if (!remoteVer) {
        return { hasUpdate: false, reason: 'invalid-tag' };
      }
      // 版本无更新 → 静默返回
      if (!gtVersion(remoteVer, appVersion)) {
        return { hasUpdate: false, reason: 'up-to-date', current: appVersion, remote: remoteVer };
      }
      // 有新版 → 弹 dialog 提示用户
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '检测到新版本',
        message: `当前 ${appVersion} → 最新 ${remoteVer}`,
        detail: rel.body || '无更新日志',
        buttons: ['稍后', '前往下载'],
        defaultId: 1,
      });
      // 用户点击"前往下载" → 打开 GitHub 发布页
      if (response === 1 && rel.html_url) {
        await shell.openExternal(rel.html_url);
      }
      return { hasUpdate: true, current: appVersion, remote: remoteVer };
    } catch (error) {
      // 不显式传 code：让 extractErrorCode 根据 'fetch failed' 自动推断为 NETWORK_ERROR
      // （显式传 UNKNOWN 会覆盖推断，导致 code 误报为 UNKNOWN）
      errorHandler.handle(error, { context: '检查更新失败' });

      // 错误分类：区分超时/网络，供 renderer 给用户更精准的提示
      const err = toError(error);
      const isTimeout = err.name === 'AbortError';
      const isNetwork = err.name === 'TypeError' || err.message.includes('fetch');

      // 网络失败时弹 dialog 提供"前往下载页"选项——api.github.com 国内不可达是常见情况，
      // 让用户能直接打开 releases 页面手动查看，而非只看到 toast 提示束手无策
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: '检查更新失败',
        message: isTimeout ? '检查更新超时' : '网络连接失败',
        detail: isTimeout
          ? `连接 GitHub API 超时（10 秒）。请检查网络或稍后重试。\n\n也可直接前往下载页查看最新版本：\nhttps://github.com/${GH_OWNER}/${GH_REPO}/releases`
          : `无法连接 GitHub API（可能是网络限制或 DNS 问题）。\n\n可尝试：\n• 配置代理后重试\n• 直接前往下载页查看最新版本：\nhttps://github.com/${GH_OWNER}/${GH_REPO}/releases`,
        buttons: ['关闭', '前往下载页'],
        defaultId: 1,
      });
      if (response === 1) {
        await shell.openExternal(`https://github.com/${GH_OWNER}/${GH_REPO}/releases`);
      }

      return {
        hasUpdate: false,
        reason: isTimeout ? 'timeout' : isNetwork ? 'network' : 'error',
        error: err.message,
      };
    }
  });
}
