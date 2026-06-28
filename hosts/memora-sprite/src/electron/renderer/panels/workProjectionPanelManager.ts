/**
 * 作品投影面板管理器（H3：作品投影 UI）
 *
 * 职责：
 *   - 加载作品投影列表并渲染到设置面板的"作品"tab
 *   - 展示每个文件的概要、结构和关键决策
 *   - 点击卡片展开详情弹窗
 *   - 刷新按钮：重新拉取最新投影数据
 *
 * 设计原则：
 *   - 独立子模块，UIManager 通过组合持有（与 ProfilePanelManager 同模式）
 *   - 事件监听器纳入 EventTracker 跟踪集合，cleanup 时统一清理
 *   - 渲染使用 textContent（防 XSS），不使用 innerHTML
 *   - 投影数据来自内核 WorkProjectionManager，通过 IPC 获取
 */

import type { WorkProjectionPayload } from '../../preload.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { reportError, toError } from '../helpers/errorHelpers.js';
import {
  clearElement,
  formatTimeAgo,
  getOptionalElement,
} from '../helpers/domHelpers.js';

/**
 * 作品投影面板管理器
 *
 * 管理"作品"tab 的加载、渲染和详情查看。
 * UIManager 通过组合持有此实例，并在切换到"作品"tab 时调用 load()。
 */
