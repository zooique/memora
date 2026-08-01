/**
 * ShortcutConfigComponent - 设置面板快捷键配置子组件
 *
 * 封装快捷键相关的 DOM 元素引用、表单读写和捕获上下文构建，
 * 降低 SettingsPanelManager 的字段数量与职责复杂度。
 *
 * 设计原则：
 * - 构造函数只做 DOM 查询，不做副作用
 * - 提供 getValidationFields() 供 Manager 统一校验
 * - 快捷键捕获式输入委托给 shortcutCapture helper，此组件仅构建 context
 *
 * 属 AUDIT-H5 SettingsPanelManager 职责拆分产物。
 */

import { getOptionalElement } from '../../helpers/domHelpers.js';
import { initShortcutCapture as initShortcutCaptureHelper } from '../../helpers/shortcutCapture.js';
import type { ShortcutCaptureContext, ShortcutInputBinding } from '../../helpers/shortcutCapture.js';
import type { EventTracker } from '../../helpers/eventTracker.js';
import type { ShortcutConfig } from '../../../../shared/shortcutDefaults.js';

/** 快捷键组件宿主回调（由 Manager 注入，用于触发 dirty 标志和 toast 通知） */
export interface ShortcutConfigHost {
  /** 标记表单为 dirty 并触发防抖自动保存 */
  onDirtyChange(): void;
  /** 显示 toast 通知 */
  showToast(message: string, type?: 'success' | 'error' | 'warning' | 'info', duration?: number): void;
}

export class ShortcutConfigComponent {
  // ─── DOM 元素引用 ──────────────────────────────────────
  /** 快捷键总开关 */
  private cfgShortcutsEnabled: HTMLInputElement | null;
  /** 显示/隐藏窗口快捷键（捕获式输入） */
  private cfgShortcutToggleWindow: HTMLInputElement | null;
  /** 快速记录快捷键（捕获式输入） */
  private cfgShortcutQuickRecord: HTMLInputElement | null;
  /** 召回记忆快捷键（捕获式输入） */
  private cfgShortcutRecallMemory: HTMLInputElement | null;
  /** 快速输入浮窗快捷键（捕获式输入，对应 quick-input 全局快捷键） */
  private cfgShortcutQuickInput: HTMLInputElement | null;

  constructor() {
    this.cfgShortcutsEnabled = getOptionalElement('cfg-shortcuts-enabled', 'input');
    this.cfgShortcutToggleWindow = getOptionalElement('cfg-shortcut-toggle-window', 'input');
    this.cfgShortcutQuickRecord = getOptionalElement('cfg-shortcut-quick-record', 'input');
    this.cfgShortcutRecallMemory = getOptionalElement('cfg-shortcut-recall-memory', 'input');
    this.cfgShortcutQuickInput = getOptionalElement('cfg-shortcut-quick-input', 'input');
  }

  /**
   * 加载快捷键配置到表单
   *
   * @param shortcuts 快捷键配置对象
   */
  loadToForm(shortcuts: ShortcutConfig): void {
    if (this.cfgShortcutsEnabled) {
      this.cfgShortcutsEnabled.checked = shortcuts.enabled;
    }
    if (this.cfgShortcutToggleWindow) {
      this.cfgShortcutToggleWindow.value = shortcuts.accelerators['toggle-window'] ?? '';
    }
    if (this.cfgShortcutQuickRecord) {
      this.cfgShortcutQuickRecord.value = shortcuts.accelerators['quick-record'] ?? '';
    }
    if (this.cfgShortcutRecallMemory) {
      this.cfgShortcutRecallMemory.value = shortcuts.accelerators['recall-memory'] ?? '';
    }
    if (this.cfgShortcutQuickInput) {
      this.cfgShortcutQuickInput.value = shortcuts.accelerators['quick-input'] ?? '';
    }
  }

  /**
   * 从表单收集快捷键配置
   *
   * @returns 快捷键配置对象
   */
  collectFromForm(): ShortcutConfig {
    return {
      enabled: this.cfgShortcutsEnabled?.checked ?? true,
      accelerators: {
        'toggle-window': this.cfgShortcutToggleWindow?.value.trim() ?? '',
        'quick-record': this.cfgShortcutQuickRecord?.value.trim() ?? '',
        'recall-memory': this.cfgShortcutRecallMemory?.value.trim() ?? '',
        'quick-input': this.cfgShortcutQuickInput?.value.trim() ?? '',
      },
    };
  }

  /**
   * 初始化快捷键捕获式输入（委托到 shortcutCapture helper）
   *
   * 捕获逻辑、accelerator 解析、冲突检测委托给 shortcutCapture.ts，
   * 此处仅构建 context 并委托。helper 通过 ctx.events 注册监听器，
   * cleanup 由主类统一管理。
   *
   * @param events 事件跟踪器（Manager 持有，统一清理）
   * @param host 宿主回调
   */
  initShortcutCapture(events: EventTracker, host: ShortcutConfigHost): void {
    const context = this.buildShortcutCaptureContext(events, host);
    initShortcutCaptureHelper(context);
  }

  /**
   * 构建快捷键捕获子系统的依赖注入容器
   *
   * 将本组件的快捷键输入框 DOM 元素、事件跟踪器和宿主回调
   * 通过 context 暴露给 shortcutCapture helper。
   */
  private buildShortcutCaptureContext(events: EventTracker, host: ShortcutConfigHost): ShortcutCaptureContext {
    // 过滤掉 null 元素（HTML ID 拼写错误时降级，validateSettingsElements 已报告）
    const inputs: ShortcutInputBinding[] = [
      { input: this.cfgShortcutToggleWindow, action: 'toggle-window' },
      { input: this.cfgShortcutQuickRecord, action: 'quick-record' },
      { input: this.cfgShortcutRecallMemory, action: 'recall-memory' },
      { input: this.cfgShortcutQuickInput, action: 'quick-input' },
    ].filter((b): b is ShortcutInputBinding => b.input !== null);

    return {
      inputs,
      events,
      onCapture: () => host.onDirtyChange(),
      onClear: () => host.onDirtyChange(),
      onConflict: (_action, accelerator) => {
        host.showToast(`快捷键 ${accelerator} 与其他动作冲突，请使用其他组合`, 'warning');
      },
    };
  }

  /**
   * 获取校验字段映射列表
   *
   * 供 Manager 统一校验所有 DOM 元素是否存在。
   * 格式：[字段名, 元素引用, 期望 ID]
   */
  getValidationFields(): Array<[string, HTMLElement | null, string]> {
    return [
      ['cfgShortcutsEnabled', this.cfgShortcutsEnabled, 'cfg-shortcuts-enabled'],
      ['cfgShortcutToggleWindow', this.cfgShortcutToggleWindow, 'cfg-shortcut-toggle-window'],
      ['cfgShortcutQuickRecord', this.cfgShortcutQuickRecord, 'cfg-shortcut-quick-record'],
      ['cfgShortcutRecallMemory', this.cfgShortcutRecallMemory, 'cfg-shortcut-recall-memory'],
      ['cfgShortcutQuickInput', this.cfgShortcutQuickInput, 'cfg-shortcut-quick-input'],
    ];
  }
}