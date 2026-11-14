/**
 * 工作台 webview HTML 骨架（编辑器区面板）
 *
 * 只复用一个骨架：`buildHtmlHead`（CSP / lang / l10n 数据块的唯一来源，见
 * `helpers/htmlShell.ts`）——**不再抄一份 head**。这里只写工作台自己的 body：
 * 第一块座位身份 + 第二块在管会话清单 + 外部脚本位。
 *
 * 红线：工作台**没有输入框**（它不是第二个聊天对象）；所有动态内容由脚本按快照
 * 填充，本文件不插值任何会话数据。
 */
import * as vscode from 'vscode';
import { buildHtmlHead, resolveHtmlLang } from '../helpers/htmlShell.js';
import { workbenchStyles } from '../styles/workbenchStyles.js';

/**
 * 构造工作台完整 HTML
 *
 * @param scriptUri 外部脚本 workbenchView.js 的 asWebviewUri（CSP script-src 放行）
 * @param cspSource webview 本地资源源（`webview.cspSource`）
 * @returns 完整 HTML 文档
 */
export function buildWorkbenchHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `${buildHtmlHead({
    lang: resolveHtmlLang(vscode.env?.language),
    cspSource,
    styles: workbenchStyles,
    // 译文随 HTML 内联（默认语言 bundle 为 undefined ⇒ 不注入；`?.` 守测试侧 mock）
    l10nBundle: vscode.l10n?.bundle,
  })}
<body>
  <main class="workbench">
    <!-- 第一块：代理是谁（座位身份区） -->
    <section class="wb-seat" aria-label="${vscode.l10n.t('Agent seat')}">
      <div class="wb-seat__name" id="seatName"></div>
      <div class="wb-seat__title" id="seatTitle"></div>
      <div class="wb-seat__role" id="seatRole" hidden></div>
      <div class="wb-seat__state" id="seatState" hidden></div>
    </section>

    <!-- 第二块：最近在办什么（在管会话清单；为空时显示空态句，不摆空表格） -->
    <section class="wb-jobs" aria-labelledby="jobsTitle">
      <h2 class="wb-jobs__title" id="jobsTitle">${vscode.l10n.t('Recent work')}</h2>
      <div class="wb-jobs__empty" id="jobsEmpty" hidden>${vscode.l10n.t('No work has been handed to the assistant yet')}</div>
      <div class="wb-jobs__notice" id="jobsNotice" hidden></div>
      <ul class="wb-jobs__list" id="jobsList"></ul>
    </section>
  </main>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
