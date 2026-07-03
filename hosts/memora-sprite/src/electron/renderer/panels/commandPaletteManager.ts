/**
 * 快捷命令面板管理器（Command Palette）
 *
 * 职责：
 * - 管理命令注册、搜索过滤、键盘导航
 * - 提供 Ctrl+K 全局快捷键打开/关闭面板
 * - 执行命令后自动关闭面板
 *
 * 设计原则：
 * - 纯 UI 层组件，零内核依赖
 * - 命令按 section 分组，支持动态命令（如角色列表）
 * - 键盘导航：↑↓ 移动、Enter 执行、Esc 关闭
 */

import type { UIManager } from '../ui.js';
// Toast 时长常量（第一轮 P1-B 遗漏 import 修复）
import { TOAST_SHORT_MS } from '../../../sprite/constants.js';
// C-2：事件监听器纳入 EventTracker 统一管理，cleanup 时统一移除，避免内存泄漏
import { EventTracker } from '../helpers/eventTracker.js';
// HC-23：统一 DOM 操作模式，使用 clearElement 替代 innerHTML=''
import { clearElement } from '../helpers/domHelpers.js';

/** 命令项定义 */
export interface Command {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  label: string;
  /** 搜索关键词（空格分隔，用于模糊匹配） */
  keywords: string;
  /** 所属分组 */
  section: string;
  /** 快捷键提示（可选，如 "Ctrl+1"） */
  shortcut?: string;
  /** 执行动作 */
  action: () => void;
}

/** 搜索结果项 */
export interface SearchResult {
  command: Command;
  /** 匹配得分（越高越相关） */
  score: number;
}

// ─── 命令定义 ────────────────────────────────────────────────

