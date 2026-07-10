/**
 * 技能拖入安装面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - onSkillInstalled：回调注册
 * - handleSkillDrop：空数组 / 全非 md / 部分 md / 全部成功 / 部分失败
 * - handleSkillFileSelect：触发 file input click
 * - installSkillFile：成功 / 失败 / 异常（通过 handleSkillDrop 间接测试）
 * - flashDropzoneError：添加 .is-error 类（通过 handleSkillDrop 间接测试）
 * - cleanup：清空 skillInstalledCallback 引用
 *
 * Mock 策略：
 * - Mock ToastManager（验证 showToast 调用参数）
 * - Mock window.electronAPI.installSkill（控制成功/失败）
 * - JSDOM 提供 File / FileReader / DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillDropManager } from '../../../electron/renderer/panels/skillDropManager.js';
import type { ToastManager } from '../../../electron/renderer/components/toast.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** Toast 调用记录 */
interface ToastCall {
  message: string;
  type: string;
  duration?: number;
}

/** 创建 Mock ToastManager（捕获 showToast 调用参数） */
function createMockToastManager() {
  const calls: ToastCall[] = [];
  return {
    showToast: vi.fn((message: string, type: string = 'info', duration?: number) => {
      calls.push({ message, type, duration });
    }),
    __calls: calls,
  } as unknown as ToastManager & { __calls: ToastCall[] };
}

/** dropzone 完整 DOM 结构 */
const DROPZONE_HTML = `
  <div id="skill-dropzone"></div>
  <input id="skill-file-input" type="file" />
`;

/** 创建 SkillDropManager 实例（注入 Mock ToastManager） */
function createManager(toast?: ToastManager): { manager: SkillDropManager; toast: ToastManager & { __calls: ToastCall[] } } {
  const mockToast = toast ?? createMockToastManager();
  document.body.innerHTML = DROPZONE_HTML;
  return { manager: new SkillDropManager(mockToast), toast: mockToast as ToastManager & { __calls: ToastCall[] } };
}

/** 创建测试用 .md 文件 */
function createMdFile(name: string, content: string = '# 技能内容'): File {
  return new File([content], name, { type: 'text/markdown' });
}

