/**
 * 命令：添加到对话（右键文件/目录 → 把引用挂到输入盒上方气泡）
 *
 * 仅挂路径与形态，不注入内容——内容由模型按需经 read_file 读取，贴合 token 预算哲学。
 *
 * 从 extension.ts 外置而来（零行为变更）：路径归属判据、选区行区间与提示文案逐字保留。
 *
 * ## G2：图片一律拒挂（方案 §4.1）
 * 本命令的契约是「挂路径，模型自己 `read_file`」，而内核 `read_file` 只按 `utf-8` 读
 * （方案 F18）⇒ 图片必然被解码损坏**且不报错**。故识别为真图就拒挂并给出路，
 * 判据与实现见 `host/refImageGuard.ts`。
 */
import { open, type FileHandle } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ChatRef } from '../../shared/protocol.js';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import { relativeUnderPrimaryRoot } from '../host/refPath.js';
import { hasImageExtension, isRefTargetImage } from '../host/refImageGuard.js';
import { selectionToRefRange } from '../host/selectionRange.js';

/** 图片嗅探所需的头部字节数（最短合法格式 12 字节，此处留余量） */
const SNIFF_HEAD_BYTES = 64;

/**
 * 把文件/目录引用挂到对话输入区
 *
 * @param uri 右键菜单传入的目标（文件 / 目录 / 多选数组 / 命令面板调用时为 undefined）
 * @param chatProvider 对话视图提供者（引用投递面；未聚焦时 pushRefs 会缓冲到 ready 补发）
 */
export async function addToChatCommand(
  uri: vscode.Uri | vscode.Uri[] | undefined,
  chatProvider: MemoraChatViewProvider,
): Promise<void> {
  // 仅支持从右键菜单触发（必须带 uri 参数）；Explorer 多选返回 uri 数组
  const uris = Array.isArray(uri) ? uri : uri ? [uri] : [];
  if (uris.length === 0) {
    vscode.window.showWarningMessage('请在文件或目录上右键，选择「Memora: 添加到对话」');
    return;
  }
  // 根归属：引用路径必须以**首个工作区根**为基准（内核 read_file cwd / openRefInEditor 同源）。
  // 不用 asRelativePath——它相对「所在根」，多根工作区下会产出「chip 正常、模型却按首根读到
  // 同名路径（不存在即 FILE_NOT_FOUND）」的撒谎指针；不在首根下的目标 fail-closed（拒挂 + 提示），
  // 挂一条注定读错的指针比不挂更坏。
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // 逐个判定 file/folder（stat type），算相对路径；stat 失败（如已删除）按 file 兜底
  const refs: ChatRef[] = [];
  const skippedOutsideRoot: string[] = [];
  // G2：真图不挂引用（模型读不到），收集后统一给出路
  const skippedImages: string[] = [];
  // 编辑器选区（仅「右键目标 = 当前编辑器文件」且非折叠选区时才带行区间）
  const editor = vscode.window.activeTextEditor;
  const sel = editor?.selection;
  for (const u of uris) {
    const rel = root ? relativeUnderPrimaryRoot(root, u.fsPath) : undefined;
    if (!rel) {
      // 不在主根下（含未打开工作区 / 跨盘 / 第二个根）：整条拒绝
      skippedOutsideRoot.push(vscode.workspace.asRelativePath(u));
      continue;
    }
    let kind: 'file' | 'folder' = 'file';
    try {
      const stat = await vscode.workspace.fs.stat(u);
      if (stat.type === vscode.FileType.Directory) kind = 'folder';
    } catch {
      // 保持 file 兜底（相对路径仍可用）
    }
    // G2：只对疑似图片读文件头（预筛的唯一目的是省读盘开销），真伪由字节嗅探定。
    if (kind === 'file' && hasImageExtension(u.fsPath)) {
      const head = await readHeadBytes(u.fsPath);
      if (isRefTargetImage(u.fsPath, head)) {
        skippedImages.push(vscode.workspace.asRelativePath(u));
        continue;
      }
    }
    const ref: ChatRef = { path: rel, kind };
    const isActiveFile = !!editor && editor.document.uri.fsPath === u.fsPath;
    if (kind === 'file' && isActiveFile && sel) {
      // 基准转换 + 空尾行边界都收在 selectionToRefRange 内（纯函数，可单测）
      const range = selectionToRefRange(sel);
      if (range) ref.range = range;
    }
    refs.push(ref);
  }
  if (skippedOutsideRoot.length > 0) {
    vscode.window.showWarningMessage(
      `以下项不在主工作区根下，未挂引用：${skippedOutsideRoot.join('、')}`,
    );
  }
  if (skippedImages.length > 0) {
    vscode.window.showWarningMessage(
      `图片不能这样添加（模型读不到图片内容）：${skippedImages.join('、')}。请改用命令「Memora: 添加图片」，或粘贴 / 上传按钮。`,
    );
  }
  if (refs.length === 0) return; // 全部被拒：不聚焦面板、不挂空引用
  // 先确保对话面板可见（未聚焦时 pushRefs 缓冲到 ready 后补发，与 prefillInput 同构）
  await vscode.commands.executeCommand('memora.chat.focus');
  chatProvider.pushRefs(refs);
}

/**
 * 读文件头（只取前 `SNIFF_HEAD_BYTES` 字节）供图片嗅探
 *
 * 为什么走 `node:fs` 而不是 `vscode.workspace.fs`：后者没有「只读前 N 字节」的能力，
 * 而引用目标的体积**不受采集链限制**（一张 2 GB 的图也会走到这里）——整份读进内存
 * 不可接受。资源管理器右键的目标恒为本地文件（`file` scheme），故两套读法不冲突。
 *
 * @returns 头部字节；读不到（权限 / 已删 / 非本地 scheme）返回 `undefined`，
 *   由调用方按「非图片」放行——不因一次读盘失败新增一条拒挂路径。
 */
async function readHeadBytes(fsPath: string): Promise<Uint8Array | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(fsPath, 'r');
    const buf = Buffer.alloc(SNIFF_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_HEAD_BYTES, 0);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
