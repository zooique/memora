/**
 * Diff 确认写入（A-101）
 *
 * 在 write_file 执行前生成 unified diff、ANSI 彩色展示、等待用户确认。
 * 详见 方案-行动侧打磨-v1.0.md §二
 *
 * 核心约束：
 *   - 零新依赖（picocolors + Node.js 内置 readline/promises）
 *   - LCS diff 算法 + fastLineDiff 降级（行数 > 1000）
 *   - 二进制文件检测（NULL 字节）→ 跳过 diff
 *
 * 暴露：
 *   - DiffLine / DiffHunk / DiffResult 类型
 *   - Differ 类：diff 算法
 *   - DiffRenderer 类：ANSI 渲染
 *   - accumulateWrite 函数：批量写入时收集 diff 信息
 *   - promptBatchWrites 函数：批量展示 + 用户确认
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pc from 'picocolors';

// ── 类型定义 ────────────────────────────────────────────────

/** 单行 diff 类型 */
export interface DiffLine {
  type: 'same' | 'add' | 'remove';
  content: string;
}

/** 一个 diff 块 */
export interface DiffHunk {
  oldStart: number; // 旧文件起始行号（1-based）
  oldCount: number; // 旧文件受影响行数
  newStart: number; // 新文件起始行号（1-based）
  newCount: number; // 新文件受影响行数
  lines: DiffLine[];
}

/** diff 完整结果 */
export interface DiffResult {
  hunks: DiffHunk[];
  isNewFile: boolean;
  isBinary: boolean;
  additions: number;
  removals: number;
}

/** 单个文件的写入信息（用于批量展示） */
export interface WriteAccumulator {
  path: string;
  oldContent: string | null;
  newContent: string;
  diffResult: DiffResult;
}

/** 快降级阈值：行数超过此值改用 O(n) 逐行比较 */
const FAST_DIFF_THRESHOLD = 1000;

/** 上下文窗口行数 */
const CONTEXT_LINES = 3;

/** 相邻 hunk 合并间距阈值 */
const HUNK_MERGE_GAP = 6;

/** 最大显示 hunk 数（超过则截断） */
const MAX_HUNKS_DISPLAY = 5;

