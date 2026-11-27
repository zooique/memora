/**
 * 配对连接串（v1）构造与可用性判定的单测
 *
 * 锁定三件事：
 *   ① base64url 转换（`+` `/` `=` 必须消失，手机据此还原标准 base64）；
 *   ② 过期 / 地址不可用时**不产出**连接串（页面据此隐藏，而不是给一条必然失败的串）；
 *   ③ 字段名与版本前缀稳定（手机解析器按前缀 fail-closed）。
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

/**
 * 构造最小句柄桩（只填配对串用到的字段，其余以 unknown 收口）
 *
 * @param options 覆盖项
 */
function makeHandle(options: {
  address?: string;
  code?: string;
  expiresAt?: number;
}): RemoteLanHandle {
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
    pairing: {
      current: () => ({
        code: options.code ?? '123456',
        expiresAt: options.expiresAt ?? 4102444800000,
      }),
    },
  } as unknown as RemoteLanHandle;
}

describe('buildPairingLink', () => {
  it('固定版本前缀与字段名，pin 转 base64url 且去 padding', () => {
    const link = buildPairingLink({
      address: '192.168.1.9',
      port: 41234,
      certDerBase64: DER_BASE64,
      code: '123456',
      shortFp: 'ABCD-1234',
      expiresAt: 4102444800000,
    });
    expect(link.startsWith('memora-pair://v1?')).toBe(true);
    const url = new URL(link);
    expect(url.searchParams.get('h')).toBe('192.168.1.9');
    expect(url.searchParams.get('p')).toBe('41234');
    expect(url.searchParams.get('pin')).toBe('-_--7wECAwQ');
    expect(url.searchParams.get('c')).toBe('123456');
    expect(url.searchParams.get('fp')).toBe('ABCD-1234');
    expect(url.searchParams.get('e')).toBe('4102444800000');
  });
});

describe('pairingMaterialOfHandle', () => {
  it('页面口令与串内口令同源（一次读取，杜绝新旧码错配）', () => {
    const material = pairingMaterialOfHandle(makeHandle({ code: '654321' }), 1);
    expect(material?.challenge.code).toBe('654321');
    expect(new URL(material!.link).searchParams.get('c')).toBe('654321');
  });
});

describe('pairingLinkOfHandle', () => {
  it('口令有效且地址可用：产出连接串', () => {
    const link = pairingLinkOfHandle(makeHandle({}), 1);
    expect(link).toContain('memora-pair://v1?');
  });

  it('口令过期：不产出', () => {
    const handle = makeHandle({ expiresAt: 1000 });
    expect(pairingLinkOfHandle(handle, 1000)).toBeUndefined();
  });

  it('地址为 0.0.0.0（绑定全部网卡）：手机拨不到，不产出', () => {
    expect(pairingLinkOfHandle(makeHandle({ address: '0.0.0.0' }), 1)).toBeUndefined();
  });
});
