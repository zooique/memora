/**
 * 安全传输层（LAN 档的 TLS 面）—— HTTPS server + 客户端证书指纹映射
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §19.9：L1 = TLS 1.3 双向自签证书（ECDSA P-256）；身份 = 证书 DER 的 SHA-256 指纹；
 *     信任**不来自 CA**：本层只要求出示证书，配对与否由 hello 判定
 *   - §16.2 G1 / G3 / G4 / G5：绑定地址显式可配；直连档必须 TLS；握手层失败计数与审计
 *
 * 为什么要有本文件：桥需要「这条 WebSocket 连接来自哪台设备」这一事实，
 * 而它只能从 TLS 客户端证书派生。把握手、证书解析、指纹映射、无证书拒绝收在一处，
 * 桥才拿得到 `fingerprintOf(socket)` 而不必自己碰 tls。
 *
 * ⚠️ 边界（不要读错）：
 *   - 证书是**自签**且 `rejectUnauthorized: false`，链校验是关掉的——
 *     **TLS 握手成功不代表身份可信**；证书只证明「对端持有某私钥」，是否已配对由
 *     hello 阶段（`tierOf`）判定，首次配对走口令 + PC 批准（见 `remoteBridge.handleHello`）。
 *   - **未配对证书必须放行到 hello**：若在本层按设备表拒绝，首次配对永远到不了口令环节
 *     （已修缺陷，见 §16.2 G2 的「首次信任必须 PC 侧人工批准」）。
 *   - 只有**无证书**的连接在本层直接 `socket.destroy()`，**不回业务错误帧**，避免给探测者任何信号；
 *   - 本文件不建立 WebSocket、不解析业务帧（那是 `remoteBridge`）。
 */

// ⚠️ 必须是第一条 import：本文件与 remoteIdentity 同属 LAN 档惰性链，而
// @peculiar/x509 依赖 tsyringe，tsyringe 需要 reflect-metadata 先完成 Reflect 元数据扩展。
// 扩展激活路径不会加载本文件（remoteBridgeHost 只在 LAN 分支动态 import）。
import 'reflect-metadata';
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fingerprintOfCertDer } from './remoteFingerprint.js';
import type { RemoteIdentity } from './remoteIdentity.js';

/**
 * 握手层安全旁路（宿主注入；本文件只做「计数 + 留痕 + 查封禁」，不维护任何安全判据）
 *
 * 与 `RemoteBridgeSecurity` 的分工：那边管 hello 之后的配对 / 档位，这边管**握手层**
 * （无证书、握手失败）——两者写同一个限流器与审计文件，避免「TLS 一套、hello 一套」两份账。
 */
export interface RemoteSecureServerSecurity {
  /** 该来源 IP 当前是否被封禁（true ⇒ 握手完成后立刻断开，不再校验证书） */
  isBlocked: (ip: string) => boolean;
  /** 记一次握手层失败（宿主侧限流器；封禁阈值 / TTL 均由宿主决定） */
  noteFailure: (ip: string) => void;
  /** 追加审计（实现约定永不抛出） */
  audit: (event: { event: string; deviceFp?: string; ip?: string; detail?: string }) => void;
}

/** 构造参数 */
export interface RemoteSecureServerOptions {
  /** PC 身份（证书 + 私钥） */
  identity: RemoteIdentity;
  /** 握手层安全旁路（缺省 = 只记日志，不计数、不审计） */
  security?: RemoteSecureServerSecurity;
  /** 日志口（握手拒绝 / 客户端错误只记这里，不弹窗） */
  log?: (message: string) => void;
}

/** 安全传输层句柄（桥只消费这四个能力） */
export interface RemoteSecureServer {
  /** 底层 HTTPS server（桥用 `new WebSocketServer({ server })` 挂上来） */
  server: Server;
  /**
   * 已出示证书连接的对端指纹；无证书 / 未知连接 = undefined
   *
   * ⚠️ 语义是「对端持有这张证书」，**不是**「已配对」——配对与否由 hello 的 `tierOf` 另判。
   */
  fingerprintOf: (socket: unknown) => string | undefined;
  /** 开始监听（port 0 = 系统分配）；返回实际端口 */
  listen: (options: { host: string; port: number }) => Promise<number>;
  /** 关闭监听（幂等） */
  close: () => Promise<void>;
}

/**
 * 创建 TLS 会话面
 *
 * @param opts 身份 + 握手安全旁路 + 日志口
 */
export function createRemoteSecureServer(opts: RemoteSecureServerOptions): RemoteSecureServer {
  const log = opts.log ?? (() => undefined);
  // socket → 设备指纹：WeakMap 让连接断开后自动回收，不留引用
  const fingerprints = new WeakMap<object, string>();
  const server = createServer({
    key: opts.identity.keyPem,
    cert: opts.identity.certPem,
    // 要求客户端出示证书，但不做链校验（信任来自指纹固定，不来自 CA）
    requestCert: true,
    rejectUnauthorized: false,
  });

  // 握手完成：按证书指纹登记；无证书即断开（不给业务错误，避免探测）
  //
  // ⚠️ 这里**刻意不查设备表**：未配对证书要能走到 hello 的口令 + 人工批准（首次配对唯一入口）。
  // 封禁中的来源在握手完成后直接断，避免被封 IP 继续消耗后续环节。
  server.on('secureConnection', (socket: TLSSocket) => {
    const ip = socket.remoteAddress;
    const security = opts.security;
    if (ip && security?.isBlocked(ip)) {
      // 封禁期内不再叠加失败计数（否则长封禁会被攻击者反复「续期」）
      security.audit({ event: 'tls_peer_rejected', ip, detail: 'rate_limited' });
      log(`[REMOTE-TLS] 来源 ${ip} 处于封禁期，断开发起连接`);
      socket.destroy();
      return;
    }
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.raw || cert.raw.length === 0) {
      if (ip && security) {
        security.noteFailure(ip);
        security.audit({ event: 'tls_peer_rejected', ip, detail: 'no_client_certificate' });
      }
      log('[REMOTE-TLS] 客户端未出示证书，断开');
      socket.destroy();
      return;
    }
    const fingerprint = fingerprintOfCertDer(new Uint8Array(cert.raw));
    // 登记的是「持有该证书」这一事实；是否已配对由上层 hello 判定（见文件头边界）
    fingerprints.set(socket, fingerprint);
  });

  // 握手层错误（证书格式 / 协议不匹配 / 半途断开等）：按来源 IP 计一次失败并留痕
  server.on('tlsClientError', (err, socket) => {
    const ip = socket?.remoteAddress;
    if (ip && opts.security) {
      opts.security.noteFailure(ip);
      opts.security.audit({ event: 'tls_handshake_failed', ip, detail: String(err) });
    }
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