/** 创建静态命令列表（不依赖动态数据的命令） */
function createStaticCommands(uiManager: UIManager): Command[] {
  return [
    // ── 导航 ──
    {
      id: 'nav-chat',
      label: '切换到对话面板',
      keywords: '对话 聊天 chat 消息',
      section: '导航',
      shortcut: 'Ctrl+1',
      action: () => { void uiManager.switchPanel('chat'); },
    },
    {
      id: 'nav-memories',
      label: '切换到记忆面板',
      keywords: '记忆 memories 知识',
      section: '导航',
      shortcut: 'Ctrl+2',
      action: () => { void uiManager.switchPanel('memories'); },
    },
    {
      id: 'nav-settings',
      label: '切换到设置面板',
      keywords: '设置 settings 配置',
      section: '导航',
      shortcut: 'Ctrl+3',
      action: () => { void uiManager.switchPanel('settings'); },
    },
    {
      id: 'nav-perception',
      label: '打开感知面板',
      keywords: '感知 精灵状态 情感 默契度 上下文 模式 dashboard',
      section: '导航',
      action: () => {
        // 通过点击精灵状态栏触发完整的感知面板流程（含数据拉取）
        const statusBar = document.getElementById('sprite-status-bar');
        statusBar?.click();
      },
    },

    // ── 记忆 ──
    {
      id: 'mem-add',
      label: '添加记忆',
      keywords: '添加 新增 创建 记忆',
      section: '记忆',
      action: () => {
        void uiManager.switchPanel('memories');
        uiManager.showModal('memory-add-modal');
      },
    },
    {
      id: 'mem-search',
      label: '搜索记忆',
      keywords: '搜索 查找 记忆 检索',
      section: '记忆',
      action: () => {
        void uiManager.switchPanel('memories');
        // 聚焦记忆搜索框
        const input = document.getElementById('memory-search') as HTMLInputElement | null;
        input?.focus();
      },
    },
    {
      id: 'mem-health',
      label: '查看记忆健康度',
      keywords: '健康 诊断 检查 记忆',
      section: '记忆',
      action: () => {
        void uiManager.switchPanel('memories');
        // 展开健康度面板
        const healthBar = document.getElementById('memory-health-bar');
        if (healthBar) healthBar.classList.toggle('hidden');
      },
    },
    {
      id: 'mem-insights',
      label: '查看记忆统计洞察',
      keywords: '统计 洞察 分析 insights 记忆',
      section: '记忆',
      action: () => {
        void uiManager.switchPanel('memories');
        // 点击更多菜单中的"统计洞察"项（与用户手动点击路径一致）
        const insightsItem = document.querySelector('.more-menu-item[data-action="insights"]') as HTMLElement | null;
        insightsItem?.click();
      },
    },
    {
      id: 'mem-graph',
      label: '切换到记忆图谱视图',
      keywords: '图谱 graph 关系 网络 拓扑 可视化',
      section: '记忆',
      action: () => {
        void uiManager.switchPanel('memories');
        const graphBtn = document.getElementById('btn-graph-view');
        graphBtn?.click();
      },
    },
    {
      id: 'mem-timeline',
      label: '切换到记忆时间线视图',
      keywords: '时间线 timeline 时间 按日期',
      section: '记忆',
      action: () => {
        void uiManager.switchPanel('memories');
        const timelineBtn = document.getElementById('btn-timeline-view');
        timelineBtn?.click();
      },
    },

    // ── 设置 ──
    {
      id: 'settings-llm',
      label: '打开 LLM 设置',
      keywords: '大模型 模型 API 配置',
      section: '设置',
      action: () => {
        void uiManager.switchPanel('settings');
        switchSettingsTab('llm');
      },
    },
    {
      id: 'settings-sprite',
      label: '打开精灵设置',
      keywords: '精灵 sprite 行为 主动提示',
      section: '设置',
      action: () => {
        void uiManager.switchPanel('settings');
        switchSettingsTab('sprite');
      },
    },
    {
      id: 'settings-profile',
      label: '打开用户画像',
      keywords: '画像 用户 profile 偏好',
      section: '设置',
      action: () => {
        void uiManager.switchPanel('settings');
        switchSettingsTab('profile');
      },
    },
    {
      id: 'settings-skill',
      label: '打开技能管理',
      keywords: '技能 skill 安装',
      section: '设置',
      action: () => {
        void uiManager.switchPanel('settings');
        switchSettingsTab('skill');
      },
    },
    {
      id: 'settings-work',
      label: '打开作品投影',
      keywords: '作品 投影 work 文件',
      section: '设置',
      action: () => {
        void uiManager.switchPanel('settings');
        switchSettingsTab('work');
      },
    },
    {
      id: 'settings-audit',
      label: '打开审计日志',
      keywords: '审计 日志 操作记录 audit 写入确认',
      section: '设置',
      action: () => {
        void uiManager.switchPanel('settings');
        switchSettingsTab('audit');
      },
    },

    // ── 动作 ──
    {
      id: 'action-theme',
      label: '切换主题（浅色/深色）',
      keywords: '主题 浅色 深色 暗色 theme',
      section: '动作',
      action: () => {
        const current = uiManager.getThemeMode();
        const next = current === 'dark' ? 'light' : 'dark';
        uiManager.setTheme(next);
        uiManager.showToast(`已切换到${next === 'dark' ? '深色' : '浅色'}主题`, 'info', TOAST_SHORT_MS);
      },
    },
    {
      id: 'action-shortcuts',
      label: '显示键盘快捷键',
      keywords: '快捷键 键盘 shortcut 帮助',
      section: '动作',
      shortcut: 'Ctrl+/',
      action: () => { uiManager.showModal('shortcuts-modal'); },
    },
    {
      id: 'action-onboarding',
      label: '显示新手引导',
      keywords: '引导 新手 欢迎 onboarding 介绍',
      section: '动作',
      action: () => { uiManager.showOnboardingDialog(); },
    },
    {
      id: 'action-silent',
      label: '切换精灵静默模式',
      keywords: '静默 安静 silent 免打扰 精灵 主动提示',
      section: '动作',
      action: () => {
        // 读取设置面板中静默模式 checkbox 的当前状态
        const checkbox = document.getElementById('cfg-silent') as HTMLInputElement | null;
        const isCurrentlySilent = checkbox?.checked ?? false;
        if (isCurrentlySilent) {
          // 退出静默模式
          void window.electronAPI.updateConfig('silentMode', false);
          void window.electronAPI.updateConfig('silentModeExpiresAt', null);
          if (checkbox) checkbox.checked = false;
          uiManager.showToast('已退出静默模式，精灵恢复主动提示', 'info', TOAST_SHORT_MS);
        } else {
          // 进入静默模式（1 小时后自动恢复）
          void window.electronAPI.updateConfig('silentMode', true);
          const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          void window.electronAPI.updateConfig('silentModeExpiresAt', expiresAt);
          if (checkbox) checkbox.checked = true;
          uiManager.showToast('已进入静默模式，精灵 1 小时内不会主动提示', 'info', TOAST_SHORT_MS);
        }
      },
    },
  ];
}

