/**
 * 模态框管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - initModalListeners：关闭按钮 data-modal 分发、背景点击关闭、Escape 键关闭最上层
 * - showModal/hideModal：焦点保存与恢复（UI-AR-02 无障碍）
 * - showConfirmDialog：默认值/自定义文案/danger 样式/messageNodes 防 XSS/
 *   并发保护（旧弹窗被取消）/Escape 取消/Enter 确认/元素缺失回退/cleanup 中断 Promise
 * - showInputDialog：必填校验/maxLength/Enter 确认/Escape 取消/默认值/并发保护
 * - showWriteConfirmation：DOM 节点构建/防 XSS/委托 showConfirmDialog
 * - cleanup：清理活跃 confirm/input 弹窗的未完成 Promise（防泄漏）
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - JSDOM 提供真实 DOM API（classList/focus/querySelector/activeElement/dispatchEvent）
 * - KeyboardEvent 需 cancelable: true 才能 preventDefault
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModalManager } from '../../../electron/renderer/components/modal.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 模态框完整 DOM 结构（confirm-modal + prompt-modal + 自定义 modal + 触发按钮） */
const MODAL_HTML = `
  <button id="trigger-btn" tabindex="0">触发按钮</button>
  <button data-modal="custom-modal" id="close-custom">关闭自定义</button>
  <div id="custom-modal" class="modal hidden">
    <div class="modal-content">
      <button class="modal-close">x</button>
      <button id="custom-action">操作</button>
    </div>
  </div>
  <div id="confirm-modal" class="modal hidden">
    <div class="modal-content">
      <h3 id="confirm-title">标题</h3>
      <div id="confirm-message">消息</div>
      <button class="modal-close">x</button>
      <button id="btn-confirm-cancel">取消</button>
      <button id="btn-confirm-ok">确定</button>
    </div>
  </div>
  <div id="prompt-modal" class="modal hidden">
    <div class="modal-content">
      <h3 id="prompt-title">标题</h3>
      <div id="prompt-message">提示</div>
      <input id="prompt-input" type="text" />
      <div id="prompt-error" class="hidden"></div>
      <button class="modal-close">x</button>
      <button id="btn-prompt-cancel">取消</button>
      <button id="btn-prompt-ok">确定</button>
    </div>
  </div>
`;

/** 创建 ModalManager 实例（可选初始化监听器） */
function createManager(opts?: { initListeners?: boolean }): ModalManager {
  document.body.innerHTML = MODAL_HTML;
  const manager = new ModalManager();
  if (opts?.initListeners !== false) {
    manager.initModalListeners();
  }
  return manager;
}

/** 在目标元素上派发键盘事件（cancelable: true 才能 preventDefault） */
function dispatchKeydown(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** 派发点击事件 */
function click(el: HTMLElement): void {
  el.click();
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // ModalManager 不依赖 rAF，但部分 focus 操作在 JSDOM 中需要 body 有焦点能力
});

afterEach(() => {
  document.body.innerHTML = '';
});

// ─── initModalListeners ───────────────────────────────────