/** 创建测试用非 .md 文件 */
function createOtherFile(name: string): File {
  return new File(['content'], name, { type: 'text/plain' });
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  window.electronAPI = {
    installSkill: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as typeof window.electronAPI;
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── onSkillInstalled · 回调注册 ─────────────────────────

describe('onSkillInstalled · 回调注册', () => {
  it('应注册技能安装成功回调', async () => {
    const { manager } = createManager();
    const callback = vi.fn();
    manager.onSkillInstalled(callback);
    await manager.handleSkillDrop([createMdFile('test.md')]);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ─── handleSkillDrop · 边界情况 ──────────────────────────

describe('handleSkillDrop · 边界情况', () => {
  it('空数组应直接返回（不调用 installSkill）', async () => {
    const { manager } = createManager();
    await manager.handleSkillDrop([]);
    expect(window.electronAPI.installSkill).not.toHaveBeenCalled();
  });
});

// ─── handleSkillDrop · 文件类型过滤 ──────────────────────

describe('handleSkillDrop · 文件类型过滤', () => {
  it('全非 md 文件应显示 warning + flashDropzoneError', async () => {
    const { manager, toast } = createManager();
    await manager.handleSkillDrop([
      createOtherFile('a.txt'),
      createOtherFile('b.json'),
    ]);
    expect(toast.__calls.some(c => c.message === '仅支持 .md 技能文件' && c.type === 'warning')).toBe(true);
    // dropzone 应添加 .is-error 类（短暂闪烁）
    expect(document.getElementById('skill-dropzone')!.classList.contains('is-error')).toBe(true);
  });

  it('部分 md 文件应显示 info toast 提示跳过数量', async () => {
    const { manager, toast } = createManager();
    await manager.handleSkillDrop([
      createMdFile('a.md'),
      createOtherFile('b.txt'),
      createOtherFile('c.json'),
    ]);
    // 应有 info toast 提示跳过 2 个非 md 文件
    expect(toast.__calls.some(c => c.type === 'info' && c.message.includes('2 个非 .md 文件'))).toBe(true);
  });

  it('全部 md 文件不应显示跳过提示', async () => {
    const { manager, toast } = createManager();
    await manager.handleSkillDrop([createMdFile('a.md'), createMdFile('b.md')]);
    expect(toast.__calls.some(c => c.type === 'info' && c.message.includes('非 .md 文件'))).toBe(false);
  });
});

// ─── handleSkillDrop · 成功流程 ──────────────────────────

describe('handleSkillDrop · 成功流程', () => {
  it('单个 md 文件成功应显示 success toast', async () => {
    const { manager, toast } = createManager();
    await manager.handleSkillDrop([createMdFile('test.md')]);
    expect(toast.__calls.some(c => c.message === '技能安装成功' && c.type === 'success')).toBe(true);
  });

  it('多个 md 文件成功应显示计数 success toast', async () => {
    const { manager, toast } = createManager();
    await manager.handleSkillDrop([createMdFile('a.md'), createMdFile('b.md'), createMdFile('c.md')]);
    expect(toast.__calls.some(c => c.message === '3 个技能安装成功' && c.type === 'success')).toBe(true);
  });

  it('成功应触发 skillInstalledCallback', async () => {
    const { manager } = createManager();
    const callback = vi.fn();
    manager.onSkillInstalled(callback);
    await manager.handleSkillDrop([createMdFile('test.md')]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('应调用 installSkill IPC（文件名 + 内容）', async () => {
    const { manager } = createManager();
    await manager.handleSkillDrop([createMdFile('test.md', '技能内容')]);
    expect(window.electronAPI.installSkill).toHaveBeenCalledWith('test.md', '技能内容');
  });
});

// ─── handleSkillDrop · 失败流程 ──────────────────────────

describe('handleSkillDrop · 失败流程', () => {
  it('installSkill 返回 success=false 应显示 error toast + flashDropzoneError', async () => {
    const { manager, toast } = createManager();
    window.electronAPI.installSkill = vi.fn().mockResolvedValue({ success: false, error: '格式错误' });
    await manager.handleSkillDrop([createMdFile('bad.md')]);
    // 应显示 error toast（包含文件名和错误信息）
    expect(toast.__calls.some(c => c.type === 'error' && c.message.includes('bad.md') && c.message.includes('格式错误'))).toBe(true);
  });

  it('installSkill 抛错应显示 error toast', async () => {
    const { manager, toast } = createManager();
    window.electronAPI.installSkill = vi.fn().mockRejectedValue(new Error('IPC 失败'));
    await manager.handleSkillDrop([createMdFile('test.md')]);
    expect(toast.__calls.some(c => c.type === 'error' && c.message.includes('IPC 失败'))).toBe(true);
  });

  it('部分失败时不应中断后续文件安装', async () => {
    const { manager } = createManager();
    let callCount = 0;
    window.electronAPI.installSkill = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ success: false, error: '第一个失败' });
      }
      return Promise.resolve({ success: true });
    });
    await manager.handleSkillDrop([createMdFile('a.md'), createMdFile('b.md')]);
    // 应全部调用（不中断）
    expect(window.electronAPI.installSkill).toHaveBeenCalledTimes(2);
  });

  it('部分成功时应显示 success toast + 失败 error toast', async () => {
    const { manager, toast } = createManager();
    let callCount = 0;
    window.electronAPI.installSkill = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ success: false, error: '失败' });
      }
      return Promise.resolve({ success: true });
    });
    await manager.handleSkillDrop([createMdFile('a.md'), createMdFile('b.md')]);
    // 应有 success toast（单个成功时消息为"技能安装成功"，多个时为"N 个技能安装成功"）
    expect(toast.__calls.some(c => c.type === 'success' && c.message === '技能安装成功')).toBe(true);
    // 应有 error toast
    expect(toast.__calls.some(c => c.type === 'error')).toBe(true);
  });

  it('全部失败时不应触发 skillInstalledCallback', async () => {
    const { manager } = createManager();
    const callback = vi.fn();
    manager.onSkillInstalled(callback);
    window.electronAPI.installSkill = vi.fn().mockResolvedValue({ success: false, error: '失败' });
    await manager.handleSkillDrop([createMdFile('a.md'), createMdFile('b.md')]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('无论成功失败都应移除 .is-installing 类', async () => {
    const { manager } = createManager();
    window.electronAPI.installSkill = vi.fn().mockResolvedValue({ success: false, error: '失败' });
    await manager.handleSkillDrop([createMdFile('test.md')]);
    expect(document.getElementById('skill-dropzone')!.classList.contains('is-installing')).toBe(false);
  });
});

// ─── handleSkillFileSelect ───────────────────────────────

describe('handleSkillFileSelect', () => {
  it('应触发 file input 的 click', () => {
    const { manager } = createManager();
    const fileInput = document.getElementById('skill-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');
    manager.handleSkillFileSelect();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('file input 缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const toast = createMockToastManager();
    const manager = new SkillDropManager(toast);
    expect(() => manager.handleSkillFileSelect()).not.toThrow();
  });
});

// ─── flashDropzoneError · 通过 handleSkillDrop 间接测试 ──

describe('flashDropzoneError · 错误态闪烁', () => {
  it('失败时应添加 .is-error 类', async () => {
    const { manager } = createManager();
    window.electronAPI.installSkill = vi.fn().mockResolvedValue({ success: false, error: '失败' });
    await manager.handleSkillDrop([createMdFile('bad.md')]);
    expect(document.getElementById('skill-dropzone')!.classList.contains('is-error')).toBe(true);
  });

  it('dropzone 缺失时 flashDropzoneError 不应抛错', async () => {
    // 删除 dropzone 后再触发失败流程
    const { manager } = createManager();
    document.getElementById('skill-dropzone')?.remove();
    window.electronAPI.installSkill = vi.fn().mockResolvedValue({ success: false, error: '失败' });
    await expect(manager.handleSkillDrop([createMdFile('bad.md')])).resolves.toBeUndefined();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 回调引用清空', () => {
  it('cleanup 不应抛错', () => {
    const { manager } = createManager();
    expect(() => manager.cleanup()).not.toThrow();
  });

  it('cleanup 后成功安装不应触发旧回调', async () => {
    const { manager } = createManager();
    const callback = vi.fn();
    manager.onSkillInstalled(callback);
    manager.cleanup();
    await manager.handleSkillDrop([createMdFile('test.md')]);
    // cleanup 后 skillInstalledCallback 已清空，不应触发
    expect(callback).not.toHaveBeenCalled();
  });
});
