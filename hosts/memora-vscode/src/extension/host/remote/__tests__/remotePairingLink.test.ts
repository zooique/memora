/**
 * 配对连接串（v2）构造与可用性判定的单测
 *
 * 锁定四件事：
 *   ① base64url 转换（`pin` 的 `+` `/` `=` 与 PEM 的换行都必须无损往返）；
 *   ② 客户端身份三字段（`ck` / `cc` / `cfp`）取自**与当前口令同代**的身份，
 *      换代后连接串里的身份随之更换（一次配对码 = 一把身份 = 一台设备）；
 *   ③ 口令 / 身份不同代、过期、地址不可用时**不产出**连接串（页面据此隐藏）；
 *   ④ 字段名与版本前缀稳定（手机解析器按前缀 fail-closed）。
 */
import { describe, expect, it } from 'vitest';
import type { RemoteLanHandle } from '../remoteBridgeHost.js';
import {
  buildPairingLink,
  pairingLinkOfHandle,
  pairingMaterialOfHandle,
} from '../remotePairingLink.js';

/** 含 `+` `/` `=` 的标准 base64（来自 fixture 同一份字节） */
const DER_BASE64 = '+/++7wECAwQ=';
/** 客户端私钥 PEM（含换行：锁死 UTF-8 → base64url → 原文的往返） */
const CLIENT_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nAAECAwQ=\n-----END PRIVATE KEY-----\n';
/** 客户端证书 PEM（同上） */
const CLIENT_CERT_PEM = '-----BEGIN CERTIFICATE-----\nBQYHCAk=\n-----END CERTIFICATE-----\n';
/** 客户端证书指纹（全大写 hex） */
const CLIENT_FP = 'A'.repeat(64);
/** 另一代客户端指纹（换代断言用） */
const CLIENT_FP_NEXT = 'B'.repeat(64);

/**
 * 构造最小句柄桩（只填配对串用到的字段，其余以 unknown 收口）
 *
 * @param options 覆盖项
 */
function makeHandle(options: {
  address?: string;
  code?: string;
  expiresAt?: number;
  /** 身份绑定的口令代号（缺省与 `code` 相同）；传不同值模拟「换代窗口」 */
  identityCode?: string;
  /** 客户端身份指纹（换代断言用） */
  clientFingerprint?: string;
}): RemoteLanHandle {
  const code = options.code ?? '123456';
  return {
    address: options.address ?? '192.168.1.9',
    port: 41234,
    identity: {
      keyPem: '',
      certPem: '',
      certDerBase64: DER_BASE64,
      fingerprint: 'F'.repeat(64),
      shortFp: 'ABCD-1234',
    },
    pairingIdentity: {
      challengeCode: options.identityCode ?? code,
      identity: {
        keyPem: CLIENT_KEY_PEM,
        certPem: CLIENT_CERT_PEM,
        certDerBase64: '',
        fingerprint: options.clientFingerprint ?? CLIENT_FP,
        shortFp: 'AAAA-AAAA',
      },
    },
    pairing: {
      current: () => ({ code, expiresAt: options.expiresAt ?? 4102444800000 }),
    },
  } as unknown as RemoteLanHandle;
}

describe('buildPairingLink', () => {
  it('固定 v2 版本前缀与字段名，pin / PEM 转 base64url 且去 padding', () => {
    const link = buildPairingLink({
      address: '192.168.1.9',
      port: 41234,
      certDerBase64: DER_BASE64,
      code: '123456',
      shortFp: 'ABCD-1234',
      expiresAt: 4102444800000,
      clientKeyPem: CLIENT_KEY_PEM,
      clientCertPem: CLIENT_CERT_PEM,
      clientFingerprint: CLIENT_FP,
    });
    expect(link.startsWith('memora-pair://v2?')).toBe(true);
    const url = new URL(link);
    expect(url.searchParams.get('h')).toBe('192.168.1.9');
    expect(url.searchParams.get('p')).toBe('41234');
    expect(url.searchParams.get('pin')).toBe('-_--7wECAwQ');
    expect(url.searchParams.get('c')).toBe('123456');
    expect(url.searchParams.get('fp')).toBe('ABCD-1234');
    expect(url.searchParams.get('e')).toBe('4102444800000');
    expect(url.searchParams.get('cfp')).toBe(CLIENT_FP);
    // PEM 往返：base64url 里不得出现 `+` `/` `=`，解回后逐字等于原文（含换行）
    const keyField = url.searchParams.get('ck') ?? '';
    const certField = url.searchParams.get('cc') ?? '';
    expect(keyField).not.toMatch(/[+/=]/);
    expect(certField).not.toMatch(/[+/=]/);
    const decode = (value: string): string => {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(base64, 'base64').toString('utf8');
    };
    expect(decode(keyField)).toBe(CLIENT_KEY_PEM);
    expect(decode(certField)).toBe(CLIENT_CERT_PEM);
  });
});

describe('pairingMaterialOfHandle', () => {
  it('页面口令与串内口令同源（一次读取，杜绝新旧码错配）', () => {
    const material = pairingMaterialOfHandle(makeHandle({ code: '654321' }), 1);
    expect(material?.challenge.code).toBe('654321');
    expect(new URL(material!.link).searchParams.get('c')).toBe('654321');
  });

  it('一次配对码一把身份：换代后连接串里的客户端身份随之更换', () => {
    const first = pairingMaterialOfHandle(makeHandle({}), 1);
    // 模拟「重新生成配对码」：新口令 + 新身份（代号与新口令一致）
    const second = pairingMaterialOfHandle(
      makeHandle({ code: '222222', clientFingerprint: CLIENT_FP_NEXT }),
      1,
    );
    expect(new URL(first!.link).searchParams.get('cfp')).toBe(CLIENT_FP);
    expect(new URL(second!.link).searchParams.get('cfp')).toBe(CLIENT_FP_NEXT);
    expect(new URL(second!.link).searchParams.get('c')).toBe('222222');
  });

  it('换代窗口（身份代号 ≠ 当前口令）：不产出，避免新码配旧身份', () => {
    const handle = makeHandle({ code: '333333', identityCode: '222222' });
    expect(pairingMaterialOfHandle(handle, 1)).toBeUndefined();
  });
});

describe('pairingLinkOfHandle', () => {
  it('口令有效且地址可用：产出连接串', () => {
    const link = pairingLinkOfHandle(makeHandle({}), 1);
    expect(link).toContain('memora-pair://v2?');
  });

  it('口令过期：不产出', () => {
    const handle = makeHandle({ expiresAt: 1000 });
    expect(pairingLinkOfHandle(handle, 1000)).toBeUndefined();
  });

  it('地址为 0.0.0.0（绑定全部网卡）：手机拨不到，不产出', () => {
    expect(pairingLinkOfHandle(makeHandle({ address: '0.0.0.0' }), 1)).toBeUndefined();
  });
});