/** 密钥/敏感字段模式（展示时用 *** 替代） */
const SENSITIVE_KEY_PATTERN =
  /^\s*(["']?(api[_-]?key|secret|password|token|auth|credential)["']?\s*[:=]\s*)/i;

// ── Differ ──────────────────────────────────────────────────

/**
 * Diff 算法类（A-101）
 *
 * 基于 LCS（最长公共子序列）的 Myers 简化版 diff。
 * 行数 > FAST_DIFF_THRESHOLD 时自动降级为 O(n) fastLineDiff。
 * 上下文窗口 = 3 行，相邻 hunk 间距 < 6 行时自动合并。
 */
export class Differ {
  /**
   * 计算两个文本之间的差异
   * @param oldLines 旧文本各行
   * @param newLines 新文本各行
   * @returns diff 结果
   */
  static diff(oldLines: string[], newLines: string[]): DiffResult {
    // 二进制检测
    if (Differ.isBinary(oldLines) || Differ.isBinary(newLines)) {
      return {
        hunks: [],
        isNewFile: oldLines.length === 0,
        isBinary: true,
        additions: newLines.length,
        removals: oldLines.length,
      };
    }

    // 新文件
    if (oldLines.length === 0) {
      const lines: DiffLine[] = newLines.map((l) => ({ type: 'add', content: l }));
      return {
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: newLines.length, lines }],
        isNewFile: true,
        isBinary: false,
        additions: newLines.length,
        removals: 0,
      };
    }

    // 行数过大 → 快速降级
    if (oldLines.length > FAST_DIFF_THRESHOLD || newLines.length > FAST_DIFF_THRESHOLD) {
      return Differ.fastLineDiff(oldLines, newLines);
    }

    return Differ.lcsDiff(oldLines, newLines);
  }

  /**
   * LCS 逐行 diff（O(n×m)，适合小到中型文件）
   */
  private static lcsDiff(oldLines: string[], newLines: string[]): DiffResult {
    const diffLines = Differ.computeDiffLines(oldLines, newLines);
    const hunks = Differ.buildHunks(diffLines);
    const stats = Differ.countChanges(hunks);

    return {
      hunks,
      isNewFile: false,
      isBinary: false,
      ...stats,
    };
  }

  /**
   * 快速行级 diff（O(n)，逐行比较）
   *
   * 用于行数超过 FAST_DIFF_THRESHOLD 的大文件降级方案。
   * 不做 LCS，直接逐行比较 + 相同行跳过。
   */
  private static fastLineDiff(oldLines: string[], newLines: string[]): DiffResult {
    const oldLen = oldLines.length;
    const newLen = newLines.length;
    const maxLen = Math.max(oldLen, newLen);
    const diffLines: DiffLine[] = [];

    for (let i = 0; i < maxLen; i++) {
      if (i < oldLen && i < newLen) {
        if (oldLines[i] === newLines[i]) {
          diffLines.push({ type: 'same', content: oldLines[i]! });
        } else {
          if (i < oldLen) diffLines.push({ type: 'remove', content: oldLines[i]! });
          if (i < newLen) diffLines.push({ type: 'add', content: newLines[i]! });
        }
      } else if (i < oldLen) {
        diffLines.push({ type: 'remove', content: oldLines[i]! });
      } else {
        diffLines.push({ type: 'add', content: newLines[i]! });
      }
    }

    const hunks = Differ.buildHunks(diffLines);
    const stats = Differ.countChanges(hunks);

    return {
      hunks,
      isNewFile: false,
      isBinary: false,
      ...stats,
    };
  }

  /**
   * 计算 DiffLine 序列
   *
   * 1. 跳过相同前缀
   * 2. 跳过相同后缀
   * 3. 中间不同部分做 LCS 回溯
   */
  private static computeDiffLines(oldLines: string[], newLines: string[]): DiffLine[] {
    const oldLen = oldLines.length;
    const newLen = newLines.length;

    // 1. 跳过相同前缀
    let prefix = 0;
    while (prefix < oldLen && prefix < newLen && oldLines[prefix] === newLines[prefix]) {
      prefix++;
    }

    // 2. 跳过相同后缀
    let suffix = 0;
    while (
      suffix < oldLen - prefix &&
      suffix < newLen - prefix &&
      oldLines[oldLen - 1 - suffix] === newLines[newLen - 1 - suffix]
    ) {
      suffix++;
    }

    const midOld = oldLines.slice(prefix, oldLen - suffix);
    const midNew = newLines.slice(prefix, newLen - suffix);

    const result: DiffLine[] = [];

    // 前缀（same）
    for (let i = 0; i < prefix; i++) {
      result.push({ type: 'same', content: oldLines[i]! });
    }

    // 中间：LCS 回溯
    if (midOld.length > 0 || midNew.length > 0) {
      const lcs = Differ.computeLcs(midOld, midNew);
      let oi = 0;
      let ni = 0;
      for (const commonLine of lcs) {
        // old 中在 commonLine 之前的行 → remove
        while (oi < midOld.length && midOld[oi] !== commonLine) {
          result.push({ type: 'remove', content: midOld[oi]! });
          oi++;
        }
        // new 中在 commonLine 之前的行 → add
        while (ni < midNew.length && midNew[ni] !== commonLine) {
          result.push({ type: 'add', content: midNew[ni]! });
          ni++;
        }
        // 公共行
        result.push({ type: 'same', content: commonLine });
        oi++;
        ni++;
      }
      // 剩余
      while (oi < midOld.length) {
        result.push({ type: 'remove', content: midOld[oi]! });
        oi++;
      }
      while (ni < midNew.length) {
        result.push({ type: 'add', content: midNew[ni]! });
        ni++;
      }
    }

    // 后缀（same）
    for (let i = 0; i < suffix; i++) {
      result.push({ type: 'same', content: oldLines[oldLen - suffix + i]! });
    }

    return result;
  }

  /**
   * 计算两个字符串数组的 LCS（使用动态规划）
   * @returns LCS 中实际的行内容列表
   */
  private static computeLcs(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;

    // dp[i][j] = a[0..i-1] 与 b[0..j-1] 的 LCS 长度
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]! + 1;
        } else {
          dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
        }
      }
    }

    // 回溯
    const result: string[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.push(a[i - 1]!);
        i--;
        j--;
      } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
        i--;
      } else {
        j--;
      }
    }
    result.reverse();
    return result;
  }

  /**
   * 将 DiffLine 列表构建为 hunk 列表
   *
   * 逻辑：
   *   1. 找到变更区域（add/remove 行）
   *   2. 前后扩展 CONTEXT_LINES 行
   *   3. 相邻 hunk 间距 < HUNK_MERGE_GAP 时合并
   */
  private static buildHunks(diffLines: DiffLine[]): DiffHunk[] {
    const rawHunks: DiffHunk[] = [];
    const len = diffLines.length;

    let i = 0;
    while (i < len) {
      // 跳过相同行，找到下一个变更起点
      while (i < len && diffLines[i]!.type === 'same') i++;
      if (i >= len) break;

      // 变更区域起始（含上下文前扩）
      const ctxStart = Math.max(0, i - CONTEXT_LINES);
      // 把 ctxStart 之前的 same 行加入 hunk 前缀
      while (i < len && diffLines[i]!.type !== 'same') i++;
      // 变更区域结束（含上下文后扩）
      const ctxEnd = Math.min(len, i + CONTEXT_LINES);

      // 收集 hunk 行
      const hunkLines: DiffLine[] = [];
      let oldCount = 0;
      let newCount = 0;

      for (let j = ctxStart; j < ctxEnd; j++) {
        const line = diffLines[j]!;
        hunkLines.push(line);
        if (line.type === 'same' || line.type === 'remove') oldCount++;
        if (line.type === 'same' || line.type === 'add') newCount++;
      }

      // 为起始行号倒退
      let os = 0;
      let ns = 0;
      for (let j = 0; j < ctxStart; j++) {
        const line = diffLines[j]!;
        if (line.type === 'same' || line.type === 'remove') os++;
        if (line.type === 'same' || line.type === 'add') ns++;
      }

      rawHunks.push({
        oldStart: os + 1,
        oldCount,
        newStart: ns + 1,
        newCount,
        lines: hunkLines,
      });
    }

    // 合并相邻 hunk
    return Differ.mergeHunks(rawHunks);
  }

  /**
   * 合并间距过小的相邻 hunk
   */
  private static mergeHunks(hunks: DiffHunk[]): DiffHunk[] {
    if (hunks.length <= 1) return hunks;

    const merged: DiffHunk[] = [hunks[0]!];
    for (let k = 1; k < hunks.length; k++) {
      const prev = merged[merged.length - 1]!;
      const curr = hunks[k]!;
      const gap = curr.oldStart - (prev.oldStart + prev.oldCount);

      if (gap < HUNK_MERGE_GAP) {
        // 合并
        merged[merged.length - 1] = {
          oldStart: prev.oldStart,
          oldCount: prev.oldCount + curr.oldCount,
          newStart: prev.newStart,
          newCount: prev.newCount + curr.newCount,
          lines: [...prev.lines, ...curr.lines],
        };
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }

  /**
   * 统计变更行数
   */
  private static countChanges(hunks: DiffHunk[]): { additions: number; removals: number } {
    let additions = 0;
    let removals = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') additions++;
        if (line.type === 'remove') removals++;
      }
    }
    return { additions, removals };
  }

  /**
   * 检测内容是否包含 NULL 字节（二进制文件）
   */
  private static isBinary(lines: string[]): boolean {
    // 检查前 100 行
    const checkCount = Math.min(lines.length, 100);
    for (let i = 0; i < checkCount; i++) {
      if (lines[i]!.includes('\x00')) return true;
    }
    return false;
  }
}

