/**
 * 对话正文档位归一化真源测试（CHAT-TEXT-SCALE-1）
 *
 * 钉住三件事：三档白名单精确、未知值回退 normal、缺省即 normal（现状逐字等价）。
 * 变异验证：放宽白名单（回传原值）→ 本文非法值用例真红。
 */
import { describe, it, expect } from 'vitest';
import { CHAT_TEXT_SCALES, DEFAULT_CHAT_TEXT_SCALE, normalizeTextScale } from '../textScale.js';

describe('对话正文档位归一化（唯一真源）', () => {
  it('白名单恰为三档，顺序即 UI 档位顺序', () => {
    expect(CHAT_TEXT_SCALES).toEqual(['small', 'normal', 'large']);
  });

  it('三档原样通过', () => {
    for (const scale of CHAT_TEXT_SCALES) expect(normalizeTextScale(scale)).toBe(scale);
  });

  it('缺省档 = normal = 现状 13px', () => {
    expect(DEFAULT_CHAT_TEXT_SCALE).toBe('normal');
    expect(normalizeTextScale(undefined)).toBe('normal');
  });

  it('未知值 / 非字符串一律回退 normal（不信任配置面与消息面）', () => {
    for (const bad of ['huge', '', 'SMALL', '13px', 13, null, true, {}, ['normal']]) {
      expect(normalizeTextScale(bad)).toBe('normal');
    }
  });
});
