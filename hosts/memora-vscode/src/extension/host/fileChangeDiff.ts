/**
 * 逐行差异计算（纯逻辑 · 零 vscode 依赖）
 *
 * 职责单一：给定「写前内容」与「写后内容」，产出可直接驱动**内联呈现**的改动块列表
 * —— 每一块覆盖「新文件中的行范围」并携带「该块被移除的旧行」（旧行只用于展示，
 * 新文件里已经不存在，不参与任何写回）。
 *
 * 为何单独成模块（而非塞进 fileChangeView）：
 *   - 它是本功能里唯一有算法含量的部分，必须能被纯 node 环境单测，
 *     不得与 `vscode` 模块产生 import 关系（宿主测试环境虽有 jsdom，但 vscode API 不可用）。
 *   - 呈现层（装饰 / CodeLens）只消费结果，换渲染方式不动算法。
 *
 * 算法：**前缀/后缀裁剪 + 行级 LCS**。
 *   - 裁剪：LLM 写文件多为局部改动，公共首尾摘掉后中间规模骤降（常见从数千行降到个位数）。
 *   - LCS：中间部分做最长公共子序列，回溯得到增/删交错的最小改动块，天然把
 *     「删 N 行 + 增 M 行」这类替换合并成**同一块**（walk 期间不 flush）。
 *   - 降级：中间行数超过 `MAX_LCS_LINES` 时放弃 LCS，退回「中间整体一块」，
 *     保证内存与耗时可控（DP 表为 O(n·m)）。
 *
 * ⚠️ 行数语义：空串按 **0 行** 处理（`''` → `[]`），与「空文件没有行」的直觉一致；
 * 否则 `''.split('\n')` 会得到 `['']`（1 个空行），使「清空文件」被误算成「保留 1 空行」。
 *
 * 块级动作（2026-09-27 加）：本模块除了「算差异」，还导出**块级回退原语**
 * —— 因为「把某一块还原成旧内容」本质是**行数组的区间替换**，与差异计算同源、同坐标系，
 * 放在这里才能被纯 node 单测；放到渲染层（fileChangeView）就既不可测又会与装饰各算一遍。
 *
 * ⚠️ **不维护「块存活集」**：接受/拒绝一块后**重算 diff** 即可，其余块坐标自动更新。
 * 关键推导（与 git 的 index 模型同构）：
 *   - 「拒绝一块」= 把 `after` 中该块换回旧行 ⇒ 写盘；
 *   - 「接受一块」= 把**基线**改成「当前内容剔除未接受的块」（= `applyHunkReverts(after, 其余块)`）
 *     ⇒ 该块在新 diff 中**自然消失**，不动盘、不记索引、不做坐标迁移。
 * 于是「接受完所有块 / 拒绝完所有块」都等价于 diff 为空 ⇒ 与文件级确认同一收口，无特判。
 *
 * @module fileChangeDiff
 */

/**
 * 参与 LCS 的最大中间行数（单边）。
 *
 * 1200 × 1200 的 `Uint32Array` 约 5.8 MB、回溯毫秒级；超过则整体降级，
 * 避免超大文件（如整库重写）把 DP 表撑爆。
 */
export const MAX_LCS_LINES = 1200;

