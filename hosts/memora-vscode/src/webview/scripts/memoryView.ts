/**
 * memoryView — 记忆子视图 webview 运行时脚本（阶段 B P2-1 模式，2026-08-17）
 *
 * 由 settingsView.ts 挂载（设置视图选项卡合并后记忆子视图）：以工厂函数 createMemoryView
 * 接收依赖（vscode / window / root）并初始化全部交互，替代「字符串注入脚本」。
 *
 * 职责：
 *   - 渲染记忆列表（按 score 降序，source 徽章 + score 圆点 + 单行预览）；
 *   - 点击卡片展开详情（全文 content + 创建时间元数据）；
 *   - 搜索框输入（非空 → postMessage memory_search；清空 → 重新加载列表）；
 *   - 监听 memory_loaded / memory_search_result 渲染（host resolve 时推送 + 搜索应答）。
 *
 * 由 esbuild 以 browser/iife 打包进 dist/webview/scripts/settingsView.js（经 settingsViewMain
 * 入口），在 webview HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  ExtensionToWebviewMessage,
  GovernanceStatsDto,
  MemoryItemDto,
  MemoryStatsDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createEmptyState } from '../helpers/cardList.js';

/** memoryView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface MemoryViewDeps {
  /** webview 通信 API（SSOT：由 settingsView 统一 acquireVsCodeApi() 一次后注入，
   *  子视图不再各自调用——acquireVsCodeApi 每个 webview 只能调用一次） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
  /** 子视图挂载根容器（设置视图选项卡合并后：查询限定在根内，多子视图 id 空间隔离） */
  root: HTMLElement;
}

/** 记忆列表加载完成载荷（memory_loaded）的最小结构 */
interface MemoryLoadedPayload {
  stats: MemoryStatsDto;
  memories: MemoryItemDto[];
}

/** 记忆搜索结果载荷（memory_search_result）的最小结构 */
interface SearchResultPayload {
  query: string;
  hits: MemoryItemDto[];
}

/** source → 徽章样式类映射（未知 source 回退中性，开放字符串不应穷举） */
const SOURCE_BADGE_CLASS: Record<string, string> = {
  'round-summary': 'source-badge-round-summary',
  profile: 'source-badge-profile',
  'work-projection': 'source-badge-work-projection',
};

/** score 阈值：高于该值视为「重要记忆」（score 圆点亮 accent） */
const SCORE_HIGH = 0.6;

/**
 * 初始化记忆管理面板 webview 交互
 *
 * @param deps 运行时依赖（vscode 通信实例 + window + root）
 */
