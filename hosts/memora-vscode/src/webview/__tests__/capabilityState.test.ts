/**
 * capabilityState 单测 — 能力面三态判定的唯一出口（`CAP-TRISTATE-1`）
 *
 * 守护点：`undefined` / `[]` / 非空 必须判成**三个不同分支**，不得折叠。
 * 这是上一轮真机缺陷的根因面（显式空被显示层折叠成「全部工具」），
 * 因此判定必须钉在唯一出口，而不是靠下游各显示面自觉。
 */

import { describe, expect, it } from 'vitest';
import { deriveCapabilityState } from '../helpers/capabilityState.js';

describe('deriveCapabilityState（三态判定唯一出口）', () => {
  it('未声明（undefined）→ all（放行全部工具）', () => {
    expect(deriveCapabilityState(undefined)).toEqual({ kind: 'all' });
  });

  it('显式空（[]）→ residentOnly（仅常驻工具，不得折叠成 all）', () => {
    expect(deriveCapabilityState([])).toEqual({ kind: 'residentOnly' });
  });

  it('非空白名单 → list，label 走缺省映射（capabilityLabel）', () => {
    expect(deriveCapabilityState([{ capability: 'file:read' }])).toEqual({
      kind: 'list',
      capabilities: [{ capability: 'file:read', label: 'Read files' }],
    });
  });

  it('未知能力不硬造文案：label 回退原始能力名', () => {
    expect(deriveCapabilityState([{ capability: 'unknown:thing' }])).toEqual({
      kind: 'list',
      capabilities: [{ capability: 'unknown:thing', label: 'unknown:thing' }],
    });
  });

  it('可注入自定义标签投影（输入区徽章用域级短标签）', () => {
    const domainLabel = (capability: string): string => capability.split(':')[0]!;
    expect(deriveCapabilityState([{ capability: 'web:search' }], domainLabel)).toEqual({
      kind: 'list',
      capabilities: [{ capability: 'web:search', label: 'web' }],
    });
  });
});
