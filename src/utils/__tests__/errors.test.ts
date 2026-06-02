/**
 * 错误类型测试
 * 覆盖 M-103：4 大类错误工厂 + format + log + toFriendlyError
 */
import { describe, it, expect } from 'vitest';
import {
  MemoraError,
  configError,
  networkError,
  llmError,
  toolError,
  toFriendlyError,
} from '../errors.js';

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

  it('toFriendlyError 应该保留 MemoraError', () => {
    const original = toolError('路径越界', '/etc/passwd', ['改用白名单路径']);
    const wrapped = toFriendlyError(original);
    expect(wrapped).toBe(original);
  });

  it('toFriendlyError 应该把普通 Error 包成 MemoraError', () => {
    const original = new Error('ENOENT: no such file');
    const wrapped = toFriendlyError(original);
    expect(wrapped).toBeInstanceOf(MemoraError);
    expect(wrapped.title).toBe('未预期错误');
    expect(wrapped.detail).toBe('ENOENT: no such file');
    expect(wrapped.category).toBe('unknown');
    expect(wrapped.cause).toBe(original);
  });

  it('toFriendlyError 应该处理非 Error 类型', () => {
    const wrapped = toFriendlyError('string error');
    expect(wrapped.title).toBe('未预期错误');
    expect(wrapped.detail).toBe('string error');
  });

  it('toFriendlyError 应该处理 null/undefined', () => {
    const wrapped1 = toFriendlyError(null);
    const wrapped2 = toFriendlyError(undefined);
    expect(wrapped1.detail).toBe('null');
    expect(wrapped2.detail).toBe('undefined');
  });

  it('4 大类错误应该正确分类', () => {
    expect(configError('a', 'b', []).category).toBe('config');
    expect(networkError('a', 'b', []).category).toBe('network');
    expect(llmError('a', 'b', []).category).toBe('llm');
    expect(toolError('a', 'b', []).category).toBe('tool');
  });

  it('错误应该保留原始 cause 用于调试', () => {
    const cause = new Error('ECONNREFUSED');
    const err = networkError('LLM 不可达', '无法连接', ['检查网络'], cause);
    expect(err.cause).toBe(cause);
    expect(err.stack).toBeDefined();
  });
});
