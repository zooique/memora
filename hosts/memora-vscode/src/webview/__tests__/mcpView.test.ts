/**
 * mcpView 纯函数 — 表单文本化 / 反文本化的**无损性契约**
 *
 * 这组用例守的是「不带伤」：编辑表单把 args/env 展成文本，若文本格式表达不出原始数据
 * （空参数、含换行的值、键里带 `=`），就必须判为不可编辑，而不是静默改写。
 * 判据 {@link isFormRepresentable} 与两个 parse/format 必须成对演进——只改一边就会出现
 * 「打开表单→点保存→配置被悄悄改掉」这类最难事后归因的损伤。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { McpServerStatusDto } from '../../shared/protocol.js';
import {
  formatArgs,
  formatEnv,
  formatServerSummary,
  isFormRepresentable,
  parseArgs,
  parseEnv,
  STATE_LABELS,
} from '../scripts/mcpView.js';

describe('args 文本化（一行一个，不做 shell 解析）', () => {
  it('往返无损：普通参数（含空格）原样还原', () => {
    const args = ['-y', '/path with space/x', '--flag=1'];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it('空数组 ↔ 空文本', () => {
    expect(formatArgs([])).toBe('');
    expect(parseArgs('')).toEqual([]);
  });

  it('空白行被忽略（换行只是分隔符，不是数据）', () => {
    expect(parseArgs('-y\n\n  \nx\n')).toEqual(['-y', 'x']);
  });

  it('空字符串参数**不可**文本化 ⇒ 判为不可编辑（否则保存时会被吞掉）', () => {
    expect(isFormRepresentable({ name: 'a', command: 'x', args: ['', 'y'] })).toBe(false);
    expect(isFormRepresentable({ name: 'a', command: 'x', args: ['a\nb'] })).toBe(false);
    expect(isFormRepresentable({ name: 'a', command: 'x', args: ['a', 'b'] })).toBe(true);
  });
});

describe('env 文本化（KEY=VALUE，按首个 = 切分）', () => {
  it('值里可以有 =（只在第一个等号处切）', () => {
    expect(parseEnv('TOKEN=a=b=c').env).toEqual({ TOKEN: 'a=b=c' });
  });

  it('往返无损', () => {
    const env = { A: '1', B: 'x=y' };
    expect(parseEnv(formatEnv(env)).env).toEqual(env);
  });

  it('缺等号的行被单独报出（不静默丢弃）', () => {
    const result = parseEnv('GOOD=1\nBADLINE');
    expect(result.env).toEqual({ GOOD: '1' });
    expect(result.invalidLines).toEqual(['BADLINE']);
  });

  it('键含 = / 空键 / 值含换行 ⇒ 不可文本化', () => {
    expect(isFormRepresentable({ name: 'a', command: 'x', env: { 'A=B': '1' } })).toBe(false);
    expect(isFormRepresentable({ name: 'a', command: 'x', env: { '': '1' } })).toBe(false);
    expect(isFormRepresentable({ name: 'a', command: 'x', env: { A: '1\n2' } })).toBe(false);
    expect(isFormRepresentable({ name: 'a', command: 'x', env: { A: '1' } })).toBe(true);
  });
});

describe('统计条口径（汇总不得与卡片分家）', () => {
  const s = (state: McpServerStatusDto['state'], toolCount = 0): McpServerStatusDto =>
    ({
      name: state,
      command: 'x',
      state,
      enabled: true,
      toolCount,
      tools: [],
    }) as McpServerStatusDto;

  it('失败与配置不完整都算「需处理」（漏掉 invalid 就会出现「0 失败」但页面有红点）', () => {
    expect(formatServerSummary([s('running', 2), s('failed'), s('invalid')])).toBe(
      '3 台 · 1 已连接 · 2 需处理 · 2 个工具',
    );
  });

  it('待接入单独说，不并进失败（没试过 ≠ 失败）', () => {
    expect(formatServerSummary([s('pending'), s('running', 1)])).toBe(
      '2 台 · 1 已连接 · 1 待接入 · 1 个工具',
    );
  });

  it('停用只进台数（用户主动停的，不需处理也不报待接入）', () => {
    expect(formatServerSummary([s('disabled')])).toBe('1 台 · 0 已连接 · 0 个工具');
  });

  it('空列表 = 空串（调用方据此隐藏统计条）', () => {
    expect(formatServerSummary([])).toBe('');
  });
});

describe('五态可见名（与 CSS data-state 同源）', () => {
  it('五态齐备且互不相同', () => {
    const labels = Object.values(STATE_LABELS);
    expect(labels).toHaveLength(5);
    expect(new Set(labels).size).toBe(5);
  });

  it('pending 有独立可见名（不能被并进「已停用」或「启动失败」——没试过 ≠ 失败）', () => {
    expect(STATE_LABELS.pending).toBe('待接入');
    expect(STATE_LABELS.pending).not.toBe(STATE_LABELS.disabled);
    expect(STATE_LABELS.pending).not.toBe(STATE_LABELS.failed);
  });
});

// ──────────────────────────────────────────────────────────────
// 判据 ↔ 往返一致性（2026-10-24 修：parse 曾 trimEnd，判据却宣称「无损」）
//
// 这组用例守的是「判据说可编辑 ⇒ 往返必然无损」：一旦 parse 再引入任何形式的
// 静默修剪（trimEnd / 丢空行 / 吞 \r），这里立刻红——而不是等用户保存后发现参数变了。
// ──────────────────────────────────────────────────────────────
describe('可编辑判据 vs 实际往返（有损就必须拒绝编辑）', () => {
  it('args 尾随空格：往返无损（曾被 trimEnd 静默吃掉）', () => {
    const args = ['--path=/tmp/x ', 'a'];
    expect(isFormRepresentable({ name: 'a', command: 'x', args })).toBe(true);
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it('env 值尾随空格：往返无损（曾被 trimEnd 静默吃掉）', () => {
    const env = { TOKEN: 'abc ' };
    expect(isFormRepresentable({ name: 'a', command: 'x', env })).toBe(true);
    expect(parseEnv(formatEnv(env)).env).toEqual(env);
  });

  it('args 含 \\r（单行内回车）：判为不可编辑（文本格式只剥行尾，表达不出）', () => {
    expect(isFormRepresentable({ name: 'a', command: 'x', args: ['a\rb'] })).toBe(false);
    expect(isFormRepresentable({ name: 'a', command: 'x', args: ['a\r'] })).toBe(false);
  });

  it('args 含纯空白项：判为不可编辑（纯空白行会被当分隔符）', () => {
    expect(isFormRepresentable({ name: 'a', command: 'x', args: ['  ', 'b'] })).toBe(false);
  });

  it('行尾 \\r\\n 的文本（从 settings.json 粘贴）：解析后不带 \\r', () => {
    expect(parseArgs('-y\r\npkg\r\n')).toEqual(['-y', 'pkg']);
    expect(parseEnv('A=1\r\nB=2\r\n').env).toEqual({ A: '1', B: '2' });
  });
});
