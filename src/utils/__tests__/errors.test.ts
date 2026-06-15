/**
 * 错误类型测试
 * 覆盖 M-103：4 大类错误工厂 + format + log
 */
import { describe, it, expect } from 'vitest';
import {
  configError,
  networkError,
  llmError,
  toolError,
} from '@/utils/errors.js';

describe('MemoraError · M-103 错误信息友好化', () => {
  it('应该构造带标题/详情/建议的错误', () => {
    const err = configError('API Key 缺失', 'MEMORA_LLM_API_KEY 未设置', ['设置环境变量']);
    expect(err.title).toBe('API Key 缺失');
    expect(err.detail).toBe('MEMORA_LLM_API_KEY 未设置');
    expect(err.suggestions).toEqual(['设置环境变量']);
    expect(err.category).toBe('config');
  });

  it('format 应该输出中文错误 + 建议列表', () => {
    const err = networkError('连接失败', 'timeout 5s', ['检查网络', '重试']);
    const formatted = err.format();
    expect(formatted).toContain('❌ 连接失败');
    expect(formatted).toContain('原因：timeout 5s');
    expect(formatted).toContain('建议：');
    expect(formatted).toContain('检查网络');
    expect(formatted).toContain('重试');
  });

  it('log 应该不抛出（仅记录到 pino）', () => {
    const err = llmError('5xx', 'service unavailable', ['稍后重试']);
    expect(() => err.log()).not.toThrow();
  });

  it('4 大类错误应该正确分类', () => {
    expect(configError('a', 'b', []).category).toBe('config');
    expect(networkError('a', 'b', []).category).toBe('network');
    expect(llmError('a', 'b', []).category).toBe('llm');
    expect(toolError('a', 'b', []).category).toBe('tool');
  });

  it('format 无 detail 时应省略原因行', () => {
    const err = toolError('路径越界', undefined, ['改用白名单路径']);
    const formatted = err.format();
    expect(formatted).toContain('❌ 路径越界');
    expect(formatted).not.toContain('原因');
    expect(formatted).toContain('建议：');
  });

  it('format 无 suggestions 时应省略建议行', () => {
    const err = toolError('路径越界', '/etc/passwd', []);
    const formatted = err.format();
    expect(formatted).toContain('❌ 路径越界');
    expect(formatted).toContain('原因：/etc/passwd');
    expect(formatted).not.toContain('建议');
  });

  it('错误应该保留原始 cause 用于调试', () => {
    const cause = new Error('ECONNREFUSED');
    const err = networkError('LLM 不可达', '无法连接', ['检查网络'], cause);
    expect(err.cause).toBe(cause);
    expect(err.stack).toBeDefined();
  });
});
