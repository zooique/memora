/**
 * capabilityState — 能力面三态判定的**唯一出口**（`CAP-TRISTATE-1`）
 *
 * 职责：把内核角色包的 `capabilities` 原值（`undefined` / `[]` / 非空）判定为
 * `CapabilityStateDto`，供 host 推送协议（`capability_badge` / `roles_loaded`）使用。
 *
 * **为什么必须单点**：三态一旦在两处各自判 `length`，两份语义从落笔即漂移——
 * 上一轮的真机缺陷正是「显式空 `[]`」被显示层折叠成「全部工具」。
 * 因此本模块是唯一判定点：调用方只消费判定结果，禁止再判 `length`。
 *
 * 边界：纯函数、零状态、不读 DOM、不发消息（可在 extension host 与 webview 侧复用）。
 *
 * @module capabilityState
 */

import type { CapabilityStateDto } from '../../shared/protocol.js';
import { capabilityLabel } from './capabilityLabels.js';

/** 能力项的最小结构（内核角色包能力项的只读子集，不绑定内核类型） */
export interface CapabilityLike {
  /** 中立能力名「域:动作」，如 `web:search` */
  capability: string;
}

/**
 * 判定能力面三态。
 *
 * @param capabilities 内核角色包的 `capabilities` 原值（`undefined` = 未声明，`[]` = 显式空）
 * @param label 能力名 → 展示文案的投影（缺省用 `capabilityLabel`；输入区徽章传域级短标签）
 * @returns 已判定的三态 DTO（webview 只按 `kind` 分支渲染）
 */
export function deriveCapabilityState(
  capabilities: readonly CapabilityLike[] | undefined,
  label: (capability: string) => string = capabilityLabel,
): CapabilityStateDto {
  // 未声明（字段缺失）= 放行全部工具
  if (capabilities === undefined) return { kind: 'all' };
  // 显式空 = 仅常驻工具（与「未声明」严格区分，不可折叠）
  if (capabilities.length === 0) return { kind: 'residentOnly' };
  // 非空 = 白名单，label 在此统一翻译（各显示面只拿结果，不再自行映射）
  return {
    kind: 'list',
    capabilities: capabilities.map((c) => ({
      capability: c.capability,
      label: label(c.capability),
    })),
  };
}
