/**
 * 安全传输层单测 —— 真 TLS 握手 / 已配对可连 / 未配对被断开 / 指纹映射
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §19.9（双向自签证书 + DER 指纹固定）、
 *   §16.2 G3（直连档必须 TLS）
 *
 * 这里**必须用真 TLS**：证书指纹映射是 Node tls 的行为，假 socket 测不出来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import type { TurnState } from '../../../../shared/protocol.js';
import {
  loadOrCreateRemoteIdentity,
  type RemoteIdentity,
  type RemoteIdentitySecretStore,
} from '../remoteIdentity.js';
import { createRemoteSecureServer, type RemoteSecureServer } from '../remoteSecureServer.js';
import {
  RemoteBridge,
  type RemoteBridgePorts,
  type RemoteBridgeSecurity,
} from '../remoteBridge.js';

/** 内存版 SecretStorage（只为生成测试身份） */
class MemorySecretStore implements RemoteIdentitySecretStore {
  /** 键 → 值 */
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

/** 轮询等待条件成立（证书握手是异步的，事件顺序不能靠 sleep 猜） */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 建一套身份（独立 store，互不影响） */
async function makeIdentity(): Promise<RemoteIdentity> {
  return loadOrCreateRemoteIdentity(new MemorySecretStore());
}

/** 发起一次 TLS 连接（信任服务端自签证书；与手机端行为一致） */
function connectClient(port: number, identity?: RemoteIdentity): TLSSocket {
  return tlsConnect({
    host: '127.0.0.1',
    port,
    rejectUnauthorized: false,
    servername: 'memora-remote',
    ...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}),
  });
}

/** 已启动的 server（afterEach 统一关闭，避免句柄泄漏） */
const opened: RemoteSecureServer[] = [];

afterEach(async () => {
  for (const server of opened.splice(0)) {
    await server.close();
  }
});

describe('RemoteSecureServer — 已配对设备', () => {
  it('已配对手机证书能建立 TLS，且服务端指纹映射正确', async () => {
    const pc = await makeIdentity();
    const phone = await makeIdentity();
    const secure = createRemoteSecureServer({
      identity: pc,
      isPaired: (fingerprint) => fingerprint === phone.fingerprint,
    });
    opened.push(secure);
    const port = await secure.listen({ host: '127.0.0.1', port: 0 });

    // 捕获服务端侧的 TLSSocket（createRemoteSecureServer 的监听先注册，这里能拿到同一对象）
    const captured: TLSSocket[] = [];
    secure.server.on('secureConnection', (socket: TLSSocket) => captured.push(socket));

    const client = connectClient(port, phone);
    await new Promise<void>((resolve, reject) => {
      client.once('secureConnect', () => resolve());
      client.once('error', reject);
    });

    await waitFor(() => captured.length === 1);
    expect(secure.fingerprintOf(captured[0])).toBe(phone.fingerprint);
    // 非连接对象 / 未知对象一律 undefined（不误报已认证）
    expect(secure.fingerprintOf(undefined)).toBeUndefined();
    expect(secure.fingerprintOf({})).toBeUndefined();

    client.destroy();
  });

  it('HTTPS 请求的 req.socket 能查到设备指纹（桥使用的查表路径）', async () => {
    const pc = await makeIdentity();
    const phone = await makeIdentity();
    const secure = createRemoteSecureServer({
      identity: pc,
      isPaired: (fingerprint) => fingerprint === phone.fingerprint,
    });
    opened.push(secure);
    // 模拟桥的用法：在请求侧拿 req.socket 去查指纹（不是握手事件的 socket）
    let requestSocket: unknown;
    secure.server.on('request', (req, res) => {
      requestSocket = req.socket;
      res.end('ok');
    });
    const port = await secure.listen({ host: '127.0.0.1', port: 0 });

    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          key: phone.keyPem,
          cert: phone.certPem,
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(secure.fingerprintOf(requestSocket)).toBe(phone.fingerprint);
  });
});

