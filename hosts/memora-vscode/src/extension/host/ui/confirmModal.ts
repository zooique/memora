/**
 * 模态确认框唯一入口（宿主侧 UI 原语）
 *
 * ## 为什么必须有这个 helper
 * VS Code 在 `{ modal: true }` 时**自动追加**一个系统级 Cancel（Esc / 关闭 X 同源），
 * 其 Promise 解析为 `undefined`；调用点若再自行传一个「取消」item，屏幕上就会出现
 * `[确认] [取消] [取消]` 双取消（2026-11-03 真机实锤，台账 `MODAL-DUP-CANCEL-1`）。
 * 历史修复靠各调用点照抄「只传确认动作」，新增调用点又踩了回去 ⇒ 把按钮集收进
 * 一个入口，**类型上根本没有「取消」这个参数位**，从结构上断掉复发。
 *
 * ## 判据（单向，改之前先读）
 * 只有 `resolved === confirmLabel` 才算确认；`undefined`（自带 Cancel / Esc / 关 X）
 * 与任何其它字符串（`'取消'`、带尾空格、大小写变体…）一律 `false`。
 * **禁止**改写成「不等于取消就是确认」这种负判据：自带 Cancel 解析为 `undefined`，
 * 负判据会把一次真取消判成确认（一个真取消、一个假取消）。
 *
 * ## 射程（2026-11-03 第二段收口后）
 * 全仓所有模态确认统一经由本函数：原有 12 处直调 `showWarningMessage(..., { modal: true }, ...)`
 * 已全部迁入；现在生产代码里 `modal: true` 只出现在本文件，由
 * `scripts/verify-modal-cancel.mjs` 的严闸钉住（新增模态确认必须走这里，不得另开入口）。
 * 台账 `MODAL-DUP-CANCEL-1` 第一段（窄闸）+ 第二段（严闸 + 12 处收口）均已闭合。
 */
import * as vscode from 'vscode';

/** 模态确认框入参（没有取消项参数位——取消是 VS Code 自带的系统行为） */
export interface ConfirmModalOptions {
  /** 主行文案：一句话说明这次操作会做什么 */
  message: string;
  /** 确认按钮文案（**唯一** item）；调用方自己决定「覆盖 / 删除 / 确认清理」等措辞 */
  confirmLabel: string;
  /** 附加行，透传 VS Code 原生 `MessageOptions.detail`（附属行渲染）；缺省则不带该键 */
  detail?: string;
}

/**
 * 弹出一个「单个确认按钮」的模态框，返回用户是否点了确认
 *
 * @param options 文案与确认按钮名（无取消项）
 * @returns true = 用户点了 `confirmLabel`；false = 其它一切情况（自带 Cancel / Esc / 关 X / 异常返回值）
 */
export async function confirmModal(options: ConfirmModalOptions): Promise<boolean> {
  // 选项对象由 helper 独占构造：modal 恒定 true，detail 走 VS Code 原生附属行（不并入 message，
  // 保持迁移前「主行 + 附属行」的渲染与文案完全等价）
  const modalOptions = options.detail ? { modal: true, detail: options.detail } : { modal: true };
  const resolved = await vscode.window.showWarningMessage(
    options.message,
    modalOptions,
    // 只传确认项：第 2 个按钮由 VS Code 自动追加（Cancel），此处再传「取消」必现双取消
    options.confirmLabel,
  );
  // 单向判据：严格等于确认文案才为 true（undefined / '取消' / 其它字符串均 false）
  return resolved === options.confirmLabel;
}
