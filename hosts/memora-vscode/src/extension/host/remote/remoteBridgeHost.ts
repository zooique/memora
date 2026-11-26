/**
 * 远程桥的宿主适配（端口实现）—— 把宿主既有能力收成 `RemoteBridgePorts` / `RemoteBridgeSecurity`
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §19.2（真源 = 按 sid 的命令执行面）
 *   - §19.3 profile 2（`loopback`：只绑 127.0.0.1、只读 + 可答、仅开发验证不交付）
 *     / profile 3（`lan`：显式开启 + 设备指纹批准，默认只读）
 *   - §16.2 六项安全底线（绑定地址 / 配对 / TLS / 限流 / 审计 / 监听失败显式报错）
 *   - §5.7 密钥与设备表的存放位置（`secrets` / `globalState` / `globalStorage`）
 *
 * 为什么单独一层：桥核心（`remoteBridge.ts`）刻意不 import 面板、不碰 vscode。
 * 本文件就是那段「差异段」——只回答「sid / 载荷 / 投影素材 / 身份材料 / 审批窗口从哪来」，
 * 不复制任何裁决：
 *   - 会话列表 → `buildSessionListMessage`（webview 历史列表的同一构建点）
 *   - 投影     → `chatPanel.projectSession`（与侧栏共用 `deriveSessionProjection`）
 *   - 相位     → `remotePhaseOf`（唯一折算点）
 *   - 答复投递 → `chatPanel.handleInput`（落到同一个 `handleInput`）
 *   - 身份/设备/限流/审计 → 本目录新模块（各自单一职责）
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostSessionStore } from '../sessionStore.js';
import { buildSessionListMessage } from '../../../webview/helpers/sessionList.js';
import type { WebviewToExtensionMessage } from '../../../shared/protocol.js';
import type { SessionViewProjection } from '../../../shared/sessionProjection.js';
import { remotePhaseOf } from './remoteCommandPolicy.js';
import { RemoteBridge, type RemoteBridgePorts } from './remoteBridge.js';
import { loadOrCreateRemoteIdentity } from './remoteIdentity.js';
import { RemoteDeviceStore } from './remoteDevices.js';
import { RemotePairing } from './remotePairing.js';
import { RemoteFailureLimiter } from './remoteRateLimiter.js';
import { RemoteAuditLog, type RemoteAuditSink } from './remoteAudit.js';
import { createRemoteSecureServer } from './remoteSecureServer.js';
import { confirmModal } from '../ui/confirmModal.js';

/** 桥需要的面板窄接口（只列本适配用到的三个方法，防止顺手把整个面板传进桥） */
export interface RemotePanelPort {
  /** 任意 sid 的投影（无副作用：不写 `_turnStates`、不投递、不盖章附件 URL） */
  projectSession: (sessionId: string) => SessionViewProjection;
  /** 远程命令投递（与 webview 落到同一个 `handleInput`；**参数顺序照抄面板**，不重排） */
  handleInput: (
    msg: Extract<WebviewToExtensionMessage, { type: 'input' }>,
    sessionId: string,
  ) => Promise<void>;
  /** 助手会话 id（工作区指针；宿主的唯一身份来源，桥不推断） */
  getAssistantSessionId: () => string | undefined;
}

/** 适配所需的宿主依赖 */
export interface RemoteBridgeHostDeps {
  /** 面板（投影 + 投递口） */
  panel: RemotePanelPort;
  /** 会话存储（定址判据 + 列表投影素材） */
  store: HostSessionStore;
  /** 日志口（扩展输出通道） */
  log: (message: string) => void;
}

/** 适配所需的 VS Code 环境（密钥 / 设备表 / 审计目录都从这里取） */
export interface RemoteBridgeHostEnv {
  /** 扩展上下文（secrets / globalState / globalStorageUri） */
  context: vscode.ExtensionContext;
}

/**
 * 把宿主能力收成桥端口
 *
 * @param deps 面板 + 会话存储 + 日志口
 */
