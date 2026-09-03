/**
 * [ASK] 提问契约解析器 测试 — 单一真理源（2026-09-03 T1 下沉）
 *
 * 覆盖：解析器主路径（含选项/纯问题/多行）、空输入/格式边界、
 * 花括号字面量防误判、stripAskLines 剔除契约行、不变性断言。
 */
import { describe, it, expect } from 'vitest';
import { parseAskQuestions, stripAskLines } from '../askParser.js';

describe('parseAskQuestions', () => {
  it('提取行首 [ASK] 带的选项声明（A|B|C），返回 question + options', () => {
    const result = parseAskQuestions('[ASK] 倾向哪个方案？{方案A|方案B}');
    expect(result).toHaveLength(1);
    expect(result[0]?.question).toBe('倾向哪个方案？');
    expect(result[0]?.options).toEqual(['方案A', '方案B']);
  });

  it('无选项的纯提问行返回 question 无 options', () => {
    const result = parseAskQuestions('[ASK] 需要我补充什么细节吗？');
    expect(result).toHaveLength(1);
    expect(result[0]?.question).toBe('需要我补充什么细节吗？');
    expect(result[0]?.options).toBeUndefined();
  });

  it('多条 [ASK] 行分别解析', () => {
    const text = '[ASK] 选方案A还是方案B？{方案A|方案B}\n[ASK] 还有什么补充吗？';
    const result = parseAskQuestions(text);
    expect(result).toHaveLength(2);
    expect(result[0]?.options).toEqual(['方案A', '方案B']);
    expect(result[1]?.options).toBeUndefined();
  });

  it('正文普通花括号字面量不误判为选项（无分隔符）', () => {
    const result = parseAskQuestions('[ASK] 请参考文档{见README}');
    expect(result).toHaveLength(1);
    expect(result[0]?.options).toBeUndefined();
  });

  it('全半角括号、全半角分隔符混用都正确拆分', () => {
    const result = parseAskQuestions('[ASK] 选择？{A｜B|C｝');
    expect(result[0]?.options).toEqual(['A', 'B', 'C']);
  });

  it('无 [ASK] 行返回空数组', () => {
    expect(parseAskQuestions('普通正文')).toEqual([]);
    expect(parseAskQuestions('')).toEqual([]);
  });

  it('[ASK] 行后无正文（纯标记行）返回空数组', () => {
    expect(parseAskQuestions('[ASK]')).toEqual([]);
    expect(parseAskQuestions('[ASK]  ')).toEqual([]);
  });

  it('大小写不敏感（[ask] / [Ask] 均可识别）', () => {
    expect(parseAskQuestions('[ask] 你好？')).toHaveLength(1);
    expect(parseAskQuestions('[Ask] 你好？')).toHaveLength(1);
    expect(parseAskQuestions('[ASK] 你好？')).toHaveLength(1);
  });

  it('空选项（花括号内无内容）不产生选项', () => {
    const result = parseAskQuestions('[ASK] 选择？{}');
    expect(result[0]?.options).toBeUndefined();
  });

  it('花括号内全为空白或空分隔的不产生选项', () => {
    const result = parseAskQuestions('[ASK] 选择？{ | }');
    expect(result[0]?.options).toBeUndefined();
  });
});

describe('stripAskLines', () => {
  it('剔除行首 [ASK] 行，保留其余正文', () => {
    const text = '先确认倾向。\n[ASK] 倾向哪个方案？{方案A|方案B}\n好的，按方案A继续。';
    expect(stripAskLines(text)).toBe('先确认倾向。\n好的，按方案A继续。');
  });

  it('纯 [ASK] 行（无正文标记）也剔除', () => {
    expect(stripAskLines('[ASK]')).toBe('');
    expect(stripAskLines('正文\n[ASK]  \n正文')).toBe('正文\n正文');
  });

  it('无 [ASK] 行的原文原样返回', () => {
    const text = '普通正文\n第二行';
    expect(stripAskLines(text)).toBe(text);
  });

  it('空字符串原样返回', () => {
    expect(stripAskLines('')).toBe('');
  });
});
