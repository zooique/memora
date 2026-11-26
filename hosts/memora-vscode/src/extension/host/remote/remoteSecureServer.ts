/**
 * 安全传输层（LAN 档的 TLS 面）—— HTTPS server + 客户端证书指纹映射
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §19.9：L1 = TLS 1.3 双向自签证书（ECDSA P-256）；身份 = 证书 DER 的 SHA-256 指纹；
 *     信任**不来自 CA**，未知证书按指纹拒绝
 *   - §16.2 G1 / G3：绑定地址显式可配；直连档必须 TLS
 *
 * 为什么要有本文件：桥需要「这条 WebSocket 连接来自哪台已认证设备」这一事实，
 * 而它只能从 TLS 客户端证书派生。把握手、证书解析、指纹映射、未配对断开收在一处，
 * 桥才拿得到 `fingerprintOf(socket)` 而不必自己碰 tls。
 *
 * ⚠️ 边界（不要读错）：
 *   - 证书是**自签**且 `rejectUnauthorized: false`，链校验是关掉的——
 *     **TLS 握手成功不代表身份可信**；信任只由「指纹白名单（`isPaired`）」决定。
 *   - 未配对 / 无证书：直接 `socket.destroy()`，**不回业务错误帧**，避免给探测者任何信号；
 *   - 本文件不建立 WebSocket、不解析业务帧（那是 `remoteBridge`）。
 */

import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fingerprintOfCertDer, type RemoteIdentity } from './remoteIdentity.js';

/** 构造参数 */
export interface RemoteSecureServerOptions {
  /** PC 身份（证书 + 私钥） */
  identity: RemoteIdentity;
  /** 指纹是否已配对（白名单判据由宿主注入，本文件不维护设备表） */
  isPaired: (fingerprint: string) => boolean;
  /** 日志口（握手拒绝 / 客户端错误只记这里，不弹窗） */
  log?: (message: string) => void;
}

/** 安全传输层句柄（桥只消费这四个能力） */
export interface RemoteSecureServer {
  /** 底层 HTTPS server（桥用 `new WebSocketServer({ server })` 挂上来） */
  server: Server;
  /** 已认证（已配对且已握手）连接的设备指纹；未知连接 = undefined */
  fingerprintOf: (socket: unknown) => string | undefined;
  /** 开始监听（port 0 = 系统分配）；返回实际端口 */
  listen: (options: { host: string; port: number }) => Promise<number>;
  /** 关闭监听（幂等） */
  close: () => Promise<void>;
}

/**
 * 创建 TLS 会话面
 *
 * @param opts 身份 + 配对判据 + 日志口
 */
export function createRemoteSecureServer(opts: RemoteSecureServerOptions): RemoteSecureServer {
  const log = opts.log ?? (() => undefined);
  // socket → 设备指纹：WeakMap 让连接断开后自动回收，不留引用
  const fingerprints = new WeakMap<object, string>();
  const server = createServer({
    key: opts.identity.keyPem,
    cert: opts.identity.certPem,
    // 要求客户端出示证书，但不做链校验（信任来自下方指纹白名单，不来自 CA）
    requestCert: true,
    rejectUnauthorized: false,
  });

  // 握手完成：取对端证书 raw → 指纹；无证书或未配对即断开（不给业务错误，避免探测）
  server.on('secureConnection', (socket: TLSSocket) => {
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.raw || cert.raw.length === 0) {
      log('[REMOTE-TLS] 客户端未出示证书，断开');
      socket.destroy();
      return;
    }
    const fingerprint = fingerprintOfCertDer(new Uint8Array(cert.raw));
    if (!opts.isPaired(fingerprint)) {
      log(`[REMOTE-TLS] 未配对设备（${fingerprint.slice(0, 8)}…）尝试连接，断开`);
      socket.destroy();
      return;
    }
    // 只在通过白名单后才登记，保证 fingerprintOf 的语义是「已认证设备」
    fingerprints.set(socket, fingerprint);
  });

  // 握手层错误（证书格式 / 协议不匹配等）只记日志：单连接失败不影响监听
  server.on('tlsClientError', (err) => {
    log(`[REMOTE-TLS] 客户端握手失败：${String(err)}`);
  });

  /** 是否已开始监听（close 幂等与 listen 判重的依据） */
  let listening = false;
  /** 是否已关闭（幂等标记） */
  let closed = false;

  return {
    server,
    fingerprintOf: (socket: unknown): string | undefined => {
      if (typeof socket !== 'object' || socket === null) return undefined;
      return fingerprints.get(socket);
    },
    listen: (options: { host: string; port: number }): Promise<number> => {
      if (listening) return Promise.reject(new Error('RemoteSecureServer already listening'));
      if (closed) return Promise.reject(new Error('RemoteSecureServer already closed'));
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off('error', onError);
          listening = true;
          // 监听后的常驻 error 监听：EventEmitter 的 'error' 无人接管会直接抛，拖崩宿主
          server.on('error', (err) => log(`[REMOTE-TLS] server error: ${String(err)}`));
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : options.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: options.host, port: options.port });
      });
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (!listening) return;
      await new Promise<void>((resolve) => {
        // 先掐掉现存连接，否则 keep-alive 会让 close 的回调迟迟不来
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
