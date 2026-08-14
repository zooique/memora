/**
 * stripDocContextPrefix 纯函数单测（阶段 A P2-1 + 固化 P1-6 修复：
 * 关闭标签锚点剥离，用户输入含「用户请求：」不被误剥）
 */
import { describe, it, expect } from 'vitest';
import { stripDocContextPrefix } from '../docContext.js';

describe('stripDocContextPrefix', () => {
  it('剥离文档上下文前缀，只留用户请求', () => {
    const content = `[当前打磨文档内容]\n# 设计文档\n[/当前打磨文档内容]\n\n用户请求：帮我打磨这段`;
    expect(stripDocContextPrefix(content)).toBe('帮我打磨这段');
  });

  it('无前缀消息原样返回（resume 补写 / 无文档场景）', () => {
    expect(stripDocContextPrefix('普通对话消息')).toBe('普通对话消息');
  });

  it('用户输入含「用户请求：」不被误剥（P1-6 回归）', () => {
    // 注入 marker 总紧跟关闭标签；用户 input 内的「用户请求：」出现在其后，应保留
    const content =
      `[当前打磨文档内容]\n# 设计文档\n[/当前打磨文档内容]\n\n` +
      `用户请求：请改写这句\n\n用户请求：这句是用户输入里的`;
    expect(stripDocContextPrefix(content)).toBe('请改写这句\n\n用户请求：这句是用户输入里的');
  });

  it('缺少关闭标签时原样返回（不误剥）', () => {
    const content = '[当前打磨文档内容]\n无关闭标签的异常消息';
    expect(stripDocContextPrefix(content)).toBe(content);
  });

  it('缺少分隔 marker 时原样返回', () => {
    const content = '[当前打磨文档内容]\n内容\n[/当前打磨文档内容]';
    expect(stripDocContextPrefix(content)).toBe(content);
  });
});
