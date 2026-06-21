/**
 * 记忆控制器 — 记忆面板业务逻辑 + 仪表盘数据加载
 *
 * 职责：
 * - 设置记忆面板回调（搜索/筛选/点击/删除/添加）
 * - 加载记忆列表到 UI
 * - 加载仪表盘数据（累积事件/触发器/推荐记忆）
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - 搜索回调内置序列号竞态保护（防止快速输入时旧结果覆盖新结果）
 * - 仪表盘高亮状态：接近阈值（>=80%）黄色，达到阈值粉色
 */

import type { UIManager } from './ui.js';
import type { MemoryListItem } from './types.js';
import { createIpcErrorHandler } from './errorHelpers.js';

/** 仪表盘计数脉冲动画时长（毫秒），对齐 layout.css @keyframes numberPulse 的 0.3s */
const DASHBOARD_PULSE_MS = 300;

/** 累积事件接近阈值的百分比（>=80% 显示黄色高亮） */
const NEAR_THRESHOLD_RATIO = 0.8;

/**
 * 创建记忆控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 记忆控制器接口（设置回调、加载列表、加载仪表盘）
 */
export function createMemoryController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /**
   * 设置记忆面板回调
   *
   * 包含搜索（带竞态保护）、筛选、点击查看详情、删除、添加。
   */
  function setupMemoryPanel(): void {
    // 搜索请求序列号：防止快速输入时旧结果覆盖新结果（竞态保护）
    let searchSeq = 0;

    // 搜索回调
    uiManager.onMemorySearch(async (query: string) => {
      if (!query) {
        // 空搜索：加载全部
        await loadMemoryList();
        return;
      }
      // 递增序列号，捕获当前请求的序号
      const seq = ++searchSeq;
      try {
        const { hits } = await window.electronAPI.searchMemories(query);
        // 若在等待期间有更新的搜索请求发起，丢弃本次过期结果
        if (seq !== searchSeq) return;
        const items: MemoryListItem[] = hits.map(h => ({
          id: h.id,
          name: h.name,
          source: h.source,
          score: h.similarity ?? h.score,
          contentPreview: h.contentPreview,
        }));
        uiManager.renderMemoryList(items);
      } catch (error) {
        // 搜索失败时保持原列表，记录日志辅助排查
        if (seq !== searchSeq) return;
        console.error('[onMemorySearch] 记忆搜索失败:', error);
      }
    });

    // 筛选回调
    uiManager.onMemoryFilter((_source: string) => {
      void loadMemoryList();
    });

    // 点击记忆条目：查看详情
    uiManager.onMemoryClick(async (id: string) => {
      try {
        const { memory } = await window.electronAPI.showMemory(id);
        if (memory) {
          uiManager.showMemoryDetail(memory);
        }
      } catch (error) {
        console.error('[onMemoryClick] 查看记忆详情失败:', error);
      }
    });

    // 删除记忆
    uiManager.onMemoryDelete(async () => {
      const id = uiManager.getCurrentMemoryId();
      if (!id) return;
      try {
        await window.electronAPI.deleteMemory(id);
        uiManager.hideModal('memory-detail-modal');
        await loadMemoryList();
        // IX-06 操作反馈走 toast
        uiManager.showToast('记忆已删除', 'success');
      } catch (error) {
        handleIpcError('onMemoryDelete', error, '删除记忆失败');
      }
    });

    // 添加记忆
    uiManager.onMemoryAdd(async (data) => {
      // FD-08 进行中反馈：禁用按钮防止重复点击
      uiManager.setButtonLoading('btn-memory-add-confirm', true, '添加中...');
      try {
        await window.electronAPI.addMemory(data);
        uiManager.clearAddMemoryForm();
        uiManager.hideModal('memory-add-modal');
        await loadMemoryList();
        // IX-06 操作反馈走 toast
        uiManager.showToast('记忆已添加', 'success');
      } catch (error) {
        handleIpcError('onMemoryAdd', error, '添加记忆失败');
      } finally {
        // FD-08 恢复按钮状态
        uiManager.setButtonLoading('btn-memory-add-confirm', false);
      }
    });
  }

  /** 加载记忆列表 */
  async function loadMemoryList(): Promise<void> {
    try {
      const filterEl = document.getElementById('memory-filter-source');
      const source = filterEl instanceof HTMLSelectElement ? filterEl.value : undefined;
      const { memories } = await window.electronAPI.listMemories(source ? { source } : {});
      uiManager.renderMemoryList(memories);

      // 更新仪表盘记忆计数
      const countEl = document.getElementById('memory-count');
      if (countEl) {
        countEl.textContent = String(memories.length);
      }
    } catch (error) {
      console.error('[loadMemoryList] 加载记忆列表失败:', error);
      uiManager.showPanelError('memory', '加载记忆列表失败，请检查连接后重试', () => loadMemoryList());
    }
  }

  /**
   * FD-03 加载完整仪表盘数据
   *
   * 对齐 CLI /dashboard 命令，在侧边栏仪表盘显示：
   * - 累积事件数 / 主动提示阈值（接近阈值黄色，达到阈值粉色）
   * - 已注册触发器数量（hover 看触发器名称列表）
   * - 推荐记忆列表（对齐方案 §6.3 推荐区）
   */
  async function loadDashboard(): Promise<void> {
    try {
      const data = await window.electronAPI.getDashboard();

      // 累积事件数 / 阈值
      const pendingEl = document.getElementById('pending-count');
      const dashPending = document.getElementById('dash-pending');
      if (pendingEl && dashPending) {
        pendingEl.textContent = `${data.pendingNotices}/${data.proactiveThreshold}`;
        // 高亮状态：接近阈值（>=80%）黄色，达到阈值粉色
        dashPending.classList.remove('near-threshold', 'at-threshold');
        if (data.pendingNotices >= data.proactiveThreshold) {
          dashPending.classList.add('at-threshold');
        } else if (data.proactiveThreshold > 0
          && data.pendingNotices / data.proactiveThreshold >= NEAR_THRESHOLD_RATIO) {
          dashPending.classList.add('near-threshold');
        }
      }

      // 已注册触发器数量 + hover 详情
      const triggerEl = document.getElementById('trigger-count');
      const dashTriggers = document.getElementById('dash-triggers');
      if (triggerEl && dashTriggers) {
        triggerEl.textContent = String(data.registeredTriggers.length);
        // hover 显示触发器名称列表
        const triggerList = data.registeredTriggers.length > 0
          ? data.registeredTriggers.join(', ')
          : '无触发器';
        dashTriggers.title = `已注册触发器：${triggerList}`;
      }

      // 渲染推荐记忆列表（对齐方案 §6.3 推荐区）
      const recList = document.getElementById('recommendation-list');
      const recSection = document.getElementById('recommendations');
      if (recList && recSection) {
        if (data.suggestions && data.suggestions.length > 0) {
          // UX-08：使用 while + removeChild 替代 innerHTML = ''，与项目约定一致
          while (recList.firstChild) {
            recList.removeChild(recList.firstChild);
          }
          for (const s of data.suggestions) {
            const li = document.createElement('li');
            li.title = `${s.contentPreview}\n\n${s.reason}`;
            // 记忆名称
            const nameSpan = document.createElement('span');
            nameSpan.textContent = s.name;
            // 相关度分数
            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'suggestion-score';
            scoreSpan.textContent = s.relevance.toFixed(2);
            li.appendChild(nameSpan);
            li.appendChild(scoreSpan);
            recList.appendChild(li);
          }
          recSection.classList.remove('hidden');
        } else {
          // 无推荐时隐藏推荐区
          recSection.classList.add('hidden');
        }
      }
    } catch (error) {
      console.error('[loadDashboard] 加载仪表盘数据失败:', error);
    }
  }

  /**
   * 仪表盘计数 +1 并触发脉冲动画
   *
   * 对齐 HTML 预览 §6.3 .stat-value.pulse。
   * 由精灵事件监听器在 memoryNoticed/insightGained 事件时调用。
   */
  function pulseCounter(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(parseInt(el.textContent ?? '0') + 1);
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), DASHBOARD_PULSE_MS);
  }

  return {
    setupMemoryPanel,
    loadMemoryList,
    loadDashboard,
    pulseCounter,
  };
}
