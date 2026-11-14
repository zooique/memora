/**
 * 开活范围声明 · 规范化与重叠判定（纯函数，判据单点）
 *
 * 背景（判据 4 · 声明式范围互斥）：托管不改变自助模式的属性——自助会话本来就能并行干活，
 * 宿主不得把「同时只许一条活」强加给用户。宿主只做一件事：**开活前要求声明打算动哪些路径**，
 * 与当前在跑的活的声明范围有交集就拒绝派发，由代理自己决定排队还是缩小范围。
 *
 * 本模块只做「字符串 → 可比较的路径」与「两份声明有没有交集」，不领锁、不管生命周期、
 * 不处理死锁（那是串行闸方案，已撤回）。
 *
 * 规范化口径（必须与工具描述一致）：
 *   - 相对仓库根；绝对路径若落在仓库内会被截成相对路径；
 *   - 分隔符统一为 `/`；
 *   - 去掉 `./` 前缀、折叠重复 `/`、去掉尾部 `/`；
 *   - 统一小写（Windows 工作区大小写不敏感，`A` 与 `a` 是同一处）；
 *   - `.` / 空串 = 整仓（根），与任何路径都重叠。
 */

/**
 * 单条声明路径的规范化
 *
 * @param raw 模型给的原始路径（可能带 `./`、反斜杠、绝对盘符、尾部斜杠）
 * @param repoRoot 仓库根绝对路径（可选；给了才能把绝对路径截成相对）
 * @returns 规范化后的相对路径；`''` = 整仓
 */
export function normalizeScopePath(raw: string, repoRoot?: string): string {
  let path = raw.trim().replace(/\\/g, '/');
  // 绝对路径落在仓库内 → 截成相对路径（仓库外的不动，避免误判成「整仓」）
  if (repoRoot) {
    const root = repoRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (path.toLowerCase().startsWith(`${root}/`)) {
      path = path.slice(root.length + 1);
    }
  }
  // 去掉 `./` 前缀（可能重复出现），折叠重复分隔符，去掉尾部斜杠
  path = path
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  // `.` / 空串 = 整仓
  if (path === '' || path === '.') return '';
  return path.toLowerCase();
}

/**
 * 一组声明路径的规范化（去重，保持声明顺序）
 *
 * @param raw 原始列表
 * @param repoRoot 仓库根（可选）
 * @returns 规范化后的路径列表
 */
export function normalizeScopePaths(raw: readonly string[], repoRoot?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const normalized = normalizeScopePath(item, repoRoot);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** 两处路径的交集结果（用于把「撞在哪」回给代理） */
export interface ScopeOverlap {
  /** 本次想动的路径（规范化后；`''` 显示为 `.`） */
  requested: string;
  /** 对方已声明的路径（规范化后；`''` 显示为 `.`） */
  declared: string;
}

/**
 * 判断两份声明范围是否有交集
 *
 * 交集判据 = 完全相同，或一方是另一方的目录祖先（按路径段边界比较，
 * `src/a` 不会误判成 `src/ab` 的祖先）。整仓（`''`）与任何路径都重叠。
 *
 * @param requested 本次想动的路径（已规范化）
 * @param declared 对方已声明的路径（已规范化）
 * @returns 第一处交集；无交集返回 undefined
 */
export function findScopeOverlap(
  requested: readonly string[],
  declared: readonly string[],
): ScopeOverlap | undefined {
  for (const mine of requested) {
    for (const theirs of declared) {
      if (mine === '' || theirs === '' || mine === theirs) {
        return { requested: mine || '.', declared: theirs || '.' };
      }
      // 目录祖先：按段边界比，避免 `src/a` 命中 `src/ab`
      if (mine.startsWith(`${theirs}/`) || theirs.startsWith(`${mine}/`)) {
        return { requested: mine, declared: theirs };
      }
    }
  }
  return undefined;
}
