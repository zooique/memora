/**
 * 作品投影面板管理器（作品投影 UI）
 *
 * 职责：
 *   - 组合持有 `FlatListPanel<WorkProjectionPayload>`（扁平列表声明式工厂，§四.2）
 *     负责容器采纳 / 计数 / 刷新 / 空态 / 错误态 / 销毁清理
 *   - 保留作品投影专属的"行内展开"交互与空态引导 hint（经 customRender 逃生舱）
 *
 * 设计原则：
 *   - 通用结构（容器采纳、计数、空/错态、刷新绑定、事件清理）下沉到 FlatListPanel；
 *     Manager 只做作品投影专属编排（卡片布局 + 展开交互 + 空态引导）。
 *   - 行级交互（展开按钮）经工厂注入的 rowEvents 绑定，确保每次渲染重建前被清理
 *     （防跨刷新监听累积泄漏），destroy 时由工厂统一清理。
 *   - 图标使用 innerHTML 赋值静态 SVG 常量（编译期硬编码，无 XSS 风险）；
 *     其余动态文本使用 textContent（防 XSS）。
 *   - 投影数据来自内核 WorkProjectionManager，通过 IPC 获取（listWorkProjections 直接返回数组）。
 */

import type { WorkProjectionPayload } from '../../preload.js';
import { clearElement, createEl, createEmptyState, formatTimeAgo, showPanelLoading } from '../helpers/domHelpers.js';
// FlatListPanel：扁平列表声明式工厂（§四.2），覆盖 audit/work 两个结构相似面板
import { FlatListPanel } from '../components/base/flatListPanel.js';
import type { EventTracker } from '../helpers/eventTracker.js';

/**
 * 作品投影面板管理器
 *
 * 管理"画像与作品"tab 内作品投影区域的加载、渲染和详情查看。
 * UIManager 通过组合持有此实例，并在切换到"画像与作品"tab 时调用 load()。
 */
export class WorkProjectionPanelManager {
  /** 扁平列表工厂（负责容器采纳/计数/空/错/刷新/销毁，持有 Component 实例） */
  private listPanel: FlatListPanel<WorkProjectionPayload>;
  /** 是否已初始化（避免重复绑定事件） */
  private initialized = false;

  /** 文件扩展名 → SVG 图标映射（用于卡片头部图标，统一"文档+文字标签"风格） */
  private static readonly FILE_ICONS: Record<string, string> = {
    '.ts': '<svg class="icon"><use href="#icon-file-ts"/></svg>',
    '.tsx': '<svg class="icon"><use href="#icon-file-ts"/></svg>',
    '.js': '<svg class="icon"><use href="#icon-file-js"/></svg>',
    '.jsx': '<svg class="icon"><use href="#icon-file-js"/></svg>',
    '.json': '<svg class="icon"><use href="#icon-file-json"/></svg>',
    '.md': '<svg class="icon"><use href="#icon-file-md"/></svg>',
    '.html': '<svg class="icon"><use href="#icon-file-html"/></svg>',
    '.css': '<svg class="icon"><use href="#icon-file-css"/></svg>',
    '.py': '<svg class="icon"><use href="#icon-file-py"/></svg>',
    '.rs': '<svg class="icon"><use href="#icon-file-rs"/></svg>',
    '.go': '<svg class="icon"><use href="#icon-file-go"/></svg>',
    '.sql': '<svg class="icon"><use href="#icon-file-sql"/></svg>',
    '.yaml': '<svg class="icon"><use href="#icon-file-config"/></svg>',
    '.yml': '<svg class="icon"><use href="#icon-file-config"/></svg>',
    '.toml': '<svg class="icon"><use href="#icon-file-config"/></svg>',
    '.gitignore': '<svg class="icon"><use href="#icon-file-git"/></svg>',
    '.env': '<svg class="icon"><use href="#icon-file-env"/></svg>',
  };

  constructor() {
    this.listPanel = new FlatListPanel<WorkProjectionPayload>({
      listContainerId: 'work-projection-list',
      countElId: 'work-projection-count',
      refreshBtnId: 'btn-work-projection-refresh',
      // IPC 直接返回数组 T[]，与工厂 load 契约精确匹配
      load: () => window.electronAPI.listWorkProjections(),
      emptyText: '暂无作品投影',
      errorText: () => '加载作品投影失败',
      // 逃生舱：作品投影需"卡片 + 行内展开 + 空态引导 hint"，默认逐行 renderRow 不满足
      customRender: (container, items, rowEvents) => {
        if (items.length === 0) {
          clearElement(container);
          container.appendChild(createEmptyState({ title: '暂无作品投影' }));
          container.appendChild(
            createEl('div', 'work-projection-empty-hint', '让精灵读取你的代码文件后，会自动生成作品投影摘要'),
          );
          return;
        }
        const frag = document.createDocumentFragment();
        for (const entry of items) {
          frag.appendChild(this.createProjectionCard(entry, rowEvents));
        }
        clearElement(container);
        container.appendChild(frag);
      },
    });
  }

