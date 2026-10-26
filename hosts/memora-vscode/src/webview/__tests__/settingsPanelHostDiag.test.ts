/**
 * host_diag 诊断路由 settings 面板出口测试（T1）
 *
 * 覆盖 settingsPanel.handleMessage 的 host_diag 分支：
 *   ① 收到上报 → console.warn 落扩展宿主日志（message + stack 留痕）；
 *   ② **不驱动任何 UI 状态**：零下行 post（卡片由 webview 就地渲染，宿主只管留痕）。
 *
 * 为何必须单独钉：错误边界在 settingsViewMain 装配、上报发到**本面板**的路由——
 * 2026-10-11 落地审查实锤过「chatPanel 接了路由、settingsPanel 漏接」的半个补丁
 * （卡片插了但日志石沉大海，卡片文案指的日志不存在）。本文件锁住 settings 侧消费面，
 * 删除分支即红。
 *
 * 驱动方式：直调 handleMessage（注册回调 `void this.handleMessage(msg)` 无附加逻辑，
 * 直调与走回调等价）；与 chatPanelHostDiag 同款断言，防两面板措辞漂移。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { MemoraSettingsPanel } from '../panels/settingsPanel.js';

// mock vscode：仅提供 settingsPanel 构造与加载期用到的最小 API
vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined), update: vi.fn() })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
}));

/** 装配：provider + postMessage 捕获 + handleMessage 私有入口 */
function setupDiag() {
  const posted: unknown[] = [];
  const provider = new MemoraSettingsPanel({} as never, {} as never);
  (provider as unknown as { _panel: unknown })._panel = {
    webview: {
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  const handleMessage = (
    provider as unknown as {
      handleMessage(msg: unknown): Promise<void>;
    }
  ).handleMessage.bind(provider);
  return { handleMessage, posted };
}

describe('host_diag 诊断路由 settings 面板出口（T1 半伤补钉）', () => {
  it('收到上报 → console.warn 落日志（含 source/message/stack），零下行 post', async () => {
    const { handleMessage, posted } = setupDiag();
    const warnSpy = vi.spyOn(console, 'warn');

    await handleMessage({
      type: 'host_diag',
      source: 'unhandledrejection',
      message: '异步任务炸了',
      stack: 'Error: 异步任务炸了\n    at foo',
    });

    const diagWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('webview 未处理异常'),
    );
    expect(diagWarns).toHaveLength(1);
    expect(String(diagWarns[0][0])).toContain('[unhandledrejection]');
    expect(String(diagWarns[0][0])).toContain('异步任务炸了');
    expect(String(diagWarns[0][1])).toContain('at foo');
    // 载荷纪律：只留痕，不驱动任何 UI 状态（宿主顺手弹 notice 即变异）
    expect(posted).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('缺 stack 字段的上报同样落日志（不因可选字段缺失而炸）', async () => {
    const { handleMessage, posted } = setupDiag();
    const warnSpy = vi.spyOn(console, 'warn');

    await handleMessage({ type: 'host_diag', source: 'error', message: '无堆栈错误' });

    const diagWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('webview 未处理异常'),
    );
    expect(diagWarns).toHaveLength(1);
    expect(String(diagWarns[0][0])).toContain('[error]');
    expect(posted).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
