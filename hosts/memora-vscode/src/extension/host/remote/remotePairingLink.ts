/**
 * 配对连接串（v2）—— PC 把「地址 + 证书 + 一次性口令 + 客户端身份」交给手机的**唯一交付面**
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §16.2（TLS + 配对 + 审计六项底线）
 *   - §19.9（手机端按服务端证书 DER 等值固定，见 `memora-mobile` 的 `PinnedTlsClient`）
 *
 * 为什么需要连接串：手机要建 mTLS 连接，除了 host/port 还必须拿到**服务端证书 DER**
 * （等值固定，比指纹更严格）。DER 约 1KB，无法手抄；手工只搬 8 位短指纹又建不了 pin。
 * 本模块产出一个可复制（未来可扫码）的单行串，把材料与有效期一次交付。
 *
 * 为什么 v2 加上客户端身份（一次授权 · 永久重连）：
 *   - 设备身份 = **客户端证书**的 DER 指纹（服务端只认这个，不验 CA 链）；
 *   - 手机端在「零第三方依赖」约束下无法自行铸造 X.509 证书，故由 PC 用同一铸造面
 *     （`remoteIdentity.createRemoteIdentity`）代铸一份**一次性客户端身份**；
 *   - 手机把 key/cert 存进应用私有目录，首次 hello 走「口令 + PC 人工批准」，
 *     之后每次连接只出示同一张证书 ⇒ 设备表命中即放行，不再弹窗、不再要口令。
 *
 * 格式（v2，手机解析器 `lib/src/contract/pairing_link.dart` 只消费、不发明）：
 *   memora-pair://v2?h=<host>&p=<port>&pin=<base64url(DER)>&c=<口令>&fp=<短指纹>&e=<过期 epoch ms>
 *                   &ck=<base64url(客户端私钥 PEM)>&cc=<base64url(客户端证书 PEM)>&cfp=<客户端证书指纹>
 *   - `pin` / `ck` / `cc` 一律 base64url 且去尾部 `=`：避免 `+` `/` `=` 在 URI/二维码里的转义损耗；
 *   - `e` 与配对口令同一个过期时刻：链接不会比口令活得更久；
 *   - `cfp` = 客户端证书 DER 的 SHA-256（全大写 hex），供手机原样填进 `hello.phoneFp`
 *     （手机侧无需自带 SHA-256 实现；真值仍以 TLS 证书为准，宿主会逐字比对）。
 *
 * 🔴 安全纪律：连接串含**一次性口令**（短时有效）+ **客户端私钥**。
 *   - **一次配对码 = 一把客户端身份 = 一台手机**（最多登记 3 台，见 `remoteDevices`）：
 *     给第二台手机配对时必须重新生成配对码，不能把同一条串导入多台（那样三台共用一个指纹，
 *     设备表只有一行、撤销一台等于全断）。
 *   - 禁止写入日志 / 审计 / 错误信息（口令与私钥会随日志长期留存）；
 *   - 只允许用户主动复制（剪贴板）；视为一次性秘密——配对完成后手机本地留存，
 *     PC 端不持久化该身份（换代即丢，手机已保存的那份不受影响）。
 */
import type { RemoteLanHandle } from './remoteBridgeHost.js';
import type { PairingChallenge } from './remotePairing.js';
import type { PublicAddress } from './remotePublicAddress.js';

/** 连接串前缀（版本写进路径，解析方按前缀 fail-closed；v1 已废弃） */
export const PAIRING_LINK_PREFIX = 'memora-pair://v2';

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
  /** 一次性客户端私钥 PEM（交给手机保存，永不出现在日志 / 审计里） */
  clientKeyPem: string;
  /** 一次性客户端证书 PEM（与私钥成对） */
  clientCertPem: string;
  /** 客户端证书 DER 的 SHA-256（全大写 hex；手机原样作为 `hello.phoneFp`） */
  clientFingerprint: string;
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
 * 文本 → base64url（UTF-8 编码后转义；PEM 含换行，必须走这条路而不是裸拼）
 *
 * @param value 原文（如 PEM）
 */
function textToBase64Url(value: string): string {
  return toBase64Url(Buffer.from(value, 'utf8').toString('base64'));
}

/**
 * 构造 v2 配对连接串
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
    ck: textToBase64Url(input.clientKeyPem),
    cc: textToBase64Url(input.clientCertPem),
    cfp: input.clientFingerprint,
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
 * 客户端身份取自句柄（与当前口令同代，一次配对码一把）：生成新口令**同时换**客户端身份——
 * 每台手机必须拿到独立证书，才能在设备表里各占一行、各自撤销。换代窗口内（异步铸证未完成）
 * 不产出连接串，宁可页面短暂隐藏，也不给「新口令 + 旧身份」的错配组合。
 *
 * 对外地址覆盖只来自第三参（已由 `normalizePublicAddress` 校验），缺省时逐字走旧路径——
 * 现有两参调用面（含命令面板）行为不变，这是本切片的「不带伤」边界。
 *
 * @param handle        LAN 运行时句柄
 * @param now           当前时刻（测试可注入；缺省取系统时间）
 * @param publicAddress 用户配置的对外地址（可覆盖 h / p；端口缺省沿用桥监听端口）
 */
export function pairingMaterialOfHandle(
  handle: RemoteLanHandle,
  now: number = Date.now(),
  publicAddress?: PublicAddress,
): PairingMaterial | undefined {
  const challenge = handle.pairing.current();
  if (!challenge || challenge.expiresAt <= now) return undefined;
  const address = publicAddress?.host ?? handle.address;
  const port = publicAddress?.port ?? handle.port;
  // `0.0.0.0` 是「监听全部网卡」的绑定值，不是手机能拨的地址
  if (!address || address === '0.0.0.0') return undefined;
  // 口令与身份必须同代：换代期间（challengeCode 已变、铸证未回）不产出
  const pairingIdentity = handle.pairingIdentity;
  if (pairingIdentity.challengeCode !== challenge.code) return undefined;
  return {
    challenge,
    link: buildPairingLink({
      address,
      port,
      certDerBase64: handle.identity.certDerBase64,
      code: challenge.code,
      shortFp: handle.identity.shortFp,
      expiresAt: challenge.expiresAt,
      clientKeyPem: pairingIdentity.identity.keyPem,
      clientCertPem: pairingIdentity.identity.certPem,
      clientFingerprint: pairingIdentity.identity.fingerprint,
    }),
  };
}

/**
 * 从 LAN 句柄取当前可用的配对连接串（只需要串的调用方用这个薄委托）
 *
 * @param handle        LAN 运行时句柄
 * @param now           当前时刻（测试可注入）
 * @param publicAddress 用户配置的对外地址（缺省走旧路径）
 */
export function pairingLinkOfHandle(
  handle: RemoteLanHandle,
  now: number = Date.now(),
  publicAddress?: PublicAddress,
): string | undefined {
  return pairingMaterialOfHandle(handle, now, publicAddress)?.link;
}
