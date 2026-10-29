/**
 * 右键「添加到对话」命令（`commands/addToChat.ts`）单元测试
 *
 * 被测核心 = IMG-12 接管分支的路由判据：**真图不挂引用，改走图片摄取执行面**；
 * 文本 / 假图（扩展名骗人）仍走挂引用。图片真伪判据本身归 `refImageGuard.test.ts`
 * （纯函数，已覆盖四种真格式头与变异）；此处用**真 PNG 字节**走通命令层的路由编排。
 *
 * mock 面取最小集：addToChat 只碰 `workspace.workspaceFolders / fs.stat / asRelativePath`、
 * `window.showWarningMessage / activeTextEditor`、`commands.executeCommand` 六个成员；
 * node 环境 + 显式 mock（jsdom 下 vi.mock('vscode') 失效的既有坑不适用——本文件无 DOM）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeSuiteTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { pngBytes } from '../../../__tests__/helpers/imageTestBytes.js';
import { addToChatCommand } from '../../commands/addToChat.js';

/** 可变状态容器：workspaceFolders 由各用例按需改写（factory 用 getter 取活值） */
const state = vi.hoisted(() => ({ wsFolders: [] as Array<{ uri: { fsPath: string } }> }));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    get workspaceFolders() {
      return state.wsFolders;
    },
    fs: { stat: vi.fn(async () => ({ type: 1 })) }, // 1 = FileType.File
    asRelativePath: vi.fn((u: { fsPath: string }) => u.fsPath),
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
  FileType: { File: 1, Directory: 2 },
}));

const root = makeSuiteTempDir('memora-addtochat-');

/** 构造被测 chatProvider 替身：只声明本命令真正消费的两个投递面 */
function makeProvider() {
  return { pushRefs: vi.fn(), pickAndAttachImages: vi.fn() };
}

/** 造指向 root 下相对路径的 vscode.Uri 形替身（本命令只读 fsPath） */
const uri = (rel: string) => ({ fsPath: join(root, rel) });

function relativeOf(abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

beforeEach(() => {
  vi.clearAllMocks(); // 只清调用记录，不动 factory 内联实现（asRelativePath 等保持可用）
  state.wsFolders = [{ uri: { fsPath: root } }];
});

describe('addToChatCommand — IMG-12 真图接管', () => {
  it('右键真图 → 不挂引用，直入图片摄取执行面（fsPath 投递）', async () => {
    const img = uri('real.png');
    writeFileSync(img.fsPath, pngBytes(4, 4));
    const provider = makeProvider();

    await addToChatCommand(img as never, provider as never);

    expect(provider.pickAndAttachImages).toHaveBeenCalledTimes(1);
    expect(provider.pickAndAttachImages.mock.calls[0]![0]).toEqual([img.fsPath]);
    expect(provider.pushRefs).not.toHaveBeenCalled();
  });

  it('主根外真图照常导入（摄取是自足副本，不需要主根归属）', async () => {
    const provider = makeProvider();
    const outside = makeSuiteTempDir('memora-addtochat-out-');
    const imgPath = join(outside, 'outside.png');
    writeFileSync(imgPath, pngBytes(4, 4));

    await addToChatCommand({ fsPath: imgPath } as never, provider as never);

    expect(provider.pickAndAttachImages).toHaveBeenCalledWith([imgPath]);
    expect(provider.pushRefs).not.toHaveBeenCalled();
  });

  it('扩展名骗人（.png 装文本）→ 字节嗅探判非图 → 照旧挂引用、不进摄取面', async () => {
    const provider = makeProvider();
    const fake = uri('fake.png');
    writeFileSync(fake.fsPath, Buffer.from('plain text, not an image'));

    await addToChatCommand(fake as never, provider as never);

    expect(provider.pickAndAttachImages).not.toHaveBeenCalled();
    expect(provider.pushRefs).toHaveBeenCalledTimes(1);
    expect(provider.pushRefs.mock.calls[0]![0]).toEqual([
      { path: relativeOf(fake.fsPath), kind: 'file' },
    ]);
  });

  it('混合多选（真图 + 文本文件）→ 两路各自投递，聚焦命令只执行一次', async () => {
    const provider = makeProvider();
    const img = uri('mix.png');
    const txt = uri('note.md');
    writeFileSync(img.fsPath, pngBytes(4, 4));
    writeFileSync(txt.fsPath, '# hello');

    await addToChatCommand([img, txt] as never, provider as never);

    expect(provider.pickAndAttachImages).toHaveBeenCalledWith([img.fsPath]);
    expect(provider.pushRefs).toHaveBeenCalledTimes(1);
    const vscodeMod = await import('vscode');
    expect(vscodeMod.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscodeMod.commands.executeCommand).toHaveBeenCalledWith('memora.chat.focus');
  });
});
