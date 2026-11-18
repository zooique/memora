/**
 * 「添加到助手」命令接线回归（ADDED-TO-ASSISTANT-1）
 *
 * 钉住三条判据（验证的是**接线**，解析链已由 addToChat.test 覆盖，不重复）：
 *   ① 注册命令 id = memora.addToAssistant（package.json 声明 ↔ 注册面守卫另管）；
 *   ② 触发后先聚焦 memora.openHosted（用户拍板「自动打开助手页」），文本引用投
 *      hostedPanel.attachRefs，不碰侧栏 pushRefs；
 *   ③ 真图回执定向到助手会话 id（getAssistantSessionId），不串侧栏。
 * node 环境 + 显式 mock（本文件无 DOM）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSuiteTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { pngBytes } from '../../../__tests__/helpers/imageTestBytes.js';
import { registerAddToAssistantCommand } from '../../commands/addToAssistant.js';

const state = vi.hoisted(() => ({
  wsFolders: [] as Array<{ uri: { fsPath: string } }>,
  handlers: new Map<string, (uri: unknown) => Promise<void>>(),
}));

const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]) => {
  let out = msg;
  args.forEach((a, i) => {
    out = out.replaceAll(`{${i}}`, String(a));
  });
  return out;
});

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(), activeTextEditor: undefined },
  workspace: {
    get workspaceFolders() {
      return state.wsFolders;
    },
    fs: { stat: vi.fn(async () => ({ type: 1 })) },
    asRelativePath: vi.fn((u: { fsPath: string }) => u.fsPath),
  },
  commands: {
    executeCommand: vi.fn(async () => undefined),
    registerCommand: vi.fn((id: string, handler: (uri: unknown) => Promise<void>) => {
      state.handlers.set(id, handler);
      return { dispose: () => {} };
    }),
  },
  l10n: { t: tStub },
  FileType: { File: 1, Directory: 2 },
  env: { language: 'en' },
}));

const root = makeSuiteTempDir('memora-addtoasst-');
const uri = (rel: string) => ({ fsPath: join(root, rel) });
const relativeOf = (abs: string) =>
  abs
    .slice(root.length + 1)
    .split('\\')
    .join('/');

function makeDeps() {
  const chatProvider = {
    pushRefs: vi.fn(),
    pickAndAttachImages: vi.fn(),
    getAssistantSessionId: vi.fn((): string | undefined => 'assistant-1'),
  };
  const hostedPanel = { attachRefs: vi.fn() };
  return { chatProvider, hostedPanel };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.handlers.clear();
  state.wsFolders = [{ uri: { fsPath: root } }];
});

function registerAndGet(): (uri: unknown) => Promise<void> {
  const { chatProvider, hostedPanel } = makeDeps();
  registerAddToAssistantCommand(
    { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never,
    chatProvider as never,
    hostedPanel as never,
  );
  return state.handlers.get('memora.addToAssistant')!;
}

describe('registerAddToAssistantCommand — 自动打开 + 助手定向投递', () => {
  it('注册 memora.addToAssistant 命令', () => {
    registerAndGet();
    expect(state.handlers.has('memora.addToAssistant')).toBe(true);
  });

  it('文本文件 → 先开助手页，引用投 hostedPanel.attachRefs，不碰侧栏 pushRefs', async () => {
    const { chatProvider, hostedPanel } = makeDeps();
    registerAddToAssistantCommand(
      { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never,
      chatProvider as never,
      hostedPanel as never,
    );
    const txt = uri('note.md');
    writeFileSync(txt.fsPath, '# hi');

    await state.handlers.get('memora.addToAssistant')!(txt);

    const vscodeMod = await import('vscode');
    expect(vscodeMod.commands.executeCommand).toHaveBeenCalledWith('memora.openHosted');
    expect(vscodeMod.commands.executeCommand).not.toHaveBeenCalledWith('memora.chat.focus');
    expect(hostedPanel.attachRefs).toHaveBeenCalledWith([
      { path: relativeOf(txt.fsPath), kind: 'file' },
    ]);
    expect(chatProvider.pushRefs).not.toHaveBeenCalled();
  });

  it('真图 → 回执定向到助手会话 id（IMAGE-TARGET-1），非无目标侧栏投递', async () => {
    const { chatProvider, hostedPanel } = makeDeps();
    registerAddToAssistantCommand(
      { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never,
      chatProvider as never,
      hostedPanel as never,
    );
    const img = uri('real.png');
    writeFileSync(img.fsPath, pngBytes(4, 4));

    await state.handlers.get('memora.addToAssistant')!(img);

    expect(chatProvider.pickAndAttachImages).toHaveBeenCalledWith([img.fsPath], 'assistant-1');
    expect(hostedPanel.attachRefs).not.toHaveBeenCalled();
  });

  it('空态（助手会话未建）→ 真图按既有兜底：目标 id 为空，不伪造会话', async () => {
    const { chatProvider, hostedPanel } = makeDeps();
    chatProvider.getAssistantSessionId.mockReturnValue(undefined);
    registerAddToAssistantCommand(
      { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never,
      chatProvider as never,
      hostedPanel as never,
    );
    const img = uri('empty.png');
    writeFileSync(img.fsPath, pngBytes(4, 4));

    await state.handlers.get('memora.addToAssistant')!(img);

    expect(chatProvider.pickAndAttachImages).toHaveBeenCalledWith([img.fsPath], undefined);
    expect(chatProvider.pickAndAttachImages.mock.calls[0]!.length).toBe(2);
    expect(hostedPanel.attachRefs).not.toHaveBeenCalled();
  });
});