export class WorkProjectionPanelManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 投影列表容器 */
  private listEl: HTMLElement | null = null;
  /** 投影计数元素 */
  private countEl: HTMLElement | null = null;
  /** 刷新按钮 */
  private refreshBtn: HTMLButtonElement | null = null;
  /** 是否已初始化（避免重复绑定事件） */
  private initialized = false;

  /** 文件扩展名 → 图标映射（用于卡片头部图标） */
  private static readonly FILE_ICONS: Record<string, string> = {
    '.ts': '📘',
    '.tsx': '📘',
    '.js': '📒',
    '.jsx': '📒',
    '.json': '📋',
    '.md': '📝',
    '.html': '🌐',
    '.css': '🎨',
    '.py': '🐍',
    '.rs': '🦀',
    '.go': '🔵',
    '.sql': '🗄️',
    '.yaml': '⚙️',
    '.yml': '⚙️',
    '.toml': '⚙️',
    '.gitignore': '🙈',
    '.env': '🔒',
  };

  /**
   * 根据文件路径获取展示图标
   *
   * @param filePath 文件路径
   * @returns 图标字符，兜底返回 📄
   */
  private static getFileIcon(filePath: string): string {
    for (const ext of Object.keys(WorkProjectionPanelManager.FILE_ICONS)) {
      if (filePath.endsWith(ext)) {
        return WorkProjectionPanelManager.FILE_ICONS[ext]!;
      }
    }
    return '📄';
  }

  /**
   * 初始化作品投影面板管理器
   *
   * 获取 DOM 元素引用并绑定刷新按钮事件。
   * 在 UIManager 构造时调用。
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 获取 DOM 元素引用（均为可选，缺失时静默降级）
    this.listEl = document.getElementById('work-projection-list');
    this.countEl = document.getElementById('work-projection-count');
    this.refreshBtn = getOptionalElement('btn-work-projection-refresh', 'button');

    // 绑定刷新按钮事件
    if (this.refreshBtn) {
      this.events.addEventListener(this.refreshBtn, 'click', () => {
        void this.load();
      });
    }
  }

  /**
   * 加载作品投影数据并渲染
   *
   * 调用 listWorkProjections IPC 获取所有投影条目，
   * 渲染为卡片列表。失败时显示错误提示。
   */
  async load(): Promise<void> {
    try {
      const entries = await window.electronAPI.listWorkProjections();
      this.render(entries);
    } catch (err) {
      reportError('WorkProjectionPanel', `加载作品投影失败: ${toError(err).message}`);
      if (this.listEl) {
        clearElement(this.listEl);
        const errorEl = document.createElement('div');
        errorEl.className = 'work-projection-empty work-projection-error';
        errorEl.textContent = '加载失败，请点击刷新重试';
        this.listEl.appendChild(errorEl);
      }
    }
  }

  /**
   * 渲染投影列表
   *
   * @param entries 投影条目数组
   */
  private render(entries: WorkProjectionPayload[]): void {
    // 更新计数
    if (this.countEl) {
      this.countEl.textContent = String(entries.length);
    }

    if (!this.listEl) return;
    clearElement(this.listEl);

    // 空列表提示
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'work-projection-empty';
      empty.textContent = '暂无作品投影';
      const hint = document.createElement('div');
      hint.className = 'work-projection-empty-hint';
      hint.textContent = '让精灵读取你的代码文件后，会自动生成作品投影摘要';
      this.listEl.appendChild(empty);
      this.listEl.appendChild(hint);
      return;
    }

    // 渲染每条投影
    for (const entry of entries) {
      const card = this.createProjectionCard(entry);
      this.listEl.appendChild(card);
    }
  }

  /**
   * 创建投影卡片 DOM 元素
   *
   * 卡片结构：
   *   <div class="work-projection-card">
   *     <div class="work-projection-card-header">
   *       <span class="work-projection-icon">{图标}</span>
   *       <span class="work-projection-filename">{文件名}</span>
   *       <span class="work-projection-updated">{更新时间}</span>
   *     </div>
   *     <div class="work-projection-summary">{概要}</div>
   *     <div class="work-projection-details" hidden>
   *       <div class="work-projection-structure">
   *         <h4>结构</h4>
   *         <ul>{结构列表}</ul>
   *       </div>
   *       <div class="work-projection-decisions">
   *         <h4>关键决策</h4>
   *         <ul>{决策列表}</ul>
   *       </div>
   *     </div>
   *     <button class="work-projection-expand-btn">展开详情</button>
   *   </div>
   *
   * @param entry 投影条目
   * @returns 卡片 DOM 元素
   */
  private createProjectionCard(entry: WorkProjectionPayload): HTMLElement {
    const card = document.createElement('div');
    card.className = 'work-projection-card';

    // 头部：图标 + 文件名 + 更新时间
    const header = document.createElement('div');
    header.className = 'work-projection-card-header';

    const icon = document.createElement('span');
    icon.className = 'work-projection-icon';
    icon.textContent = WorkProjectionPanelManager.getFileIcon(entry.sourcePath);
    header.appendChild(icon);

    // 提取文件名（从完整路径中截取最后一部分）
    const fileName = entry.sourcePath.split(/[/\\]/).pop() ?? entry.sourcePath;
    const fileNameEl = document.createElement('span');
    fileNameEl.className = 'work-projection-filename';
    fileNameEl.textContent = fileName;
    fileNameEl.title = entry.sourcePath; // tooltip 显示完整路径
    header.appendChild(fileNameEl);

    const updatedEl = document.createElement('span');
    updatedEl.className = 'work-projection-updated';
    updatedEl.textContent = formatTimeAgo(entry.updatedAt);
    header.appendChild(updatedEl);

    card.appendChild(header);

    // 概要（始终可见）
    const summary = document.createElement('div');
    summary.className = 'work-projection-summary';
    summary.textContent = entry.summary;
    card.appendChild(summary);

    // 详情区（默认折叠）
    const details = document.createElement('div');
    details.className = 'work-projection-details';
    details.hidden = true;

    // 结构列表
    if (entry.structure.length > 0) {
      const structureSection = document.createElement('div');
      structureSection.className = 'work-projection-section';

      const structureTitle = document.createElement('h4');
      structureTitle.className = 'work-projection-section-title';
      structureTitle.textContent = '结构';
      structureSection.appendChild(structureTitle);

      const structureList = document.createElement('ul');
      structureList.className = 'work-projection-list';
      for (const item of entry.structure) {
        const li = document.createElement('li');
        li.textContent = item;
        structureList.appendChild(li);
      }
      structureSection.appendChild(structureList);
      details.appendChild(structureSection);
    }

    // 关键决策列表
    if (entry.keyDecisions.length > 0) {
      const decisionsSection = document.createElement('div');
      decisionsSection.className = 'work-projection-section';

      const decisionsTitle = document.createElement('h4');
      decisionsTitle.className = 'work-projection-section-title';
      decisionsTitle.textContent = '关键决策';
      decisionsSection.appendChild(decisionsTitle);

      const decisionsList = document.createElement('ul');
      decisionsList.className = 'work-projection-list';
      for (const item of entry.keyDecisions) {
        const li = document.createElement('li');
        li.textContent = item;
        decisionsList.appendChild(li);
      }
      decisionsSection.appendChild(decisionsList);
      details.appendChild(decisionsSection);
    }

    card.appendChild(details);

    // 展开/折叠按钮
    const expandBtn = document.createElement('button');
    expandBtn.className = 'work-projection-expand-btn';
    expandBtn.textContent = '展开详情';
    this.events.addEventListener(expandBtn, 'click', () => {
      const isHidden = details.hidden;
      details.hidden = !isHidden;
      expandBtn.textContent = isHidden ? '收起详情' : '展开详情';
    });
    card.appendChild(expandBtn);

    return card;
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.events.cleanup();
  }
}