/** 切换设置面板的 tab */
function switchSettingsTab(tabName: string): void {
  const tab = document.querySelector(`.settings-tab[data-settings-tab="${tabName}"]`) as HTMLButtonElement | null;
  tab?.click();
}

// ─── 搜索引擎 ────────────────────────────────────────────────

/** 对命令列表进行模糊搜索并排序 */
export function searchCommands(commands: Command[], query: string): SearchResult[] {
  if (!query.trim()) {
    // 无输入时显示全部命令，按 section 排序
    return commands.map((cmd) => ({ command: cmd, score: 0 }));
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  for (const cmd of commands) {
    const searchText = `${cmd.label} ${cmd.keywords} ${cmd.section}`.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (searchText.includes(term)) {
        // 精确匹配 label 得分最高
        if (cmd.label.toLowerCase().includes(term)) score += 3;
        // 关键词匹配
        else if (cmd.keywords.toLowerCase().includes(term)) score += 2;
        // section 匹配
        else score += 1;
      } else {
        // 有一个词不匹配，该命令出局
        score = -1;
        break;
      }
    }

    if (score >= 0) {
      results.push({ command: cmd, score });
    }
  }

  // 按得分降序排列
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ─── 管理器类 ────────────────────────────────────────────────

/**
 * 快捷命令面板管理器
 *
 * 管理命令面板的打开/关闭、搜索过滤、键盘导航和命令执行。
 * 通过 Ctrl+K 快捷键触发，提供类似 VS Code Command Palette 的体验。
 */
export class CommandPaletteManager {
  private uiManager: UIManager;
  private commands: Command[] = [];
  private results: SearchResult[] = [];
  private selectedIndex = 0;
  private isOpen = false;

  /** 面板容器元素 */
  private paletteEl: HTMLElement | null = null;
  /** 搜索输入框 */
  private inputEl: HTMLInputElement | null = null;
  /** 搜索结果容器 */
  private resultsEl: HTMLElement | null = null;
  /**
   * C-2：事件监听器跟踪器
   *
   * 原先 init() 中用裸 addEventListener 注册了 4 个监听器（遮罩点击、输入、
   * 键盘导航、全局 Ctrl+K），均未纳入统一管理。beforeunload 触发 UIManager.cleanup()
   * 时不会清理这些监听器，页面重新加载后会累积，导致同一事件触发多次。
   * 改用 EventTracker 后，cleanup() 时统一移除所有监听器。
   */
  private events = new EventTracker();

  constructor(uiManager: UIManager) {
    this.uiManager = uiManager;
  }

  /** 初始化命令面板（DOM 绑定 + 事件监听） */
  init(): void {
    this.paletteEl = document.getElementById('command-palette');
    this.inputEl = document.getElementById('command-palette-input') as HTMLInputElement | null;
    this.resultsEl = document.getElementById('command-palette-results');

    if (!this.paletteEl || !this.inputEl || !this.resultsEl) {
      console.warn('[CommandPalette] 命令面板 DOM 元素缺失，功能降级');
      return;
    }

    // 点击遮罩层关闭
    this.events.addEventListener(this.paletteEl, 'click', (e) => {
      if (e.target === this.paletteEl) {
        this.close();
      }
    });

    // 输入时实时搜索
    this.events.addEventListener(this.inputEl, 'input', () => {
      this.search(this.inputEl!.value);
    });

    // 键盘导航
    this.events.addEventListener(this.inputEl, 'keydown', (e) => {
      this.handleKeydown(e as KeyboardEvent);
    });

    // 注册全局快捷键 Ctrl+K
    this.events.addEventListener(document, 'keydown', (e) => {
      this.handleGlobalKeydown(e as KeyboardEvent);
    });
  }

  /**
   * C-2：清理所有事件监听器
   *
   * 由 UIManager.cleanup() 统一调用，确保 beforeunload 时移除全局 keydown
   * 监听器，避免页面重新加载后监听器累积导致同一事件触发多次。
   */
  cleanup(): void {
    this.events.cleanup();
    // 关闭面板状态，恢复 body 滚动（防御性：cleanup 时若面板仍打开）
    if (this.isOpen) {
      document.body.style.overflow = '';
      this.isOpen = false;
    }
  }

  /** 重新加载命令列表（角色列表变化时调用） */
  reloadCommands(): void {
    this.commands = createStaticCommands(this.uiManager);
    // 如果面板打开中，刷新搜索结果
    if (this.isOpen && this.inputEl) {
      this.search(this.inputEl.value);
    }
  }

  /** 打开命令面板 */
  open(): void {
    if (!this.paletteEl || !this.inputEl) return;

    // 确保命令列表是最新的（角色可能已切换）
    this.reloadCommands();

    this.paletteEl.classList.remove('hidden');
    this.isOpen = true;
    this.selectedIndex = 0;

    // 清空输入并显示全部命令
    this.inputEl.value = '';
    this.search('');
    this.inputEl.focus();

    // 阻止背景滚动
    document.body.style.overflow = 'hidden';
  }

  /** 关闭命令面板 */
  close(): void {
    if (!this.paletteEl) return;

    this.paletteEl.classList.add('hidden');
    this.isOpen = false;
    this.selectedIndex = 0;

    // 恢复背景滚动
    document.body.style.overflow = '';

    // 清空输入
    if (this.inputEl) {
      this.inputEl.value = '';
    }
  }

  /** 搜索过滤命令 */
  private search(query: string): void {
    this.results = searchCommands(this.commands, query);
    this.selectedIndex = 0;
    this.renderResults();
  }

  /** 渲染搜索结果列表 */
  private renderResults(): void {
    if (!this.resultsEl) return;

    // HC-23：使用 clearElement 替代 innerHTML=''，遵循统一 DOM 操作模式
    clearElement(this.resultsEl);

    if (this.results.length === 0) {
      this.resultsEl.innerHTML =
        '<div class="command-palette-empty">无匹配命令</div>';
      return;
    }

    // 按 section 分组渲染
    let lastSection = '';
    for (let i = 0; i < this.results.length; i++) {
      const result = this.results[i];
      if (!result) continue;
      const { command } = result;

      // 分组标题
      if (command.section !== lastSection) {
        lastSection = command.section;
        const header = document.createElement('div');
        header.className = 'command-palette-section';
        header.textContent = command.section;
        this.resultsEl.appendChild(header);
      }

      // 命令项
      const item = document.createElement('div');
      item.className = `command-palette-item${i === this.selectedIndex ? ' active' : ''}`;
      item.setAttribute('data-index', String(i));
      item.innerHTML = `
        <span class="command-palette-label">${this.highlightMatch(command.label)}</span>
        ${command.shortcut ? `<kbd class="command-palette-shortcut">${command.shortcut}</kbd>` : ''}
      `;

      // 点击执行
      item.addEventListener('click', () => {
        this.executeCommand(i);
      });

      this.resultsEl.appendChild(item);
    }
  }

  /** 高亮匹配的文本 */
  private highlightMatch(text: string): string {
    if (!this.inputEl) return text;
    const query = this.inputEl.value.trim();
    if (!query) return text;

    const terms = query.split(/\s+/).filter(Boolean);
    let result = text;
    for (const term of terms) {
      const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      result = result.replace(regex, '<mark>$1</mark>');
    }
    return result;
  }

  /** 键盘导航处理 */
  private handleKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
        this.renderResults();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderResults();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.results.length > 0) {
          this.executeCommand(this.selectedIndex);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  /** 全局快捷键处理 */
  private handleGlobalKeydown(e: KeyboardEvent): void {
    // Ctrl+K：打开/关闭命令面板
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
      return;
    }

    // 命令面板关闭时不处理其他快捷键
    if (!this.isOpen) return;
  }

  /** 执行指定索引的命令 */
  private executeCommand(index: number): void {
    const result = this.results[index];
    if (!result) return;

    this.close();
    // 延迟执行，确保面板关闭动画完成
    setTimeout(() => {
      result.command.action();
    }, 50);
  }
}