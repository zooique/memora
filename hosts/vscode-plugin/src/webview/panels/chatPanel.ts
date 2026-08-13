/**
 * 对话打磨面板 — Webview 侧（ADR-VC-001 决策 5：Webview 只做 UI，走 postMessage）
 *
 * 职责：
 *   - 渲染对话 UI（消息区 + 输入框）——切片 A
 *   - 将用户输入 postMessage 到 extension host，调 Agent.chat() 流式返回并渲染
 *   - 携带「当前打磨文档」上下文注入对话，引导 AI 围绕该文档打磨（任务 A）
 *
 * 设计说明（单一真理源）：
 *   - 文档内容是「当前任务上下文」，不是记忆，不进入 recall 通道（避免污染跨会话召回）。
 *   - 薄壳只做装配：读取文档文本 → 作为上下文前缀注入 chat() 输入，不改内核。
 *   - docContext 为打开面板时的一次性快照：面板打开后若继续编辑文档，不会自动刷新。
 *     如需同步最新内容，需关闭面板重新打开（MVP 阶段保持简单，不做实时监听）。
 *
 * 未来扩展：本面板演进为「对话打磨」主面板；自洽检查/骨架生成/记忆分属独立面板（panels/ 下）。
 */
import * as vscode from 'vscode';
import type { Agent, AgentChunk } from '@zooique/memora';
import type {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
} from '../../shared/protocol.js';

/** 当前打开的对话面板（单例，聚焦复用） */
let currentPanel: vscode.WebviewPanel | undefined;

/** 打开对话打磨面板 */
export function openChatPanel(agent: Agent, docContext?: string): void {
  // 已有面板则聚焦并返回
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'memoraDocReview.chat',
    'Memora 文档打磨',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  currentPanel = panel;

  panel.webview.html = buildHtml();
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  // 记忆可观测出口（任务 D）：监听 Agent 记忆活动事件，转发到 Webview 提示条
  // 薄壳只做转发，不改内核；事件源为 memoryRecalled / memoryAdded
  const postMemory = (payload: { action: 'recalled' | 'added'; count: number }) => {
    void panel.webview.postMessage({ type: 'memory', ...payload });
  };
  const onRecalled = (e: { count: number; query: string }) =>
    postMemory({ action: 'recalled', count: e.count });
  const onAdded = (_e: { id: string; source: string; name: string }) =>
    postMemory({ action: 'added', count: 1 });
  agent.on('memoryRecalled', onRecalled);
  agent.on('memoryAdded', onAdded);
  panel.onDidDispose(() => {
    // 面板关闭时移除监听，避免泄漏
    agent.off('memoryRecalled', onRecalled);
    agent.off('memoryAdded', onAdded);
  });

  // 处理来自 Webview 的用户输入 → 流式对话
  panel.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
    if (msg.type === 'send' && msg.text) {
      await handleSend(panel, agent, msg.text, docContext);
    }
  });
}

/**
 * 处理一次用户输入：流式调用 Agent.chat 并回发 chunk
 *
 * @param docContext 当前打磨文档内容（可选）。非空时注入用户输入前缀，
 *                   让 Agent 围绕该文档打磨；为空则退化为普通对话。
 */
async function handleSend(
  panel: vscode.WebviewPanel,
  agent: Agent,
  input: string,
  docContext?: string,
): Promise<void> {
  const post = (m: ExtensionToWebviewMessage) => {
    void panel.webview.postMessage(m);
  };

  // 用户消息上屏
  post({ type: 'user', text: input });

  // 注入文档上下文：文档属于「当前任务上下文」，作为输入前缀，不进入记忆召回
  const chatInput = docContext
    ? `[当前打磨文档内容]\n${docContext}\n[/当前打磨文档内容]\n\n用户请求：${input}`
    : input;

  let done = false;
  try {
    // 流式消费 Agent 输出
    for await (const chunk of agent.chat(chatInput) as AsyncIterable<AgentChunk>) {
      if (chunk.type === 'text' && chunk.content) {
        post({ type: 'chunk', content: chunk.content });
      }
    }
    done = true;
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  if (done) {
    post({ type: 'done' });
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
  .memory-bar { padding: 4px 12px; font-size: 12px; color: #5f6368; background: #e6f4ea; border-bottom: 1px solid #ceead6; }
</style>
</head>
<body>
  <div id="memoryBar" class="memory-bar" hidden></div>
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
    const memoryBar = document.getElementById('memoryBar');

    function append(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    // 记忆提示条：短暂展示后自动隐藏（主动可见，不过度设计）
    let memoryTimer = null;
    function showMemory(text) {
      memoryBar.textContent = text;
      memoryBar.hidden = false;
      clearTimeout(memoryTimer);
      memoryTimer = setTimeout(() => { memoryBar.hidden = true; }, 2500);
    }

    // 接收 extension host 推送（用户消息 / 流式 chunk / done / error / memory）
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'user') {
        append('user', msg.text);
      } else if (msg.type === 'chunk') {
        const last = messages.lastElementChild;
        if (last && last.classList.contains('assistant')) {
          last.textContent += msg.content;
        } else {
          append('assistant', msg.content);
        }
        messages.scrollTop = messages.scrollHeight;
      } else if (msg.type === 'error') {
        append('error', msg.message);
      } else if (msg.type === 'memory') {
        // 记忆可观测出口：召回 / 沉淀提示
        if (msg.action === 'recalled') {
          showMemory('🧠 已召回 ' + msg.count + ' 条记忆');
        } else if (msg.action === 'added') {
          showMemory('📝 已沉淀 1 条记忆');
        }
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
