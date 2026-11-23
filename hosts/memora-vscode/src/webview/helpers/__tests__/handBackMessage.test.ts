/**
 * Hand back 消息解析器单元测试（P2 骨架 · 2026-11-17）
 *
 * 设计文档 B6（纯文本固定格式）+ B9（JSON payload 扩展）同源覆盖。
 * 纯函数零宿主依赖，直接测即可。
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  isHandBackMessage,
  parseHandBackMessage,
  formatHandBackMessage,
} from '../handBackMessage.js';

describe('handBackMessage', () => {
  // ── isHandBackMessage：只做前缀判定 ──
  describe('isHandBackMessage', () => {
    it('以 [HAND_BACK] 开头 → true', () => {
      expect(isHandBackMessage('[HAND_BACK] reason: 超出范围')).toBe(true);
    });
    it('不是 [HAND_BACK] 开头 → false', () => {
      expect(isHandBackMessage('[后台命令完成] foo')).toBe(false);
      expect(isHandBackMessage('HAND_BACK reason: x')).toBe(false);
      expect(isHandBackMessage('')).toBe(false);
    });
    it('前导空白（换行 / 空格）不影响识别 → true', () => {
      expect(isHandBackMessage('\n\n[HAND_BACK] reason: 超出范围')).toBe(true);
      expect(isHandBackMessage('   [HAND_BACK] reason: 超出范围')).toBe(true);
    });
    it('正文先说话 / 代码围栏包裹 → false（必须在最前，保持协议严格）', () => {
      expect(isHandBackMessage('已完成盘点。[HAND_BACK] reason: x')).toBe(false);
      expect(isHandBackMessage('```\n[HAND_BACK] reason: x\n```')).toBe(false);
    });
  });

  // ── parseHandBackMessage：纯文本版（B6） ──
  describe('parseHandBackMessage · 纯文本', () => {
    it('只有 reason → 解析成功', () => {
      const result = parseHandBackMessage('[HAND_BACK] reason: Worker 超出边界');
      expect(result).toEqual({ reason: 'Worker 超出边界' });
    });
    it('reason + suggestion → 两个字段都取到', () => {
      const result = parseHandBackMessage(
        '[HAND_BACK] reason: 超出范围 | suggestion: 应该新建会话',
      );
      expect(result).toEqual({
        reason: '超出范围',
        suggestion: '应该新建会话',
      });
    });
    it('字段顺序不固定也能解析（reason 放后面）', () => {
      const result = parseHandBackMessage('[HAND_BACK] suggestion: 新建会话 | reason: 超出范围');
      expect(result?.reason).toBe('超出范围');
      expect(result?.suggestion).toBe('新建会话');
    });
    it('reason 缺失 → null（不合法 Hand back）', () => {
      const result = parseHandBackMessage('[HAND_BACK] suggestion: x');
      expect(result).toBeNull();
    });
    it('空 body → null', () => {
      expect(parseHandBackMessage('[HAND_BACK]')).toBeNull();
    });
    it('未知字段 → 忽略（未来扩张）', () => {
      const result = parseHandBackMessage('[HAND_BACK] reason: x | unknown: y');
      expect(result).toEqual({ reason: 'x' });
    });
    it('前导换行 / 空格仍能解析出 reason（真机常见流式空白）', () => {
      expect(parseHandBackMessage('\n\n[HAND_BACK] reason: 超出边界')).toEqual({
        reason: '超出边界',
      });
      expect(parseHandBackMessage('  [HAND_BACK] reason: 超出边界 | suggestion: 新建')).toEqual({
        reason: '超出边界',
        suggestion: '新建',
      });
    });
  });

  // ── parseHandBackMessage：JSON payload 版（B9） ──
  describe('parseHandBackMessage · payload（B9 扩张）', () => {
    it('合法 JSON payload → 解析成对象', () => {
      const result = parseHandBackMessage(
        '[HAND_BACK] reason: 超出范围 | payload: {"action":"new_ticket","type":"docs"}',
      );
      expect(result).toEqual({
        reason: '超出范围',
        payload: { action: 'new_ticket', type: 'docs' },
      });
    });
    it('非法 JSON payload → 不崩，当普通字符串存 _raw', () => {
      const result = parseHandBackMessage('[HAND_BACK] reason: x | payload: {not json');
      expect(result?.payload).toEqual({ _raw: '{not json' });
    });
    it('三字段同时存在 → 全部取到', () => {
      const result = parseHandBackMessage(
        '[HAND_BACK] reason: x | suggestion: y | payload: {"a":1}',
      );
      expect(result).toEqual({
        reason: 'x',
        suggestion: 'y',
        payload: { a: 1 },
      });
    });
  });

  // ── formatHandBackMessage：反向格式化 ──
  describe('formatHandBackMessage', () => {
    it('只有 reason → 纯文本', () => {
      expect(formatHandBackMessage({ reason: '超出范围' })).toBe('[HAND_BACK] reason: 超出范围');
    });
    it('reason + suggestion → 追加字段', () => {
      expect(
        formatHandBackMessage({
          reason: '超出范围',
          suggestion: '新建会话',
        }),
      ).toBe('[HAND_BACK] reason: 超出范围 | suggestion: 新建会话');
    });
    it('有 payload → 输出 JSON 字符串', () => {
      expect(
        formatHandBackMessage({
          reason: 'x',
          payload: { action: 'new_ticket' },
        }),
      ).toBe('[HAND_BACK] reason: x | payload: {"action":"new_ticket"}');
    });
  });

  // ── 往返一致性：format → parse 必须同源 ──
  describe('format → parse 往返一致', () => {
    it('纯文本版', () => {
      const original = {
        reason: '超出边界',
        suggestion: '应该拆成两条活',
      };
      const formatted = formatHandBackMessage(original);
      const parsed = parseHandBackMessage(formatted);
      expect(parsed).toEqual(original);
    });
    it('payload 版', () => {
      const original = {
        reason: '需要更多信息',
        payload: { action: 'ask_user', question: 'A 还是 B?' },
      };
      const formatted = formatHandBackMessage(original);
      const parsed = parseHandBackMessage(formatted);
      expect(parsed).toEqual(original);
    });
  });
});
