/**
 * 快捷键捕获子系统辅助（从 settingsPanelManager.ts 提取）
 *
 * 职责：
 *   集中管理设置面板中快捷键捕获式输入的逻辑，降低 settingsPanelManager.ts 体量。涵盖：
 *   - keyEventToAccelerator：KeyboardEvent → Electron accelerator 字符串（纯函数）
 *   - isShortcutConflict：检测快捷键与其他动作是否冲突（纯函数）
 *   - initShortcutCapture：为快捷键输入框注册 focus/blur/keydown 监听器（context 注入）
 *
 * 提取原因：
 *   settingsPanelManager.ts 在 Provider 管理提取后约 1344 行，其中「快捷键捕获子系统」
 *   （原 L528-705，约 178 行）自成闭环：3 个方法仅依赖快捷键输入框 DOM 元素 +
 *   host 回调（toast）+ dirty 标志/自动保存触发。
 *
 * 设计：
 *   - keyEventToAccelerator / isShortcutConflict 为纯函数，无副作用，可直接导出复用
 *   - initShortcutCapture 通过 ShortcutCaptureContext 注入依赖（DOM 元素、事件跟踪器、
 *     宿主回调），不持有状态，保持 SettingsPanelManager 作为状态所有者
 *   - 事件监听器通过 ctx.events（EventTracker）注册，cleanup 由主类统一管理
 *
 * 先例：
 *   参照 providerManagement.ts 的 context 注入模式
 */

import type { EventTracker } from './eventTracker.js';
import type { ShortcutConfig } from '../../../shared/shortcutDefaults.js';

// ─── 纯函数 ────────────────────────────────────────────────

/**
 * keyEventToAccelerator 的返回值类型
 *
 * - string：有效的 accelerator 字符串（如 "Ctrl+Shift+Space"）
 * - '__cancel__'：Esc 键，表示取消捕获
 * - '__clear__'：Backspace（无修饰键），表示清除快捷键
 * - null：不支持的键（如单独的修饰键、无法识别的键），继续等待
 */
export type AcceleratorParseResult = string | '__cancel__' | '__clear__' | null;

/**
 * 将 KeyboardEvent 解析为 Electron accelerator 格式字符串
 *
 * Electron accelerator 格式：修饰键 + 主键，如 "Ctrl+Shift+Space"。
 * 修饰键顺序：Ctrl → Cmd → Alt → Shift（与 Electron 文档一致）。
 *
 * 特殊返回值：
 * - '__cancel__'：Esc 键，表示取消捕获
 * - '__clear__'：Backspace（无修饰键），表示清除快捷键
 * - null：不支持的键（如单独的修饰键、无法识别的键），继续等待
 *
 * @param e 键盘事件
 * @returns accelerator 字符串、特殊标记或 null
 */
export function keyEventToAccelerator(e: KeyboardEvent): AcceleratorParseResult {
  // Esc 取消捕获
  if (e.key === 'Escape') return '__cancel__';

  // Backspace（无修饰键）清除快捷键
  if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    return '__clear__';
  }

  // 收集修饰键（顺序：Ctrl → Cmd → Alt → Shift）
  /** 修饰键列表（按 Electron accelerator 规范顺序） */
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  // 单独的修饰键不构成有效快捷键，继续等待
  if (parts.length === 0) return null;

  // 主键映射表（e.key → Electron accelerator 键名）
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
  };

  /** 主键名（Electron accelerator 格式） */
  let key = keyMap[e.key];
  if (!key) {
    // 字母键转大写（accelerator 规范：A-Z）
    if (/^[a-z]$/i.test(e.key)) {
      key = e.key.toUpperCase();
    } else if (/^F\d{1,2}$/i.test(e.key)) {
      // 功能键 F1-F24 转大写
      key = e.key.toUpperCase();
    } else if (/^\d$/.test(e.key)) {
      // 数字键 0-9
      key = e.key;
    } else {
      // 不支持的键，继续等待
      return null;
    }
  }

  parts.push(key);
  return parts.join('+');
}

/**
 * 检查快捷键是否与其他动作冲突
 *
 * 遍历 existing.accelerators 中的所有条目（排除 excludeAction 对应的动作），
 * 检查是否有相同的 accelerator。空字符串不视为冲突（允许未设置的快捷键）。
 *
 * @param accelerator 待检查的 accelerator 字符串
 * @param existing 当前快捷键配置（包含 accelerators 映射）
 * @param excludeAction 排除的动作名（当前正在捕获的动作，不与自身比较）
 * @returns true 表示与其他动作冲突
 */
export function isShortcutConflict(
  accelerator: string,
  existing: ShortcutConfig,
  excludeAction?: string,
): boolean {
  for (const [action, acc] of Object.entries(existing.accelerators)) {
    if (action === excludeAction) continue;
    // 空字符串不视为冲突（允许未设置的快捷键）
    if (!acc) continue;
    if (acc === accelerator) return true;
  }
  return false;
}

