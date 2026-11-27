/**
 * 开发用桥夹具（**仅开发联调，不参与扩展激活路径**）
 *
 * 目的：给手机仓一条可端到端跑通的真链路——真 `RemoteBridge` + 真 mTLS
 * （`createRemoteSecureServer`）+ 真口令校验（`RemotePairing`），只有
 * 「宿主数据」是假 ports。用它验证手机端 `parseFrame` / `Wss` 客户端没有与宿主契约脱节。
 *
 * 口径（勿读成产品能力）：
 *   - 假端口只提供 1 个会话 + 1 个轮次，**不是**真实会话投影；
 *   - 自动批准配对（`requestApproval` 恒 true）只为免去人工点按，**不是**产品配对流程；
 *   - 不 import vscode，因此不能用于真机宿主验证；真机仍走 `remoteBridgeHost`。
 *
 * 用法（宿主包目录）：
 *   npm run dev:bridge -- [--mode lan|loopback] --certs <证书目录> [--host 127.0.0.1] [--port 0]
 * 允许手机连入的局域网地址请显式传 `--host 0.0.0.0`（绑定地址是安全边界，不替调用方决定）。
 */

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  RemoteBridge,
  type RemoteBridgePorts,
  type RemoteBridgeSecurity,
} from '../src/extension/host/remote/remoteBridge.js';
import { createRemoteSecureServer } from '../src/extension/host/remote/remoteSecureServer.js';
import {
  fingerprintOfCertDer,
  shortFingerprint,
} from '../src/extension/host/remote/remoteFingerprint.js';
import { RemotePairing } from '../src/extension/host/remote/remotePairing.js';
import { RemoteFailureLimiter } from '../src/extension/host/remote/remoteRateLimiter.js';
import type { RemoteDeviceTier } from '../src/extension/host/remote/remoteDevices.js';
import type { RoundView, TurnState } from '../src/shared/protocol.js';

/** 假宿主数据：唯一会话 id（手机冒烟按它订阅） */
const DEV_SESSION_ID = 's-dev-1';

/** 假宿主数据：唯一助手会话 id（hello_ok 回显，证明端口被消费） */
const DEV_ASSISTANT_SID = 'assistant-dev';

/** 开发期 PC 身份标识（日志与 hello_ok.pcId 用，不参与任何判据） */
const DEV_PC_ID = 'pc-dev';

/** 日志口：夹具只打控制台，不落盘（避免留下「像是审计」的假文件） */
function log(message: string): void {
  console.log(`[DEV-BRIDGE] ${message}`);
}

/** 取 `--name value` 形式的参数（缺省 undefined） */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

/** 证书目录：参数优先，其次环境变量，最后按「宿主包目录」相对推手机仓默认路径 */
function resolveCertsDir(): string {
  const fromArg = argOf('certs');
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = process.env.MEMORA_MOBILE_CERTS;
  if (fromEnv) return path.resolve(fromEnv);
  // cwd = hosts/memora-vscode ⇒ 上三级到 F:\zooique，再进手机仓
  return path.resolve('../../../memora-mobile/tool/dev/certs');
}

/** 从 PEM 证书算 DER 的 SHA-256 指纹（与宿主 `fingerprintOfCertDer` 同一形态） */
function fingerprintOfPem(pem: string): string {
  return fingerprintOfCertDer(new Uint8Array(new X509Certificate(pem).raw));
}

/** 构造假端口：1 个会话、1 个轮次、相位 idle */
function makePorts(): RemoteBridgePorts {
  /** 该会话唯一的轮次（字段只够手机首屏渲染，不冒充完整投影） */
  const rounds = [
    {
      id: 'r-dev-1',
      userMessage: {
        role: 'user',
        content: '联调用的假提问',
        timestamp: '2026-11-27T00:00:00.000Z',
      },
      assistantMessage: {
        id: 'm-dev-1',
        role: 'assistant',
        content: '联调用的假回答',
        timestamp: '2026-11-27T00:00:05.000Z',
      },
    },
  ] as unknown as RoundView[];
  /** 相位：idle（可发送新提问；只在投影层使用） */
  const state: TurnState = { phase: 'idle' };
  return {
    listSessions: () => ({
      sessions: [
        {
          sessionId: DEV_SESSION_ID,
          title: '联调会话（假数据）',
          updatedAt: '2026-11-27T00:00:05.000Z',
          messageCount: 2,
          lastOutcome: 'completed',
        },
      ],
      archivedIds: [],
      assistantSid: DEV_ASSISTANT_SID,
    }),
    hasSession: (sessionId) => sessionId === DEV_SESSION_ID,
    phaseOf: () => 'idle',
    snapshot: () => ({ state, rounds, pendingQueue: [] }),
    deliverInput: (sessionId, input) => {
      // 夹具不执行任何命令：只留痕，证明投递端口被桥调用到
      log(`deliverInput sid=${sessionId} kind=${input.kind}`);
    },
    answerConfirm: () => true,
  };
}

