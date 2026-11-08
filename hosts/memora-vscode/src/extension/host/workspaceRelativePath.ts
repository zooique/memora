/**
 * workspaceRelativePath — 宿主侧「项目内相对路径生成」的**单点入口**（首根语义）
 *
 * 为什么必须单点：登记作品投影、右键「提升为项目规则」、QuickPick 管理面这三个入口
 * 都要把文件路径交给内核存成**chip / 清单里的相对路径**。路径一旦不一致，就会出现
 * 「chip 看着正常、模型按首根读到同名路径（不存在即 FILE_NOT_FOUND）」的撒谎指针。
 * 故生成侧只留这一份判据：所有入口必须调用 {@link toWorkspaceRelativePath}，
 * **禁止自行拼接相对路径，禁止 `vscode.workspace.asRelativePath`**（它相对「所在根」，
 * 多根工作区下第二根会产出撒谎指针）。
 *
 * 分层：
 * - 纯判据 {@link adjudicateWorkspaceRelativePath}（入参收窄为字符串，无 vscode 依赖 ⇒ 可单测）；
 * - 宿主包装 {@link toWorkspaceRelativePath}（只负责从 `workspaceFolders[0]` 取首根）。
 * 判据本体全部委托给 refPath 的 `relativeUnderPrimaryRoot` / `resolveUnderPrimaryRoot`，
 * 本模块**不复制任何路径规范化逻辑**（双真源）。
 *
 * 拒绝策略：非首根 / 越界 / 跨盘 / 非规范形一律返回**可读原因**，由调用方当场拒绝并提示；
 * 不静默截断成一个「能存下但读不到」的路径。
 */
import { isAbsolute, relative as pathRelative, resolve as pathResolve } from 'node:path';
import * as vscode from 'vscode';
import { relativeUnderPrimaryRoot, resolveUnderPrimaryRoot } from './refPath.js';

/**
 * 拒绝原因码（调用方据此分支；新增原因必须同步下方 message 映射）
 *
 * - `no-workspace`：未打开任何工作区文件夹（无首根）
 * - `empty-target`：目标路径为空
 * - `non-canonical`：非规范形（含 `.` / `..` 段，或无法按首根往返还原）
 * - `is-root-itself`：目标就是首根本身（不是可登记的文件）
 * - `cross-drive`：与首根不在同一盘符（Windows）
 * - `outside-primary-root`：在首根之外（含多根工作区的第二根）
 */
export type WorkspacePathRejectReason =
  | 'no-workspace'
  | 'empty-target'
  | 'non-canonical'
  | 'is-root-itself'
  | 'cross-drive'
  | 'outside-primary-root';

/**
 * 判据结果：成功给出首根相对路径（POSIX 分隔）；失败给出原因码 + 可读文案
 */
export type WorkspaceRelativePathResult =
  { ok: true; relPath: string } | { ok: false; reason: WorkspacePathRejectReason; message: string };

/** 原因码 → 用户可读文案（统一在这里，避免各入口各写一套说法） */
const REJECT_MESSAGES: Record<WorkspacePathRejectReason, string> = {
  'no-workspace': '未打开工作区，无法生成项目内相对路径',
  'empty-target': '目标路径为空',
  'non-canonical': '路径不是规范形（不可含 . 或 .. 段），请使用规范的绝对路径',
  'is-root-itself': '目标是工作区根自身，不是可登记的文件',
  'cross-drive': '目标与首个工作区根不在同一盘符，无法生成相对路径',
  'outside-primary-root': '目标不在首个工作区根下（多根工作区下仅支持首根）',
};

/**
 * 构造失败结果（原因码 + 统一文案）
 *
 * @param reason 原因码
 * @returns 失败结果对象
 */
function reject(reason: WorkspacePathRejectReason): WorkspaceRelativePathResult {
  return { ok: false, reason, message: REJECT_MESSAGES[reason] };
}

/**
 * 纯判据：首根绝对路径 + 目标绝对路径 → 首根相对路径 / 拒绝原因
 *
 * 判据顺序固定（顺序反了文案就会撒谎）：
 * ① 无首根 → ② 空目标 → ③ 非规范形（含 `.`/`..` 段，拒绝而非静默归一化）→
 * ④ `relativeUnderPrimaryRoot` 判包含性 → ⑤ 失败时区分「根自身 / 跨盘 / 其它越界」→
 * ⑥ 规范形往返（`resolveUnderPrimaryRoot` 必须能还原，防生成侧出现第二形态）。
 *
 * @param rootFsPath 首个工作区根绝对路径（`workspaceFolders[0]?.uri.fsPath`）
 * @param targetFsPath 目标绝对路径（`uri.fsPath`）
 * @returns 首根内 → `{ ok: true, relPath }`；否则 `{ ok: false, reason, message }`
 */
export function adjudicateWorkspaceRelativePath(
  rootFsPath: string | undefined,
  targetFsPath: string,
): WorkspaceRelativePathResult {
  // ① 无工作区：没有基准根，任何相对路径都无从谈起
  if (!rootFsPath) return reject('no-workspace');
  // ② 空目标：调用方传了空串（多为 uri 缺失），直接拒
  if (!targetFsPath) return reject('empty-target');

  // ③ 非规范形：`. / ..` 段不静默归一化——归一化后「能存下」的路径可能并非用户所指
  //    （也杜绝借 `..` 绕出首根后再被 relative 抹平的写法）
  const segments = targetFsPath.split(/[\\/]+/);
  if (segments.includes('.') || segments.includes('..')) return reject('non-canonical');

  // ④ 包含性判据（首根语义的唯一实现，见 refPath）
  const relPath = relativeUnderPrimaryRoot(rootFsPath, targetFsPath);
  if (relPath === undefined) {
    // ⑤ 细分失败原因：根自身 / 跨盘 / 其它越界（三者文案不同，用户才知道该改什么）
    const resolvedRoot = pathResolve(rootFsPath);
    const resolvedTarget = pathResolve(targetFsPath);
    if (resolvedTarget === resolvedRoot) return reject('is-root-itself');
    // Windows 跨盘时 path.relative 会回退成目标绝对路径（isAbsolute 为真）
    if (isAbsolute(pathRelative(resolvedRoot, resolvedTarget))) return reject('cross-drive');
    return reject('outside-primary-root');
  }

  // ⑥ 规范形往返：生成侧只允许一种形态（POSIX 分隔、无冗余段），消费侧必须能逐字还原
  if (resolveUnderPrimaryRoot(rootFsPath, relPath) === undefined) return reject('non-canonical');

  return { ok: true, relPath };
}

/**
 * 宿主包装：目标 Uri → 首根相对路径 / 拒绝原因
 *
 * **所有需要生成「项目内相对路径」的入口都必须调用本函数**（登记作品投影 / 右键
 * 「提升为项目规则」/ QuickPick 管理面）。新入口**禁止**自行拼接相对路径，也**禁止**
 * 使用 `vscode.workspace.asRelativePath`（多根工作区下会产出模型读不到的撒谎指针）。
 *
 * @param target 目标文件 / 目录的 Uri
 * @returns 首根内 → 相对路径；否则带可读原因的失败结果（调用方当场拒绝并提示）
 */
export function toWorkspaceRelativePath(target: vscode.Uri): WorkspaceRelativePathResult {
  // 首根唯一基准：与内核 read_file cwd / 宿主 openRefInEditor 同源（workspaceFolders[0]）
  const rootFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return adjudicateWorkspaceRelativePath(rootFsPath, target.fsPath);
}
