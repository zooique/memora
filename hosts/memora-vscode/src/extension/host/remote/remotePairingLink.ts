/**
 * 配对连接串（v1）—— PC 把「地址 + 证书 + 一次性口令」交给手机的**唯一交付面**
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §16.2（TLS + 配对 + 审计六项底线）
 *   - §19.9（手机端按服务端证书 DER 等值固定，见 `memora-mobile` 的 `PinnedTlsClient`）
 *
 * 为什么需要连接串：手机要建 mTLS 连接，除了 host/port 还必须拿到**服务端证书 DER**
 * （等值固定，比指纹更严格）。DER 约 1KB，无法手抄；手工只搬 8 位短指纹又建不了 pin。
 * 本模块产出一个可复制（未来可扫码）的单行串，把三样材料和有效期一次交付。
 *
 * 格式（v1，手机解析器 `lib/src/contract/pairing_link.dart` 只消费、不发明）：
 *   memora-pair://v1?h=<host>&p=<port>&pin=<base64url(DER)>&c=<口令>&fp=<短指纹>&e=<过期 epoch ms>
 *   - `pin` 用 base64url 且去尾部 `=`：避免 `+` `/` `=` 在 URI/二维码里的转义损耗；
 *   - `e` 与配对口令同一个过期时刻：链接不会比口令活得更久。
 *
 * 🔴 安全纪律：连接串里含**一次性口令**（短时有效）+ 证书（公开）。
 *   - 禁止写入日志 / 审计 / 错误信息（口令会随日志长期留存）；
 *   - 只允许用户主动复制（剪贴板）或后续本地二维码展示。
 */
import type { RemoteLanHandle } from './remoteBridgeHost.js';
import type { PairingChallenge } from './remotePairing.js';

/** 连接串前缀（版本写进路径，解析方按前缀 fail-closed） */
export const PAIRING_LINK_PREFIX = 'memora-pair://v1';

/** 构造连接串所需材料 */
export interface PairingLinkInput {
  /** 主局域网地址（`0.0.0.0` / 空串视为不可用，调用方应跳过） */
  address: string;
  /** 实际监听端口 */
  port: number;
  /** 服务端证书 DER 的标准 base64 */
  certDerBase64: string;
  /** 一次性配对口令 */
  code: string;
  /** 指纹短码（手机上人工核对用） */
  shortFp: string;
  /** 口径与配对口令一致的过期时刻（epoch ms） */
  expiresAt: number;
}

/**
 * 标准 base64 → base64url（去 padding）
 *
 * @param value 标准 base64 字符串
 */
function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 构造 v1 配对连接串
 *
 * @param input 交付材料
 * @returns 单行连接串（不含换行；可直接写入剪贴板）
 */
export function buildPairingLink(input: PairingLinkInput): string {
  const params = new URLSearchParams({
    h: input.address,
    p: String(input.port),
    pin: toBase64Url(input.certDerBase64),
    c: input.code,
    fp: input.shortFp,
    e: String(input.expiresAt),
  });
  return `${PAIRING_LINK_PREFIX}?${params.toString()}`;
}

/** 一次取齐的配对材料：口令快照与它的连接串**必须来自同一次读取** */
export interface PairingMaterial {
  /** 当前有效口令（含过期时刻） */
  challenge: PairingChallenge;
  /** 与该口令同源的连接串 */
  link: string;
}

/**
 * 从 LAN 句柄取当前可用的配对材料（口令 + 连接串）
 *
 * 为什么合成一次读取：口令可能被「重新生成」替换，分两次 `current()` 会让页面上
 * 显示的口令与连接串里的口令来自不同代（一段必然配不上的组合）。真源读取只此一次。
 *
 * 判定口径与 UI 展示一致：只在「监听已起 + 地址可用 + 口令未过期」时产出；
 * 任一不成立返回 `undefined`（页面据此隐藏，而不是显示一条必然失败的串）。
 *
 * @param handle LAN 运行时句柄
 * @param now    当前时刻（测试可注入；缺省取系统时间）
 */
export function pairingMaterialOfHandle(
  handle: RemoteLanHandle,
  now: number = Date.now(),
): PairingMaterial | undefined {
  const challenge = handle.pairing.current();
  if (!challenge || challenge.expiresAt <= now) return undefined;
  // `0.0.0.0` 是「监听全部网卡」的绑定值，不是手机能拨的地址
  if (!handle.address || handle.address === '0.0.0.0') return undefined;
  return {
    challenge,
    link: buildPairingLink({
      address: handle.address,
      port: handle.port,
      certDerBase64: handle.identity.certDerBase64,
      code: challenge.code,
      shortFp: handle.identity.shortFp,
      expiresAt: challenge.expiresAt,
    }),
  };
}

/**
 * 从 LAN 句柄取当前可用的配对连接串（只需要串的调用方用这个薄委托）
 *
 * @param handle LAN 运行时句柄
 * @param now    当前时刻（测试可注入）
 */
export function pairingLinkOfHandle(
  handle: RemoteLanHandle,
  now: number = Date.now(),
): string | undefined {
  return pairingMaterialOfHandle(handle, now)?.link;
}
