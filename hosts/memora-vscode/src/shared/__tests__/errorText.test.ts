/**
 * 错误文案映射单测（shared/errorText）
 *
 * 治理背景：error 从「只发实时提示条」扩展为「同时落重放轨」后，同一份 category→文案映射被
 * Node 侧（chatPanel 实时）与 webview 侧（chatView 重放）共用 → 收敛到 shared/ 单一真理源。
 *
 * 断言口径 = 收口前后**行为等价**：本次收敛只搬位置、不改语义——特别地 'unknown' 与无 category
 * 都必须回退原始 message（收口前 chatPanel 内联 map 未收录 unknown，走 `?? chunk.message`）。
 * 若在此处给 unknown 补文案 = 静默改既有错误展示行为，本用例即红。
 */
import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage } from '../errorText.js';

describe('friendlyErrorMessage · category → 用户可见文案', () => {
  it('connection → 连接中断文案（保留部分回答提示）', () => {
    expect(friendlyErrorMessage('connection', 'fetch failed')).toBe(
      '对话连接中断，已保留部分回答，请检查网络后重试',
    );
  });

  it('timeout → 超时文案', () => {
    expect(friendlyErrorMessage('timeout', 'LLM request timed out (no response)')).toBe(
      '对话处理超时，请稍后重试',
    );
  });

  it("'unknown' 回退原始 message（收口前内联 map 未收录 unknown，等价性守卫）", () => {
    expect(friendlyErrorMessage('unknown', 'HTTP 500')).toBe('HTTP 500');
  });

  it('无 category（普通错误 / 旧数据）回退原始 message', () => {
    expect(friendlyErrorMessage(undefined, 'HTTP 400: maximum context length exceeded')).toBe(
      'HTTP 400: maximum context length exceeded',
    );
  });

  it('空串 message 不被吞成 falsy 误判（回退路径原样返回）', () => {
    expect(friendlyErrorMessage(undefined, '')).toBe('');
    expect(friendlyErrorMessage('timeout', '')).toBe('对话处理超时，请稍后重试');
  });
});
