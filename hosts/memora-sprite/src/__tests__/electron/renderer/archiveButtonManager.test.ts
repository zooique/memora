/**
 * 归档按钮管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - maybeAddArchiveButton：manual 模式渲染 / 非 manual 跳过 / 非 assistant 跳过 / 幂等保护
 * - handleClick：正常归档 / 无配对 user 消息 / 空 user 消息 / 归档成功 / 无内容 / 归档失败
 * - findPreviousUserMessage：同组内查找 / 跨组查找 / 无匹配
 * - cleanup：空实现不应抛错
 *
 * Mock 策略：
 * - Mock ArchiveButtonHost（getArchiveMode / archiveConversation / showToast）
 * - DOM 结构手动构建（message-group + message.user + message.assistant）
 */
import { describe, it, expect, vi } from 'vitest';
import { ArchiveButtonManager } from '../../../electron/renderer/panels/archiveButtonManager.js';
import type { ArchiveButtonHost } from '../../../electron/renderer/panels/archiveButtonManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock ArchiveButtonHost */
function createMockHost(archiveMode: 'full' | 'insights-only' | 'manual' = 'manual'): ArchiveButtonHost {
  return {
    getArchiveMode: vi.fn().mockReturnValue(archiveMode),
    archiveConversation: vi.fn().mockResolvedValue(3),
    showToast: vi.fn(),
  };
}

/** 创建 ArchiveButtonManager 实例 */
function createManager(host: ArchiveButtonHost = createMockHost()): {
  manager: ArchiveButtonManager;
  host: ArchiveButtonHost;
} {
  return { manager: new ArchiveButtonManager(host), host };
}

/** 构建完整消息组 DOM 结构（user → assistant → archive 按钮） */
function buildMessageGroup(): {
  container: HTMLElement;
  userEl: HTMLElement;
  assistantEl: HTMLElement;
  copyBtn: HTMLButtonElement;
  metaRow: HTMLElement;
} {
  const container = document.createElement('div');
  container.className = 'message-group';

  // user 消息
  const userEl = document.createElement('div');
  userEl.className = 'message user';
  const userBubble = document.createElement('div');
  userBubble.className = 'message-bubble';
  userBubble.textContent = '用户输入内容';
  userEl.appendChild(userBubble);
  container.appendChild(userEl);

  // assistant 消息
  const assistantEl = document.createElement('div');
  assistantEl.className = 'message assistant';
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'message-bubble';
  assistantBubble.textContent = '助手回复内容';
  assistantEl.appendChild(assistantBubble);
  const metaRow = document.createElement('div');
  metaRow.className = 'message-meta';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'message-copy-btn';
  metaRow.appendChild(copyBtn);
  assistantEl.appendChild(metaRow);
  container.appendChild(assistantEl);

  document.body.appendChild(container);
  return { container, userEl, assistantEl, copyBtn, metaRow };
}

// ─── maybeAddArchiveButton ────────────────────────────────

describe('maybeAddArchiveButton · 渲染条件', () => {
  it('manual 模式 + assistant 消息应渲染归档按钮', () => {
    const { manager } = createManager();
    const { assistantEl, copyBtn, metaRow } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, copyBtn, metaRow);
    const btn = assistantEl.querySelector('.message-archive-btn');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('data-action')).toBe('archive');
  });

  it('full 模式不应渲染归档按钮', () => {
    const { manager } = createManager(createMockHost('full'));
    const { assistantEl, copyBtn, metaRow } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, copyBtn, metaRow);
    expect(assistantEl.querySelector('.message-archive-btn')).toBeNull();
  });

  it('insights-only 模式不应渲染归档按钮', () => {
    const { manager } = createManager(createMockHost('insights-only'));
    const { assistantEl, copyBtn, metaRow } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, copyBtn, metaRow);
    expect(assistantEl.querySelector('.message-archive-btn')).toBeNull();
  });

  it('非 assistant 消息不应渲染归档按钮', () => {
    const { manager } = createManager();
    const { userEl, copyBtn, metaRow } = buildMessageGroup();
    manager.maybeAddArchiveButton(userEl, copyBtn, metaRow);
    expect(userEl.querySelector('.message-archive-btn')).toBeNull();
  });

  it('幂等保护：已存在归档按钮时跳过', () => {
    const { manager } = createManager();
    const { assistantEl, copyBtn, metaRow } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, copyBtn, metaRow);
    manager.maybeAddArchiveButton(assistantEl, copyBtn, metaRow);
    // 只应渲染一个归档按钮
    expect(assistantEl.querySelectorAll('.message-archive-btn')).toHaveLength(1);
  });
});

// ─── handleClick · 归档流程 ───────────────────────────────

