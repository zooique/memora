/**
 * 远程控制设置页的宿主执行面 —— 「读状态 / 执行动作」两个口
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §16.2 G5：审计落 `globalStorage`、只追加（本文件只读尾部，不写）
 *   - §19.3 profile 2（loopback 开发验证）/ profile 3（lan 配对后使用）
 *
 * 为什么单独一层：设置面板是「投递意图 + 渲染状态」的容器，不该 import 桥句柄、
 * 不认识设备表；而状态真源（设备表 / 口令 / 身份 / 审计）全在 `remoteBridgeHost.ts`。
 * 本文件只做**组装与转发**：
 *   - 读状态 = 桥运行时登记 + LAN 句柄（`getRemoteBridgeRuntime` / `getRemoteLanHandle`）
 *     + 审计文件尾部；
 *   - 动作 = 直接调用命令层同一函数（`regenerateLanPairingCode` / `applyDeviceAction`），
 *     **不重写任何档位判据 / 确认框 / 审计写入**——两条入口共用同一执行面。
 *
 * 边界：不新增持久化、不缓存状态（每次读都取实时真值）、不碰手机端。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  RemoteActionPayload,
  RemoteAuditTailDto,
  RemoteSettingsStatus,
} from '../../../shared/protocol.js';
import {
  applyDeviceAction,
  getRemoteBridgeRuntime,
  getRemoteLanHandle,
  regenerateLanPairingCode,
  toggleRemoteBridge,
} from './remoteBridgeHost.js';
import { isRemoteDeviceTier } from './remoteDevices.js';
import { pairingLinkOfHandle, pairingMaterialOfHandle } from './remotePairingLink.js';

/** 审计文件名（与 `remoteBridgeHost.ts` 的写入侧同名；此处只读） */
const AUDIT_FILE_NAME = 'remote-audit.log';
/** 审计尾部读取窗口（字节）：只读文件末尾一段，避免大文件整读 */
const AUDIT_TAIL_BYTES = 16 * 1024;
/** 审计展示行数（最新在后） */
const AUDIT_TAIL_LINES = 20;

/** 审计读取结果（`error` 存在时 UI 必须明说「读取失败」，不能显示成「没有记录」） */
interface AuditTailResult {
  /** 解析成功的事件行（最新在后） */
  audit: RemoteAuditTailDto[];
  /** 读取失败原因（文件不存在不算失败） */
  error?: string;
}

/**
 * 读取审计文件尾部
 *
 * @param dir `context.globalStorageUri.fsPath`
 */
async function readAuditTail(dir: string): Promise<AuditTailResult> {
  const file = path.join(dir, AUDIT_FILE_NAME);
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - AUDIT_TAIL_BYTES);
      const length = stat.size - start;
      if (length <= 0) return { audit: [] };
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      // 短读（文件被截断 / 读取不足）时只解析真实读到的字节，避免把尾部零字节算成坏行
      if (bytesRead <= 0) return { audit: [] };
      const lines = buffer
        .subarray(0, bytesRead)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim() !== '');
      // 从文件中间起读时首行可能被截断：丢弃它，避免把半行 JSON 当事件
      const complete = start > 0 ? lines.slice(1) : lines;
      const audit: RemoteAuditTailDto[] = [];
      for (const line of complete.slice(-AUDIT_TAIL_LINES)) {
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (typeof raw.at !== 'number' || typeof raw.event !== 'string') continue;
          audit.push({
            at: raw.at,
            event: raw.event,
            ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
          });
        } catch {
          // 坏行 / 半行跳过：审计是旁路证据，不让一行坏数据打穿整页
        }
      }
      return { audit };
    } finally {
      await handle.close();
    }
  } catch (err) {
    // 尚无审计文件 = 从未发生过远程事件（正常空态），不是读取失败
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { audit: [] };
    return { audit: [], error: String(err) };
  }
}

/**
 * 组装远程控制页的状态快照
 *
 * @param context 扩展上下文（取 `globalStorageUri` 读审计）
 */
