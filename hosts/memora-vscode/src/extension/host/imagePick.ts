/**
 * 原生文件选择框 —— Q3 图片拾取入口的宿主适配层
 *
 * ## 为什么单独成模块（零 vscode 依赖）
 * `showOpenDialog` 只有扩展宿主拿得到（webview 无此 API）；但「开框」这件事的
 * 可测逻辑（选项构造、取消语义、多选编排）不该绑死在 vscode 类型上——与
 * `imageIngest.ts` 同一范式：**vscode 交互由调用方注入**，本模块只用 `node:*` 与
 * 纯函数，vitest 直接断言注入参数与编排结果。
 *
 * ## 两条入口汇于一个执行面
 * - webview 上传按钮 → `image_pick_request` → chatPanel 分支；
 * - 命令面板 `memora.attachImage` → chatPanel 公共方法。
 * 两路都调 {@link pickAndIngestImages}：编排只有这一份，取消语义 /
 * 过滤器口径 / 逐张落盘的循环禁在任一入口复写。
 *
 * ## 扩展名只是预筛，不是判据
 * 过滤器给图片扩展名是**交互友好**（少翻无关节点）；真伪由校验链的字节嗅探说了算
 * （`ingestDiskFile` 不传声明 mime）。故必须留「所有文件」兜底——扩展名不可信正是
 * 本路径的立身前提，把用户锁死在扩展名里等于自打嘴巴；选错内容会被 rejected
 * **可见**拒收，不静默。
 */
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { ingestDiskFile } from './imageIngest.js';

/** 拾取回执类型（从协议联合取型，禁手写第二份字段表） */
type ImagePickedResult = Extract<ExtensionToWebviewMessage, { type: 'image_picked' }>;

/** 对话框选项（与 vscode `OpenDialogOptions` 结构兼容的最小面，零 vscode 依赖） */
export interface ImagePickDialogOptions {
  title: string;
  canSelectMany: boolean;
  filters: Record<string, string[]>;
}

/**
 * 对话框注入口：入参 = 选项，出参 = 选中文件绝对路径（`Uri.fsPath`）；
 * 取消 = `undefined`（与 vscode 原语义一致，禁把它改造成空数组——两种「没选」
 * 在原生侧本来就是一个语义）。
 */
export type ImageFilePicker = (
  options: ImagePickDialogOptions,
) => Promise<string[] | undefined>;

/**
 * 对话框文案与过滤器（单点）。
 *
 * filters 键用中文「图片」：键名直接显示在原生对话框的下拉里，与面板全中文 UI 同语。
 */
const DIALOG_OPTIONS: ImagePickDialogOptions = {
  title: '选择要添加到对话的图片',
  canSelectMany: true,
  filters: {
    图片: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
    所有文件: ['*'],
  },
};

export interface ImagePickDeps {
  /**
   * 对话面板是否可投递回执（`_view` 已解析）。
   *
   * 命令入口在面板未打开时**不开框**：开了框、落了盘、回执却无处可去 =
   * 造出「写了盘但没有 chip」的孤儿（G9 同族），还让用户以为添加成功了。
   * fail-fast 给一句引导，比事后清理诚实。
   */
  hasPanel: boolean;
  picker: ImageFilePicker;
  projectPath: string;
  post: (msg: ImagePickedResult) => void;
  /** 落盘文件 → webview 可加载 URL（悬停预览；语义同 `ingestImage` 第 4 参） */
  toWebviewUri?: (file: string) => string | undefined;
  /** 面板不可用时的用户提示（注入保持零 vscode；文案面归调用方） */
  notifyPanelUnavailable: () => void;
}

/**
 * 图片拾取编排：开框 → 逐张读盘校验落盘 → 逐张回执。
 *
 * 一次多选产多条回执（每张一条 `image_picked`，webview 逐条建/拒 chip）；
 * 取消 / 空选 = 「没有发生任何事」，不回执（协议约定：取消不产生事件）。
 * 逐张**并发**落盘但整体收口：本函数返回 = 全部回执已投递（`Promise.all`）——
 * 生产侧无感（回执本来就经 postMessage 异步上屏），测试侧则获得确定性断言点；
 * 单张失败不拖累其余（每张独立三态回执），与粘贴多图的并发时序同构。
 */
export async function pickAndIngestImages(deps: ImagePickDeps): Promise<void> {
  if (!deps.hasPanel) {
    deps.notifyPanelUnavailable();
    return;
  }
  const picked = await deps.picker(DIALOG_OPTIONS);
  if (!picked || picked.length === 0) return;
  await Promise.all(
    picked.map((file) => ingestDiskFile(deps.projectPath, file, deps.post, deps.toWebviewUri)),
  );
}