/** 打印 `BRIDGE_READY {json}` 并挂中断处理（两档共用；`connectHost` 把 0.0.0.0 归一为 127.0.0.1） */
function announce(payload: Record<string, unknown>, onShutdown: () => Promise<void>): void {
  const connectHost = payload.host === '0.0.0.0' ? '127.0.0.1' : String(payload.host);
  console.log(`BRIDGE_READY ${JSON.stringify({ ...payload, connectHost })}`);
  // 收到中断时先停桥再退，避免端口与 TLS server 留在半开状态
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await onShutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** 启动夹具桥：`--mode lan`（缺省，真 mTLS）或 `loopback`（明文 ws，仅本机） */
async function main(): Promise<void> {
  const host = argOf('host') ?? '127.0.0.1';
  const portArg = argOf('port');
  const port = portArg === undefined ? 0 : Number.parseInt(portArg, 10);
  const mode = argOf('mode') ?? 'lan';

  // 回环档：与宿主 profile 2 同构——无 TLS / 无配对，只绑 127.0.0.1
  if (mode === 'loopback') {
    const bridge = new RemoteBridge(makePorts(), { pcId: DEV_PC_ID, port, log });
    const started = await bridge.start();
    announce(
      { mode, host: '127.0.0.1', port: started.port, sessionId: DEV_SESSION_ID, pcId: DEV_PC_ID },
      async () => {
        await bridge.stop();
      },
    );
    return;
  }
  if (mode !== 'lan') throw new Error(`未知 --mode: ${mode}（可用：lan / loopback）`);

  const certsDir = resolveCertsDir();

  // 真证书：服务端（PC）用于 TLS，客户端（手机）证书的指纹用于自检/打印
  const serverCertPem = readFileSync(path.join(certsDir, 'server-cert.pem'), 'utf8');
  const serverKeyPem = readFileSync(path.join(certsDir, 'server-key.pem'), 'utf8');
  const clientCertPem = readFileSync(path.join(certsDir, 'client-cert.pem'), 'utf8');
  const serverFp = fingerprintOfPem(serverCertPem);
  /** 手机在 hello.phoneFp 里必须回这个值（握手会与 TLS 证书指纹逐字比对） */
  const phoneFp = fingerprintOfPem(clientCertPem);

  // 握手层安全旁路：夹具不做封禁，只留痕（真限流器在 hello 之后才用）
  const secure = createRemoteSecureServer({
    identity: {
      keyPem: serverKeyPem,
      certPem: serverCertPem,
      // 夹具直接用 PEM 正文（= DER 的 base64）：与宿主 `loadOrCreateRemoteIdentity`
      // 的派生口径一致，供配对连接串使用
      certDerBase64: serverCertPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
      fingerprint: serverFp,
      shortFp: shortFingerprint(serverFp),
    },
    security: {
      isBlocked: () => false,
      noteFailure: (ip) => log(`tls handshake failure ip=${ip}`),
      audit: (event) => log(`tls audit ${JSON.stringify(event)}`),
    },
    log,
  });

  // 配对与权限：真口令校验 + 真限流，只有「人工批准」换成自动同意
  const pairing = new RemotePairing({ ttlMs: 24 * 60 * 60 * 1000 });
  const challenge = pairing.start();
  const tiers = new Map<string, RemoteDeviceTier>();
  const limiter = new RemoteFailureLimiter({ log });
  const security: RemoteBridgeSecurity = {
    fingerprintOf: (socket) => secure.fingerprintOf(socket),
    tierOf: (fingerprint) => tiers.get(fingerprint),
    verifyPasscode: (code) => pairing.verify(code),
    requestApproval: async (info) => {
      log(`自动批准配对 device=${info.name} shortFp=${info.shortFp} ip=${info.ip ?? '-'}`);
      return true;
    },
    registerDevice: ({ fingerprint }) => {
      tiers.set(fingerprint, 'observe');
    },
    rateLimit: {
      check: (key) => limiter.check(key),
      noteFailure: (key) => limiter.noteFailure(key),
      noteSuccess: (key) => limiter.noteSuccess(key),
    },
    audit: (event) => log(`audit ${JSON.stringify(event)}`),
  };

  const bridge = new RemoteBridge(makePorts(), {
    pcId: DEV_PC_ID,
    host,
    port,
    server: secure.server,
    security,
    log,
  });
  const started = await bridge.start();
  announce(
    {
      mode,
      host,
      port: started.port,
      phoneFp,
      passcode: challenge.code,
      sessionId: DEV_SESSION_ID,
      pcId: DEV_PC_ID,
    },
    async () => {
      await bridge.stop();
      await secure.close();
    },
  );
}

void main().catch((err: unknown) => {
  console.error(`DEV_BRIDGE_FAILED ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
