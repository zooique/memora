/**
 * 剪贴板保护面板管理器 — 数据/状态层
 *
 * 职责：
 * - 维护待处理列表（pendingItems）：去重 + FIFO 淘汰 + 24h 标记较旧
 * - localStorage 持久化：应用重启后恢复历史记录（不含原文，仅预览元数据）
 * - 提供 addPendingItem / removePendingItem / clearPendingItems / getPendingItems API
 * - 通过 onChange 回调通知 UI 层（clipboardPanelManager）刷新角标和列表
 * - 普通内容静默累积到待处理列表，角标 +1，不打断用户
 * - 敏感内容保护性主动提醒 Toast（5s 自动消失），不进入待处理列表
 * - 内容确认对话框（showClipboardConfirmDialog，归档流程复用）
 *
 * 设计原则：
 * - 依赖注入：通过构造函数接收 ToastManager / ModalManager 引用
 * - 单向依赖：clipboardManager 不依赖 clipboardPanelManager，通过 onChange 回调解耦
 * - 无 DOM 操作：本类只管数据/状态，DOM 渲染由 clipboardPanelManager 负责
 * - 无事件监听器（不直接绑定 DOM 事件），无需 EventTracker
 */

import type { ToastManager } from '../components/toast.js';
import type { ModalManager } from '../components/modal.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'，ADR-017 枝叶层 2 次提取）
import { truncate } from '../../../shared/truncate.js';

// ─── 类型定义 ───────────────────────────────────────────

/**
 * 剪贴板待处理条目（localStorage 持久化，应用重启恢复）
 *
 * 设计决策：
 * - 不存储原文：仅存预览（前 100 字符）+ 长度，原文在归档时从 OS 剪贴板读取
 * - 不持有哈希：clipboardHandler 的哈希是 private 状态不暴露；
 *   归档时通过 preview.slice(0,100) 比较做软校验（防止内容已变化时存错条目）
 * - isStale 标记：超过 24h 未处理标记为"较旧"，角标边框变橙色提示
 * - 持久化策略：每次状态变更 fire-and-forget 写 localStorage；
 *   恢复时由 ClipboardHandler 启动主动推送 + loadPendingItems() 双重兜底
 */
export interface ClipboardPendingItem {
  /** 唯一 ID（时间戳 + 随机数，便于列表 key 和单条操作定位） */
  id: string;
  /** 完整内容（用于复制按钮，localStorage 持久化） */
  content: string;
  /** 内容预览（前 100 字符，用于列表展示和归档时软校验） */
  preview: string;
  /** 内容长度（完整内容长度，用于列表展示"100字"等） */
  length: number;
  /** 检测时间戳（Date.now()，用于计算"刚刚/N分钟前/N天前"和 isStale） */
  detectedAt: number;
  /** 是否较旧（>24h 未处理，由 addPendingItem 和 refreshStaleFlags 动态计算） */
  isStale: boolean;
}

// ─── 常量 ───────────────────────────────────────────────

/** 待处理列表上限（FIFO 淘汰最旧条目，20 条覆盖一次工作会话的复制量） */
export const MAX_PENDING_ITEMS = 20;

/** 角标显示上限（超过显示 99+，避免视觉噪音） */
export const BADGE_MAX_DISPLAY = 99;

/** 较旧阈值（24h，超过则标记 isStale，角标边框变橙色） */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** localStorage 键名（剪贴板待处理历史，应用重启恢复） */
const STORAGE_KEY = 'memora:clipboard-pending';

/** localStorage 键名（未查看计数，跨应用重启保持） */
const UNVIEWED_KEY = 'memora:clipboard-unviewed';

// ─── ClipboardManager 类 ───────────────────────────────

/**
 * 剪贴板保护管理器类（数据/状态层）
 *
 * 职责：维护待处理列表 + 敏感内容保护性主动提醒 + 归档确认对话框
 * 依赖：ToastManager（敏感提醒 Toast）、ModalManager（归档确认对话框）
 * 生命周期：无事件监听器，cleanup() 为空实现；
 *           UIManager 在初始化时调用 setOnChange 注入刷新回调
 */
