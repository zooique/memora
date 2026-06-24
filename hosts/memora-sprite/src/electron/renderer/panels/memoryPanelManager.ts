/**
 * 记忆面板管理器 — 记忆面板 UI 逻辑独立子模块
 *
 * 职责：
 * - 管理记忆面板所有 DOM 元素引用
 * - 初始化记忆面板事件监听（搜索/筛选/添加/删除）
 * - 渲染记忆列表（分页 + 空状态引导）
 * - 显示记忆详情弹窗
 * - 管理添加记忆表单
 *
 * 设计原则：
 * - 遵循 SettingsPanelManager 的组合模式，UIManager 持有实例并委托
 * - 自管理事件监听器，通过注入的 EventTracker 统一管理
 * - 跨模块关注点（showModal / showConfirmDialog）通过 host 回调注入
 *
 * 提取自 ui.ts（P2-008：ui.ts 体积过大拆分），减少约 290 行。
 */

import { getOptionalElement, clearElement, formatTimeAgo } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { MemoryListItem, MemoryDetail, ConfirmDialogOptions } from '../types.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 记忆面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface MemoryPanelHost {
  /** 显示模态框 */
  showModal(modalId: string): void;
  /** 显示确认对话框（FD-07 取消按钮） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
}

// ─── 记忆面板管理器类 ─────────────────────────────────────

export class MemoryPanelManager {
  // ─── 静态常量 ───────────────────────────────────────────
  /**
   * P3-FLOW-13 记忆列表分页每页大小
   * 50 条平衡了首屏渲染性能和用户浏览体验，超过时显示"加载更多"按钮
   */
  static readonly MEMORY_PAGE_SIZE = 50;

  // ─── 内部状态 ────────────────────────────────────────────
  /** P3-FLOW-13 完整记忆列表缓存（供分页使用） */
  private allMemories: MemoryListItem[] = [];
  /** P3-FLOW-13 当前记忆列表页码（从 1 开始） */
  private memoryPage = 1;
  /** 记忆搜索防抖定时器（cleanup 时需清理，避免回调在 DOM 销毁后触发） */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 回调 ────────────────────────────────────────────────
  private memorySearchCallback: ((query: string) => void) | null = null;
  private memoryFilterCallback: ((source: string) => void) | null = null;
  private memoryClickCallback: ((id: string) => void) | null = null;
  private memoryDeleteCallback: (() => void) | null = null;
  private memoryAddCallback:
    | ((data: { source: string; name: string; content: string }) => void)
    | null = null;
  /** P2-FLOW-08 记忆编辑回调：携带记忆 ID 和新内容 */
  private memoryEditCallback: ((id: string, content: string) => void) | null = null;
  /** P2-FLOW-08 编辑模式状态：true 时显示保存/取消按钮，隐藏编辑/删除按钮 */
  private isEditing = false;

  constructor(
    private host: MemoryPanelHost,
    /** 记忆列表容器元素（可选，缺失时渲染降级） */
    private memoryListEl: HTMLElement | null,
    /** 记忆搜索输入框（可选，缺失时搜索功能降级） */
    private memorySearchEl: HTMLInputElement | null,
    /** 记忆 source 筛选下拉框（可选，缺失时筛选功能降级） */
    private memoryFilterSourceEl: HTMLSelectElement | null,
    /** 记忆详情模态框容器（可选，缺失时详情功能降级） */
    private memoryDetailModal: HTMLElement | null,
    /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
    private events: EventTracker,
  ) {}

  // ─── 资源清理 ──────────────────────────────────────────

  /** 清理防抖定时器和事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发） */
  cleanup(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.events.cleanup();
  }

  // ─── 事件监听器初始化 ───────────────────────────────────

  /** 初始化记忆面板事件监听 */
  initMemoryPanelListeners(): void {
    // 记忆面板元素缺失时静默降级（不阻塞其他功能）
    if (!this.memorySearchEl || !this.memoryFilterSourceEl) return;

    // QC-19 P2 修复：提取局部常量，避免闭包内控制流分析断裂导致的非空断言
    const searchEl = this.memorySearchEl;
    const filterSourceEl = this.memoryFilterSourceEl;

    // QC-22 记忆列表事件委托：在 list 容器上注册统一 click 监听器，
    // 通过 data-action="view-memory" + data-memory-id 分发，
    // 替代动态列表项各自的 addEventListener，统一纳入 EventTracker 管理
    if (this.memoryListEl) {
      this.events.addEventListener(this.memoryListEl, 'click', (e: Event) => {
        const target = e.target as HTMLElement;
        const item = target.closest<HTMLElement>('[data-action="view-memory"]');
        if (item) {
          const memoryId = item.dataset.memoryId ?? '';
          this.memoryClickCallback?.(memoryId);
        }
      });
    }

    // 搜索框：输入时触发搜索（带防抖）
    this.events.addEventListener(searchEl, 'input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.memorySearchCallback?.(searchEl.value.trim());
      }, 300);
    });

    // source 筛选变更
    this.events.addEventListener(filterSourceEl, 'change', () => {
      this.memoryFilterCallback?.(filterSourceEl.value);
    });

    // 添加按钮（可选）
    const btnAdd = getOptionalElement('btn-add-memory', 'button');
    if (btnAdd) {
      this.events.addEventListener(btnAdd, 'click', () => {
        this.host.showModal('memory-add-modal');
      });
    }

    // 添加确认按钮（可选）
    const btnAddConfirm = getOptionalElement('btn-memory-add-confirm', 'button');
    if (btnAddConfirm) {
      this.events.addEventListener(btnAddConfirm, 'click', () => {
        const data = this.getAddMemoryFormData();
        if (data) {
          this.memoryAddCallback?.(data);
        }
      });
    }

    // 删除按钮（可选，带确认对话框，防止误删不可恢复数据）
    const btnDelete = getOptionalElement('btn-memory-delete', 'button');
    if (btnDelete) {
      this.events.addEventListener(btnDelete, 'click', async () => {
        // 确认删除：记忆是持久化数据，删除后不可恢复，需二次确认
        const confirmed = await this.host.showConfirmDialog({
          title: '删除记忆',
          message: '确定要删除这条记忆吗？此操作不可撤销。',
          confirmText: '删除',
          danger: true,
        });
        if (!confirmed) return;
        this.memoryDeleteCallback?.();
      });
    }

    // P2-FLOW-08 编辑按钮：进入编辑模式，将 content 区域变为可编辑
    const btnEdit = getOptionalElement('btn-memory-edit', 'button');
    if (btnEdit) {
      this.events.addEventListener(btnEdit, 'click', () => {
        this.enterEditMode();
      });
    }

    // P2-FLOW-08 编辑保存按钮：保存编辑内容
    const btnEditSave = getOptionalElement('btn-memory-edit-save', 'button');
    if (btnEditSave) {
      this.events.addEventListener(btnEditSave, 'click', () => {
        this.saveEdit();
      });
    }

    // P2-FLOW-08 编辑取消按钮：退出编辑模式，恢复原始内容
    const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');
    if (btnEditCancel) {
      this.events.addEventListener(btnEditCancel, 'click', () => {
        this.exitEditMode();
      });
    }
  }

  // ─── 记忆列表渲染 ───────────────────────────────────────

  /**
   * 渲染记忆列表
   *
   * 卡片结构对齐 docs/memora-sprite-preview.html §6.4：
   *   <div class="memory-item">
   *     <div class="name">{name}</div>
   *     <div class="meta">
   *       <span class="source-tag">{source}</span>
   *       <span class="score">score: {score}</span>
   *     </div>
   *     <div class="preview">{contentPreview}</div>
   *   </div>
   */
  renderMemoryList(memories: MemoryListItem[]): void {
    // 记忆面板元素缺失时静默降级
    if (!this.memoryListEl) return;

    // P3-FLOW-13 缓存完整列表供分页使用
    this.allMemories = memories;
    this.memoryPage = 1;

    // 安全清空容器（使用 clearElement 统一封装 while + removeChild 模式）
    clearElement(this.memoryListEl);

    if (memories.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无记忆';

      // 空状态引导：提供"添加第一条记忆"按钮，避免用户不知道下一步
      const hintBtn = document.createElement('button');
      // UX-P2-27 同时添加 .btn-secondary 类复用通用按钮样式
      hintBtn.className = 'empty-action-btn btn-secondary';
      hintBtn.textContent = '+ 添加第一条记忆';
      this.events.addEventListener(hintBtn, 'click', () => {
        this.host.showModal('memory-add-modal');
      });
      empty.appendChild(hintBtn);

      this.memoryListEl.appendChild(empty);
      return;
    }

    // P3-FLOW-13 渲染第一页
    this.renderMemoryPage();
  }

  /**
   * P3-FLOW-13 渲染当前页的记忆列表项
   *
   * 分页策略：每页 MEMORY_PAGE_SIZE 条，超出部分通过"加载更多"按钮加载。
   * 避免大量记忆一次性渲染导致 DOM 性能下降。
   */
  private renderMemoryPage(): void {
    if (!this.memoryListEl || !this.allMemories) return;

    // 计算当前页的起止索引
    const start = 0;
    const end = this.memoryPage * MemoryPanelManager.MEMORY_PAGE_SIZE;
    const pageItems = this.allMemories.slice(start, end);

    // 清空容器（保留"加载更多"按钮的容器结构）
    clearElement(this.memoryListEl);

    for (const mem of pageItems) {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.dataset.id = mem.id;

      // 名称
      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = mem.name;
      item.appendChild(nameEl);

      // 元数据（source 标签 + score + P3-FLOW-14 创建时间）
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';

      const sourceTag = document.createElement('span');
      // source 标签颜色区分：不同 source 类型用不同颜色，提升视觉识别度
      // 颜色映射：profile(绿)/insight(蓝)/guardrail(粉)/skill(黄)/rule(紫)/persona(青)/session(橙)
      sourceTag.className = `source-tag source-${this.getSourceColorClass(mem.source)}`;
      sourceTag.textContent = mem.source;
      metaEl.appendChild(sourceTag);

      const scoreEl = document.createElement('span');
      scoreEl.className = 'score';
      scoreEl.textContent = `score: ${mem.score.toFixed(2)}`;
      metaEl.appendChild(scoreEl);

      // P3-FLOW-14 显示创建时间（仅当存在时）
      if (mem.createdAt) {
        const timeEl = document.createElement('span');
        timeEl.className = 'memory-time';
        timeEl.title = `创建于 ${mem.createdAt}`;
        timeEl.textContent = formatTimeAgo(mem.createdAt);
        metaEl.appendChild(timeEl);
      }

      item.appendChild(metaEl);

      // 预览（2 行截断）
      const previewEl = document.createElement('div');
      previewEl.className = 'preview';
      previewEl.textContent = mem.contentPreview;
      item.appendChild(previewEl);

      // QC-22 事件委托：用 data-action + data-memory-id 替代直接 addEventListener
      item.setAttribute('data-action', 'view-memory');
      item.setAttribute('data-memory-id', mem.id);

      this.memoryListEl.appendChild(item);
    }

    // P3-FLOW-13 如果还有更多记忆，添加"加载更多"按钮
    if (this.allMemories.length > end) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'memory-load-more btn-secondary';
      loadMoreBtn.textContent = `加载更多（剩余 ${this.allMemories.length - end} 条）`;
      this.events.addEventListener(loadMoreBtn, 'click', () => {
        this.memoryPage++;
        this.renderMemoryPage();
      });
      this.memoryListEl.appendChild(loadMoreBtn);
    }
  }

  // ─── 记忆详情 ───────────────────────────────────────────

  /** 显示记忆详情 */
  showMemoryDetail(memory: MemoryDetail): void {
    if (!this.memoryDetailModal) return;

    // P2-FLOW-08 打开详情时退出编辑模式，恢复只读状态
    this.isEditing = false;

    const nameEl = getOptionalElement('memory-detail-name', 'h3');
    const sourceEl = getOptionalElement('memory-detail-source', 'code');
    const scoreEl = getOptionalElement('memory-detail-score', 'span');
    const createdEl = getOptionalElement('memory-detail-created', 'span');
    const accessedEl = getOptionalElement('memory-detail-accessed', 'span');
    const contentEl = getOptionalElement('memory-detail-content', 'pre');

    if (nameEl) nameEl.textContent = memory.name;
    if (sourceEl) {
      sourceEl.textContent = memory.source;
      // source 标签颜色区分（与列表保持一致）
      sourceEl.className = `source-${this.getSourceColorClass(memory.source)}`;
    }
    if (scoreEl) scoreEl.textContent = memory.score.toFixed(2);
    // R5 详情面板日期用 formatTimeAgo 统一格式化（ISO → 相对时间）
    if (createdEl) createdEl.textContent = formatTimeAgo(memory.createdAt);
    if (accessedEl) accessedEl.textContent = formatTimeAgo(memory.accessedAt);
    if (contentEl) contentEl.textContent = memory.content;

    // P2-FLOW-08 保存原始内容到 dataset，供编辑取消时恢复
    if (contentEl) contentEl.dataset.originalContent = memory.content;

    // 记录当前查看的记忆 ID（供删除/编辑按钮使用）
    this.memoryDetailModal.dataset.memoryId = memory.id;
    // P2-FLOW-08 保存 source 和 name 到 dataset，供编辑保存时使用
    this.memoryDetailModal.dataset.memorySource = memory.source;
    this.memoryDetailModal.dataset.memoryName = memory.name;

    // P2-FLOW-08 切换按钮可见性：只读模式显示编辑/删除，隐藏保存/取消
    this.updateDetailButtons();
    this.host.showModal('memory-detail-modal');
  }

  // ─── 辅助方法 ───────────────────────────────────────────

  /**
   * 将 source 字符串映射到颜色类名
   *
   * 颜色映射规则（对齐记忆系统 source 分类）：
   * - profile → green（用户画像，绿色代表身份）
   * - insight → blue（洞察，蓝色代表智慧）
   * - guardrail → pink（护栏，粉色代表警示）
   * - skill → yellow（技能，黄色代表能力）
   * - rule → purple（规则，紫色代表约束）
   * - persona → cyan（角色，青色代表个性）
   * - session → orange（会话，橙色代表活跃）
   * - 其他 → default（灰色）
   */
  private getSourceColorClass(source: string): string {
    const normalized = source.toLowerCase().trim();
    const knownSources = ['profile', 'insight', 'guardrail', 'skill', 'rule', 'persona', 'session'];
    return knownSources.includes(normalized) ? normalized : 'default';
  }

  // ─── P2-FLOW-08 记忆编辑模式 ────────────────────────────

  /**
   * 进入编辑模式
   *
   * 将 content 区域从只读 <pre> 变为可编辑 <textarea>，
   * 切换底部按钮：隐藏编辑/删除，显示保存/取消。
   */
  private enterEditMode(): void {
    if (this.isEditing) return;
    this.isEditing = true;

    const contentEl = getOptionalElement('memory-detail-content', 'pre');
    if (!contentEl) return;

    // 将 <pre> 内容替换为 <textarea>，保留原始内容
    const originalContent = contentEl.dataset.originalContent ?? contentEl.textContent ?? '';
    const textarea = document.createElement('textarea');
    textarea.id = 'memory-detail-content';
    textarea.className = 'memory-edit-textarea';
    textarea.value = originalContent;
    // 保留 dataset 引用
    textarea.dataset.originalContent = originalContent;
    contentEl.replaceWith(textarea);
    textarea.focus();

    this.updateDetailButtons();
  }

  /**
   * 退出编辑模式
   *
   * 将 <textarea> 恢复为只读 <pre>，恢复原始内容，
   * 切换底部按钮：显示编辑/删除，隐藏保存/取消。
   */
  private exitEditMode(): void {
    if (!this.isEditing) return;
    this.isEditing = false;

    const textarea = document.getElementById('memory-detail-content');
    if (!textarea) return;

    // 恢复为只读 <pre>，使用原始内容
    const originalContent = textarea.dataset.originalContent ?? '';
    const pre = document.createElement('pre');
    pre.id = 'memory-detail-content';
    pre.textContent = originalContent;
    pre.dataset.originalContent = originalContent;
    textarea.replaceWith(pre);

    this.updateDetailButtons();
  }

  /**
   * 保存编辑内容
   *
   * 读取 textarea 中的新内容，通过回调通知宿主层保存。
   * 底层使用 upsert 语义（MEMORIES_ADD 通道），无需新增 IPC 通道。
   */
  private saveEdit(): void {
    const textarea = document.getElementById('memory-detail-content') as HTMLTextAreaElement | null;
    if (!textarea) return;

    const newContent = textarea.value.trim();
    if (!newContent) return;

    const id = this.memoryDetailModal?.dataset.memoryId;
    if (!id) return;

    this.memoryEditCallback?.(id, newContent);
  }

  /**
   * 切换详情弹窗底部按钮可见性
   *
   * 只读模式：显示编辑 + 删除 + 关闭
   * 编辑模式：显示保存 + 取消 + 关闭
   */
  private updateDetailButtons(): void {
    const btnEdit = getOptionalElement('btn-memory-edit', 'button');
    const btnDelete = getOptionalElement('btn-memory-delete', 'button');
    const btnEditSave = getOptionalElement('btn-memory-edit-save', 'button');
    const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');

    if (btnEdit) btnEdit.classList.toggle('hidden', this.isEditing);
    if (btnDelete) btnDelete.classList.toggle('hidden', this.isEditing);
    if (btnEditSave) btnEditSave.classList.toggle('hidden', !this.isEditing);
    if (btnEditCancel) btnEditCancel.classList.toggle('hidden', !this.isEditing);
  }

  // ─── 添加记忆表单 ───────────────────────────────────────

  /** 获取添加记忆表单数据（供测试与外部调用） */
  getAddMemoryFormData(): { source: string; name: string; content: string } | null {
    const sourceEl = getOptionalElement('memory-add-source', 'input');
    const nameEl = getOptionalElement('memory-add-name', 'input');
    const contentEl = getOptionalElement('memory-add-content', 'textarea');
    if (!sourceEl || !nameEl || !contentEl) return null;

    const source = sourceEl.value.trim();
    const name = nameEl.value.trim();
    const content = contentEl.value.trim();

    if (!source || !name || !content) {
      return null;
    }
    return { source, name, content };
  }

  /** 清空添加记忆表单 */
  clearAddMemoryForm(): void {
    const sourceEl = getOptionalElement('memory-add-source', 'input');
    const nameEl = getOptionalElement('memory-add-name', 'input');
    const contentEl = getOptionalElement('memory-add-content', 'textarea');
    if (sourceEl) sourceEl.value = '';
    if (nameEl) nameEl.value = '';
    if (contentEl) contentEl.value = '';
  }

  /** 获取当前查看的记忆 ID（供删除使用） */
  getCurrentMemoryId(): string | null {
    return this.memoryDetailModal?.dataset.memoryId ?? null;
  }

  // ─── 回调注册 ───────────────────────────────────────────

  onMemorySearch(cb: (query: string) => void): void {
    this.memorySearchCallback = cb;
  }
  onMemoryFilter(cb: (source: string) => void): void {
    this.memoryFilterCallback = cb;
  }
  onMemoryClick(cb: (id: string) => void): void {
    this.memoryClickCallback = cb;
  }
  onMemoryDelete(cb: () => void): void {
    this.memoryDeleteCallback = cb;
  }
  onMemoryAdd(cb: (data: { source: string; name: string; content: string }) => void): void {
    this.memoryAddCallback = cb;
  }
  /** P2-FLOW-08 注册记忆编辑回调 */
  onMemoryEdit(cb: (id: string, content: string) => void): void {
    this.memoryEditCallback = cb;
  }
}