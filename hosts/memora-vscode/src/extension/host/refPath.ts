/**
 * refPath — 引用路径的**根归属解析**（宿主侧，纯函数可单测）
 *
 * ⚠️ **为什么不能直接用 `vscode.workspace.asRelativePath`**：它相对的是**「该 uri 所在的根」**
 * （多根工作区下选包含它的那一根），而内核 `read_file` 的 cwd、宿主 `openRefInEditor` 与
 * `resolveWorkspacePath` 都恒取 `workspaceFolders[0]` ⇒ 直接用 asRelativePath 生成引用路径，
 * 会在**第二根**下产出「chip 看着完全正常、模型却按首根读到同名路径（不存在即 FILE_NOT_FOUND）」
 * 的撒谎指针。故根归属判据必须以**首根**为唯一基准；不在首根下即 fail-closed（返回 undefined），
 * 由调用方拒绝挂载——挂一条注定读错的指针，比不挂更坏。
 *
 * 入参收窄为纯字符串（无 vscode 依赖）⇒ 可单测、webview 侧无需引用。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 目标绝对路径在**首根**下的相对路径（统一 POSIX 分隔）；不在首根下（或跨盘 / 根为空）返回 undefined
 *
 * @param rootFsPath 首个工作区根的绝对路径（`workspaceFolders[0].uri.fsPath`）
 * @param targetFsPath 目标绝对路径（`uri.fsPath`）
 * @returns 根内相对路径（如 `sub/x.md`）；目标即根自身、越出根、跨盘时 undefined
 */
export function relativeUnderPrimaryRoot(
  rootFsPath: string,
  targetFsPath: string,
): string | undefined {
  if (!rootFsPath || !targetFsPath) return undefined;
  const rel = relative(rootFsPath, targetFsPath);
  // 空串 = 目标即根自身（引用根自身无意义）；`..` 开头或成绝对路径 = 越出首根
  // （Windows 跨盘时 relative 直接回退成目标绝对路径，故 isAbsolute 一并兜住）
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  // 统一 POSIX 分隔：引用路径跨平台一致（内核 read_file 与信封均按 `/` 语义解析）
  return rel.split(sep).join('/');
}

/**
 * 引用相对路径 → 首根下的绝对路径（**消费侧**：`openRefInEditor` 用，与生成侧同一模块）
 *
 * 为什么消费侧不能各写一套守卫：`ref.path` 由 webview 回传，等于一条「打开任意文件」的上行
 * 通道，必须校验；而「什么算合法引用路径」的判据与生成侧（{@link relativeUnderPrimaryRoot}）
 * 是**同一契约的两半**——分居两个模块必然漂移（本仓血训：措辞折叠 / 第二真理源）。故收口在此：
 * ① 形态守卫拒绝对路径与 `..` 段；② 解析后用**生成侧同一谓词**做包含性复核；
 * ③ **规范形往返校验**——解析结果再投影回首根必须与输入逐字一致。生成侧只产这一种规范形
 * （POSIX 分隔、无冗余段），非规范形（`docs//x.md`、尾斜杠）即使能解析也拒，防止 chip 键
 * 与信封路径出现第二形态。
 *
 * @param rootFsPath 首个工作区根的绝对路径（`workspaceFolders[0].uri.fsPath`）
 * @param relPath 引用相对路径（chip / 信封里存的规范形）
 * @returns 首根下的绝对路径；越界、非规范形、空入参时 undefined（调用方走 notice 拒开）
 */
export function resolveUnderPrimaryRoot(rootFsPath: string, relPath: string): string | undefined {
  if (!rootFsPath || !relPath) return undefined;
  // 形态守卫：绝对路径（含 Windows 盘符 / UNC）/ 任何 `..` 段一律不解析
  if (isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) return undefined;
  const abs = resolve(rootFsPath, relPath);
  // 包含性 + 规范形复核：再投影回首根的结果必须与输入逐字一致（生成侧唯一规范形）
  if (relativeUnderPrimaryRoot(rootFsPath, abs) !== relPath) return undefined;
  return abs;
}
