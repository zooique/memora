/**
 * 设备菜单文案层单测 —— 档位话术 / 条目顺序 / 高风险判定 / 确认文案
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §5.9（三档话术与默认最小）
 */
import { describe, expect, it } from 'vitest';
import type { RemoteDeviceRecord } from '../remoteDevices.js';
import {
  buildConfirm,
  buildDeviceActions,
  buildDeviceList,
  deviceMenuLabel,
  requiresConfirmation,
  tierLabel,
  TIER_LABELS,
} from '../remoteDeviceMenu.js';

/** 构造一条设备记录（短码由指纹前缀派生，形态与真实设备表一致） */
function device(
  name: string,
  tier: RemoteDeviceRecord['tier'],
  shortFp = 'AB12-CD34',
): RemoteDeviceRecord {
  return {
    fingerprint: `${shortFp.replace('-', '')}${'0'.repeat(56)}`,
    shortFp,
    name,
    tier,
    pairedAt: 1,
  };
}

describe('remoteDeviceMenu — 档位话术', () => {
  it('三档映射为只读 / 可发 / 可答', () => {
    expect(TIER_LABELS).toEqual({ observe: '只读', send: '可发', approve: '可答' });
    expect(tierLabel('observe')).toBe('只读');
    expect(tierLabel('send')).toBe('可发');
    expect(tierLabel('approve')).toBe('可答');
  });
});

describe('remoteDeviceMenu — 第一层列表', () => {
  it('生成口令项固定在前，设备项按设备表顺序紧随其后', () => {
    const items = buildDeviceList([
      device('手机一', 'observe'),
      device('手机二', 'approve', 'CD34-EF56'),
    ]);
    expect(items.map((item) => item.selection.kind)).toEqual(['regenerate', 'device', 'device']);
    expect(items[1].label).toBe('手机一 · AB12-CD34');
    expect(items[1].description).toBe('只读');
    expect(items[2].label).toBe('手机二 · CD34-EF56');
    expect(items[2].description).toBe('可答');
  });

  it('设备列表为空时仍保留生成口令项', () => {
    const items = buildDeviceList([]);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('生成新的配对口令');
    expect(items[0].selection).toEqual({ kind: 'regenerate' });
  });

  it('短码缺失时标签不出现尾随分隔符', () => {
    expect(deviceMenuLabel(device('无短码手机', 'observe', ''))).toBe('无短码手机');
  });
});

describe('remoteDeviceMenu — 第二层动作', () => {
  it('四个动作顺序固定，且带目标指纹与档位', () => {
    const actions = buildDeviceActions('FINGERPRINT-X');
    expect(actions.map((item) => item.selection)).toEqual([
      { kind: 'set_tier', fingerprint: 'FINGERPRINT-X', tier: 'observe' },
      { kind: 'set_tier', fingerprint: 'FINGERPRINT-X', tier: 'send' },
      { kind: 'set_tier', fingerprint: 'FINGERPRINT-X', tier: 'approve' },
      { kind: 'revoke', fingerprint: 'FINGERPRINT-X' },
    ]);
    expect(actions.map((item) => item.label)).toEqual([
      '改为只读',
      '改为可发',
      '改为可答（可答审批 / 回答提问）',
      '撤销配对',
    ]);
  });

  it('只有可答授权与撤销配对需要模态确认', () => {
    expect(requiresConfirmation({ kind: 'set_tier', fingerprint: 'F', tier: 'observe' })).toBe(
      false,
    );
    expect(requiresConfirmation({ kind: 'set_tier', fingerprint: 'F', tier: 'send' })).toBe(false);
    expect(requiresConfirmation({ kind: 'set_tier', fingerprint: 'F', tier: 'approve' })).toBe(
      true,
    );
    expect(requiresConfirmation({ kind: 'revoke', fingerprint: 'F' })).toBe(true);
  });

  it('确认文案带设备名与短码，且覆盖两种高风险动作', () => {
    const target = device('我的手机', 'observe', 'AB12-CD34');
    const approve = buildConfirm(target, {
      kind: 'set_tier',
      fingerprint: target.fingerprint,
      tier: 'approve',
    });
    expect(approve.message).toContain('我的手机');
    expect(approve.message).toContain('可答');
    expect(approve.confirmLabel).toBe('改为可答');

    const revoke = buildConfirm(target, { kind: 'revoke', fingerprint: target.fingerprint });
    expect(revoke.message).toContain('我的手机');
    expect(revoke.detail).toContain('AB12-CD34');
    expect(revoke.confirmLabel).toBe('撤销配对');
  });
});