export function createRemoteBridgePorts(deps: RemoteBridgeHostDeps): RemoteBridgePorts {
  const { panel, store } = deps;
  return {
    // 列表：currentSessionId 传空串 = 不排除任何会话（手机端有自己的「当前」概念）；
    // 助手会话仍排除（它不是工作会话，助手身份经 hello_ok.assistantSid 单独下发）
    listSessions: () => {
      const assistantSid = panel.getAssistantSessionId();
      const message = buildSessionListMessage(store, '', vscode.l10n, undefined, assistantSid);
      return { sessions: message.sessions, archivedIds: message.archivedIds, assistantSid };
    },
    // 定址：只认存储里的会话 id（草稿态无 id，天然落空 ⇒ no_session，§6.6 断路器）
    hasSession: (sessionId) => store.listSessions().includes(sessionId),
    // 相位：素材来自实时投影（不是 `_turnStates` —— 那份只在有视图时更新）
    phaseOf: (sessionId) => remotePhaseOf(panel.projectSession(sessionId).state, false),
    snapshot: (sessionId) => panel.projectSession(sessionId),
    // 投递：与 webview 同一个入口；失败只记日志（投递可靠性不靠桥重试，靠手机重拉快照）
    deliverAnswer: (sessionId, answers) => {
      void panel
        .handleInput({ type: 'input', kind: 'answer', answers: [...answers] }, sessionId)
        .catch((err: unknown) => {
          deps.log(`[REMOTE-BRIDGE] 答复投递失败 sid=${sessionId}: ${String(err)}`);
        });
    },
  };
}

/** 开发启动开关（缺省不启动；`1` 兼容旧值，等同 `loopback`） */
export const REMOTE_BRIDGE_ENV = 'MEMORA_REMOTE_BRIDGE';
/** 端口覆盖（缺省 0 = 系统分配；日志里会打印实际端口） */
export const REMOTE_BRIDGE_PORT_ENV = 'MEMORA_REMOTE_BRIDGE_PORT';

/** 桥档位（§19.3 profile 2 / profile 3） */
export type RemoteBridgeMode = 'loopback' | 'lan';

/** 审计文件名（放 `globalStorage`，不写 `.memora`，§16.2 G5） */
const AUDIT_FILE_NAME = 'remote-audit.log';

/**
 * 解析环境变量里的档位
 *
 * 缺省 = 不启动（D1：入站端口风险最高，不默认开）。未知取值同样不启动（fail-closed），
 * 避免「写错一个词就静默绑了 LAN」。
 */
function resolveMode(): { mode?: RemoteBridgeMode; raw?: string } {
  const raw = process.env[REMOTE_BRIDGE_ENV]?.trim().toLowerCase();
  if (!raw) return {};
  if (raw === '1' || raw === 'loopback') return { mode: 'loopback', raw };
  if (raw === 'lan') return { mode: 'lan', raw };
  return { raw };
}

/** 读端口环境变量（非法值回落到 0 = 系统分配） */
function resolvePort(): number {
  const rawPort = Number.parseInt(process.env[REMOTE_BRIDGE_PORT_ENV] ?? '0', 10);
  return Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 0;
}

/**
 * 按环境变量启动远程桥
 *
 * - `loopback`（或旧值 `1`）：回环档，行为与 profile 2 完全一致（只绑 127.0.0.1）；
 * - `lan`：局域网档，TLS + 指纹配对 + 限流 + 审计（§16.2 六项底线）；
 * - 未设置 / 未知值：不创建实例、不开端口。
 *
 * 监听失败必须显式报错并保持未监听态（§16.2），故异常转成用户可见的警告，不静默吞。
 *
 * @param deps    宿主能力
 * @param hostEnv 扩展上下文（密钥 / 设备表 / 审计目录）
 * @returns 桥实例（未监听时也返回实例，便于 `deactivate` 无条件 `stop()`）
 */
