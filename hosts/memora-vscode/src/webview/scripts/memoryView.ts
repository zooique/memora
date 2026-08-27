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

/** SummaryType → 中文徽章文案（round-summary 子类型，对齐内核 SummaryType 硬契约） */
const TYPE_BADGE_LABEL: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  intent: '意图',
  general: '通用',
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

  // 治理区元素（G4，2026-08-23：统计卡 + 清理按钮 + 结果提示）
  const govActive = root.querySelector('#govActive') as HTMLElement | null;
  const govDeleted = root.querySelector('#govDeleted') as HTMLElement | null;
  const govSuperseded = root.querySelector('#govSuperseded') as HTMLElement | null;
  const govDetail = root.querySelector('#govDetail') as HTMLElement | null;
  const btnCleanup = root.querySelector('#btnCleanup') as HTMLButtonElement | null;

  // 回收站 + 提示（G19，2026-08-25：软删除记忆的可恢复暂存区 + 操作反馈）
  const recycle = root.querySelector('#recycle') as HTMLDetailsElement | null;
  const recycleList = root.querySelector('#recycleList') as HTMLElement | null;
  const recycleSummary = root.querySelector('#recycle > summary') as HTMLElement | null;
  const memHint = root.querySelector('#memHint') as HTMLElement | null;

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
    // 治理状态：取代态 / 编辑态（仅 round-summary 且满足条件时标记）
    if (m.supersededBy) card.classList.add('mem-card-superseded');
    if (m.isModified) card.classList.add('mem-card-modified');
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

    // 类型徽章：round-summary 的子类型（SummaryType），与 source 徽章互补展示语义分类
    if (m.summaryType) {
      const typeBadge = document.createElement('span');
      typeBadge.className = 'type-badge';
      typeBadge.textContent = TYPE_BADGE_LABEL[m.summaryType] ?? m.summaryType;
      typeBadge.title = `摘要类型：${m.summaryType}`;
      head.appendChild(typeBadge);
    }

    // score 圆点：高重要度点亮 accent（视觉辅助，主动可见）
    const scoreDot = document.createElement('span');
    scoreDot.className = 'score-dot' + (m.score >= SCORE_HIGH ? ' score-dot-high' : '');
    scoreDot.title = `重要度 ${m.score.toFixed(2)}`;
    scoreDot.setAttribute('aria-hidden', 'true');
    head.appendChild(scoreDot);

    // 删除按钮（G19）：stopPropagation 避免触发卡片展开，独立走 memory_delete
    const delBtn = document.createElement('button');
    delBtn.className = 'mem-del-btn';
    delBtn.textContent = '✕';
    delBtn.title = '删除这条记忆（进入回收站，可恢复）';
    delBtn.setAttribute('aria-label', '删除记忆');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'memory_delete', id: m.id });
    });
    // 编辑按钮（G19 内联 edit，2026-08-25）：stopPropagation 避免触发卡片展开，独立走 memory_edit
    const editBtn = document.createElement('button');
    editBtn.className = 'mem-edit-btn';
    editBtn.textContent = '✎';
    editBtn.title = '编辑这条记忆的内容';
    editBtn.setAttribute('aria-label', '编辑记忆');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      enterEditMode();
    });
    head.appendChild(editBtn);
    head.appendChild(delBtn);
    card.appendChild(head);

    // 内容预览：单行截断（快速扫读）
    const preview = document.createElement('div');
    preview.className = 'mem-card-preview';
    preview.textContent = m.content;
    card.appendChild(preview);
    // 取代/编辑状态标记（仅命中对应字段时渲染，非 round-summary 自然无）
    if (m.supersededBy || m.isModified) {
      const tags = document.createElement('div');
      tags.className = 'mem-card-tags';
      if (m.supersededBy) {
        const t = document.createElement('span');
        t.className = 'tag tag-superseded';
        t.textContent = '已取代';
        t.title = `已被 ${m.supersededBy} 取代`;
        tags.appendChild(t);
      }
      if (m.isModified) {
        const t = document.createElement('span');
        t.className = 'tag tag-modified';
        t.textContent = '已编辑';
        tags.appendChild(t);
      }
      card.appendChild(tags);
    }

    // 内联编辑（G19 内联 edit 收尾，2026-08-25）：进入编辑态——隐藏预览、注入 textarea
    // + 保存/取消按钮；编辑区 stopPropagation 防卡片展开误触。保存 postMessage memory_edit，
    // 取消退出编辑态；成功时 host 推 memory_loaded 重建卡片使编辑态自然消失。
    function enterEditMode(): void {
      if (card.querySelector('.mem-edit-wrap')) return; // 已在编辑态，幂等
      // 收起可能展开的全文详情，避免与编辑区叠加
      const detail = card.querySelector('.mem-card-detail');
      if (detail) {
        detail.remove();
        card.classList.remove('expanded');
        card.setAttribute('aria-expanded', 'false');
      }
      preview.hidden = true;
      const wrap = document.createElement('div');
      wrap.className = 'mem-edit-wrap';
      const ta = document.createElement('textarea');
      ta.className = 'mem-edit-area';
      ta.value = m.content;
      wrap.appendChild(ta);
      const actions = document.createElement('div');
      actions.className = 'mem-edit-actions';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'memory_edit', id: m.id, content: ta.value });
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exitEditMode();
      });
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      wrap.appendChild(actions);
      // 编辑区内部点击不冒泡到卡片（防触发展开切换）
      wrap.addEventListener('click', (e) => e.stopPropagation());
      card.appendChild(wrap);
      ta.focus();
    }

    function exitEditMode(): void {
      const wrap = card.querySelector('.mem-edit-wrap');
      if (wrap) wrap.remove();
      preview.hidden = false;
    }

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
        // 双溯源：会话 / 轮次（仅 round-summary 携带 sessionName/roundId）
        const traceParts: string[] = [];
        if (m.sessionName) traceParts.push(`会话 ${m.sessionName}`);
        if (m.roundId) traceParts.push(`轮次 ${m.roundId}`);
        if (traceParts.length > 0) {
          const trace = document.createElement('div');
          trace.className = 'mem-card-meta';
          trace.textContent = traceParts.join(' · ');
          detail.appendChild(trace);
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

  /** 回收站标题条数徽标：有回收站条目时在「回收站」后显示 (N)，提高可发现性 */
  function updateRecycleCount(n: number): void {
    if (!recycleSummary) return;
    recycleSummary.textContent = n > 0 ? `回收站（${n}）` : '回收站';
  }

  /** 渲染治理统计（活跃 / 回收站 + 结果提示） */
  function renderGovernance(stats: GovernanceStatsDto): void {
    if (govActive) govActive.textContent = String(stats.active);
    if (govDeleted) govDeleted.textContent = String(stats.deleted);
    if (govSuperseded) govSuperseded.textContent = String(stats.superseded ?? 0);
    // 回收站标题同步条数（软删记忆可发现，非死字段）
    updateRecycleCount(stats.deleted);
    if (govDetail) govDetail.hidden = true;
  }

  /** 渲染回收站列表（G19，2026-08-25：软删除记忆的可恢复暂存区；2026-08-26 加清空操作） */
  function renderRecycle(items: MemoryItemDto[]): void {
    updateRecycleCount(items?.length ?? 0);
    if (!recycleList) return;
    recycleList.textContent = '';
    if (!items || items.length === 0) {
      recycleList.appendChild(
        createEmptyState(document, {
          title: '回收站为空',
          hint: '被删除的记忆会出现在这里，可随时恢复。',
        }),
      );
      return;
    }
    // 操作行：清空回收站（物理删除全部，不可恢复）
    const toolRow = document.createElement('div');
    toolRow.className = 'mem-recycle-tools';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-danger mem-recycle-clear';
    clearBtn.textContent = '清空回收站';
    clearBtn.title = '永久删除回收站全部记忆，不可恢复';
    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'memory_recycle_clear' });
    });
    toolRow.appendChild(clearBtn);
    recycleList.appendChild(toolRow);
    items.forEach((m) => recycleList.appendChild(buildRecycleCard(m)));
  }

  /** 构建单个回收站条目（名称 + source 徽章 + 预览 + 删除时间 + 恢复按钮） */
  function buildRecycleCard(m: MemoryItemDto): HTMLElement {
    const card = document.createElement('div');
    card.className = 'mem-card mem-recycle-card';
    card.title = '点击卡片或「恢复」按钮还原这条记忆';

    const textWrap = document.createElement('div');
    textWrap.className = 'mem-recycle-text';

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
    textWrap.appendChild(head);

    const preview = document.createElement('div');
    preview.className = 'mem-card-preview';
    preview.textContent = m.content;
    textWrap.appendChild(preview);

    // 删除时间：帮助判断恢复优先级（deletedAt 由内核软删时写入，须被消费而非死字段）
    if (m.deletedAt) {
      const meta = document.createElement('div');
      meta.className = 'mem-recycle-meta';
      meta.textContent = `删除于 ${formatTime(m.deletedAt)}`;
      textWrap.appendChild(meta);
    }
    card.appendChild(textWrap);

    // 恢复按钮：独立走 memory_restore（卡片整体亦可点击，按钮 stopPropagation 防双触发）
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'mem-restore-btn btn btn-secondary';
    restoreBtn.textContent = '恢复';
    restoreBtn.title = '从回收站恢复这条记忆';
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'memory_restore', id: m.id });
    });
    card.appendChild(restoreBtn);

    // 永久删除按钮（2026-08-26）：独立走 memory_purge，物理删除不可恢复
    const purgeBtn = document.createElement('button');
    purgeBtn.className = 'mem-purge-btn btn btn-danger';
    purgeBtn.textContent = '永久删除';
    purgeBtn.title = '物理删除这条记忆，不可恢复';
    purgeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'memory_purge', id: m.id });
    });
    card.appendChild(purgeBtn);

    card.addEventListener('click', () => {
      vscode.postMessage({ type: 'memory_restore', id: m.id });
    });
    return card;
  }

  /** 操作反馈提示（G19：删除/恢复失败等错误，成功不显示） */
  function showMemHint(message: string, isError: boolean): void {
    if (!memHint) return;
    memHint.textContent = message;
    memHint.hidden = message.length === 0;
    memHint.classList.toggle('mem-hint-error', isError);
  }

  /**
   * 展示治理操作结果（governance_result）并刷新数据
   *
   * 治理操作会改变记忆库（衰减改 score 顺序 / 清理删条目）→ 重新拉取治理数据 + 列表，
   * 保证治理区统计与列表实时一致。
   */
  function showGovernanceResult(msg: { ok: boolean; message?: string; action: 'cleanup' }): void {
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
      showMemHint('', false);
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
    } else if (msg.type === 'memory_recycle_loaded') {
      // 渲染回收站列表（G19）
      renderRecycle(msg.items);
    } else if (msg.type === 'memory_deleted') {
      // 成功：host 已推 memory_loaded 刷新活跃列表；此处自动展开回收站并拉取，
      // 让"软删的记忆去哪了、如何撤销"一目了然（恢复按钮立即可点）。
      if (msg.ok) {
        if (recycle) {
          recycle.open = true; // 程序性展开，不依赖手点 summary
          vscode.postMessage({ type: 'memory_recycle_load' });
        }
        showMemHint('已移入回收站，可在下方「回收站」中恢复', false);
      } else if (msg.message) {
        showMemHint(msg.message, true);
      }
    } else if (msg.type === 'memory_restored') {
      if (msg.ok) {
        // 重新拉取回收站（若展开）移除已恢复项；列表由 host 推送 memory_loaded 刷新
        if (recycle?.open) vscode.postMessage({ type: 'memory_recycle_load' });
      } else if (msg.message) {
        showMemHint(msg.message, true);
      }
    } else if (msg.type === 'memory_purged') {
      // 永久删除单条（2026-08-26）：成功重拉回收站 + 活跃列表；失败显示错误
      if (msg.ok) {
        if (recycle?.open) vscode.postMessage({ type: 'memory_recycle_load' });
        showMemHint('已永久删除', false);
      } else if (msg.message) {
        showMemHint(msg.message, true);
      }
    } else if (msg.type === 'memory_recycle_cleared') {
      // 清空回收站（2026-08-26）：成功重拉回收站；失败显示错误
      if (msg.ok) {
        if (recycle?.open) vscode.postMessage({ type: 'memory_recycle_load' });
        showMemHint(msg.count > 0 ? `已清空回收站（${msg.count} 条）` : '回收站已是空的', false);
      } else if (msg.message) {
        showMemHint(msg.message, true);
      }
    } else if (msg.type === 'memory_edited') {
      // 成功时 host 已推 memory_loaded 重建列表（编辑态随卡片销毁自然消失）；
      // 仅失败显示错误提示（编辑态保留，用户可重试 / 取消）
      if (!msg.ok && msg.message) showMemHint(msg.message, true);
    }
  });

  // 治理按钮：清理过期（确认由 host 侧弹窗，webview 只发消息）
  btnCleanup?.addEventListener('click', () => {
    vscode.postMessage({ type: 'governance_cleanup' });
  });

  // 回收站：展开时拉取列表（G19，2026-08-25）
  recycle?.addEventListener('toggle', () => {
    if (recycle.open) vscode.postMessage({ type: 'memory_recycle_load' });
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
