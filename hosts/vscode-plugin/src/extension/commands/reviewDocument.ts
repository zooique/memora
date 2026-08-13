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

  // 状态栏提示：自洽检查进行中
  const status = vscode.window.setStatusBarMessage('$(sync~spin) Memora 正在做自洽检查…');
  try {
    const agent = await getAgent(workspaceFolder.uri.fsPath);
    // 注入文档内容作为上下文，引导 Agent 围绕该文档审阅（同任务 A 模式）
    const chatInput = `[待审阅文档]\n${docText}\n[/待审阅文档]\n\n${REVIEW_INSTRUCTION}`;

    let result = '';
    for await (const chunk of agent.chat(chatInput) as AsyncIterable<{
      type: string;
      content?: string;
    }>) {
      if (chunk.type === 'text' && chunk.content) result += chunk.content;
    }

    // 结果写入新 .md 文档并打开（主动可见）
    await writeReviewResult(doc, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Memora 自洽检查失败：${msg}`);
  } finally {
    status.dispose();
  }
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