// ── DiffRenderer ─────────────────────────────────────────────

/**
 * Diff ANSI 渲染器（A-101）
 *
 * 将 Differ.diff() 的结果渲染为终端友好的 ANSI 彩色字符串。
 * 颜色约定：
 *   - 绿色（+）：新增行
 *   - 红色（-）：删除行
 *   - 青色：行号锚点
 *   - 灰色：上下文行
 */
export class DiffRenderer {
  /**
   * 渲染一个文件的 diff 结果
   * @param result diff 算法结果
   * @param relPath 文件相对路径
   * @returns ANSI 彩色多行字符串
   */
  static render(result: DiffResult, relPath: string): string {
    // 二进制文件
    if (result.isBinary) {
      const sizeInfo = result.additions > 0 ? `${result.additions} 行` : '未知大小';
      return [
        '',
        pc.cyan(`┌─ 📝 ${relPath} ─${'─'.repeat(Math.max(0, 44 - relPath.length))}┐`),
        `│ ${pc.yellow('⚠ 二进制文件（跳过 diff）')}${' '.repeat(Math.max(0, 42 - 17))}│`,
        `│ 文件大小: ${sizeInfo}${' '.repeat(Math.max(0, 42 - 9 - sizeInfo.length))}│`,
        pc.cyan(`└${'─'.repeat(48)}┘`),
      ].join('\n');
    }

    // 新文件
    if (result.isNewFile) {
      return [
        '',
        pc.cyan(`┌─ 📝 ${relPath} ─${'─'.repeat(Math.max(0, 44 - relPath.length))}┐`),
        `│ ${pc.green('新建文件')}：${relPath}（${result.additions} 行）${' '.repeat(Math.max(0, 36 - relPath.length - String(result.additions).length))}│`,
        pc.cyan(`└${'─'.repeat(48)}┘`),
      ].join('\n');
    }

    // 无变更
    if (result.hunks.length === 0 && result.additions === 0 && result.removals === 0) {
      return [
        '',
        pc.cyan(`┌─ 📝 ${relPath} ─${'─'.repeat(Math.max(0, 44 - relPath.length))}┐`),
        `│ ${pc.dim('文件未变更')}${' '.repeat(38)}│`,
        pc.cyan(`└${'─'.repeat(48)}┘`),
      ].join('\n');
    }

    // 正常 diff
    const totalChanges = result.additions + result.removals;
    const statsLine = `共 ${totalChanges} 处变更: +${result.additions} −${result.removals}`;
    const lines: string[] = [
      '',
      pc.cyan(`┌─ 📝 ${relPath} ─${'─'.repeat(Math.max(0, 44 - relPath.length))}┐`),
      `│ ${pc.bold(statsLine)}${' '.repeat(Math.max(0, 46 - statsLine.length))}│`,
      '│' + ' '.repeat(48) + '│',
    ];

    // hunk 截断
    let displayHunks = result.hunks;
    let truncatedCount = 0;
    if (displayHunks.length > MAX_HUNKS_DISPLAY) {
      truncatedCount = displayHunks.length - MAX_HUNKS_DISPLAY;
      displayHunks = displayHunks.slice(0, MAX_HUNKS_DISPLAY);
    }

    for (const hunk of displayHunks) {
      lines.push(
        `│ ${pc.cyan(`第 ${hunk.oldStart} 行`)}${' '.repeat(Math.max(0, 42 - String(hunk.oldStart).length - 4))}│`,
      );

      for (const line of hunk.lines) {
        const sanitized = DiffRenderer.sanitizeContent(line.content);
        const truncated = sanitized.length > 44 ? sanitized.slice(0, 41) + '…' : sanitized;
        const prefix =
          line.type === 'add' ? pc.green('+ ') : line.type === 'remove' ? pc.red('- ') : '  ';
        const styled =
          line.type === 'add'
            ? pc.green(truncated)
            : line.type === 'remove'
              ? pc.red(truncated)
              : pc.dim(truncated);
        lines.push(`│ ${prefix}${styled}${' '.repeat(Math.max(0, 46 - truncated.length))}│`);
      }
    }

    // 截断提示
    if (truncatedCount > 0) {
      lines.push(
        `│ ${pc.dim(`…其余 ${truncatedCount} 处变更`)}${' '.repeat(Math.max(0, 32 - String(truncatedCount).length))}│`,
      );
    }

    // 底部分隔线
    lines.push(`│ ${pc.dim('─'.repeat(46))} │`);

    return lines.join('\n');
  }

