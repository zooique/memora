/**
 * refProbe — 引用文件的**发送前存在性核实**（宿主侧，stat 注入式、可单测）
 *
 * 动机（HOST-CTX-9 发送侧）：用户在发送前把文件「添加到对话」，此后该文件被删 / 改名——
 * 信封里的引用行便成了一条**死指针**：模型按它 read_file 必然失败，却不知道原因，只能误判
 * 「读不到是文件不存在还是我读错了」。发送前对每条文件引用做一次存在性核实，失效者降级为
 * 「裸指针 + 标记」（见 docContext.refItemLine），把死指针变成**模型可读事实**。
 *
 * SSOT：相对路径 → 首根绝对路径的**唯一解析器** = refPath.resolveUnderPrimaryRoot（纯字符串、
 * 已被 openRefInEditor 消费）。本模块**复用**它、不自写解析与越界守卫，避免出现第二真理源。
 *
 * 边界（刻意不做）：
 *   - 目录引用不检测（存在性语义由模型经 list_dir 自行发现）；
 *   - 「当前打开文件」指针行不检测（来自活动编辑器，实体必存在）。
 */
import type { ChatRef } from '../../shared/protocol.js';
import { resolveUnderPrimaryRoot } from './refPath.js';

/**
 * 收集「发送前已不存在」的文件引用路径（相对首根规范形，与引用行同形）
 *
 * 判据：`kind === 'file'` 的引用，经首根解析后 `stat` 未命中（抛错）即为失效。
 * 解析失败（越界 / 非规范形）同样计入——一条解析不出绝对路径的引用对模型而言与死指针无异。
 *
 * @param refs 本轮要挂进信封的引用
 * @param rootFsPath 首个工作区根的绝对路径（`workspaceFolders[0].uri.fsPath`）；空 / 未打开
 *   工作区 ⇒ 返回空集合（无基准时不臆造失效）
 * @param stat 存在性检测器（注入式：生产用 `vscode.workspace.fs.stat`，测试用桩）。
 *   实现须「未命中即抛错」——本模块只以**是否抛错**判定存在性，不解读返回的 stat 形态
 *   （用 async `workspace.fs.stat` 而非 node `statSync`：异步不阻塞、兼容远程 / 虚拟 FS）
 * @returns 失效文件引用的**规范相对路径**集合（可直接 `has` 命中引用行）
 */
export async function collectMissingFileRefPaths(
  refs: readonly ChatRef[],
  rootFsPath: string | undefined,
  stat: (absPath: string) => Promise<unknown>,
): Promise<Set<string>> {
  const missing = new Set<string>();
  if (!rootFsPath) return missing;
  const fileRefs = refs.filter((r) => r.kind === 'file');
  if (fileRefs.length === 0) return missing;
  // 并发核实：引用数通常个位数，Promise.all 无并发风险，却避免串行 stat 的往返累积。
  await Promise.all(
    fileRefs.map(async (ref) => {
      const abs = resolveUnderPrimaryRoot(rootFsPath, ref.path);
      if (!abs) {
        // 解析失败（越出首根 / 非规范形）⇒ 同样计入：模型拿不到可读的绝对路径即等同死指针
        missing.add(ref.path);
        return;
      }
      try {
        await stat(abs);
      } catch {
        missing.add(ref.path);
      }
    }),
  );
  return missing;
}
