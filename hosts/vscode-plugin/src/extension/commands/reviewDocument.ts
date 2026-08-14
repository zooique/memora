/**
 * 命令：审阅当前文档自洽性（切片 B）
 *
 * 职责：
 *   - 读取当前活动编辑器的 .md 文档内容
 *   - 调 Agent.chat() 触发 doc-review skill（矛盾 / 缺口 / 悬空引用）
 *   - 将自洽检查结果写入一个新的 .md 结果文档并打开（主动可见）
 *
 * 设计（薄壳 + 复用内核）：
 *   - 自洽检查逻辑由 doc-review skill 承载（skill 已随 configDir 装配），宿主不重复实现
 *   - 结果落成 .md 文档，复用 VS Code 编辑/查看能力，比独立 webview 面板更轻
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';

/** 触发 doc-review skill 的输入前缀（让 Agent 明确知道要审阅哪份文档） */
const REVIEW_INSTRUCTION = '请对当前文档做自洽性审阅（矛盾 / 缺口 / 悬空引用），按「问题 / 位置 / 建议修复」输出。';

/**
 * 审阅当前文档自洽性
 *
 * @param getAgent 按工作区路径懒加载 Agent 的工厂（由 extension.ts 注入）
 */
export async function reviewDocumentCommand(
  getAgent: (projectPath: string) => Promise<Agent>,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showErrorMessage('Memora：请先打开一个 Markdown 文档再执行自洽检查');
    return;
  }
  const doc = editor.document;
  const docText = doc.getText();
  if (!docText.trim()) {
    void vscode.window.showErrorMessage('Memora：当前文档为空，无可审阅内容');
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('Memora：请先打开一个工作区');
    return;
  }

  // 取消控制器：进度窗口的取消按钮 → AbortSignal → 内核 chat 中断（复用内核已落地的打断能力）
  const controller = new AbortController();

  // withProgress 提供进度反馈 + 可取消按钮，替代原先的阻塞式状态栏提示
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Memora 自洽检查',
      cancellable: true,
    },
    async (progress, token) => {
      // 进度窗口取消按钮 → 触发 AbortSignal
      token.onCancellationRequested(() => controller.abort());
      progress.report({ message: 'Agent 正在分析文档…' });

      try {
        const agent = await getAgent(workspaceFolder.uri.fsPath);
        // 注入文档内容作为上下文，引导 Agent 围绕该文档审阅（同任务 A 模式）
        const chatInput = `[待审阅文档]\n${docText}\n[/待审阅文档]\n\n${REVIEW_INSTRUCTION}`;

        let result = '';
        let cancelled = false;
        // 进度消息节流时间戳：流式 chunk 频繁，避免每次更新导致通知 UI 抖动
        let lastReportAt = 0;
        for await (const chunk of agent.chat(chatInput, controller.signal) as AsyncIterable<{
          type: string;
          content?: string;
        }>) {
          // 用户取消：内核 yield aborted 后流结束，此处同样收敛退出
          if (chunk.type === 'aborted') {
            cancelled = true;
            break;
          }
          if (chunk.type === 'text' && chunk.content) {
            result += chunk.content;
            // 节流更新进度（≥500ms 才刷新一次）
            const now = Date.now();
            if (now - lastReportAt > 500) {
              lastReportAt = now;
              progress.report({ message: `已生成 ${result.length} 字符…` });
            }
          }
        }

        // 取消时不落结果文档（避免写出空/半截报告）
        if (cancelled) {
          void vscode.window.showInformationMessage('Memora 自洽检查已取消');
          return;
        }

        // 结果写入新 .md 文档并打开（主动可见）
        await writeReviewResult(doc, result);
      } catch (err) {
        // 取消导致的异常（部分 provider 以 AbortError 抛错）同样按取消处理
        if (controller.signal.aborted) {
          void vscode.window.showInformationMessage('Memora 自洽检查已取消');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Memora 自洽检查失败：${msg}`);
      }
    },
  );
}

/**
 * 将自洽检查结果写入一个新文档并打开
 *
 * @param sourceDoc 被审阅的源文档（用于生成结果文档名）
 * @param result 自洽检查结果文本
 */
async function writeReviewResult(sourceDoc: vscode.TextDocument, result: string): Promise<void> {
  const baseName = sourceDoc.fileName.replace(/\.md$/i, '');
  // 结果文档与被审阅文档同目录，命名 `源文件名-自洽检查.md`
  const resultUri = vscode.Uri.file(`${baseName}-自洽检查.md`);

  const content = `# 自洽检查报告\n\n> 源文档：${sourceDoc.fileName}\n\n---\n\n${result}\n`;
  await vscode.workspace.fs.writeFile(resultUri, Buffer.from(content, 'utf8'));
  const resultDoc = await vscode.workspace.openTextDocument(resultUri);
  // 在分栏中打开结果，保留源文档
  await vscode.window.showTextDocument(resultDoc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}