/**
 * LLM 错误分类器测试
 *
 * 覆盖：
 * - 认证/授权类（401/403/invalid api key）
 * - 模型/资源类（404/context length）
 * - 速率/额度类（429/余额不足）
 * - 网络类（ECONNREFUSED/ETIMEDOUT/fetch failed/SSL）
 * - 服务端类（500/502/503）
 * - 协议/配置类（base url/empty response）
 * - 优先级顺序（具体模式优先于通用模式）
 * - 未匹配回退到原始消息
 * - 空值兜底
 */
import { describe, it, expect } from 'vitest';
import { classifyLlmError } from '../../shared/llmErrorClassifier.js';

describe('llmErrorClassifier', () => {
  // ─── 认证/授权类 ────────────────────────────────────────
  describe('认证/授权类', () => {
    it('401 Unauthorized 应映射为 API Key 无效', () => {
      expect(classifyLlmError('401 Unauthorized')).toBe('API Key 无效，请检查是否复制完整（注意前后不要有空格）');
    });

    it('invalid api key 应映射为 API Key 无效', () => {
      expect(classifyLlmError('Error: invalid api key')).toBe('API Key 无效，请检查是否复制完整（注意前后不要有空格）');
    });

    it('大小写不敏感：UNAUTHORIZED 应匹配', () => {
      expect(classifyLlmError('Request failed with UNAUTHORIZED')).toBe('API Key 无效，请检查是否复制完整（注意前后不要有空格）');
    });

    it('403 Forbidden 应映射为权限不足', () => {
      expect(classifyLlmError('403 Forbidden')).toBe('API Key 无权访问该模型，请检查账户额度或模型权限');
    });
  });

  // ─── 模型/资源类 ────────────────────────────────────────
  describe('模型/资源类', () => {
    it('404 应映射为模型不存在', () => {
      expect(classifyLlmError('404 Not Found')).toBe('模型不存在，请检查模型名称拼写（如 deepseek-chat 而非 deepseek）');
    });

    it('model not found 应映射为模型不存在', () => {
      expect(classifyLlmError('model not found: gpt-5')).toBe('模型不存在，请检查模型名称拼写（如 deepseek-chat 而非 deepseek）');
    });

    it('context length exceeded 应映射为上下文超限', () => {
      expect(classifyLlmError('context length exceeded')).toBe('上下文长度超限，请缩短输入或切换支持更长上下文的模型');
    });
  });

  // ─── 速率/额度类 ────────────────────────────────────────
  describe('速率/额度类', () => {
    it('429 应映射为请求频繁', () => {
      expect(classifyLlmError('429 Too Many Requests')).toBe('请求过于频繁或额度已用尽，请稍后重试或检查账户余额');
    });

    it('rate limit exceeded 应映射为请求频繁', () => {
      expect(classifyLlmError('rate limit exceeded')).toBe('请求过于频繁或额度已用尽，请稍后重试或检查账户余额');
    });

    it('余额不足 应映射为账户余额不足', () => {
      expect(classifyLlmError('账户余额不足，请充值')).toBe('账户余额不足，请充值后重试');
    });
  });

  // ─── 网络类 ──────────────────────────────────────────────
  describe('网络类', () => {
    it('ECONNREFUSED 应映射为无法连接服务器', () => {
      expect(classifyLlmError('connect ECONNREFUSED 127.0.0.1:443')).toBe('无法连接服务器，请检查 API 地址（baseUrl）是否正确');
    });

    it('ENOTFOUND 应映射为无法连接服务器', () => {
      expect(classifyLlmError('getaddrinfo ENOTFOUND api.example.com')).toBe('无法连接服务器，请检查 API 地址（baseUrl）是否正确');
    });

    it('ETIMEDOUT 应映射为请求超时', () => {
      expect(classifyLlmError('ETIMEDOUT')).toBe('请求超时，请检查网络连接或稍后重试');
    });

    it('fetch failed 应映射为网络连接失败', () => {
      expect(classifyLlmError('fetch failed')).toBe('网络连接失败，请检查网络或 API 地址是否可访问');
    });

    it('SSL certificate 应映射为 SSL 证书错误', () => {
      expect(classifyLlmError('SSL certificate verification failed')).toBe('SSL 证书验证失败，请检查 API 地址协议（http/https）是否正确');
    });
  });

  // ─── 服务端类 ────────────────────────────────────────────
  describe('服务端类', () => {
    it('500 应映射为服务端不可用', () => {
      expect(classifyLlmError('500 Internal Server Error')).toBe('服务端临时不可用，请稍后重试');
    });

    it('503 Service Unavailable 应映射为服务端不可用', () => {
      expect(classifyLlmError('503 Service Unavailable')).toBe('服务端临时不可用，请稍后重试');
    });
  });

  // ─── 协议/配置类 ────────────────────────────────────────
  describe('协议/配置类', () => {
    it('base url 错误 应映射为 API 地址格式错误', () => {
      expect(classifyLlmError('Invalid base url')).toBe('API 地址格式错误，请确认以 https:// 开头且无多余路径');
    });

    it('empty response 应映射为 LLM 返回空响应', () => {
      expect(classifyLlmError('LLM 返回空响应')).toBe('LLM 返回空响应，请检查模型名称是否正确或更换模型');
    });
  });

  // ─── 优先级顺序 ──────────────────────────────────────────
  describe('优先级顺序', () => {
    it('401 + network 同时出现应优先匹配 401', () => {
      // 401 模式在 network 之前，应优先匹配
      const result = classifyLlmError('401 network error');
      expect(result).toBe('API Key 无效，请检查是否复制完整（注意前后不要有空格）');
    });

    it('429 + fetch failed 同时出现应优先匹配 429', () => {
      const result = classifyLlmError('429 fetch failed');
      expect(result).toBe('请求过于频繁或额度已用尽，请稍后重试或检查账户余额');
    });
  });

  // ─── 未匹配回退 ──────────────────────────────────────────
  describe('未匹配回退', () => {
    it('未知错误应回退到原始消息', () => {
      expect(classifyLlmError('some unknown weird error')).toBe('some unknown weird error');
    });

    it('空字符串应返回未知错误', () => {
      expect(classifyLlmError('')).toBe('未知错误');
    });

    it('null/undefined 应返回未知错误（类型宽松处理）', () => {
      // 实际调用方传入 string，但运行时可能传 null/undefined，做兜底处理
      expect(classifyLlmError(null as unknown as string)).toBe('未知错误');
      expect(classifyLlmError(undefined as unknown as string)).toBe('未知错误');
    });
  });
});
