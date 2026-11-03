/**
 * 用户资产（技能 / 角色包）名字净化与写入路径解析（宿主写入用户的唯一判据面）。
 *
 * 为什么单独成模块：任何「把用户给的名字变成一个落在用户目录内的路径」的入口
 * （压缩包导入 / 对话写入的安装窄口）都要回答同一个问题。若各写一份正则与逃逸断言，
 * 两份判据从落笔那一刻起就会漂移（其中一个漏掉 `..` 或绝对路径），且没有任何测试会红。
 *
 * 硬约束：本模块只做**判据**与**路径推导**，不碰 SecurityGuard / allowedPaths，
 * 也不做任何写入。
 *
 * ## 模块边界（`userAssets/`）
 *   - 本文件 = 名字净化 / 路径推导 / 逃逸断言 / 路径归属判定，**零写入**；
 *   - `zipImport.ts` = **唯一的资产建仓执行面**（读包 → 校验 → 暂存 → 换名提交；
 *     项目级 → 用户级的「添加到用户级」复制也在这里，复用同一提交原语）；
 *   - `validateSkill.ts` = 技能格式校验，**只校验、不落盘**（被 `zipImport` 复用）；
 *   - `projectScope.ts` = 项目级目录推导与信任门单点。
 *
 * **不要再往本目录加写盘函数**：LLM 的正常工具路径只写项目 `.memora/` 下的资产
 * （宿主不再把用户目录注入 `allowedPaths`），用户级资产一律由宿主经
 * `zipImport.ts` 的暂存 / 备份 / 换名事务装载。宿主若再留第二套写盘器，就是两条覆盖语义
 * （且 `pathExists` → `writeFile` 还有 TOCTOU），从落笔那一刻起必然分叉。
 */

import { resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';

/**
 * 用户资产名字合法性正则：中文 / 字母 / 数字 / 下划线 / 连字符，1-64 字符。
 *
 * 不含 `.`、`/`、`\`、`:`：既排除 `..` 与路径分隔符，也排除 Windows 盘符与绝对路径；
 * 中文允许是因为技能名常以中文书写（如「资料整理」），且内核按 frontmatter 名寻址。
 */
export const USER_ASSET_NAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,64}$/;

/** 名字净化结果：ok=true 带净化后名字，否则带拒绝原因（原因直接进用户提示） */
export type SanitizeResult = { ok: true; name: string } | { ok: false; reason: string };

/**
 * 净化用户输入的名字（所有写入入口的唯一判据）
 *
 * @param raw 用户原始输入（可能带首尾空格）
 * @returns 通过时返回 trim 后的名字；拒绝时给出可读原因
 */
export function sanitizeAssetName(raw: string): SanitizeResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: '名字不能为空' };
  }
  // 首尾空格不再静默 trim 后放行：用户以为名字含空格，落盘却不同名，属隐式改写
  if (trimmed !== raw) {
    return { ok: false, reason: '名字首尾不得有空格' };
  }
  if (!USER_ASSET_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      reason:
        '名字只能包含中文、字母、数字、下划线、连字符（最长 64 字符），不得含路径分隔符、.. 或首尾空格',
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * 在根目录内解析一个子路径，并断言**未逃出根目录**（最终路径逃逸的唯一防线）。
 *
 * 判据：`path.resolve(root, segment)` 的结果必须以 `root + 分隔符` 开头。
 * 覆盖三类逃逸：`..` 上跳、绝对路径（resolve 直接丢弃 root）、盘符切换。
 *
 * @param root 用户资产根目录（如 globalStorage/skills）
 * @param segment 子路径片段（单文件形态传 `name.md`，目录形态传 `name`）
 */
export function resolveInsideDir(
  root: string,
  segment: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const safeRoot = resolve(root);
  const target = resolve(safeRoot, segment);
  if (!target.startsWith(safeRoot + sep)) {
    return { ok: false, reason: `写入路径越出用户目录：${target}` };
  }
  return { ok: true, path: target };
}

/**
 * 判定目标路径是否落在根目录**之内**（来源归属 / 内置包判定的唯一判据）
 *
 * 与 `resolveInsideDir` 同源：`resolve` 规范化后再比对 `root + sep` 前缀。
 * 只用字符串 `startsWith` 不带 `sep` 会把兄弟目录误判成子目录
 * （`role-packs-x` 被当成 `role-packs` 内），且 Windows 的 `\` 与 `/` 混用会漏判。
 *
 * @param root 归属根目录（如内置角色包目录）；undefined 视为「无根」⇒ 恒不在其中
 * @param target 待判定路径（如角色包装配得到的 filePath）；undefined 视为不在根内
 */
export function isPathWithin(root: string | undefined, target: string | undefined): boolean {
  if (!root || !target) return false;
  const safeRoot = resolve(root);
  return resolve(target).startsWith(safeRoot + sep);
}

/** 路径是否已存在（用于「同名已存在 ⇒ 拒绝覆盖」与「目标目录已存在 ⇒ 拒绝创建」） */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