export class ClipboardManager {
  /** 共享的 Toast 管理器实例（与 UIManager 同一引用） */
  private readonly toastManager: ToastManager;
  /** 共享的 Modal 管理器实例（与 UIManager 同一引用） */
  private readonly modalManager: ModalManager;
  /** 待处理条目列表（按检测时间倒序，最新的在最前面） */
  private pendingItems: ClipboardPendingItem[] = [];
  /** 状态变更回调（由 UIManager 注入，触发 clipboardPanelManager.refresh） */
  private onChange?: () => void;
  /** 未查看条目数（自上次切换到剪贴板面板后新增的条目数，用于角标显示） */
  private unviewedCount = 0;

  /**
   * 构造函数：注入共享的 Toast / Modal 管理器实例，从 localStorage 恢复历史记录
   *
   * @param toastManager Toast 通知管理器（用于敏感内容保护性提醒 + 归档成功 toast）
   * @param modalManager 模态框管理器（用于归档确认对话框）
   */
  constructor(
    toastManager: ToastManager,
    modalManager: ModalManager,
  ) {
    this.toastManager = toastManager;
    this.modalManager = modalManager;
    // 应用重启后恢复剪贴板历史记录（不含原文，仅预览元数据）
    this.pendingItems = this.loadPendingItems();
    // 恢复未查看计数（跨应用重启保持，直到用户切换到剪贴板面板清零）
    this.unviewedCount = this.loadUnviewedCount();
  }

  /**
   * 设置状态变更回调（由 UIManager 在初始化时注入）
   *
   * 回调触发时机：addPendingItem / removePendingItem / clearPendingItems / markStaleItems
   * 回调职责：调用 clipboardPanelManager.refresh() 刷新角标和列表
   *
   * @param cb 状态变更回调
   */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /**
   * 通知 UI 层状态变更并持久化到 localStorage
   *
   * 每次 pendingItems 变更时调用，fire-and-forget 不阻塞 UI。
   */
  private notifyAndSave(): void {
    this.onChange?.();
    this.savePendingItems();
    this.saveUnviewedCount();
  }

  /**
   * 添加待处理条目（普通内容复制时调用）
   *
   * 行为：
   * - 去重：相同 preview 不重复添加（用户重复复制同一内容不堆积）
   * - FIFO 淘汰：超出 MAX_PENDING_ITEMS 时丢弃最旧条目
   * - 最新条目插入到列表头部（倒序展示，最新在最前）
   * - 触发 onChange 回调通知 UI 层刷新
   *
   * @param preview 内容预览（前 100 字符，由 main.ts 在 CLIPBOARD_CHANGED emit 时构造）
   * @param length 内容完整长度
   */
  addPendingItem(preview: string, length: number, content?: string): void {
    // 去重：相同 preview 不重复添加
    const existingIndex = this.pendingItems.findIndex((item) => item.preview === preview);
    if (existingIndex >= 0) {
      // 已存在相同预览的条目，将其移到列表头部（最新的在最前）
      const [existing] = this.pendingItems.splice(existingIndex, 1);
      // 类型守卫：splice 返回数组解构在 noUncheckedIndexedAccess 下推断为 possibly undefined，
      // 实际 existingIndex >= 0 保证 splice 必返回非空数组，守卫仅满足类型契约
      if (!existing) return;
      existing.detectedAt = Date.now();
      existing.isStale = false;
      this.pendingItems.unshift(existing);
      this.notifyAndSave();
      return;
    }

    // 构造新条目
    const item: ClipboardPendingItem = {
      id: this.generateId(),
      content: content ?? preview,
      preview,
      length,
      detectedAt: Date.now(),
      isStale: false,
    };

    // 插入到列表头部
    this.pendingItems.unshift(item);

    // 新条目（非重复）增加未查看计数
    this.unviewedCount++;

    // FIFO 淘汰：超出上限丢弃最旧条目（列表尾部）
    if (this.pendingItems.length > MAX_PENDING_ITEMS) {
      this.pendingItems.length = MAX_PENDING_ITEMS;
    }

    // 通知 UI 层刷新
    this.notifyAndSave();
  }

