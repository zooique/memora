/**
 * 设备 / PC 指纹的纯函数族（无证书库依赖）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §19.9：身份 = 证书 DER 的 SHA-256 指纹（信任来自指纹固定，不来自 CA）
 *   - §5.4：`pcFp` / `phoneFp` 的展示短码 = 前 8 hex，分 2 组（`AB12-CD34`）
 *   - §5.7：指纹是设备表 / 白名单 / 握手比对的**唯一判据**，全仓必须同一形态
 *
 * 为什么单独成文件：`remoteIdentity.ts` 为了生成证书，静态依赖
 * `@peculiar/x509` 与 `reflect-metadata`；而**扩展激活路径**（`extension.ts` →
 * `remoteBridgeHost` → 桥核心）只需要指纹的字符串变换。若指纹实现留在
 * `remoteIdentity.ts`，每次激活都会把整条证书栈拖进扩展宿主进程——远程桥未开时
 * 这笔加载成本纯属浪费。故把「不碰证书库」的纯函数切出来，让激活链路只引本文件。
 *
 * 边界：
 *   - 只做指纹的**派生与形态归一**，不读盘、不验签、不判配对；
 *   - 不 import `@peculiar/x509` / `reflect-metadata` / 任何证书库；
 *   - `shortFingerprint` 只承担展示职责，任何授权判据必须用全长指纹。
 */

import { createHash } from 'node:crypto';

/**
 * 证书 DER → SHA-256 指纹（全大写 hex，64 字符）
 *
 * 指纹是身份的**唯一判据**：设备表、白名单、`phoneFp` / `pcFp` 全用同一形态。
 *
 * @param der 证书 DER 字节
 * @returns 64 位大写 hex
 */
export function fingerprintOfCertDer(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex').toUpperCase();
}

/**
 * 长指纹 → 短码（前 8 hex，`AB12-CD34`）
 *
 * 只承担**展示**职责（人工比对 / 日志），不承担任何判据职责——判据永远用全长指纹。
 * 非 hex 字符会被剔除（容忍用户手抄时带入分隔符），大小写不敏感。
 *
 * @param fingerprint 全长指纹（任意大小写；非 hex 字符忽略）
 * @returns 短码（长度不足时按实际 hex 位数截断，不抛错）
 */
export function shortFingerprint(fingerprint: string): string {
  const hex = fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/**
 * 指纹归一（去首尾空白 + 全大写）
 *
 * 设备表写入 / 查询与握手比对共用同一形态，避免「小写存进去、大写查不到」。
 * 只做形态归一，不剔除内部字符（全长指纹的合法性由证书派生保证）。
 *
 * @param fingerprint 原始指纹
 * @returns 归一后的指纹
 */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().toUpperCase();
}