describe('initModalListeners · 关闭按钮 data-modal 分发', () => {
  it('click 带 data-modal 的按钮应隐藏对应弹窗', () => {
    createManager();
    const modal = document.getElementById('custom-modal')!;
    modal.classList.remove('hidden'); // 先显示
    click(document.getElementById('close-custom')!);
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('click 不带 data-modal 的按钮不应触发 hideModal', () => {
    createManager();
    const modal = document.getElementById('custom-modal')!;
    modal.classList.remove('hidden');
    click(document.getElementById('custom-action')!);
    // 非 data-modal 按钮，弹窗应仍可见
    expect(modal.classList.contains('hidden')).toBe(false);
  });
});

describe('initModalListeners · 背景点击关闭', () => {
  it('click 弹窗背景（target === modal）应关闭', () => {
    createManager();
    const modal = document.getElementById('custom-modal')!;
    modal.classList.remove('hidden');
    // 模拟点击背景：dispatch click 到 modal 元素本身（target === modal）
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'target', { value: modal });
    modal.dispatchEvent(event);
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('click 弹窗内容（target !== modal）不应关闭', () => {
    createManager();
    const modal = document.getElementById('custom-modal')!;
    modal.classList.remove('hidden');
    // 点击 modal-content（target !== modal）
    click(document.querySelector('.modal-content')!);
    expect(modal.classList.contains('hidden')).toBe(false);
  });
});

describe('initModalListeners · Escape 键关闭最上层', () => {
  it('Escape 应关闭最上层可见弹窗（排除 confirm-modal）', () => {
    createManager();
    const customModal = document.getElementById('custom-modal')!;
    customModal.classList.remove('hidden');
    // document 上派发 Escape
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(event);
    expect(customModal.classList.contains('hidden')).toBe(true);
  });

  it('Escape 不应关闭 confirm-modal（由 showConfirmDialog 独立处理）', () => {
    createManager();
    const confirmModal = document.getElementById('confirm-modal')!;
    confirmModal.classList.remove('hidden');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(event);
    // confirm-modal 仍可见（initModalListeners 的全局 Escape 排除它）
    expect(confirmModal.classList.contains('hidden')).toBe(false);
  });

  it('非 Escape 键不应关闭弹窗', () => {
    createManager();
    const customModal = document.getElementById('custom-modal')!;
    customModal.classList.remove('hidden');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    document.dispatchEvent(event);
    expect(customModal.classList.contains('hidden')).toBe(false);
  });
});

// ─── showModal / hideModal · 焦点管理 ────────────────────

describe('showModal / hideModal · 焦点管理', () => {
  it('showModal 应移除 hidden 类', () => {
    const manager = createManager();
    manager.showModal('custom-modal');
    expect(document.getElementById('custom-modal')!.classList.contains('hidden')).toBe(false);
  });

  it('showModal 应将焦点移到弹窗内第一个可交互元素', () => {
    const manager = createManager();
    manager.showModal('custom-modal');
    // 第一个可交互元素是 .modal-close
    const firstFocusable = document.querySelector('.modal-close') as HTMLElement;
    expect(document.activeElement).toBe(firstFocusable);
  });

  it('showModal 应保存触发元素的焦点，hideModal 后恢复', () => {
    const manager = createManager();
    const trigger = document.getElementById('trigger-btn') as HTMLElement;
    trigger.focus();
    manager.showModal('custom-modal');
    // showModal 后焦点已转移到弹窗内
    expect(document.activeElement).not.toBe(trigger);
    manager.hideModal('custom-modal');
    // hideModal 后焦点恢复到 trigger
    expect(document.activeElement).toBe(trigger);
  });

  it('hideModal 应添加 hidden 类', () => {
    const manager = createManager();
    manager.showModal('custom-modal');
    manager.hideModal('custom-modal');
    expect(document.getElementById('custom-modal')!.classList.contains('hidden')).toBe(true);
  });

  it('showModal 不存在的 modalId 应静默退出', () => {
    const manager = createManager();
    expect(() => manager.showModal('not-exist')).not.toThrow();
  });

  it('hideModal 不存在的 modalId 应静默退出', () => {
    const manager = createManager();
    expect(() => manager.hideModal('not-exist')).not.toThrow();
  });
});

// ─── showConfirmDialog ───────────────────────────────────

describe('showConfirmDialog · 基础渲染', () => {
  it('应使用默认文案显示弹窗', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: '测试消息' });
    // 默认标题 "确认"
    expect(document.getElementById('confirm-title')!.textContent).toBe('确认');
    // 默认确认按钮 "确定"
    expect(document.getElementById('btn-confirm-ok')!.textContent).toBe('确定');
    // 默认取消按钮 "取消"
    expect(document.getElementById('btn-confirm-cancel')!.textContent).toBe('取消');
    // message 走 textContent
    expect(document.getElementById('confirm-message')!.textContent).toBe('测试消息');
    // 弹窗应可见
    expect(document.getElementById('confirm-modal')!.classList.contains('hidden')).toBe(false);
    // 取消以结束 Promise
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('应支持自定义 title/confirmText/cancelText', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({
      title: '警告',
      message: '确认删除？',
      confirmText: '删除',
      cancelText: '保留',
    });
    expect(document.getElementById('confirm-title')!.textContent).toBe('警告');
    expect(document.getElementById('btn-confirm-ok')!.textContent).toBe('删除');
    expect(document.getElementById('btn-confirm-cancel')!.textContent).toBe('保留');
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('danger=true 应使用 btn-danger 样式', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x', danger: true });
    expect(document.getElementById('btn-confirm-ok')!.className).toBe('btn-danger');
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('danger=false（默认）应使用 btn-primary 样式', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    expect(document.getElementById('btn-confirm-ok')!.className).toBe('btn-primary');
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('danger=true 应将焦点放在取消按钮（防误操作）', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x', danger: true });
    expect(document.activeElement).toBe(document.getElementById('btn-confirm-cancel'));
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('danger=false 应将焦点放在确认按钮', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    expect(document.activeElement).toBe(document.getElementById('btn-confirm-ok'));
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });
});

describe('showConfirmDialog · messageNodes 防 XSS', () => {
  it('messageNodes 应通过 DOM 节点构建（不解析 HTML）', async () => {
    const manager = createManager();
    // 构造恶意 DOM 节点（模拟调用方）
    const malicious = document.createElement('div');
    malicious.textContent = '<img src=x onerror=alert(1)>';
    const promise = manager.showConfirmDialog({ message: '', messageNodes: [malicious] });
    // textContent 应为字面量（未作为 HTML 解析）
    expect(document.getElementById('confirm-message')!.textContent).toBe('<img src=x onerror=alert(1)>');
    // 不应存在 img 元素
    expect(document.getElementById('confirm-message')!.querySelector('img')).toBeNull();
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('message 优先级低于 messageNodes', async () => {
    const manager = createManager();
    const node = document.createElement('span');
    node.textContent = '节点内容';
    const promise = manager.showConfirmDialog({
      message: '纯文本（应被忽略）',
      messageNodes: [node],
    });
    expect(document.getElementById('confirm-message')!.textContent).toBe('节点内容');
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });
});

describe('showConfirmDialog · 用户操作', () => {
  it('click 确认按钮应 resolve(true) + 隐藏弹窗', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    click(document.getElementById('btn-confirm-ok')!);
    const result = await promise;
    expect(result).toBe(true);
    expect(document.getElementById('confirm-modal')!.classList.contains('hidden')).toBe(true);
  });

  it('click 取消按钮应 resolve(false)', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    click(document.getElementById('btn-confirm-cancel')!);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('click 关闭按钮（.modal-close）应 resolve(false)', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    const closeBtn = document.querySelector('#confirm-modal .modal-close') as HTMLElement;
    click(closeBtn);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('click 背景应 resolve(false)（stopPropagation 防 initModalListeners 冲突）', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    const modal = document.getElementById('confirm-modal')!;
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'target', { value: modal });
    modal.dispatchEvent(event);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('Escape 应 resolve(false)', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    dispatchKeydown(document.getElementById('confirm-modal')!, 'Escape');
    const result = await promise;
    expect(result).toBe(false);
  });

  it('Enter 应 resolve(true)', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    dispatchKeydown(document.getElementById('confirm-modal')!, 'Enter');
    const result = await promise;
    expect(result).toBe(true);
  });
});

describe('showConfirmDialog · 并发保护', () => {
  it('并发调用应取消旧弹窗（resolve false）+ 显示新弹窗', async () => {
    const manager = createManager();
    const promise1 = manager.showConfirmDialog({ message: '弹窗1' });
    // 立即调用第二个（旧弹窗应被取消）
    const promise2 = manager.showConfirmDialog({ message: '弹窗2' });
    // 第一个应被 resolve(false)
    expect(await promise1).toBe(false);
    // 当前显示的应是弹窗2
    expect(document.getElementById('confirm-message')!.textContent).toBe('弹窗2');
    // 清理第二个
    click(document.getElementById('btn-confirm-cancel')!);
    await promise2;
  });

  it('cleanup 中断时应 resolve(false)', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    manager.cleanup();
    expect(await promise).toBe(false);
  });
});

describe('showConfirmDialog · 元素缺失回退', () => {
  it('confirm-modal 不存在时应回退到 window.confirm', async () => {
    document.body.innerHTML = ''; // 清空所有 DOM
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const manager = new ModalManager();
    const result = await manager.showConfirmDialog({ message: '回退' });
    expect(confirmSpy).toHaveBeenCalledWith('回退');
    expect(result).toBe(true);
    confirmSpy.mockRestore();
  });
});

// ─── showInputDialog ─────────────────────────────────────

describe('showInputDialog · 基础渲染', () => {
  it('应使用默认值显示输入弹窗', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: '请输入名称' });
    expect(document.getElementById('prompt-title')!.textContent).toBe('输入');
    expect(document.getElementById('prompt-message')!.textContent).toBe('请输入名称');
    // 默认 maxLength=100
    expect((document.getElementById('prompt-input') as HTMLInputElement).maxLength).toBe(100);
    // error 应隐藏
    expect(document.getElementById('prompt-error')!.classList.contains('hidden')).toBe(true);
    // 弹窗可见
    expect(document.getElementById('prompt-modal')!.classList.contains('hidden')).toBe(false);
    click(document.getElementById('btn-prompt-cancel')!);
    await promise;
  });

  it('应支持自定义 title/defaultValue/placeholder/maxLength', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({
      title: '重命名',
      message: '输入新名称',
      defaultValue: '默认值',
      placeholder: '提示文本',
      maxLength: 50,
    });
    const input = document.getElementById('prompt-input') as HTMLInputElement;
    expect(document.getElementById('prompt-title')!.textContent).toBe('重命名');
    expect(input.value).toBe('默认值');
    expect(input.placeholder).toBe('提示文本');
    expect(input.maxLength).toBe(50);
    click(document.getElementById('btn-prompt-cancel')!);
    await promise;
  });

  it('应将焦点移到输入框并选中文本', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({
      message: 'x',
      defaultValue: 'hello',
    });
    const input = document.getElementById('prompt-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    // select() 在 JSDOM 中设置 selectionStart/End
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    click(document.getElementById('btn-prompt-cancel')!);
    await promise;
  });
});

describe('showInputDialog · 必填校验', () => {
  it('required=true（默认）空值应显示错误 + 不关闭弹窗', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: '请输入' });
    // 清空输入框
    (document.getElementById('prompt-input') as HTMLInputElement).value = '';
    click(document.getElementById('btn-prompt-ok')!);
    // 弹窗应仍可见
    expect(document.getElementById('prompt-modal')!.classList.contains('hidden')).toBe(false);
    // error 应显示
    const errorEl = document.getElementById('prompt-error')!;
    expect(errorEl.classList.contains('hidden')).toBe(false);
    expect(errorEl.textContent).toBe('输入不能为空');
    // Promise 不应 resolve（用未 resolve 断言：等待微任务后仍 pending）
    await Promise.race([promise.then(() => false), Promise.resolve(true)]).then((stillPending) => {
      // stillPending=true 表示 promise 仍 pending
      expect(stillPending).toBe(true);
    });
    // 取消以结束
    click(document.getElementById('btn-prompt-cancel')!);
    await promise;
  });

  it('required=false 空值应 resolve(null)', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x', required: false });
    (document.getElementById('prompt-input') as HTMLInputElement).value = '   ';
    click(document.getElementById('btn-prompt-ok')!);
    const result = await promise;
    expect(result).toBe(null);
  });

  it('required=true 有值应 resolve(trim 后的值)', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x' });
    (document.getElementById('prompt-input') as HTMLInputElement).value = '  hello  ';
    click(document.getElementById('btn-prompt-ok')!);
    const result = await promise;
    expect(result).toBe('hello');
  });
});