  /**
   * 移除指定条目（用户点击"忽略"或归档成功后调用）
   *
   * @param id 条目 ID
   */
  removePendingItem(id: string): void {
    const index = this.pendingItems.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.pendingItems.splice(index, 1);
      this.notifyAndSave();
    }
  }

  /**
   * 清空所有待处理条目（用户点击"全部忽略"后调用）
   *
   * 同时重置未读计数：用户主动清空列表表示不再关心这些条目，
   * 角标应立即消失（否则清空后角标仍显示数字，UX 不合理）。
   */
  clearPendingItems(): void {
    if (this.pendingItems.length === 0) return;
    this.pendingItems = [];
    this.unviewedCount = 0;
    this.saveUnviewedCount();
    this.notifyAndSave();
  }

  /**
   * 获取待处理条目列表（只读副本，防止外部直接修改内部状态）
   *
   * @returns 待处理条目数组的只读副本
   */
  getPendingItems(): readonly ClipboardPendingItem[] {
    return [...this.pendingItems];
  }

  /**
   * 获取待处理条目数量（用于角标显示）
   *
   * @returns 待处理条目数量
   */
  getPendingCount(): number {
    return this.pendingItems.length;
  }

  /**
   * 是否存在较旧条目（用于角标边框变橙色提示）
   *
   * @returns true 表示存在至少一个较旧条目
   */
  hasStaleItem(): boolean {
    return this.pendingItems.some((item) => item.isStale);
  }

  /**
   * 获取未查看条目数（用于角标显示）
   *
   * 自上次切换到剪贴板面板后新增的条目数。角标仅显示此值而非总条目数，
   * 避免已浏览过的历史条目持续占据角标。
   *
   * @returns 未查看条目数
   */
  getUnviewedCount(): number {
    return this.unviewedCount;
  }

  /**
   * 标记所有条目为已查看（用户切换到剪贴板面板时调用）
   *
   * 重置未查看计数为 0，并持久化。角标在下次 UI 刷新时自动隐藏。
   */
  markAllViewed(): void {
    if (this.unviewedCount === 0) return;
    this.unviewedCount = 0;
    this.saveUnviewedCount();
    this.onChange?.();
  }

  /**
   * 刷新较旧标记（定期调用，将超过 24h 的条目标记为 isStale）
   *
   * 由 clipboardPanelManager 在面板可见时定期调用（如每 5 分钟），
   * 或在 addPendingItem / refresh 时按需调用。
   */
  refreshStaleFlags(): void {
    const now = Date.now();
    let changed = false;
    for (const item of this.pendingItems) {
      const shouldBeStale = now - item.detectedAt > STALE_THRESHOLD_MS;
      if (item.isStale !== shouldBeStale) {
        item.isStale = shouldBeStale;
        changed = true;
      }
    }
    if (changed) {
      this.notifyAndSave();
    }
  }

  /**
   * 敏感内容保护性主动提醒
   *
   * 触发时机：ClipboardHandler.analyze() 检测到敏感内容时
   * 行为：显示 warning Toast（5 秒自动消失），提示用户已自动忽略
   * 设计理由：敏感内容主动提醒是"安全保护"，不是"体验打扰"——
   *           让用户感知到"三重保护"的价值
   *
   * 注意：此场景下剪贴板内容不进入待处理列表（敏感内容不存储）
   *
   * @param type 敏感内容类型（如 'token' / 'password' / 'private-key'）
   */
  showSensitiveWarning(type: string): void {
    this.toastManager.showToast(
      `检测到敏感内容（${type}），已为你忽略`,
      'warning',
      5000,
    );
  }

  /**
   * 显示剪贴板内容确认对话框（归档流程复用）
   *
   * 内容通过敏感检测和护栏检查后调用，展示内容预览供用户确认。
   * 用户确认后通过 MEMORIES_ADD 通道写入记忆。
   *
   * @param content 剪贴板内容（已通过检测）
   */
  async showClipboardConfirmDialog(content: string): Promise<void> {
    // 构建内容预览 DOM（防 XSS，使用 textContent）
    const container = document.createElement('div');
    container.className = 'write-confirm-info';

    const contentP = document.createElement('p');
    const contentLabel = document.createElement('strong');
    contentLabel.textContent = '内容：';
    contentP.appendChild(contentLabel);
    // 截断过长内容，避免对话框过大
    const preview = truncate(content, 200);
    const codeEl = document.createElement('code');
    codeEl.textContent = preview;
    contentP.appendChild(codeEl);
    container.appendChild(contentP);

    const confirmed = await this.modalManager.showConfirmDialog({
      title: '将剪贴板内容存为记忆？',
      message: '',
      messageNodes: [container],
      confirmText: '存为记忆',
      cancelText: '取消',
    });

    if (confirmed) {
      // 用户确认后，通过 MEMORIES_ADD 写入记忆
      await window.electronAPI.addMemory({
        content,
        source: 'clipboard',
        name: `剪贴板记忆 ${new Date().toLocaleString()}`,
      });
      this.toastManager.showToast('已存为记忆', 'success');
    }
  }

  /**
   * 清理资源
   *
   * ClipboardManager 不持有事件监听器，无需实际清理。
   * 提供空实现以与其他 Manager 保持统一的生命周期接口。
   */
  cleanup(): void {
    // 清空待处理列表（会话级状态，重启清空）
    this.pendingItems = [];
    // 移除 onChange 引用，避免潜在的内存泄漏（UIManager 重建时旧引用残留）
    this.onChange = undefined;
  }

  /**
   * 生成条目唯一 ID（时间戳 + 随机数，避免列表 key 冲突）
   *
   * @returns 唯一 ID 字符串
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 从 localStorage 恢复剪贴板待处理历史
   *
   * 应用重启后调用，恢复上次会话的 pendingItems 列表（不含原文，仅预览元数据）。
   * JSON 解析失败或数据格式异常时静默降级返回空数组（历史丢失优于初始化崩溃）。
   *
   * @returns 恢复的 ClipboardPendingItem 数组，失败时返回空数组
   */
  private loadPendingItems(): ClipboardPendingItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // 基本结构校验：至少要有 id 字段（防止非预期格式注入）
      return parsed.filter(
        (item): item is ClipboardPendingItem =>
          typeof item === 'object' && item !== null && typeof (item as ClipboardPendingItem).id === 'string',
      );
    } catch {
      // JSON 解析失败：可能被手动编辑损坏或版本不兼容，静默丢弃
      return [];
    }
  }

  /**
   * 持久化待处理列表到 localStorage
   *
   * 每次 pendingItems 变更时 fire-and-forget 调用，不阻塞 UI 线程。
   * 写入失败静默降级（历史丢失优于抛错阻断剪贴板功能）。
   */
  private savePendingItems(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pendingItems));
    } catch {
      // localStorage 写入失败：可能是配额耗尽或隐私模式下不可用，静默降级
    }
  }

  /**
   * 从 localStorage 恢复未查看计数
   */
  private loadUnviewedCount(): number {
    try {
      const raw = localStorage.getItem(UNVIEWED_KEY);
      if (!raw) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 持久化未查看计数到 localStorage
   */
  private saveUnviewedCount(): void {
    try {
      localStorage.setItem(UNVIEWED_KEY, String(this.unviewedCount));
    } catch {
      // 静默降级
    }
  }
}