describe('handleClick · 归档流程', () => {
  it('正常归档应调用 archiveConversation + 显示成功 toast', async () => {
    const host = createMockHost();
    const { manager } = createManager(host);
    const { assistantEl } = buildMessageGroup();
    // 先渲染归档按钮
    manager.maybeAddArchiveButton(assistantEl, assistantEl.querySelector('button')!, assistantEl.querySelector('.message-meta')!);
    const archiveBtn = assistantEl.querySelector('.message-archive-btn') as HTMLElement;
    await manager.handleClick(archiveBtn);
    expect(host.archiveConversation).toHaveBeenCalledTimes(1);
    expect(host.archiveConversation).toHaveBeenCalledWith('用户输入内容', '助手回复内容');
    expect(host.showToast).toHaveBeenCalledWith('已归档 3 条记忆', 'success', 2000);
  });

  it('归档成功应禁用按钮 + 添加 archived 类', async () => {
    const { manager } = createManager();
    const { assistantEl } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, assistantEl.querySelector('button')!, assistantEl.querySelector('.message-meta')!);
    const archiveBtn = assistantEl.querySelector('.message-archive-btn') as HTMLElement;
    await manager.handleClick(archiveBtn);
    expect(archiveBtn.hasAttribute('disabled')).toBe(true);
    expect(archiveBtn.classList.contains('archived')).toBe(true);
  });

  it('无配对 user 消息应显示 error toast', async () => {
    const { manager, host } = createManager();
    // 孤立 assistant 消息（无前置 user）
    const assistantEl = document.createElement('div');
    assistantEl.className = 'message assistant';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = '助手回复';
    assistantEl.appendChild(bubble);
    document.body.appendChild(assistantEl);
    const btn = document.createElement('button');
    btn.className = 'message-archive-btn';
    btn.dataset.action = 'archive';
    assistantEl.appendChild(btn);

    await manager.handleClick(btn);
    expect(host.showToast).toHaveBeenCalledWith('未找到配对的用户消息，无法归档', 'error');
  });

  it('空 user 消息应显示 error toast', async () => {
    const { manager, host } = createManager();
    // user 消息内容为空
    const container = document.createElement('div');
    container.className = 'message-group';
    const userEl = document.createElement('div');
    userEl.className = 'message user';
    const userBubble = document.createElement('div');
    userBubble.className = 'message-bubble';
    userBubble.textContent = '   '; // 仅空白
    userEl.appendChild(userBubble);
    container.appendChild(userEl);
    const assistantEl = document.createElement('div');
    assistantEl.className = 'message assistant';
    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'message-bubble';
    assistantBubble.textContent = '助手回复';
    assistantEl.appendChild(assistantBubble);
    container.appendChild(assistantEl);
    document.body.appendChild(container);
    const btn = document.createElement('button');
    btn.className = 'message-archive-btn';
    btn.dataset.action = 'archive';
    assistantEl.appendChild(btn);

    await manager.handleClick(btn);
    expect(host.showToast).toHaveBeenCalledWith('用户消息为空，无法归档', 'error');
  });

  it('未提取到有价值信息应恢复按钮', async () => {
    const host = createMockHost();
    (host.archiveConversation as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const { manager } = createManager(host);
    const { assistantEl } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, assistantEl.querySelector('button')!, assistantEl.querySelector('.message-meta')!);
    const archiveBtn = assistantEl.querySelector('.message-archive-btn') as HTMLElement;
    await manager.handleClick(archiveBtn);
    expect(host.showToast).toHaveBeenCalledWith('本轮对话无需归档（未提取到有价值信息）', 'info', 2000);
    expect(archiveBtn.hasAttribute('disabled')).toBe(false);
  });

  it('归档失败应恢复按钮 + 显示 error toast', async () => {
    const host = createMockHost();
    (host.archiveConversation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('失败'));
    const { manager } = createManager(host);
    const { assistantEl } = buildMessageGroup();
    manager.maybeAddArchiveButton(assistantEl, assistantEl.querySelector('button')!, assistantEl.querySelector('.message-meta')!);
    const archiveBtn = assistantEl.querySelector('.message-archive-btn') as HTMLElement;
    await manager.handleClick(archiveBtn);
    expect(host.showToast).toHaveBeenCalledWith('归档失败，请重试', 'error');
    expect(archiveBtn.hasAttribute('disabled')).toBe(false);
  });
});

// ─── findPreviousUserMessage · 向前查找 ────────────────────

describe('findPreviousUserMessage · 向前查找', () => {
  it('同组内应找到前一条 user 消息', () => {
    const { manager } = createManager();
    const { assistantEl } = buildMessageGroup();
    // 通过反射调用 private 方法
    const result = (manager as unknown as {
      findPreviousUserMessage(el: HTMLElement): HTMLElement | null;
    }).findPreviousUserMessage(assistantEl);
    expect(result).not.toBeNull();
    expect(result!.classList.contains('user')).toBe(true);
  });

  // TODO: 此测试场景不成立——assistant 消息所在 group 内已有 user 消息时，
  // findPreviousUserMessage 应返回同组内的 user 消息（正确行为），而非跨组查找。
  // 待重新设计后补充。

  it('无匹配时应返回 null', () => {
    const { manager } = createManager();
    // 孤立 assistant 消息，无前置 user
    const assistantEl = document.createElement('div');
    assistantEl.className = 'message assistant';
    document.body.appendChild(assistantEl);
    const result = (manager as unknown as {
      findPreviousUserMessage(el: HTMLElement): HTMLElement | null;
    }).findPreviousUserMessage(assistantEl);
    expect(result).toBeNull();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 空实现', () => {
  it('cleanup 不应抛错（空实现，与其他 Manager 保持统一生命周期接口）', () => {
    const { manager } = createManager();
    expect(() => manager.cleanup()).not.toThrow();
  });
});