  /**
   * 脱敏 + 截断：对敏感字段值用 *** 替代
   */
  private static sanitizeContent(line: string): string {
    // 敏感值脱敏
    return line.replace(SENSITIVE_KEY_PATTERN, (_match, prefix) => `${prefix}***`);
  }
}

// ── 交互式确认 ──────────────────────────────────────────────

/**
 * 收集单次写入的 diff 信息（供批量展示使用）
 *
 * @param path 文件相对路径
 * @param oldContent 旧内容（null 表示新文件）
 * @param newContent 新内容
 * @param accumulators 累加器数组（原地修改）
 */
export function accumulateWrite(
  path: string,
  oldContent: string | null,
  newContent: string,
  accumulators: WriteAccumulator[],
): void {
  const oldLines = oldContent !== null ? oldContent.split('\n') : [];
  const newLines = newContent.split('\n');
  const diffResult = Differ.diff(oldLines, newLines);

  accumulators.push({
    path,
    oldContent,
    newContent,
    diffResult,
  });
}

/**
 * 对批量写入进行集中展示 + 用户确认（A-101）
 *
 * 多个 write_file 在同一次对话轮次中时，先计算所有 diff，
 * 统一展示后由用户一次性确认全部写入。
 *
 * @param accumulators 写入累加器数组
 * @returns true 确认全部写入，false 拒绝
 */
