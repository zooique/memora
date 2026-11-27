/**
 * remoteStatusPush — 设置页「远程控制」状态推送的公共实现（执行窄口 + 一次推送）
 *
 * 为什么外置：`settingsPanel.ts` 逼近 eslint `max-lines` 基线（只降不升），
 * 「读状态 → post 一条消息」零面板状态依赖，本就不该长在面板类体里
 * （与 `settingsStatusPush.ts` 同款理由）。
 *
 * 🔴 判据不变：状态真源 = 宿主 `remoteSettingsOps`（桥运行时 + 设备表 + 审计尾），
 * 本模块只转交 `post`，不缓存、不派生、不做授权判断。
 */
import type {
  ExtensionToWebviewMessage,
  RemoteActionPayload,
  RemoteSettingsStatus,
} from '../../shared/protocol.js';

/**
 * 远程控制页执行窄口（extension 注入；未注入 = 页面只显示静态说明）
 */
export interface RemoteOpsPort {
  /** 读当前状态快照（含设备表与审计尾） */
  readStatus: () => Promise<RemoteSettingsStatus>;
  /** 执行动作（成功/失败都回结论；失败文案已本地化） */
  applyAction: (payload: RemoteActionPayload) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * 推送一次远程控制状态
 *
 * 读取整体失败只记日志、不弹全局提示：审计读取失败已由 DTO 的 `auditError`
 * 在页内显式降级；整函数失败属异常缺陷，ready / 转可见各弹一次 toast 反而打扰用户。
 *
 * @param ops  注入的执行面（未注入 = 空操作）
 * @param post 面板投递口
 */
export function pushRemoteSettingsStatus(
  ops: RemoteOpsPort | undefined,
  post: (msg: ExtensionToWebviewMessage) => void,
): void {
  if (!ops) return;
  void ops.readStatus().then(
    (status) => post({ type: 'remote_settings', status }),
    (err: unknown) => console.warn('[memora] remote status read failed', err),
  );
}
