/**
 * docContext 纯函数单测：写入/剥离对偶
 * （buildInjectedContextEnvelope ↔ stripInjectedContextPrefix）
 *
 * 覆盖沿革：阶段 A P2-1（从 chatPanel.ts 抽出为可测模块）+ 固化 P1-6 修复（关闭标签
 * 锚点剥离，用户输入含「用户请求：」不被误剥）+ 站 59 修复（原实现以 startsWith
 * 文档块开标签为判据，技能块排在文档块之前时整体回显泄露 → 判据改为「消息内含宿主
 * 注入块标记」，覆盖 仅文档 / 技能+文档 / 仅技能 三态）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildDocContextBlock,
  buildInjectedContextEnvelope,
  stripInjectedContextPrefix,
} from '../docContext.js';

const INPUT = '帮我打磨这段';
const SKILL_BLOCK = '【当前技能】design-review\n技能正文…';

describe('stripInjectedContextPrefix', () => {
  it('剥离文档上下文前缀，只留用户请求', () => {
    const content = buildInjectedContextEnvelope([buildDocContextBlock('# 设计文档')], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('技能块排在文档块之前时同样剥离（站 59 回归：原 startsWith 判据导致整块回显）', () => {
    const content = buildInjectedContextEnvelope(
      [SKILL_BLOCK, buildDocContextBlock('# 设计文档')],
      INPUT,
    );
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('仅技能块（无文档上下文）时同样剥离（站 59 回归）', () => {
    const content = buildInjectedContextEnvelope([SKILL_BLOCK], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('无前缀消息原样返回（resume 补写 / 无上下文场景）', () => {
    expect(stripInjectedContextPrefix('普通对话消息')).toBe('普通对话消息');
  });

  it('用户输入含「用户请求：」不被误剥（P1-6 回归）', () => {
    // 注入 marker 总紧跟关闭标签；用户 input 内的「用户请求：」出现在其后，应保留
    const content =
      `[当前打磨文档内容]\n# 设计文档\n[/当前打磨文档内容]\n\n` +
      `用户请求：请改写这句\n\n用户请求：这句是用户输入里的`;
    expect(stripInjectedContextPrefix(content)).toBe('请改写这句\n\n用户请求：这句是用户输入里的');
  });

  it('仅技能块 + 用户输入含「用户请求：」不被误剥', () => {
    const content = `${SKILL_BLOCK}\n\n用户请求：请改写这句\n\n用户请求：这句是用户输入里的`;
    expect(stripInjectedContextPrefix(content)).toBe('请改写这句\n\n用户请求：这句是用户输入里的');
  });

  it('文档正文自带「用户请求：」字样不被误剥（关闭标签锚点）', () => {
    const doc = '# 设计文档\n\n用户请求：这段是文档正文里的字样';
    const content = buildInjectedContextEnvelope([buildDocContextBlock(doc)], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('普通消息含「用户请求：」但无注入块标记 → 不剥离', () => {
    const content = '先看这段\n\n用户请求：这只是一条普通消息';
    expect(stripInjectedContextPrefix(content)).toBe(content);
  });

  it('缺少关闭标签时原样返回（不误剥）', () => {
    const content = '[当前打磨文档内容]\n无关闭标签的异常消息';
    expect(stripInjectedContextPrefix(content)).toBe(content);
  });

  it('缺少分隔 marker 时原样返回', () => {
    const content = '[当前打磨文档内容]\n内容\n[/当前打磨文档内容]';
    expect(stripInjectedContextPrefix(content)).toBe(content);
  });
});

describe('buildInjectedContextEnvelope ↔ stripInjectedContextPrefix 对偶', () => {
  it('无任何块时不注入信封（chatInput 即用户原文，不含分隔符）', () => {
    const built = buildInjectedContextEnvelope([undefined, ''], INPUT);
    expect(built).toBe(INPUT);
    expect(built).not.toContain('用户请求：');
  });

  it('三态信封剥离后均还原用户原文（对称的另一半）', () => {
    const docBlock = buildDocContextBlock('# 文档\n多行内容');
    const shapes: string[][] = [[SKILL_BLOCK], [docBlock], [SKILL_BLOCK, docBlock]];
    for (const blocks of shapes) {
      expect(stripInjectedContextPrefix(buildInjectedContextEnvelope(blocks, INPUT))).toBe(INPUT);
    }
  });
});