export async function promptBatchWrites(accumulators: WriteAccumulator[]): Promise<boolean> {
  if (accumulators.length === 0) return true;

  // 渲染所有 diff
  const displayTexts: string[] = [];
  let totalAdditions = 0;
  let totalRemovals = 0;
  let hasBinary = false;

  for (const acc of accumulators) {
    const rendered = DiffRenderer.render(acc.diffResult, acc.path);
    displayTexts.push(rendered);
    totalAdditions += acc.diffResult.additions;
    totalRemovals += acc.diffResult.removals;
    if (acc.diffResult.isBinary) hasBinary = true;
  }

  // 汇总标题
  const summaryParts: string[] = [];
  if (totalAdditions > 0 || totalRemovals > 0) {
    summaryParts.push(`共 +${totalAdditions} −${totalRemovals}`);
  }
  if (hasBinary) {
    summaryParts.push(pc.yellow('含二进制文件'));
  }
  const summaryLine = summaryParts.length > 0 ? summaryParts.join(' · ') : '';

  // 输出所有 diff
  process.stdout.write('\n');
  if (summaryLine) {
    process.stdout.write(pc.bold(`📝 批量写入 ${accumulators.length} 个文件：${summaryLine}\n`));
  }
  for (const text of displayTexts) {
    process.stdout.write(text + '\n');
  }

  // 确认提示
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const promptLine =
        [
          '',
          pc.cyan('┌'),
          pc.cyan('│'),
          pc.cyan('│ 确认写入？[Enter=确认] [n=拒绝]'),
          pc.cyan('└'),
        ].join('') + ' ';

      const answer = (await rl.question(promptLine)).trim().toLowerCase();

      if (answer === '' || answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      // 其他输入 → 重新显示提示
    }
  } finally {
    rl.close();
  }
}