export async function readRemoteSettingsStatus(
  context: vscode.ExtensionContext,
): Promise<RemoteSettingsStatus> {
  const runtime = getRemoteBridgeRuntime();
  const handle = getRemoteLanHandle();
  const { audit, error } = await readAuditTail(context.globalStorageUri.fsPath);
  // 设备表只在 LAN 句柄存在时可读：回环档没有配对概念，空数组 = 如实。
  // 「已配对」与「已连接」分属两个真源：表给配对事实，桥的已认证连接给在线事实。
  const online = new Set(handle?.listConnectedFingerprints() ?? []);
  const devices = handle
    ? handle.devices.list().map((device) => ({ ...device, online: online.has(device.fingerprint) }))
    : [];
  const base: RemoteSettingsStatus = {
    mode: runtime?.mode ?? 'off',
    ...(runtime ? { port: runtime.port } : {}),
    devices,
    audit,
    ...(error ? { auditError: error } : {}),
  };
  if (!handle) return base;
  // 口令与连接串必须同源：一次读取取得两者，避免「页面上是旧码、串里是新码」的错配。
  // 不可用（过期 / 地址未识别）时缺省，页面据此隐藏，而不是显示一条必然失败的串。
  const material = pairingMaterialOfHandle(handle);
  return {
    ...base,
    address: handle.address,
    pcShortFp: handle.identity.shortFp,
    ...(material
      ? {
          pairingCode: material.challenge.code,
          pairingExpiresAt: material.challenge.expiresAt,
          pairingLink: material.link,
        }
      : {}),
  };
}

/**
 * 执行远程控制页的动作
 *
 * 动作执行面全部复用命令层同一函数（高风险动作的模态确认与审计在 `applyDeviceAction`
 * 内部完成），本函数只做「桥未启动 / 设备已消失」两类前置判定的如实回报。
 *
 * @param payload webview 上报的动作载荷
 * @returns `ok=false` 时 `message` 是可直接上屏的本地化提示
 */
export async function applyRemoteSettingsAction(
  payload: RemoteActionPayload,
): Promise<{ ok: boolean; message?: string }> {
  if (payload.action === 'refresh') return { ok: true };
  // 启停目标由宿主运行时裁决：webview 只给意图，不把过期 UI 状态当命令参数。
  if (payload.action === 'toggle') return toggleRemoteBridge();
  const handle = getRemoteLanHandle();
  if (!handle) {
    return {
      ok: false,
      message: vscode.l10n.t(
        'The remote bridge is not running. Use the Remote control switch to start it, or set MEMORA_REMOTE_BRIDGE=lan and reload the window.',
      ),
    };
  }
  if (payload.action === 'regenerate') {
    await regenerateLanPairingCode(handle);
    return { ok: true };
  }
  if (payload.action === 'copy_pairing') {
    const link = pairingLinkOfHandle(handle);
    if (!link) return { ok: false, message: vscode.l10n.t('No active pairing link yet.') };
    // 只写剪贴板：不回显到通知 / 日志（连接串含一次性口令）
    await vscode.env.clipboard.writeText(link);
    return { ok: true, message: vscode.l10n.t('Pairing link copied.') };
  }
  // 边界校验：webview 消息属不可信输入，档位不合法就不许落到设备表
  //（`setTier` 是类型信任的写入面，没有第二道运行时校验）
  if (payload.action === 'set_tier' && !isRemoteDeviceTier(payload.tier)) {
    return { ok: false, message: vscode.l10n.t('Unknown permission level.') };
  }
  // 设备可能在页面停留期间被撤销：以设备表实时读取为准，不拿页面快照操作
  const device = handle.devices.get(payload.fingerprint);
  if (!device) {
    return { ok: false, message: vscode.l10n.t('That device is no longer paired.') };
  }
  const selection =
    payload.action === 'set_tier'
      ? ({ kind: 'set_tier', fingerprint: payload.fingerprint, tier: payload.tier } as const)
      : ({ kind: 'revoke', fingerprint: payload.fingerprint } as const);
  await applyDeviceAction(handle, device, selection);
  return { ok: true };
}
