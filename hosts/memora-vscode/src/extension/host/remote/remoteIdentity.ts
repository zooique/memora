/**
 * PC 长期身份（L1 身份层）—— 自签证书 + 私钥的生成、持久化与指纹派生
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §19.9（E2EE 定案）：L1 = TLS 1.3 双向自签证书（ECDSA P-256），
 *     身份 = 证书 DER 的 SHA-256 指纹，信任来自「指纹固定」而非 CA
 *   - §5.4：`pcFp` = 证书 DER 的 SHA-256 前 8 hex，分 2 组展示（`AB12-CD34`）
 *   - §5.7：PC 长期私钥只放 `context.secrets`（VS Code SecretStorage），
 *     绝不写进工作区 `.memora` 目录 / 日志
 *
 * 为什么要有本文件：证书与私钥是「这台 PC 是谁」的唯一载体；生成、落库、读回必须只有
 * 一份实现，否则宿主 / 桥 / UI 各自算一套身份，设备表对不上。指纹派生本身已外置到
 * `remoteFingerprint.ts`（不碰证书库），本文件只消费它。
 *
 * 边界：
 *   - 只做身份材料（生成 / 读写 / 指纹），**不做配对、不做连接判定**；
 *   - 不 import vscode：SecretStorage 经 `RemoteIdentitySecretStore` 窄接口注入；
 *   - 损坏数据必须**重建**（不可抛错拖死宿主激活），这是本文件唯一的容错承诺。
 */

// ⚠️ 必须是第一条 import：@peculiar/x509 依赖 tsyringe，tsyringe 需要 reflect-metadata
// 先完成 Reflect 元数据扩展（缺它时运行期报 Reflect.getMetadata 不存在）。
import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import { X509Certificate, X509CertificateGenerator } from '@peculiar/x509';
import { fingerprintOfCertDer, shortFingerprint } from './remoteFingerprint.js';

/** PC 身份（落库形态 + 派生指纹） */
export interface RemoteIdentity {
  /** 私钥 PEM（pkcs8；只允许进 SecretStorage，禁止落盘到工作区） */
  keyPem: string;
  /** 自签证书 PEM（公开材料，可随配对流程展示） */
  certPem: string;
  /**
   * 证书 DER 的标准 base64（公开材料；手机 `PinnedTlsClient` 的等值固定输入）
   *
   * 为什么落成字段而不是让消费方从 PEM 现场剥：剥离规则（头尾标签 / 换行）只该有一份，
   * 散在配对串构造、测试、未来二维码里必然漂移。
   */
  certDerBase64: string;
  /** 证书 DER 的 SHA-256（全大写 hex，64 字符）——设备指纹的长形态 */
  fingerprint: string;
  /** 指纹短码（前 8 hex，`AB12-CD34`）——UI / 日志展示用 */
  shortFp: string;
}

/** SecretStorage 窄接口（vscode.secrets 的适配面；本模块不 import vscode） */
export interface RemoteIdentitySecretStore {
  /** 读密钥材料（不存在 = undefined） */
  get(key: string): Promise<string | undefined>;
  /** 写密钥材料（覆盖写） */
  store(key: string, value: string): Promise<void>;
}

/** SecretStorage 里的键名（v1：结构变更须换键，避免旧结构被误读） */
export const REMOTE_IDENTITY_SECRET_KEY = 'memora.remote.identity.v1';

/** 证书 Subject（固定名：只是可读标识，身份判据仍是 DER 指纹） */
const IDENTITY_SUBJECT = 'CN=memora-remote';

/** 证书有效期（10 年；到期后按「指纹已变化」重新配对，不在此自动轮换） */
const IDENTITY_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** 私钥 PEM 每行 base64 宽度（PEM 规范惯例，非判据） */
const PEM_LINE_WIDTH = 64;

/**
 * 读取或创建 PC 身份
 *
 * 读：SecretStorage 里是 JSON `{keyPem, certPem}`；指纹每次都从证书 DER 重算
 * （不信任库里的派生值，避免「证书换了、指纹没换」的静默不一致）。
 * 缺失 / JSON 损坏 / 证书无法解析 ⇒ 生成新身份并覆盖写入，**不抛错**。
 *
 * @param store SecretStorage 窄接口
 * @param log   日志口（损坏重建 / 新建时留痕；缺省静默）
 */
export async function loadOrCreateRemoteIdentity(
  store: RemoteIdentitySecretStore,
  log: (message: string) => void = () => undefined,
): Promise<RemoteIdentity> {
  const raw = await store.get(REMOTE_IDENTITY_SECRET_KEY);
  const existing = parseStoredIdentity(raw, log);
  if (existing) return existing;

  const identity = await createIdentity();
  await store.store(
    REMOTE_IDENTITY_SECRET_KEY,
    JSON.stringify({ keyPem: identity.keyPem, certPem: identity.certPem }),
  );
  log(`[REMOTE-IDENTITY] 已生成新的 PC 身份证书（短指纹 ${identity.shortFp}）`);
  return identity;
}

/**
 * 解析库里的身份 JSON（任何一步不成立都返回 undefined，由调用方重建）
 *
 * @param raw SecretStorage 原文
 * @param log 日志口（损坏原因留痕）
 */
function parseStoredIdentity(
  raw: string | undefined,
  log: (message: string) => void,
): RemoteIdentity | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('不是对象');
    const { keyPem, certPem } = parsed as { keyPem?: unknown; certPem?: unknown };
    if (typeof keyPem !== 'string' || keyPem.length === 0) throw new Error('keyPem 缺失');
    if (typeof certPem !== 'string' || certPem.length === 0) throw new Error('certPem 缺失');
    // 证书必须能解析：解析失败即视为损坏（不能把坏证书继续喂给 tls.createServer）
    const cert = new X509Certificate(certPem);
    const der = new Uint8Array(cert.rawData);
    const fingerprint = fingerprintOfCertDer(der);
    return {
      keyPem,
      certPem,
      certDerBase64: Buffer.from(der).toString('base64'),
      fingerprint,
      shortFp: shortFingerprint(fingerprint),
    };
  } catch (err) {
    log(`[REMOTE-IDENTITY] 已存身份损坏，将重建：${String(err)}`);
    return undefined;
  }
}

/**
 * 生成新身份（ECDSA P-256 自签证书 + pkcs8 私钥 PEM）
 *
 * 私钥必须是 extractable=true：需要导出 pkcs8 后落 SecretStorage；
 * 证书只用于 TLS 与指纹，不声明 CA / 扩展密钥用途（自签 + 指纹固定，不走链校验）。
 */
async function createIdentity(): Promise<RemoteIdentity> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const cert = await X509CertificateGenerator.createSelfSigned({
    name: IDENTITY_SUBJECT,
    keys,
    notBefore: new Date(),
    notAfter: new Date(Date.now() + IDENTITY_VALIDITY_MS),
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = toPem(Buffer.from(pkcs8).toString('base64'), 'PRIVATE KEY');
  const certPem = cert.toString();
  const der = new Uint8Array(cert.rawData);
  const fingerprint = fingerprintOfCertDer(der);
  return {
    keyPem,
    certPem,
    certDerBase64: Buffer.from(der).toString('base64'),
    fingerprint,
    shortFp: shortFingerprint(fingerprint),
  };
}

/**
 * base64 → PEM（64 列换行 + 头尾标签）
 *
 * @param base64 base64 正文（不含换行）
 * @param label  PEM 标签（如 `PRIVATE KEY`）
 */
function toPem(base64: string, label: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += PEM_LINE_WIDTH) {
    lines.push(base64.slice(i, i + PEM_LINE_WIDTH));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