describe('showInputDialog · 用户操作', () => {
  it('Escape 应 resolve(null)', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x' });
    dispatchKeydown(document.getElementById('prompt-modal')!, 'Escape');
    const result = await promise;
    expect(result).toBe(null);
  });

  it('Enter 应确认输入', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x', defaultValue: 'test' });
    dispatchKeydown(document.getElementById('prompt-modal')!, 'Enter');
    const result = await promise;
    expect(result).toBe('test');
  });

  it('click 取消按钮应 resolve(null)', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x' });
    click(document.getElementById('btn-prompt-cancel')!);
    const result = await promise;
    expect(result).toBe(null);
  });

  it('click 关闭按钮应 resolve(null)', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x' });
    click(document.querySelector('#prompt-modal .modal-close') as HTMLElement);
    const result = await promise;
    expect(result).toBe(null);
  });
});

describe('showInputDialog · 并发保护', () => {
  it('并发调用应取消旧弹窗（resolve null）', async () => {
    const manager = createManager();
    const promise1 = manager.showInputDialog({ message: '弹窗1' });
    const promise2 = manager.showInputDialog({ message: '弹窗2' });
    expect(await promise1).toBe(null);
    expect(document.getElementById('prompt-message')!.textContent).toBe('弹窗2');
    click(document.getElementById('btn-prompt-cancel')!);
    await promise2;
  });
});

