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
 *   ③ **fire-and-forget，但不许哑巴失败**：通知失败绝不能反噬主链路（确认卡建立是安全关键
 *      路径，不能被一次 spawn 拖慢或抛错），可「没反应」必须留得下线索——失败写
 *      `%TEMP%/memora-toast.log`。AUMID 不匹配属于**静默不显示**（官方文档原话 "your toast
 *      will not be displayed"），这条日志是唯一诊断面。
 */
import { spawn } from 'node:child_process';

/** XML 硬上限（字符）：防御性截断，不是展示策略（展示截断归调用方） */
const XML_TEXT_HARD_MAX = 300;

/**
 * 默认 AUMID = VS Code 的 AppUserModelID（注册表里的真值：**中间不带点**）
 *
 * 🔴 官方 Win32 文档原话：`CreateToastNotifier(appId)` 的 AUMID 与「开始菜单快捷方式的
 * System.AppUserModel.ID 不一致」时 **"your toast will not be displayed"** —— 不抛错、
 * 不弹窗。写成想当然的 `Microsoft.VisualStudio.Code`（按扩展 ID 的拼法）就是这种**静默不显示**
 * 缺陷：真机只会看到「什么都没有」，日志里也没有线索（2026-10-22 排雷查证）。
 * 故脚本里还留了一条「从开始菜单发现 AppID 再重试」的兜底（便携版 / 分支版 AUMID 不同）。
 */
export const DEFAULT_TOAST_APP_ID = 'Microsoft.VisualStudioCode';

/** 失败日志文件名（落在 `%TEMP%`）：通知失败必须可诊断，否则真机只能看到「没反应」 */
export const TOAST_LOG_FILENAME = 'memora-toast.log';

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

/** PowerShell 单引号串转义：`'` 写成 `''`（AppID 由外部传入，不能假定无引号） */
function escapePsSingle(text: string): string {
  return text.replace(/'/g, "''");
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
 *
 * 三层失败处理（缺一层就是「真机没反应且查不出原因」）：
 *   ① AUMID 不信默认值 → 抛错后从开始菜单发现 `*Visual Studio Code*` 的 AppID 重试一次；
 *   ② 仍失败 → 尽力记录到 `%TEMP%/memora-toast.log`（含时间、当时用的 appId、异常消息）；
 *   ③ 记录本身失败 → 静默（通知链路不得反噬主链路）。
 *
 * 多行脚本：`-EncodedCommand` 收的是整段脚本，不需要压成一行。
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
    "$ErrorActionPreference='Stop'",
    `$appId='${escapePsSingle(appId)}'`,
    `$log=Join-Path $env:TEMP '${TOAST_LOG_FILENAME}'`,
    'try{',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]|Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]|Out-Null',
    '$xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${xml}')`,
    '$toast=New-Object Windows.UI.Notifications.ToastNotification $xml',
    'try{[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)}',
    'catch{',
    // AUMID 未注册 / 不匹配是**静默不显示**，只能靠抛错发现；发现后按开始菜单再猜一次
    '$alt=(Get-StartApps|Where-Object{$_.Name -like "*Visual Studio Code*"}|Select-Object -First 1).AppID',
    'if(-not $alt){throw}',
    '$appId=$alt',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '}',
    '}catch{',
    '"$(Get-Date -Format o) appId=$appId error=$($_.Exception.Message)"|Out-File -Append -Encoding utf8 $log',
    '}',
  ].join('\n');
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
