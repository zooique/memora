/**
 * 命令：根据设计文档生成代码骨架（切片 C）
 *
 * 职责：
 *   - 读取当前活动编辑器的 .md 设计文档内容
 *   - 调 Agent.chat() 触发 scaffold skill，用 write_file 工具在工作区生成骨架
 *   - 将骨架生成报告写入新 .md 文档并打开（主动可见）
 *
 * 设计（薄壳 + 复用内核）：
 *   - 骨架生成规则由 scaffold skill 承载（skill 随 configDir 装配），宿主不重复实现
 *   - Agent 的 write_file / list_dir 工具已按 allowedPaths 限定在工作区内，天然安全
 *   - 结果落成 .md 文档，复用 VS Code 编辑/查看能力，比独立面板更轻
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';

/** 触发 scaffold skill 的输入前缀（让 Agent 明确要基于哪份设计文档生成骨架） */
const SCAFFOLD_INSTRUCTION = '请基于上述设计文档，在工作区生成项目代码骨架（目录结构 + 占位实现），完成后列出生成的文件清单。';

/**
 * 生成文档骨架
 *
 * @param getAgent 按工作区路径懒加载 Agent 的工厂（由 extension.ts 注入）
 */
export async function scaffoldProjectCommand(
  getAgent: (projectPath: string) => Promise<Agent>,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showErrorMessage('Memora：请先打开一个 Markdown 设计文档再生成骨架');
    return;
  }
  const doc = editor.document;
  const docText = doc.getText();
  if (!docText.trim()) {
    void vscode.window.showErrorMessage('Memora：当前文档为空，无可生成的设计内容');
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
      title: 'Memora 骨架生成',
      cancellable: true,
    },
    async (progress, token) => {
      // 进度窗口取消按钮 → 触发 AbortSignal
      token.onCancellationRequested(() => controller.abort());
      progress.report({ message: 'Agent 正在读取设计文档…' });

      try {
        const agent = await getAgent(workspaceFolder.uri.fsPath);
        // 注入设计文档内容作为上下文，引导 Agent 围绕该文档生成骨架（同任务 A/B 模式）
        const chatInput = `[设计文档]\n${docText}\n[/设计文档]\n\n${SCAFFOLD_INSTRUCTION}`;

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
          void vscode.window.showInformationMessage('Memora 骨架生成已取消');
          return;
        }

        // 结果写入新 .md 文档并打开（主动可见）
        await writeScaffoldResult(doc, result);
      } catch (err) {
        // 取消导致的异常（部分 provider 以 AbortError 抛错）同样按取消处理
        if (controller.signal.aborted) {
          void vscode.window.showInformationMessage('Memora 骨架生成已取消');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Memora 骨架生成失败：${msg}`);
      }
    },
  );
}

/**
 * 将骨架生成报告写入一个新文档并打开
 *
 * @param sourceDoc 被生成的源设计文档（用于生成结果文档名）
 * @param result 骨架生成报告文本
 */
async function writeScaffoldResult(sourceDoc: vscode.TextDocument, result: string): Promise<void> {
  const baseName = sourceDoc.fileName.replace(/\.md$/i, '');
  // 结果文档与被生成文档同目录，命名 `源文件名-骨架生成报告.md`
  const resultUri = vscode.Uri.file(`${baseName}-骨架生成报告.md`);

  const content = `# 代码骨架生成报告\n\n> 设计文档：${sourceDoc.fileName}\n\n---\n\n${result}\n`;
  await vscode.workspace.fs.writeFile(resultUri, Buffer.from(content, 'utf8'));
  const resultDoc = await vscode.workspace.openTextDocument(resultUri);
  // 在分栏中打开结果，保留源文档
  await vscode.window.showTextDocument(resultDoc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}