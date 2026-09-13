/**
 * 工具结果卸载原语单元测试（大文本统一通道 · 入口关）
 *
 * 守四条不变量：
 * 1. 判据与 `estimateTokensText` **同源**（CJK 感知）且为**严格大于**默认阈值（= 单条工具结果上限）；
 * 2. 落盘内容 = 传入内容**原样**（含包裹，不 unwrap）；引用路径必须在注入目录内（可回取的前提）；
 * 3. 写失败 → **降级为原文**入上下文（不造假引用、不截断）；
 * 4. **嵌套不可能**：`read_file` 分段产出（≤ 阈值 − 包裹开销）结构性不落盘。
 *
 * 对应实现：`src/agent/toolResultOffload.ts`；论证见 `docs/大文本统一通道-探索方案.md` §6.2。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offloadLargeToolResult } from '@/agent/toolResultOffload.js';
import { estimateTokensText } from '@/agent/contextManager.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';

describe('offloadLargeToolResult（入口关原语）', () => {
  let offloadDir: string;

  beforeEach(async () => {
    offloadDir = await mkdtemp(join(tmpdir(), 'memora-offload-primitive-'));
  });

  afterEach(async () => {
    await rm(offloadDir, { recursive: true, force: true });
  });

  /** 默认阈值 = 单条工具结果上限（与 read_file 分段上限同键同源） */
  const THRESHOLD = LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS;

  it('超阈 → 落盘 + 替换为「路径 + 预览 + 续读提示」，落盘内容与传入内容逐字一致', async () => {
    const large = 'x'.repeat(200_000); // ASCII 口径 ≈ 66,667 tokens，远超阈值
    const out = offloadLargeToolResult(large, { offloadDir });

    expect(out.offloaded).toBe(true);
    expect(out.filePath).toBeDefined();
    expect(out.content).toContain('工具结果已卸载至磁盘');
    expect(out.content).toContain(out.filePath!);
    expect(out.content).toContain('read_file'); // 续读提示（回取通道）
    // 落盘内容 = 传入内容原样（不做 unwrap —— 路径指向的即「原本将入上下文的内容」）
    expect(await readFile(out.filePath!, 'utf-8')).toBe(large);
    // 产物必须在注入目录内，否则 read_file 读不回（信任根外被拦 → 假引用）
    const files = await readdir(offloadDir);
    expect(files).toHaveLength(1);
    expect(out.filePath!.startsWith(offloadDir)).toBe(true);
    // 替换文本自身远小于阈值（不会二次触发落盘）
    expect(estimateTokensText(out.content)).toBeLessThan(THRESHOLD);
  });

  it('未超阈 → 原样返回，不落盘', async () => {
    const small = 'x'.repeat(3_000); // ≈1,000 tokens
    const out = offloadLargeToolResult(small, { offloadDir });

    expect(out).toEqual({ content: small, offloaded: false });
    expect(await readdir(offloadDir)).toHaveLength(0); // 无目录副作用
  });

  it('判据为「严格大于」默认阈值：恰等于不落盘，多 1 token 才落盘（阈值与上限同源）', async () => {
    // ASCII 口径 token = ceil(len / 3)
    const exact = 'a'.repeat(3 * THRESHOLD);
    expect(estimateTokensText(exact)).toBe(THRESHOLD);
    expect(offloadLargeToolResult(exact, { offloadDir }).offloaded).toBe(false);

    const over = 'a'.repeat(3 * THRESHOLD + 1);
    expect(estimateTokensText(over)).toBe(THRESHOLD + 1);
    expect(offloadLargeToolResult(over, { offloadDir }).offloaded).toBe(true);
  });

  it('判据与 CJK 感知估算器同源：÷4 字符近似会漏判的中文大结果，此处必须落盘', () => {
    // 取值须落在「两口径方向相反」的区间：正式口径 > 阈值 且 ÷4 近似 ≤ 阈值
    // 汉字正式口径 = len × 1.5，÷4 近似 = len / 4 → len ∈ (阈值/1.5, 阈值×4] = (4,000, 24,000]
    const text = '中'.repeat(10_000);
    expect(estimateTokensText(text)).toBeGreaterThan(THRESHOLD); // 正式口径 = 15,000
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(THRESHOLD); // ÷4 近似 = 2,500

    expect(offloadLargeToolResult(text, { offloadDir }).offloaded).toBe(true);
  });

  it('嵌套不可能：read_file 分段产出（= 阈值 − 包裹开销）结构性不落盘', () => {
    // read_file 分段预算 = SINGLE_TOOL_RESULT_MAX_TOKENS − TOOL_RESULT_WRAP_OVERHEAD_TOKENS
    const budget = THRESHOLD - LOOP_CONSTANTS.TOOL_RESULT_WRAP_OVERHEAD_TOKENS;
    const readFileOutput = 'a'.repeat(3 * budget); // 恰用满预算
    expect(estimateTokensText(readFileOutput)).toBe(budget);

    // 读回产物 → 再过一次入口关 → 不落盘（无限嵌套的结构性阻断）
    const out = offloadLargeToolResult(readFileOutput, { offloadDir });
    expect(out.offloaded).toBe(false);
    expect(out.content).toBe(readFileOutput);
  });

  it('写失败 → 降级为原文入上下文（不造假引用、不截断）', async () => {
    // 以「已存在的文件」为父目录 → mkdir 必失败（ENOTDIR / EEXIST）
    const blocker = join(offloadDir, 'blocker');
    await writeFile(blocker, 'not a dir', 'utf-8');

    const large = 'x'.repeat(200_000);
    const out = offloadLargeToolResult(large, { offloadDir: join(blocker, 'sub') });

    expect(out.offloaded).toBe(false);
    expect(out.filePath).toBeUndefined();
    expect(out.content).toBe(large);
  });

  it('previewChars 可覆盖：预览长度受控，省略计数与之一致', async () => {
    const large = 'y'.repeat(50_000);
    const out = offloadLargeToolResult(large, { offloadDir, previewChars: 200 });

    expect(out.content).toContain('y'.repeat(200));
    expect(out.content).toContain(`省略 ${50_000 - 200} 字符`);
  });

  it('thresholdTokens 可覆盖：显式传阈值时按该值判定', async () => {
    const text = 'a'.repeat(3_000); // ≈1,000 tokens
    expect(offloadLargeToolResult(text, { offloadDir, thresholdTokens: 999 }).offloaded).toBe(true);
    expect(offloadLargeToolResult(text, { offloadDir, thresholdTokens: 1_000 }).offloaded).toBe(
      false,
    );
  });
});