// ─── showWriteConfirmation ───────────────────────────────

describe('showWriteConfirmation · DOM 节点构建', () => {
  it('应构建工具/路径/描述节点并委托 showConfirmDialog', async () => {
    const manager = createManager();
    const promise = manager.showWriteConfirmation({
      tool: 'write_file',
      targetPath: '/project/file.ts',
      description: '写入 100 字节',
    });
    // 委托到 confirm-modal
    expect(document.getElementById('confirm-modal')!.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('confirm-title')!.textContent).toBe('确认写入操作');
    // 消息容器应包含工具/路径/描述
    const messageEl = document.getElementById('confirm-message')!;
    expect(messageEl.textContent).toContain('write_file');
    expect(messageEl.textContent).toContain('/project/file.ts');
    expect(messageEl.textContent).toContain('写入 100 字节');
    // 应包含 code 元素（路径用 <code> 包裹）
    expect(messageEl.querySelector('code')!.textContent).toBe('/project/file.ts');
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('无 description 时不应包含描述行', async () => {
    const manager = createManager();
    const promise = manager.showWriteConfirmation({
      tool: 'edit_file',
      targetPath: '/x.ts',
    });
    const messageEl = document.getElementById('confirm-message')!;
    // 应包含工具和路径，但无描述行
    expect(messageEl.textContent).toContain('edit_file');
    expect(messageEl.textContent).toContain('/x.ts');
    // 应有 2 个 p（工具行 + 路径行），无第 3 个
    expect(messageEl.querySelectorAll('p').length).toBe(2);
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });

  it('确认按钮文本应为"允许写入"', async () => {
    const manager = createManager();
    const promise = manager.showWriteConfirmation({
      tool: 'x',
      targetPath: '/x',
    });
    expect(document.getElementById('btn-confirm-ok')!.textContent).toBe('允许写入');
    click(document.getElementById('btn-confirm-cancel')!);
    await promise;
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 清理活跃 Promise', () => {
  it('cleanup 应中断活跃的 confirm 弹窗（resolve false）', async () => {
    const manager = createManager();
    const promise = manager.showConfirmDialog({ message: 'x' });
    manager.cleanup();
    expect(await promise).toBe(false);
  });

  it('cleanup 应中断活跃的 input 弹窗（resolve null）', async () => {
    const manager = createManager();
    const promise = manager.showInputDialog({ message: 'x' });
    manager.cleanup();
    expect(await promise).toBe(null);
  });

  it('cleanup 无活跃弹窗时不应抛错', () => {
    const manager = createManager();
    expect(() => manager.cleanup()).not.toThrow();
  });
});
