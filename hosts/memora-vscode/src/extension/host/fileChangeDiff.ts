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
