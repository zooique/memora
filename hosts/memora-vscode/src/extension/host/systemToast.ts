/**
 * Windows 系统级 toast — 交互提醒的**离屏层**（HOST-ATTN-1）
 *
 * 为什么需要它：VS Code 的 workbench toast（`showInformationMessage` 带按钮时失焦不自动
 * 消失，见 microsoft/vscode#80285 / #80456）只能挂在 VS Code 窗口里——窗口最小化时窗口
 * 不渲染，用户**什么都看不到**。系统 toast 由 Windows 直接画在屏幕右下角，最小化/被遮挡
 * 都可见，是唯一能覆盖「人已离开 VS Code」的通道。
 *
 * 为什么不是「闪任务栏」：扩展 API 无此通道（Electron `flashFrame` 未暴露；1.105 的
 * `task.notifyWindowOnTaskCompletion` 仅限 Tasks 系统）。要闪只能引 native FFI 拿窗口句柄
 * 调 `FlashWindowEx`——为一个提醒引此依赖，成本倒挂（2026-10-22 排雷结论）。
 *
 * 🔴 三条实现纪律（缺一条就是造伤）：
 *   ① **数据进 XML 前必须转义**：文案含 `& < > " '` 会破 XML，PowerShell 侧静默失败
 *      （用户以为「没提醒」，实际是脚本崩了）——`info.description` 这类工具路径完全可能带引号；
 *   ② **数据永不拼命令位**：走 `-EncodedCommand`（UTF-16LE + Base64），既绕开中文编码坑，
 *      也避免脚本注入；
 *   ③ **fire-and-forget + 失败静默**：通知是增值能力，任何时候都不得反噬主链路
 *      （确认卡建立是安全关键路径，不能被一次 spawn 拖慢或抛错）。
 */
import { spawn } from 'node:child_process';

/** XML 硬上限（字符）：防御性截断，不是展示策略（展示截断归调用方） */
const XML_TEXT_HARD_MAX = 300;

/** 默认借用 VS Code 的 AUMID（注册表 Application User Model ID）：toast 显示 VS Code 图标 */
export const DEFAULT_TOAST_APP_ID = 'Microsoft.VisualStudio.Code';

/**
 * XML 文本转义
 *
 * `&` **必须最先替换**——否则后续替换产生的 `&lt;` 等实体里的 `&` 会被二次转义成
 * `&amp;lt;`，系统把整串当字面量显示。
 */
export function escapeXml(text: string): string {
  const clipped = text.length > XML_TEXT_HARD_MAX ? text.slice(0, XML_TEXT_HARD_MAX) : text;
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface SystemToastPayload {
  title: string;
  body: string;
  /** 点击 toast 后由系统拉起的协议链接（`vscode://...`；扩展侧 URI handler 承接） */
  launchUri: string;
}

/**
 * 生成 PowerShell 脚本（固定模板 + 转义后的数据）
 *
 * `activationType="protocol"`：点击 toast 走协议链接（唯一对扩展可行的激活方式——
 * `foreground` 需要应用注册 COM activator，扩展没有）。
 *
 * 单引号定界：转义后正文里不可能出现裸 `'`（已被 `&apos;` 吃掉），故整个 XML 安全落在
 * PowerShell 单引号字符串内。
 */
export function buildToastScript(payload: SystemToastPayload, appId: string): string {
  const title = escapeXml(payload.title);
  const body = escapeXml(payload.body);
  const launch = escapeXml(payload.launchUri);
  const bodyNode = body ? `<text>${body}</text>` : '';
  const xml =
    `<toast activationType="protocol" launch="${launch}">` +
    `<visual><binding template="ToastGeneric"><text>${title}</text>${bodyNode}</binding></visual>` +
    `</toast>`;
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${xml}')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)`,
  ].join('; ');
}

/** PowerShell `-EncodedCommand` 口径 = UTF-16LE + Base64（官方契约，非 base64(UTF-8)） */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** spawn 的最小结构面（只声明我们用到的两面，便于测试注入替身） */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => { on(event: 'error', listener: () => void): void; unref?: () => void };

export interface SystemToastDeps {
  spawnFn?: SpawnLike;
  platform?: NodeJS.Platform;
  appId?: string;
}

export type SystemToastSender = (payload: SystemToastPayload) => void;

/**
 * 构造系统 toast 发送器
 *
 * 非 Windows 平台直接 no-op（macOS 的 osascript / Linux 的 notify-send 未接，登记为
 * 待触发项）；spawn 失败、PowerShell 不存在、AUMID 未注册均在静默面——**不报错、不重试**。
 */
export function createSystemToastSender(deps: SystemToastDeps = {}): SystemToastSender {
  const spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnLike);
  const platform = deps.platform ?? process.platform;
  const appId = deps.appId ?? DEFAULT_TOAST_APP_ID;
  return (payload) => {
    if (platform !== 'win32') return;
    try {
      const child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(buildToastScript(payload, appId))],
        { stdio: 'ignore', windowsHide: true },
      );
      // error 事件必须有人接：无人接的 'error' 会抛成进程级未捕获异常（Node 语义）
      child.on('error', () => undefined);
      // unref：不因这条子进程拖住宿主退出（VS Code 关窗时不等 toast 脚本收尾）
      child.unref?.();
    } catch {
      // spawn 同步抛（参数非法等极端面）：吞掉，通知失败绝不冒泡到调用方
    }
  };
}
