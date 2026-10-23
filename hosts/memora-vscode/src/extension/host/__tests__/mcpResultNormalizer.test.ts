/**
 * MCP 结果归一化测试 — isError / 非文本块 / structuredContent 降级 / per-result 预裁
 *
 * 判据来源：方案-MCP工具接入 §7 P3（isError 不当正常文本）/ P6（结构化输出降级文本）、
 * §10「单次结果无 per-result 预裁」行的退出条件（预裁 + 截断提示）。
 * 纯函数，不碰内核、不拉起子进程（连接面见 mcpConnectionManager.test.ts）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeToolResult } from '../mcp/resultNormalizer.js';

describe('normalizeToolResult（结果归一化）', () => {
  it('文本块按序拼接（多块换行相连）', () => {
    const text = normalizeToolResult({
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    });
    expect(text).toBe('第一段\n第二段');
  });

  it('isError → 抛错（不当正常文本回填：假成功比失败更糟）', () => {
    expect(() =>
      normalizeToolResult({ content: [{ type: 'text', text: '工具内部炸了' }], isError: true }),
    ).toThrow('工具内部炸了');
  });

  it('isError 且无文本 → 固定说明文案（不让空错误文本流进模型）', () => {
    expect(() => normalizeToolResult({ content: [], isError: true })).toThrow(
      'MCP 工具返回错误（无文本说明）',
    );
  });

  it('非文本块丢弃但注明类型（不静默吞掉）', () => {
    const text = normalizeToolResult({
      content: [
        { type: 'text', text: '见图' },
        { type: 'image', data: 'base64...', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x' } },
      ],
    });
    expect(text).toBe('见图\n[已丢弃非文本结果：image]\n[已丢弃非文本结果：resource]');
  });

  it('空结果 → 明示文案（不被误读成工具无事可做）', () => {
    expect(normalizeToolResult({ content: [] })).toBe('（MCP 工具返回空结果）');
  });

  it('载荷不是对象 → 明说「非标准结果」（协议违规 ≠ 真空结果：后者是工具跑完没输出，前者是 server 没按协议回）', () => {
    expect(normalizeToolResult(undefined)).toBe('（MCP 工具返回非标准结果：载荷不是对象）');
    expect(normalizeToolResult('不是对象')).toBe('（MCP 工具返回非标准结果：载荷不是对象）');
    expect(normalizeToolResult(42)).toBe('（MCP 工具返回非标准结果：载荷不是对象）');
  });

  it('structuredContent 降级：无文本正文时转 JSON 并注明来源', () => {
    const text = normalizeToolResult({
      content: [],
      structuredContent: { ok: true, items: [1, 2] },
    });
    expect(text).toBe('[结构化输出已降级为文本]\n{"ok":true,"items":[1,2]}');
  });

  it('有文本正文时 structuredContent 丢弃不注（平行冗余形态，注了反而双份）', () => {
    const text = normalizeToolResult({
      content: [{ type: 'text', text: '正文' }],
      structuredContent: { ok: true },
    });
    expect(text).toBe('正文');
  });

  it('空对象 structuredContent 不触发降级（空结构不是内容）', () => {
    expect(normalizeToolResult({ content: [], structuredContent: {} })).toBe(
      '（MCP 工具返回空结果）',
    );
  });

  it('超长结果截断并附原长（per-result 预裁）', () => {
    const huge = 'x'.repeat(20_001);
    const text = normalizeToolResult({ content: [{ type: 'text', text: huge }] });
    expect(text.startsWith('x'.repeat(20_000))).toBe(true);
    expect(text).toContain('[结果已截断：原长 20001 字符，仅保留前 20000 字符]');
  });

  it('恰好等于上限不截断（边界：不误伤正常大结果）', () => {
    const exact = 'y'.repeat(20_000);
    expect(normalizeToolResult({ content: [{ type: 'text', text: exact }] })).toBe(exact);
  });

  it('isError 且超长：先截断再抛（错误文案同样有界）', () => {
    const huge = 'e'.repeat(20_001);
    expect(() =>
      normalizeToolResult({ content: [{ type: 'text', text: huge }], isError: true }),
    ).toThrow(/结果已截断：原长 20001 字符/);
  });
});
