/**
 * 设计文档打磨面板 — Webview 侧（ADR-VC-001 决策 5：Webview 只做 UI，走 postMessage）
 *
 * 职责：
 *   - 渲染对话 UI（消息区 + 输入框）
 *   - 将用户输入 postMessage 到 extension host，调 Agent.chat() 流式返回并渲染
 *
 * 阶段 0：最小对话 UI（文本气泡 + 输入）。后续阶段扩展自洽检查/骨架/记忆面板。
 */
import * as vscode from 'vscode';
import type { Agent, AgentChunk } from '@zooique/memora';

/** 当前打开的面板（单例，聚焦复用） */
let currentPanel: vscode.WebviewPanel | undefined;

/** 打开设计文档打磨面板 */
export function openDocReviewPanel(agent: Agent): void {
  // 已有面板则聚焦并返回
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'memoraDocReview.panel',
    'Memora 文档打磨',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  currentPanel = panel;

  panel.webview.html = buildHtml();
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  // 处理来自 Webview 的用户输入 → 流式对话
  panel.webview.onDidReceiveMessage(async (msg: { type: string; text?: string }) => {
    if (msg.type === 'send' && msg.text) {
      await handleSend(panel, agent, msg.text);
    }
  });
}

/** 处理一次用户输入：流式调用 Agent.chat 并回发 chunk */
async function handleSend(panel: vscode.WebviewPanel, agent: Agent, input: string): Promise<void> {
  // 通知 Webview：用户消息上屏 + 清空输入
  panel.webview.postMessage({ type: 'user', text: input });

  let done = false;
  try {
    // 流式消费 Agent 输出
    for await (const chunk of agent.chat(input) as AsyncIterable<AgentChunk>) {
      if (chunk.type === 'text' && chunk.content) {
        panel.webview.postMessage({ type: 'chunk', content: chunk.content });
      }
    }
    done = true;
  } catch (err) {
    panel.webview.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (done) {
    panel.webview.postMessage({ type: 'done' });
  }
}

/** 生成 Webview HTML（阶段 0 最小对话 UI） */
function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; box-sizing: border-box; }
  .msg { margin: 6px 0; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { background: #e8f0fe; align-self: flex-end; }
  .msg.assistant { background: #f1f3f4; }
  .msg.error { background: #fdecea; color: #b3261e; }
  #inputBar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #ddd; }
  #input { flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #ccc; }
  button { padding: 8px 14px; border-radius: 6px; border: none; background: #1a73e8; color: #fff; cursor: pointer; }
</style>
</head>
<body>
  <div id="messages"></div>
  <div id="inputBar">
    <input id="input" type="text" placeholder="在文档上打磨你的想法……" />
    <button id="send">发送</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');

    function append(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    // 接收 extension host 推送（用户消息 / 流式 chunk / done / error）
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'user') {
        append('user', msg.text);
      } else if (msg.type === 'chunk') {
        // 流式：合并到最后一个 assistant 气泡
        const last = messages.lastElementChild;
        if (last && last.classList.contains('assistant')) {
          last.textContent += msg.content;
        } else {
          append('assistant', msg.content);
        }
        messages.scrollTop = messages.scrollHeight;
      } else if (msg.type === 'done') {
        // 结束：无需额外处理
      } else if (msg.type === 'error') {
        append('error', msg.message);
      }
    });

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ type: 'send', text });
    }
    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
  </script>
</body>
</html>`;
}
