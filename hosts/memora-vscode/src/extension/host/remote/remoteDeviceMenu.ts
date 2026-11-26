/**
 * 远程设备菜单的**纯文案层**（把「档位 → 用户话术」收成唯一真源）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §5.9：权限三档（`observe` 只读 / `send` 可发 / `approve` 可答；配对默认只读）
 *   - §16.2 可后补档「设备撤销与重配」——撤销必须由 PC 侧显式确认
 *
 * 为什么单独成文件：菜单条目与确认框文案属于**用户话术**，与 vscode 的 QuickPick /
 * 模态 API 无关。若文案散在命令实现里，档位改名时就会出现「菜单写可答、提示写审批」
 * 这类两套说法；收成纯模块后可单测，且命令层只剩「弹框 / 写设备表 / 写审计」。
 *
 * 边界：
 *   - 不 import vscode、不读写设备表、不发审计——只产出数据；
 *   - 高风险动作的判定（`requiresConfirmation`）与确认文案（`buildConfirm`）同处本文件，
 *     保证「哪些动作要确认」与「确认说什么」不会各改一半。
 */

import type { RemoteDeviceRecord, RemoteDeviceTier } from './remoteDevices.js';

/** 档位 → 用户话术（唯一真源：菜单、提示、日志均从这里取） */
export const TIER_LABELS: Readonly<Record<RemoteDeviceTier, string>> = {
  observe: '只读',
  send: '可发',
  approve: '可答',
};

/**
 * 档位 → 用户话术
 *
 * @param tier 权限档
 * @returns 三档之一的中文话术（`只读` / `可发` / `可答`）
 */
export function tierLabel(tier: RemoteDeviceTier): string {
  return TIER_LABELS[tier];
}

/**
 * 菜单选中结果（命令层按 `kind` 分派；第二层动作带目标设备指纹）
 *
 * 用判别联合而不是「动作 + 可选字段」：`set_tier` 必须带 tier、`device` 必须带
 * fingerprint，类型上就排除了「选了档位却没目标设备」这类半成品组合。
 */
export type RemoteDeviceMenuSelection =
  | { kind: 'regenerate' }
  | { kind: 'device'; fingerprint: string }
  | { kind: 'set_tier'; fingerprint: string; tier: RemoteDeviceTier }
  | { kind: 'revoke'; fingerprint: string };

/** 高风险动作子集（可答授权 / 撤销配对：必须过模态确认） */
export type HighRiskSelection = Extract<
  RemoteDeviceMenuSelection,
  { kind: 'set_tier' } | { kind: 'revoke' }
>;

/**
 * 一条菜单项（可直接交给 `vscode.window.showQuickPick`）
 *
 * 只声明 QuickPick 需要的三个展示字段 + 本模块自己的分派载荷；宿主层不需要再做映射。
 */
export interface RemoteDeviceMenuItem {
  /** 主行文本 */
  label: string;
  /** 右侧说明（设备项显示当前档位） */
  description?: string;
  /** 附加行（可选） */
  detail?: string;
  /** 选中后命令层的分派依据 */
  selection: RemoteDeviceMenuSelection;
}

/** 设备项的标签（`名称 · AB12-CD34`；短码缺失时只显示名称，避免尾随分隔符） */
export function deviceMenuLabel(device: RemoteDeviceRecord): string {
  return device.shortFp ? `${device.name} · ${device.shortFp}` : device.name;
}

/**
 * 第一层菜单：首项固定为「生成新的配对口令」，其后逐台已配对设备
 *
 * @param devices 设备表当前内容（调用方实时读取，菜单不缓存）
 * @returns 菜单项数组（设备列表为空时仍含生成口令项）
 */
export function buildDeviceList(devices: readonly RemoteDeviceRecord[]): RemoteDeviceMenuItem[] {
  const items: RemoteDeviceMenuItem[] = [
    {
      label: '生成新的配对口令',
      description: '8 位数字 · 5 分钟有效 · 一次即废',
      selection: { kind: 'regenerate' },
    },
  ];
  for (const device of devices) {
    items.push({
      label: deviceMenuLabel(device),
      description: tierLabel(device.tier),
      selection: { kind: 'device', fingerprint: device.fingerprint },
    });
  }
  return items;
}

/**
 * 第二层菜单：对一台设备可执行的动作（顺序固定，便于用户形成肌肉记忆）
 *
 * @param fingerprint 目标设备指纹
 * @returns 四个动作项（档位三档 + 撤销）
 */
export function buildDeviceActions(fingerprint: string): RemoteDeviceMenuItem[] {
  return [
    {
      label: '改为只读',
      description: '只能看会话与轮次，不能发消息或答复',
      selection: { kind: 'set_tier', fingerprint, tier: 'observe' },
    },
    {
      label: '改为可发',
      description: '可发消息、插话、暂停 / 停止',
      selection: { kind: 'set_tier', fingerprint, tier: 'send' },
    },
    {
      label: '改为可答（可答审批 / 回答提问）',
      description: '可批准命令与脚本执行，可回答 AI 提问',
      selection: { kind: 'set_tier', fingerprint, tier: 'approve' },
    },
    {
      label: '撤销配对',
      description: '删除该设备，需重新配对才能再次连接',
      selection: { kind: 'revoke', fingerprint },
    },
  ];
}

/**
 * 该动作是否必须先过模态确认
 *
 * 判据（§5.9）：`approve` 是审批安全边界（confirmCoordinator fail-closed），撤销是
 * 不可逆的信任删除——两者都不能「点一下就生效」。只读 / 可发可逆且不扩大审批面，直接生效。
 *
 * @param selection 菜单选中结果
 * @returns true = 必须走 `confirmModal`
 */
export function requiresConfirmation(
  selection: RemoteDeviceMenuSelection,
): selection is HighRiskSelection {
  if (selection.kind === 'revoke') return true;
  return selection.kind === 'set_tier' && selection.tier === 'approve';
}

/**
 * 高风险动作的确认框文案（唯一来源）
 *
 * @param device    目标设备（用于展示名称与指纹短码）
 * @param selection 已判定为高风险的选中结果
 * @returns 可直接传给 `confirmModal` 的 message / detail / confirmLabel
 */
export function buildConfirm(
  device: RemoteDeviceRecord,
  selection: HighRiskSelection,
): { message: string; detail: string; confirmLabel: string } {
  if (selection.kind === 'revoke') {
    return {
      message: `撤销设备「${device.name}」的配对？`,
      detail: `撤销后该设备（指纹 ${device.shortFp || '未知'}）会被立即拒绝，需重新配对才能连接。`,
      confirmLabel: '撤销配对',
    };
  }
  return {
    message: `将设备「${device.name}」改为可答权限？`,
    detail:
      '可答权限允许这台设备批准命令执行、脚本 / 代码执行，以及回答 AI 提问。' +
      '这是一项高风险授权，请确认对方是你信任的设备。',
    confirmLabel: '改为可答',
  };
}
