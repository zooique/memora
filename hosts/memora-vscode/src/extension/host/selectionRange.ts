/**
 * selectionRange — 编辑器选区 → 引用行区间（宿主侧，纯函数可单测）
 *
 * ⚠️ **基准转换的唯一发生地**：VS Code `selection.line` 是 **0-based**，而协议与内核
 * `read_file` 工具的 `offset` 参数是 **1-based**（其描述明写「起始行号（从 1 开始）」）
 * ⇒ 只在这里 +1，下游（协议 / webview / 信封）一律不再转换——两处各转一次必漂移（SSOT）。
 * （定位一律用符号名而非行号：行号无 SSOT，注释里的行号引用会被 commentHygiene 守卫拦下。）
 *
 * 入参收窄为**纯数据结构**（不含 vscode 依赖）⇒ 可单测、webview 侧也无需引用。
 * `vscode.Selection` 天然满足该结构（start/end 各含 line/character）。
 */

/** 选区端点（与 vscode.Position 同形，仅取两个字段） */
export type SelectionLike = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

/**
 * 选区 → 行区间（1-based 闭区间）；折叠选区（仅光标，无选中内容）返回 undefined
 * ⇒ 调用方按「整文件引用」处理，保持既有行为不变。
 */
export function selectionToRefRange(
  sel: SelectionLike,
): { start: number; end: number } | undefined {
  const isEmpty = sel.start.line === sel.end.line && sel.start.character === sel.end.character;
  if (isEmpty) return undefined;
  // 整行选中（三击 / Shift+↓）会在末尾多带一个空行：末列为 0 且跨行时回退一行，
  // 否则会多框一行（真机可复现的边界，非理论推演）。
  const endLine =
    sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  // VS Code 已归一化方向（start 恒 ≤ end），故不做大小校正
  return { start: sel.start.line + 1, end: endLine + 1 };
}
