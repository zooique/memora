/**
 * 润色风格单向注入守卫（POLISH-STYLE-1）
 *
 * 判据：宿主 `handlePolishInput` 从**当前会话 Agent 的角色包 Assembly**取 `personaBasePrompt`
 * 作第三参传给内核 `polish`；角色包定义零改动、协议零字段。三态：有 persona / 无激活角色包 /
 * 有角色包但无 persona（传 undefined，内核走历史 prompt）。
 *
 * 驱动方式：走 `onDidReceiveMessage` 真实注册回调发 `polish_input`（与 chatPanelHostDiag 同范式），
 * 不做源码字符串断言——回退成 `polish(text)` 必须真红。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

vi.mock('vscode', async () => ({
  l10n: { t: tStub },
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    file: (p: string) => ({ fsPath: p, toString: () => 'mock://file' }),
    fsPath: '/mock/path',
  },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

type ActivePack = { personaBasePrompt?: string } | null;

/** 装配：真实 Provider + 注入角色包桩的 Agent + 捕获 polish 调用参数 */
function setupPolish(active: ActivePack) {
  const dir = __dirname;
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    {} as never,
    '/mock/workspace',
  );
  const polish = vi.fn(async () => ({ polished: '润色后', changed: true }));
  const agent = {
    polish: { polish },
    rolePackManager: { getActive: () => active },
  } as unknown as Agent;
  (provider as unknown as { _agent: unknown })._agent = agent;
  const p = provider as unknown as { render(): void; ensureAgent(): Promise<void> };
  p.render = () => {};
  p.ensureAgent = async () => {};
  const posted: unknown[] = [];
  let receive: ((msg: unknown) => void) | undefined;
  const webviewView = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receive = cb;
        return { dispose: () => {} };
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  } as never;
  (provider as unknown as { _view: unknown })._view = webviewView;
  provider.resolveWebviewView(webviewView, {} as never, {} as never);
  return {
    polish,
    posted,
    dispatch: (msg: unknown): void => receive?.(msg),
  };
}

describe('润色风格单向注入（POLISH-STYLE-1）', () => {
  it('激活角色包有 persona → 第三参取 personaBasePrompt 原文', async () => {
    const { polish, dispatch } = setupPolish({ personaBasePrompt: '简洁克制的顾问口吻' });

    dispatch({ type: 'polish_input', text: '这段需要润色' });
    await vi.waitFor(() => expect(polish).toHaveBeenCalled());

    expect(polish).toHaveBeenCalledWith('这段需要润色', undefined, '简洁克制的顾问口吻');
  });

  it('无激活角色包 → 第三参 undefined（内核走历史 prompt）', async () => {
    const { polish, dispatch } = setupPolish(null);

    dispatch({ type: 'polish_input', text: '这段需要润色' });
    await vi.waitFor(() => expect(polish).toHaveBeenCalled());

    expect(polish).toHaveBeenCalledWith('这段需要润色', undefined, undefined);
  });

  it('角色包存在但无 persona → 不伪造风格文本', async () => {
    const { polish, dispatch } = setupPolish({});

    dispatch({ type: 'polish_input', text: '这段需要润色' });
    await vi.waitFor(() => expect(polish).toHaveBeenCalled());

    expect(polish).toHaveBeenCalledWith('这段需要润色', undefined, undefined);
  });

  it('成功回执仍走既有 polish_input_result（风格注入不改回执形状）', async () => {
    const { posted, dispatch } = setupPolish({ personaBasePrompt: '精炼风格' });

    dispatch({ type: 'polish_input', text: '这段需要润色' });
    await vi.waitFor(() =>
      expect(posted.some((m) => (m as { type: string }).type === 'polish_input_result')).toBe(true),
    );

    expect(posted).toContainEqual({
      type: 'polish_input_result',
      ok: true,
      text: '润色后',
    });
  });
});