export async function startRemoteBridge(
  deps: RemoteBridgeHostDeps,
  hostEnv: RemoteBridgeHostEnv,
): Promise<RemoteBridge | undefined> {
  const { mode, raw } = resolveMode();
  if (!mode) {
    if (raw) deps.log(`[REMOTE-BRIDGE] 未知开关值 ${raw}，不启动（可用：loopback / lan）`);
    return undefined;
  }
  if (mode === 'loopback') return startLoopbackBridge(deps);
  return startLanBridge(deps, hostEnv.context);
}

/**
 * 回环档（profile 2 · 仅开发验证）
 *
 * @param deps 宿主能力
 */
async function startLoopbackBridge(deps: RemoteBridgeHostDeps): Promise<RemoteBridge> {
  const bridge = new RemoteBridge(createRemoteBridgePorts(deps), {
    pcId: 'memora-loopback',
    port: resolvePort(),
    log: deps.log,
  });
  try {
    const started = await bridge.start();
    deps.log(`[REMOTE-BRIDGE] listening on 127.0.0.1:${started.port}（profile 2 · 仅开发验证）`);
    void vscode.window.showInformationMessage(
      `Memora 远程桥（开发验证）已监听 127.0.0.1:${started.port}`,
    );
  } catch (err) {
    // 端口占用 / 权限不足：显式报错 + 保持未监听（禁止「失败但 UI 显示已连接」）
    deps.log(`[REMOTE-BRIDGE] 启动失败: ${String(err)}`);
    void vscode.window.showWarningMessage(`Memora 远程桥启动失败：${String(err)}`);
  }
  return bridge;
}

/**
 * 局域网档（profile 3）—— 六项安全底线的宿主接线
 *
 * 身份 / 设备表 / 限流 / 审计全部落在宿主持久层：
 *   - 私钥 → `context.secrets`（§5.7，绝不落工作区）
 *   - 设备表 → `context.globalState`（不含密钥）
 *   - 审计 → `globalStorage/remote-audit.log`（只追加）
 *
 * @param deps    宿主能力
 * @param context 扩展上下文
 */