export function createMemoryView({ vscode, window, root }: MemoryViewDeps): void {
  const document = window.document;
  // id 空间隔离：查询限定在 root 容器内（设置视图合并后与 roles/config 子视图共存，
  // 各自根内都有 #list/#statBar，不做根内查询会冲突）
  const list = root.querySelector('#list') as HTMLElement;
  const statBar = root.querySelector('#statBar') as HTMLElement;
  const searchInput = root.querySelector('#searchInput') as HTMLInputElement;

  // 治理区元素（G4，2026-08-23：统计卡 + 衰减/清理按钮 + 结果提示）
  const govActive = root.querySelector('#govActive') as HTMLElement | null;
  const govDeleted = root.querySelector('#govDeleted') as HTMLElement | null;
  const govDecayRun = root.querySelector('#govDecayRun') as HTMLElement | null;
  const govDetail = root.querySelector('#govDetail') as HTMLElement | null;
  const btnDecay = root.querySelector('#btnDecay') as HTMLButtonElement | null;
  const btnCleanup = root.querySelector('#btnCleanup') as HTMLButtonElement | null;

  /** 当前搜索词（非空表示处于搜索模式，列表模式为空串） */
  let activeQuery = '';

  /** 渲染记忆列表（列表模式 / 搜索结果共用，searchSummary 可选区分） */
  function render(memories: MemoryItemDto[], searchSummary?: string): void {
    if (!memories || memories.length === 0) {
      // 空态引导：无记忆或搜索结果为空（SSOT：createEmptyState 纯函数）
      list.textContent = '';
      list.appendChild(
        createEmptyState(document, {
          title: searchSummary ? '没有匹配的记忆' : '暂无记忆',
          hint: searchSummary
            ? `未找到与「${searchSummary}」相关的记忆。换个关键词，或开始一段新对话让 Agent 生成记忆`
            : '对话沉淀的 round-summary 记忆会出现在这里',
        }),
      );
      return;
    }
    list.textContent = '';
    // 搜索模式：顶部展示命中摘要（主动可见：当前检索上下文）
    if (searchSummary) {
      const summary = document.createElement('div');
      summary.className = 'search-summary';
      summary.textContent = `「${searchSummary}」命中 ${memories.length} 条`;
      list.appendChild(summary);
    }
    memories.forEach((m) => list.appendChild(buildCard(m)));
  }

  /** 构建单个记忆条目卡片（名称 + source 徽章 + score + 预览 + 可展开详情） */
  function buildCard(m: MemoryItemDto): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mem-card';
    card.setAttribute('role', 'button');
    card.setAttribute('aria-expanded', 'false');
    card.title = '点击展开 / 收起详情';

    // 头部：名称 + source 徽章 + score 圆点
    const head = document.createElement('div');
    head.className = 'mem-card-head';
    const name = document.createElement('span');
    name.className = 'mem-card-name';
    name.textContent = m.name;
    name.title = m.name;
    head.appendChild(name);

    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'source-badge ' + (SOURCE_BADGE_CLASS[m.source] ?? '');
    sourceBadge.textContent = m.source;
    sourceBadge.title = m.id;
    head.appendChild(sourceBadge);

    // score 圆点：高重要度点亮 accent（视觉辅助，主动可见）
    const scoreDot = document.createElement('span');
    scoreDot.className = 'score-dot' + (m.score >= SCORE_HIGH ? ' score-dot-high' : '');
    scoreDot.title = `重要度 ${m.score.toFixed(2)}`;
    scoreDot.setAttribute('aria-hidden', 'true');
    head.appendChild(scoreDot);
    card.appendChild(head);

    // 内容预览：单行截断（快速扫读）
    const preview = document.createElement('div');
    preview.className = 'mem-card-preview';
    preview.textContent = m.content;
    card.appendChild(preview);

    // 展开/收起：点击切换，显示全文 + 创建时间（textContent 赋值防注入）
    card.addEventListener('click', () => {
      const expanded = card.classList.toggle('expanded');
      card.setAttribute('aria-expanded', String(expanded));
      let detail = card.querySelector('.mem-card-detail');
      if (expanded && !detail) {
        detail = document.createElement('div');
        detail.className = 'mem-card-detail';
        detail.textContent = m.content;
        card.appendChild(detail);
        // 元数据：创建时间（无 createdAt 则不显示）
        if (m.createdAt) {
          const meta = document.createElement('div');
          meta.className = 'mem-card-meta';
          meta.textContent = formatTime(m.createdAt);
          detail.appendChild(meta);
        }
      } else if (!expanded && detail) {
        detail.remove();
      }
    });
    return card;
  }

  /** ISO 时间 → 简短可读格式（YYYY-MM-DD HH:mm，无效输入回退原串） */
  function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 顶栏统计（source 分布 + 总数） */
  function renderStats(stats: MemoryStatsDto): void {
    statBar.hidden = false;
    const parts = Object.entries(stats.bySource).map(([s, n]) => `${s} ${n}`);
    statBar.textContent = `共 ${stats.total} 条` + (parts.length > 0 ? ` · ${parts.join(' · ')}` : '');
  }

  /** 渲染治理统计（活跃 / 回收站 / 衰减次数 + 累计衰减条数详情） */
  function renderGovernance(stats: GovernanceStatsDto): void {
    if (govActive) govActive.textContent = String(stats.active);
    if (govDeleted) govDeleted.textContent = String(stats.deleted);
    if (govDecayRun) govDecayRun.textContent = String(stats.decay?.runCount ?? 0);
    if (govDetail && stats.decay && stats.decay.totalDecayedCount > 0) {
      govDetail.hidden = false;
      govDetail.classList.remove('gov-error');
      govDetail.textContent = `累计衰减 ${stats.decay.totalDecayedCount} 条记忆`;
    } else if (govDetail) {
      govDetail.hidden = true;
    }
  }

  /**
   * 展示治理操作结果（governance_result）并刷新数据
   *
   * 治理操作会改变记忆库（衰减改 score 顺序 / 清理删条目）→ 重新拉取治理数据 + 列表，
   * 保证治理区统计与列表实时一致。
   */
  function showGovernanceResult(msg: { ok: boolean; message?: string; action: 'decay' | 'cleanup' }): void {
    if (govDetail) {
      govDetail.hidden = false;
      govDetail.textContent = msg.message ?? (msg.ok ? '操作完成' : '操作失败');
      govDetail.classList.toggle('gov-error', !msg.ok);
    }
    vscode.postMessage({ type: 'governance_load' });
    vscode.postMessage({ type: 'memory_load' });
  }

  // 消息接收：memory_loaded 渲染列表，memory_search_result 渲染搜索结果，governance_* 渲染治理区
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'memory_loaded') {
      const payload = msg as MemoryLoadedPayload;
      renderStats(payload.stats);
      activeQuery = '';
      render(payload.memories);
    } else if (msg.type === 'memory_search_result') {
      const payload = msg as SearchResultPayload;
      // 竞态守卫：仅当结果 query 与当前输入框一致才渲染——用户搜索后清空/改词时，
      // 迟到的旧搜索结果会被丢弃，避免残影覆盖列表态。
      if (payload.query !== searchInput.value.trim()) return;
      render(payload.hits, payload.query);
    } else if (msg.type === 'governance_loaded') {
      renderGovernance(msg.stats);
    } else if (msg.type === 'governance_result') {
      showGovernanceResult(msg);
    }
  });

  // 治理按钮：触发衰减 / 清理过期（确认由 host 侧弹窗，webview 只发消息）
  btnDecay?.addEventListener('click', () => {
    vscode.postMessage({ type: 'governance_decay' });
  });
  btnCleanup?.addEventListener('click', () => {
    vscode.postMessage({ type: 'governance_cleanup' });
  });

  // 搜索：非空提交搜索，清空回列表（防抖避免每击键都触发 IPC）
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    searchTimer = setTimeout(() => {
      if (query) {
        activeQuery = query;
        vscode.postMessage({ type: 'memory_search', query });
      } else if (activeQuery) {
        // 从搜索模式清空 → 重新加载列表
        activeQuery = '';
        vscode.postMessage({ type: 'memory_load' });
      }
    }, 300);
  });

  // 首屏：请求加载列表 + 治理统计
  vscode.postMessage({ type: 'memory_load' });
  vscode.postMessage({ type: 'governance_load' });
}