describe('RemoteSecureServer — 未配对 / 无证书', () => {
  it('未配对手机的证书：握手后被服务端断开，且不登记指纹', async () => {
    const pc = await makeIdentity();
    const phone = await makeIdentity();
    const stranger = await makeIdentity();
    const secure = createRemoteSecureServer({
      identity: pc,
      isPaired: (fingerprint) => fingerprint === phone.fingerprint,
    });
    opened.push(secure);
    const port = await secure.listen({ host: '127.0.0.1', port: 0 });

    const captured: TLSSocket[] = [];
    secure.server.on('secureConnection', (socket: TLSSocket) => captured.push(socket));

    // 未配对：服务端 destroy ⇒ 客户端收到 close（不断言 secureConnect，避免时序抖动）
    await new Promise<void>((resolve, reject) => {
      const client = connectClient(port, stranger);
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('未配对连接没有被断开'));
      }, 3_000);
      client.on('error', () => undefined);
      client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await waitFor(() => captured.length === 1);
    expect(secure.fingerprintOf(captured[0])).toBeUndefined();
  });

  it('客户端不出示证书：同样被断开', async () => {
    const pc = await makeIdentity();
    const secure = createRemoteSecureServer({ identity: pc, isPaired: () => true });
    opened.push(secure);
    const port = await secure.listen({ host: '127.0.0.1', port: 0 });

    const captured: TLSSocket[] = [];
    secure.server.on('secureConnection', (socket: TLSSocket) => captured.push(socket));

    await new Promise<void>((resolve, reject) => {
      const client = connectClient(port);
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('无证书连接没有被断开'));
      }, 3_000);
      client.on('error', () => undefined);
      client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await waitFor(() => captured.length === 1);
    expect(secure.fingerprintOf(captured[0])).toBeUndefined();
  });
});

describe('RemoteSecureServer + RemoteBridge — LAN 组合（真 TLS）', () => {
  it('已配对手机经 wss 握手 → hello_ok（req.socket 指纹映射贯通）', async () => {
    const pc = await makeIdentity();
    const phone = await makeIdentity();
    const secure = createRemoteSecureServer({
      identity: pc,
      isPaired: (fingerprint) => fingerprint === phone.fingerprint,
    });
    opened.push(secure);
    const ports: RemoteBridgePorts = {
      listSessions: () => ({ sessions: [], archivedIds: [], assistantSid: 'assist-1' }),
      hasSession: () => true,
      phaseOf: () => 'idle',
      snapshot: () => ({ state: { phase: 'idle' } as TurnState, rounds: [], pendingQueue: [] }),
      deliverAnswer: () => undefined,
    };
    const security: RemoteBridgeSecurity = {
      fingerprintOf: (socket) => secure.fingerprintOf(socket),
      tierOf: (fingerprint) => (fingerprint === phone.fingerprint ? 'observe' : undefined),
      verifyPasscode: () => 'none',
      requestApproval: async () => false,
      registerDevice: () => undefined,
      rateLimit: {
        check: () => ({ blocked: false, retryAfterMs: 0 }),
        noteFailure: () => ({ blocked: false, retryAfterMs: 0 }),
        noteSuccess: () => undefined,
      },
      audit: () => undefined,
    };
    const bridge = new RemoteBridge(ports, {
      pcId: 'pc-lan',
      port: 0,
      host: '127.0.0.1',
      server: secure.server,
      security,
    });
    const { port } = await bridge.start();
    try {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, {
        key: phone.keyPem,
        cert: phone.certPem,
        rejectUnauthorized: false,
      });
      const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.once('open', () => {
          ws.send(
            JSON.stringify({
              t: 'hello',
              v: 1,
              deviceId: '我的手机',
              nonce: 'n1',
              phoneFp: phone.fingerprint,
            }),
          );
        });
        ws.once('message', (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>),
        );
        ws.once('error', reject);
      });
      expect(frame.t).toBe('hello_ok');
      expect(frame.pcId).toBe('pc-lan');
      ws.close();
    } finally {
      // stop 会一并关闭外部 HTTPS server（幂等；afterEach 再关一次也安全）
      await bridge.stop();
    }
  });
});

describe('RemoteSecureServer — 生命周期', () => {
  it('close 幂等：重复调用不抛错', async () => {
    const pc = await makeIdentity();
    const secure = createRemoteSecureServer({ identity: pc, isPaired: () => false });
    await secure.listen({ host: '127.0.0.1', port: 0 });
    await secure.close();
    await expect(secure.close()).resolves.toBeUndefined();
  });

  it('已关闭后不能再 listen', async () => {
    const pc = await makeIdentity();
    const secure = createRemoteSecureServer({ identity: pc, isPaired: () => false });
    await secure.listen({ host: '127.0.0.1', port: 0 });
    await secure.close();
    await expect(secure.listen({ host: '127.0.0.1', port: 0 })).rejects.toThrow();
  });
});
