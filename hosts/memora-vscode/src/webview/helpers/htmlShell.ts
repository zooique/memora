/**
 * Webview HTML 文档头骨架 — 面板级 <head> 的单一真理源
 *
 * 背景：chatPanel 与 settingsPanel 各自持有一份逐字节相同的 <head>（lang / charset /
 * viewport / CSP / <style> 容器），且 `<html lang>` 硬编码为 zh-CN——与本仓库 bilingual
 * 产品形态、以及用户实际的 VS Code 显示语言脱钩：屏幕阅读器会用中文语音朗读英文内容，
 * 字体回退与断词行为也跟着错位。
 *
 * 本文件抽走这段骨架，使 CSP 与安全策略只在一处定义；lang 改由调用方按运行时环境
 * 解析后传入（本文件不依赖 vscode，保持纯函数、可直接单测）。
 */
export interface HtmlHeadParams {
  /** `<html lang>`：调用方应取 vscode.env.language，不可得时经 resolveHtmlLang 回落 */
  lang: string;
  /** webview.cspSource：放行 asWebviewUri 产出的外部脚本 */
  cspSource: string;
  /** 已拼接好的完整样式文本（可含多个样式片段） */
  styles: string;
}

/** lang 回落值：env.language 不可得时（如测试环境的 vscode mock 未定义 env）沿用中文 */
export const DEFAULT_HTML_LANG = 'zh-CN';

/**
 * lang 取值稳健解析：undefined 与空串一律回落，避免产出 `<html lang="undefined">`
 * ——那会被浏览器当作未知语言区域处理，比不写 lang 更糟。
 */
export function resolveHtmlLang(envLanguage: string | undefined): string {
  return envLanguage || DEFAULT_HTML_LANG;
}

/**
 * 生成 `<!DOCTYPE>` 到 `</head>` 的完整文档头（不含 `<body>`，由调用方续接）。
 *
 * CSP `img-src data: ${cspSource}`（2026-10-28 IMG-2 K3 放宽，改安全面 · 显式理由如下）：
 * - `data:`（2026-10-13 补）：样式层 mask 图标（如 AI 回答完成的「已完成」淡勾，
 *   chatStyles `.round-group__footer::after` 底栏标签用 `data:image/svg+xml` 画，同日自
 *   `.msg-body[data-terminus='已完成']::after` 迁来）按 CSP 规范走 img-src；
 *   不显式声明则被 `default-src 'none'` 兜底拦截——实测被拦后 VS Code 报
 *   "Note that 'img-src' was not explicitly set... The action has been blocked"，图标静默消失。
 * - `${cspSource}`（本次新增）：图片**磁盘预览**——附件缩略图/悬停大图用 `asWebviewUri`
 *   指向数据目录 `attachments/`（走宿主 `localResourceRoots` 同源路径），webview 只留
 *   URI 不留字节（数据唯一一份在磁盘，重启/销毁重建不产生「chip 在、预览空白」半死态）。
 *   这是对 VS Code 官方默认（本就放行扩展目录与工作区）的**恢复性放宽**——本宿主曾把
 *   `localResourceRoots` 主动收窄到 `dist/webview`，图片预览是收窄后第一个合法消费者；
 *   论证见 `docs/边界-图片采集UI-VSCode能力边界-20261028.md` §2 B4/B8（P-b 方案）。
 * ⚠️ 曾经那句「全库零 `<img>`，不授任何外部源」在图片输入落地后即成谎话，故本批同文订正
 * （注释与现实背离 = K3 立刺的本体，勿回退成只改一半）。
 */
export function buildHtmlHead({ lang, cspSource, styles }: HtmlHeadParams): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; style-src 'unsafe-inline'; script-src ${cspSource};" />
<style>
${styles}
</style>
</head>
`;
}