  /**
   * 根据文件路径获取展示图标（SVG 字符串）
   *
   * @param filePath 文件路径
   * @returns SVG 图标字符串，兜底返回默认文件图标
   */
  private static getFileIcon(filePath: string): string {
    for (const ext of Object.keys(WorkProjectionPanelManager.FILE_ICONS)) {
      if (filePath.endsWith(ext)) {
        return WorkProjectionPanelManager.FILE_ICONS[ext]!;
      }
    }
    // 兜底：无文字标签的默认文件图标
    return '<svg class="icon"><use href="#icon-file-default"/></svg>';
  }

  /**
   * 初始化作品投影面板管理器
   *
   * 采纳静态列表容器 + 绑定刷新按钮。在 UIManager 构造时调用。
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    // 采纳静态列表容器 + 绑定刷新（幂等，由 FlatListPanel 内部守卫）
    this.listPanel.mount();
  }

  /**
   * 加载作品投影数据并渲染（委托到 FlatListPanel）
   *
   * 渲染前展示 loading 占位（对齐原 showPanelLoading 行为），随后由工厂完成
   * IPC 拉取 → 渲染 / 空态 / 错误态。
   */
  async load(): Promise<void> {
    const el = this.listPanel.getElement();
    if (el) showPanelLoading(el, '加载作品投影…');
    return this.listPanel.load();
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
   * @param rowEvents 行级事件追踪器（工厂注入，确保展开按钮监听随渲染/销毁被清理）
   * @returns 卡片 DOM 元素
   */
  private createProjectionCard(entry: WorkProjectionPayload, rowEvents: EventTracker): HTMLElement {
    const card = createEl('div', 'work-projection-card');

    // 头部：图标 + 文件名 + 更新时间
    const header = createEl('div', 'work-projection-card-header');

    const icon = document.createElement('span');
    icon.className = 'work-projection-icon flex-shrink-0';
    // SVG 字符串来自编译期静态常量 FILE_ICONS，无 XSS 风险
    icon.innerHTML = WorkProjectionPanelManager.getFileIcon(entry.sourcePath);
    header.appendChild(icon);

    // 提取文件名（从完整路径中截取最后一部分）
    const fileName = entry.sourcePath.split(/[/\\]/).pop() ?? entry.sourcePath;
    const fileNameEl = createEl('span', 'work-projection-filename text-truncate', fileName);
    fileNameEl.title = entry.sourcePath; // tooltip 显示完整路径
    header.appendChild(fileNameEl);

    const updatedEl = createEl(
      'span',
      'work-projection-updated flex-shrink-0',
      formatTimeAgo(entry.updatedAt),
    );
    // data-timestamp 保留原始时间戳，供 timeRefresher 在窗口恢复焦点时统一刷新
    updatedEl.dataset.timestamp = entry.updatedAt;
    header.appendChild(updatedEl);

    card.appendChild(header);

    // 概要（始终可见）
    const summary = createEl('div', 'work-projection-summary', entry.summary);
    card.appendChild(summary);

    // 详情区（默认折叠）
    const details = createEl('div', 'work-projection-details');
    details.hidden = true;

    // 结构列表
    if (entry.structure.length > 0) {
      const structureSection = createEl('div', 'work-projection-section');

      const structureTitle = createEl('h4', 'work-projection-section-title', '结构');
      structureSection.appendChild(structureTitle);

      const structureList = createEl('ul', 'work-projection-list');
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
      const decisionsSection = createEl('div', 'work-projection-section');

      const decisionsTitle = createEl('h4', 'work-projection-section-title', '关键决策');
      decisionsSection.appendChild(decisionsTitle);

      const decisionsList = createEl('ul', 'work-projection-list');
      for (const item of entry.keyDecisions) {
        const li = document.createElement('li');
        li.textContent = item;
        decisionsList.appendChild(li);
      }
      decisionsSection.appendChild(decisionsList);
      details.appendChild(decisionsSection);
    }

    card.appendChild(details);

    // 展开/折叠按钮（行级交互，经 rowEvents 绑定以便清理）
    const expandBtn = createEl('button', 'work-projection-expand-btn', '展开详情');
    rowEvents.addEventListener(expandBtn, 'click', () => {
      const isHidden = details.hidden;
      details.hidden = !isHidden;
      expandBtn.textContent = isHidden ? '收起详情' : '展开详情';
    });
    card.appendChild(expandBtn);

    return card;
  }

  /** 清理所有事件监听器（UIManager.cleanup 时调用） */
  cleanup(): void {
    this.listPanel.destroy();
  }
}