async function startLanBridge(
  deps: RemoteBridgeHostDeps,
  context: vscode.ExtensionContext,
): Promise<RemoteBridge | undefined> {
  const { log } = deps;
  // §16.2 另两条硬前置之一：工作区未受信任 ⇒ 拒绝入站（不静默降级成只读）
  if (!vscode.workspace.isTrusted) {
    log('[REMOTE-BRIDGE] 工作区未受信任，局域网档不启动');
    void vscode.window.showWarningMessage(
      'Memora 远程桥（局域网）未启动：当前工作区未受信任。请先信任工作区再重试。',
    );
    return undefined;
  }
  let secure: ReturnType<typeof createRemoteSecureServer> | undefined;
  try {
    // ① 身份：SecretStorage 里的长期证书 / 私钥（缺失或损坏自动重建）
    const identity = await loadOrCreateRemoteIdentity(
      {
        get: async (key) => context.secrets.get(key),
        store: async (key, value) => {
          await context.secrets.store(key, value);
        },
      },
      log,
    );
    // ② 设备表：globalState（只存指纹 / 档位 / 时间，不含密钥）
    const devices = new RemoteDeviceStore(context.globalState, log);
    // ③ 审计：globalStorage 下的追加式文件
    const auditLog = new RemoteAuditLog(
      createAuditSink(context.globalStorageUri.fsPath),
      Date.now,
      log,
    );
    // ④ 一次性口令 + 失败限流（均为进程内状态，重启即重置）
    const pairing = new RemotePairing();
    const limiter = new RemoteFailureLimiter({ log });
    // ⑤ TLS 面：客户端证书指纹 → 配对白名单
    const secureServer = createRemoteSecureServer({
      identity,
      isPaired: (fingerprint) => devices.get(fingerprint) !== undefined,
      log,
    });
    // 供 catch 分支关闭半启动的 server（正常路径由 bridge.stop() 关闭）
    secure = secureServer;
    const bridge = new RemoteBridge(createRemoteBridgePorts(deps), {
      pcId: `memora-lan-${identity.shortFp}`,
      port: resolvePort(),
      host: '0.0.0.0',
      server: secureServer.server,
      security: {
        fingerprintOf: (socket) => secureServer.fingerprintOf(socket),
        tierOf: (fingerprint) => devices.get(fingerprint)?.tier,
        verifyPasscode: (code) => pairing.verify(code),
        requestApproval: (info) => requestDeviceApproval(info),
        registerDevice: (info) => {
          // 配对默认最小权限（§5.9：observe），提档需 PC 端另行勾选（不在本切片）
          void devices
            .upsert({
              fingerprint: info.fingerprint,
              shortFp: info.shortFp,
              name: info.name,
              tier: 'observe',
              pairedAt: Date.now(),
            })
            .catch((err: unknown) => log(`[REMOTE-BRIDGE] 写设备表失败: ${String(err)}`));
        },
        rateLimit: {
          check: (key) => limiter.check(key),
          noteFailure: (key) => limiter.noteFailure(key),
          noteSuccess: (key) => limiter.noteSuccess(key),
        },
        audit: (event) => {
          // record 约定永不抛出；仍用 void 显式标记「不等待」
          void auditLog.record(event);
        },
      },
      log,
    });
    const started = await bridge.start();
    // ⑥ 监听成功后才生成口令并展示：TTL 从「用户看到」开始算
    const challenge = pairing.start();
    const addresses = listLanAddresses();
    const where = addresses.length > 0 ? addresses.join(' / ') : '（未找到局域网地址）';
    log(
      `[REMOTE-BRIDGE] listening on ${where}:${started.port}（LAN · 配对口令 ${challenge.code}，PC 指纹 ${identity.shortFp}）`,
    );
    void vscode.window.showInformationMessage(
      `Memora 远程桥（局域网）已监听 ${where}:${started.port}；` +
        `配对口令 ${challenge.code}（5 分钟内有效、一次即废）；PC 指纹 ${identity.shortFp}`,
    );
    return bridge;
  } catch (err) {
    // 监听失败 / 身份材料不可用：显式报错 + 保持未监听（禁止「失败但 UI 显示已连接」）
    log(`[REMOTE-BRIDGE] LAN 档启动失败: ${String(err)}`);
    void vscode.window.showWarningMessage(`Memora 远程桥（局域网）启动失败：${String(err)}`);
    await secure?.close().catch(() => undefined);
    return undefined;
  }
}

/**
 * 首次配对的人工批准（模态框）
 *
 * 拒绝 / 关闭一律视为拒绝（fail-closed）；不阻塞 VS Code 其他窗口。
 *
 * @param info 待批准设备（指纹短码 + 展示名 + 来源 IP）
 */
async function requestDeviceApproval(info: {
  fingerprint: string;
  shortFp: string;
  name: string;
  ip?: string;
}): Promise<boolean> {
  const from = info.ip ? `，来自 ${info.ip}` : '';
  // 模态确认必须走唯一入口（系统自带 Cancel 解析为 undefined ⇒ fail-closed）
  return confirmModal({
    message: `手机「${info.name}」请求配对（指纹 ${info.shortFp}${from}）`,
    detail: '允许后该设备获得只读权限（observe）；取消或关闭窗口视为拒绝。',
    confirmLabel: '允许',
  });
}

/**
 * 审计落盘口（`globalStorage/remote-audit.log`，一条一行，只追加）
 *
 * @param dir `context.globalStorageUri.fsPath`
 */
function createAuditSink(dir: string): RemoteAuditSink {
  const file = path.join(dir, AUDIT_FILE_NAME);
  return {
    append: async (line) => {
      // 目录可能尚未创建（首次运行）；mkdir recursive 幂等
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.appendFile(file, `${line}\n`, 'utf8');
    },
  };
}

/**
 * 列出局域网 IPv4 地址（排除回环）
 *
 * 只用于「监听地址」展示（§16.2 G1：必须显示当前绑定地址），不参与绑定决策。
 * 注意：`internal` 只标回环，不排除 169.254 / 私网段——它们恰恰就是手机要连的地址。
 */
function listLanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      addresses.push(entry.address);
    }
  }
  return addresses;
}