/** 一个改动块（新文件坐标系） */
export interface DiffHunk {
  /** 新文件中的起始行（0-based，含）。纯删除块 = 删除位置（新文件中已无对应行） */
  startLine: number;
  /** 新文件中的结束行（0-based，含）。纯删除块 = `startLine - 1` */
  endLine: number;
  /** 该块从旧文件移除的行（**仅用于展示**，不写回） */
  removed: string[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  /** 是否因超出 `MAX_LCS_LINES` 而降级为「中间整体一块」 */
  degraded: boolean;
}

/**
 * 切行：空串 → 空数组（见模块注释的「行数语义」）
 */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** 纯删除块判据（新文件中没有覆盖任何行） */
export function isRemovedOnly(hunk: DiffHunk): boolean {
  return hunk.endLine < hunk.startLine;
}

/**
 * 改动块在新文件中的**锚点行**（装饰 / CodeLens 的落点）
 *
 * 非删除块 = 块首行；纯删除块 = 删除位置（新文件中「原本该出现的位置」）。
 * 末尾越界统一 clamp 到末行，保证调用方拿到的行号一定可寻址。
 */
export function hunkAnchorLine(hunk: DiffHunk, afterLineCount: number): number {
  if (afterLineCount <= 0) return 0;
  return Math.min(Math.max(hunk.startLine, 0), afterLineCount - 1);
}

/**
 * 在已裁剪的中间段上跑 LCS 并回溯出改动块（行号为中间段局部坐标）
 */
function lcsHunks(midBefore: string[], midAfter: string[]): DiffHunk[] {
  const n = midBefore.length;
  const m = midAfter.length;
  const width = m + 1;
  // dp[i][j] = midBefore[i..] 与 midAfter[j..] 的 LCS 长度（后缀型，便于正向回溯）
  const dp = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => i * width + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[at(i, j)] =
        midBefore[i] === midAfter[j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  const open = (startLine: number): DiffHunk => ({ startLine, endLine: startLine - 1, removed: [] });

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midBefore[i] === midAfter[j]) {
      // 相同行：中断当前块（相邻的多个改动不会被并成一块，因为中间隔着公共行）
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      i += 1;
      j += 1;
      continue;
    }
    // 不同行：取「删除更优」或「新增更优」——都在同一块内累积，故「删 N + 增 M」自然合并
    if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      if (!cur) cur = open(j);
      cur.removed.push(midBefore[i]);
      i += 1;
    } else {
      if (!cur) cur = open(j);
      cur.endLine = j;
      j += 1;
    }
  }
  // 收尾：任一侧剩余的尾部改动并入当前块
  while (i < n) {
    if (!cur) cur = open(j);
    cur.removed.push(midBefore[i]);
    i += 1;
  }
  while (j < m) {
    if (!cur) cur = open(j);
    cur.endLine = j;
    j += 1;
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/**
 * FNV-1a 32 位指纹（非加密用途：只做「内容是否变了」的比对）
 *
 * 不用 `node:crypto` 的理由：本模块要保持**零依赖、跨平台纯逻辑**，而内容指纹只需抗碰撞
 * 到「改一个字符就变」的程度，sha1 是杀鸡用牛刀且要引入 node 内建模块。
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 块的**寻址指纹** = 位置 + 内容，二者都对上才动手
 *
 * 用途：CodeLens 的按钮在**渲染时**生成、在**点击时**消费，两次之间文件内容可能已变
 * （并行写同一文件、用户手改）。只传下标会在内容变动后**静默打错块**——回退是写盘动作，
 * 打错块 = 吃掉用户内容。故按钮携带本指纹，点击时按指纹重新定位：
 *   - 命中 ⇒ 执行；
 *   - 不命中 ⇒ **fail-closed**（不动盘、留痕、刷新按钮），绝不退化为「按下标猜一个」。
 *
 * ⚠️ 指纹**含行号**是刻意的：两处内容完全相同的插入（同一行插在两个位置）只靠内容无法区分，
 * 而它们的回退结果不同（删掉的上下文不同）。含行号后即无歧义。
 *
 * ⚠️ 分隔符写作 `\u0000` **转义**（保持源码纯 ASCII）：切行结果里不可能出现该字符，
 * 故 `removed` 与 `added` 的拼接无歧义。**勿写成裸 NUL 字节**——文件里出现裸 0x00 会让
 * git（首 8000 字节内即判二进制）与 ripgrep 把整个文件当二进制，diff 不可读、grep 静默失效。
 *
 * @param afterText 该块所属的「写后全文」（取块的新行内容用）
 */
export function hunkKey(hunk: DiffHunk, afterText: string): string {
  const lines = splitLines(afterText);
  const added = isRemovedOnly(hunk) ? [] : lines.slice(hunk.startLine, hunk.endLine + 1);
  return `${hunk.startLine}:${hunk.endLine}:${fnv1a(`${hunk.removed.join('\n')}\u0000${added.join('\n')}`)}`;
}

/**
 * 把指定块还原为旧内容，返回还原后的全文
 *
 * 每块 = 行数组上的一次**区间替换**：`[startLine..endLine]` 换成 `hunk.removed`。
 * 纯删除块（`endLine < startLine`）的区间长度为 0 ⇒ 退化为「在该位置插入旧行」，语义自洽。
 *
 * ⚠️ **多块必须按 `startLine` 降序处理**：先改后面的块，前面块的坐标才不受影响。
 * 升序处理会让第 2 块的行号因第 1 块的长度变化而错位 ⇒ 打错位置（且无报错，静默错）。
 *
 * @param afterText 写后全文
 * @param hunks 要还原的块（须出自 `computeFileDiff(afterText 的同一次计算)`）
 */
export function applyHunkReverts(afterText: string, hunks: readonly DiffHunk[]): string {
  if (hunks.length === 0) return afterText;
  const lines = splitLines(afterText);
  const ordered = [...hunks].sort((a, b) => b.startLine - a.startLine);
  for (const hunk of ordered) {
    const count = hunk.endLine - hunk.startLine + 1; // 纯删除块 = 0 ⇒ splice 退化为插入
    lines.splice(hunk.startLine, count, ...hunk.removed);
  }
  return lines.join('\n');
}

/**
 * 生成**统一视图（上下排列）**的改动对照文本
 *
 * 用途：给「查看对比」渲染一份只读文本——单列、全宽，改动前 / 改动后**上下排列**。
 * 起因（2026-09-27 真机反馈）：`vscode.diff` 的左右并排把长行挤成两个窄栏，**看不清原文**。
 *
 * 为何自渲染而不继续用 `vscode.diff`（**已实证**，勿回退猜测）：
 *   - VS Code 扩展 API **没有**「以 inline 布局打开 diff」的入口——`vscode.diff` 的第 4 个参数
 *     是 `TextDocumentShowOptions`（`override` 是编辑器解析用，取值是编辑器 id，不是布局）；
 *   - 布局只受两处影响：全局设置 `diffEditor.renderSideBySide`（改它 = 改用户配置，侵入），
 *     或命令面板的 **Toggle** Inline View（切换型，盲调会把用户的偏好翻反）；
 *   - ⇒ 想要「确定性地以上下排列呈现」，只能自己渲染文本。
 *
 * 复用 `computeFileDiff` 的同一份块数据（SSOT）：高亮、块按钮、本对照文本三者永不漂移。
 *
 * @param before 改动前全文
 * @param after  改动后全文
 * @param title  首行标题（调用方给文件名，便于在多标签间辨认）
 */
export function formatUnifiedDiff(before: string, after: string, title: string): string {
  const diff = computeFileDiff(before, after);
  const afterLines = splitLines(after);
  const out: string[] = [
    title,
    `共 ${diff.hunks.length} 处改动${diff.degraded ? '（改动过大，已按整体一块对照）' : ''}`,
  ];
  diff.hunks.forEach((hunk, index) => {
    const removedOnly = isRemovedOnly(hunk);
    const added = removedOnly ? [] : afterLines.slice(hunk.startLine, hunk.endLine + 1);
    // 纯删除块在新文件里不占行 ⇒ 只报「删除位置」；其余报实际行范围（1-based，给人看）
    const where = removedOnly
      ? `第 ${hunk.startLine + 1} 行之前（纯删除）`
      : hunk.startLine === hunk.endLine
        ? `第 ${hunk.startLine + 1} 行`
        : `第 ${hunk.startLine + 1}–${hunk.endLine + 1} 行`;
    out.push('', `──────── 改动 ${index + 1}/${diff.hunks.length} · 新文件${where} ────────`);
    // 旧行在前、新行在后：上下排列即「先看改前、再看改后」
    for (const line of hunk.removed) out.push(`- ${line}`);
    for (const line of added) out.push(`+ ${line}`);
  });
  return out.join('\n');
}

/**
 * 计算两个版本之间的改动块
 *
 * @param before 写前全文（`''` 表示文件原本不存在或为空）
 * @param after  写后全文（`''` 表示文件被清空）
 */
export function computeFileDiff(before: string, after: string): FileDiff {
  const b = splitLines(before);
  const a = splitLines(after);

  let prefix = 0;
  while (prefix < b.length && prefix < a.length && b[prefix] === a[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < b.length - prefix &&
    suffix < a.length - prefix &&
    b[b.length - 1 - suffix] === a[a.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midBefore = b.slice(prefix, b.length - suffix);
  const midAfter = a.slice(prefix, a.length - suffix);
  if (midBefore.length === 0 && midAfter.length === 0) return { hunks: [], degraded: false };

  if (midBefore.length > MAX_LCS_LINES || midAfter.length > MAX_LCS_LINES) {
    return {
      hunks: [
        { startLine: prefix, endLine: prefix + midAfter.length - 1, removed: [...midBefore] },
      ],
      degraded: true,
    };
  }

  const hunks = lcsHunks(midBefore, midAfter).map((hunk) => ({
    startLine: hunk.startLine + prefix,
    endLine: hunk.endLine + prefix,
    removed: hunk.removed,
  }));
  return { hunks, degraded: false };
}