// ─── Context 注入的捕获逻辑 ────────────────────────────────

/**
 * 快捷键输入框与动作的绑定
 *
 * 每个快捷键输入框对应一个 action（如 'toggle-window'），
 * 用于冲突检测时排除自身、回调时通知宿主哪个动作被捕获/清除。
 */
export interface ShortcutInputBinding {
  /** 快捷键输入框 DOM 元素 */
  readonly input: HTMLInputElement;
  /** 动作名（对应 ShortcutConfig.accelerators 的 key） */
  readonly action: string;
}

/**
 * 快捷键捕获子系统的上下文（依赖注入容器）
 *
 * 由 SettingsPanelManager 构建并传入。设计为接口而非直接传入 manager 实例，
 * 避免运行时循环依赖并便于独立测试。
 */
export interface ShortcutCaptureContext {
  /** 快捷键输入框与动作的绑定列表（已过滤 null 元素） */
  readonly inputs: ReadonlyArray<ShortcutInputBinding>;
  /** 事件跟踪器（统一管理监听器注册与清理，避免内存泄漏） */
  readonly events: EventTracker;
  /**
   * 捕获成功回调
   *
   * helper 已将 accelerator 填入输入框并 blur，宿主通过此回调触发
   * dirty 标志和自动保存。
   *
   * @param action 被捕获的动作名
   * @param accelerator 捕获到的 accelerator 字符串
   */
  onCapture(action: string, accelerator: string): void;
  /**
   * 清除快捷键回调
   *
   * helper 已清空输入框并 blur，宿主通过此回调触发 dirty 标志和自动保存。
   *
   * @param action 被清除的动作名
   */
  onClear(action: string): void;
  /**
   * 冲突回调
   *
   * 捕获的 accelerator 与其他动作重复时触发，helper 不会将值填入输入框，
   * 宿主通过此回调显示警告提示。
   *
   * @param action 冲突的动作名
   * @param accelerator 冲突的 accelerator 字符串
   */
  onConflict(action: string, accelerator: string): void;
}

/**
 * 初始化快捷键捕获式输入
 *
 * 为绑定的快捷键输入框注册 focus/blur/keydown 监听器：
 * - focus：进入捕获状态，显示"按下组合键..."提示
 * - keydown：解析组合键为 Electron accelerator 格式，Esc 取消，Backspace 清除
 * - blur：退出捕获状态，恢复默认提示
 *
 * 冲突检测：捕获成功后检查与其他动作的快捷键是否重复，重复时通过 onConflict
 * 回调通知宿主并不填入值。
 *
 * @param ctx 快捷键捕获上下文（输入框绑定 + 事件跟踪器 + 宿主回调）
 */
export function initShortcutCapture(ctx: ShortcutCaptureContext): void {
  for (const { input, action } of ctx.inputs) {
    /** 捕获状态标志（focus 时置 true，blur/cancel/capture 时置 false） */
    let capturing = false;
    /** 进入捕获前的原值（Esc 取消时恢复） */
    let originalValue = '';

    ctx.events.addEventListener(input, 'focus', () => {
      capturing = true;
      originalValue = input.value;
      input.classList.add('capturing');
      input.placeholder = '按下组合键…（Esc 取消，Backspace 清除）';
    });

    ctx.events.addEventListener(input, 'blur', () => {
      if (capturing) {
        capturing = false;
        input.classList.remove('capturing');
        input.placeholder = '点击捕获组合键';
      }
    });

    ctx.events.addEventListener(input, 'keydown', (e: Event) => {
      // EventListener 签名要求 (e: Event)，keydown 事件实际为 KeyboardEvent，窄化转换
      const ke = e as KeyboardEvent;
      if (!capturing) return;
      // 阻止默认行为（如 Tab 切换焦点、空格滚动页面）
      ke.preventDefault();
      ke.stopPropagation();

      const result = keyEventToAccelerator(ke);
      // null 表示不支持的键，继续等待用户按下有效组合键
      if (result === null) return;

      // Esc 取消：恢复原值并退出捕获
      if (result === '__cancel__') {
        input.value = originalValue;
        input.blur();
        return;
      }

      // Backspace（无修饰键）清除快捷键
      if (result === '__clear__') {
        input.value = '';
        input.blur();
        ctx.onClear(action);
        return;
      }

      // 从当前所有输入框值构建 accelerators 映射，用于冲突检测
      const accelerators: Record<string, string> = {};
      for (const binding of ctx.inputs) {
        accelerators[binding.action] = binding.input.value.trim();
      }

      // 冲突检测：检查与其他动作的快捷键是否重复（排除当前动作自身）
      if (isShortcutConflict(result, { enabled: true, accelerators }, action)) {
        ctx.onConflict(action, result);
        return; // 不填入，继续等待
      }

      // 捕获成功：填入并退出捕获状态
      input.value = result;
      input.blur();
      ctx.onCapture(action, result);
    });
  }
}
