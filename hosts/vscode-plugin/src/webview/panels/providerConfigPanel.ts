/**
 * 大模型配置面板 — 侧边栏 Webview 视图提供者
 *
 * 职责：
 *   - 渲染多 Provider 卡片列表（激活徽章 + 设为当前/编辑/删除按钮）
 *   - 新增/编辑弹窗表单（别名/显示名/模型/BaseURL/API Key/测试连接）
 *   - 通过 postMessage 与 extension host 通信，读写 ProviderStore
 *
 * 设计（对齐 memora-sprite 的多 Provider 管理 + 单一真理源）：
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM
 *   - apiKey 传输给 webview 时为脱敏值；保存时留空=保留原值
 *   - 复用 shared/protocol.ts 的 LlmProviderConfig 与 cfg_* 消息契约
 */
import * as vscode from 'vscode';
import type { ProviderStore } from '../../extension/providers/providerStore.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { configStyles } from '../styles/configStyles.js';

/** 配置视图提供者 */
export class MemoraConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.docReview.config';

  /** 当前 webview */
  private _view: vscode.WebviewView | undefined;

  /**
   * @param store 大模型配置存储（extension 注入）
   */
  constructor(private readonly store: ProviderStore) {}

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    // 渲染界面
    webviewView.webview.html = buildHtml();

    // 处理来自 webview 的配置操作
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      void this.handleMessage(msg);
    });

    // 首次加载列表
    void this.load();
  }

  /** 处理 webview 发来的配置消息 */
  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'cfg_load':
          await this.load();
          break;
        case 'cfg_save': {
          const r = await this.store.save(msg.config, msg.isEditing);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'save' });
          if (r.ok) await this.load();
          break;
        }
        case 'cfg_delete': {
          const r = await this.store.remove(msg.name);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'delete' });
          if (r.ok) await this.load();
          break;
        }
        case 'cfg_set_active': {
          const r = await this.store.setActive(msg.name);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'set_active' });
          if (r.ok) await this.load();
          break;
        }
        case 'cfg_test': {
          const r = await this.store.test(msg.config);
          this.post({ type: 'cfg_result', ok: r.ok, message: r.message, action: 'test' });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.post({
        type: 'cfg_result',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        action: 'save',
      });
    }
  }

  /** 加载 Provider 列表并推送给 webview */
  private async load(): Promise<void> {
    const [providers, activeName] = await Promise.all([
      this.store.listMasked(),
      Promise.resolve(this.store.getActiveName()),
    ]);
    this.post({ type: 'cfg_loaded', providers, activeName });
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }
}

/** 生成 Webview HTML（Provider 列表 + 表单弹窗） */
function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  ${configStyles}
</style>
</head>
<body>
  <div class="header">
    <h2>大模型配置</h2>
    <button id="btnAdd" class="btn">添加 API</button>
  </div>
  <div id="list">
    <p class="hint">加载中…</p>
  </div>

  <!-- 新增/编辑弹窗 -->
  <div id="modal" class="modal-mask">
    <div class="modal">
      <h3 id="modalTitle">添加 API</h3>
      <!-- 表单语义：label 与 input 用 for/id 关联（可点击聚焦 + 读屏识别），
           支持 Enter 提交；非认证字段 autocomplete=off 避免密码管理器误触发。 -->
      <form id="cfgForm">
        <div class="field">
          <label for="f-name">别名（唯一，仅英文数字.-_）</label>
          <input id="f-name" name="name" type="text" placeholder="如 deepseek" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-display">显示名称</label>
          <input id="f-display" name="displayName" type="text" placeholder="如 DeepSeek" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-model">模型</label>
          <input id="f-model" name="model" type="text" placeholder="如 deepseek-chat" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-baseurl">API Base URL</label>
          <input id="f-baseurl" name="baseUrl" type="url" placeholder="https://api.deepseek.com/v1" autocomplete="url" />
        </div>
        <div class="field">
          <label for="f-apikey">API Key（编辑时留空保持不变）</label>
          <input id="f-apikey" name="apiKey" type="password" placeholder="sk-…" autocomplete="new-password" />
          <div id="apikeyHint" class="key-hint" hidden></div>
        </div>
        <div id="testResult" class="test-result" hidden></div>
        <div class="modal-actions">
          <button id="btnTest" type="button" class="btn btn-secondary">测试连接</button>
          <button id="btnCancel" type="button" class="btn btn-secondary">取消</button>
          <button id="btnSave" type="submit" class="btn">保存</button>
        </div>
      </form>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');
    const btnAdd = document.getElementById('btnAdd');
    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modalTitle');
    const fName = document.getElementById('f-name');
    const fDisplay = document.getElementById('f-display');
    const fModel = document.getElementById('f-model');
    const fBaseUrl = document.getElementById('f-baseurl');
    const fApiKey = document.getElementById('f-apikey');
    const apikeyHint = document.getElementById('apikeyHint');
    const testResult = document.getElementById('testResult');
    const btnTest = document.getElementById('btnTest');
    const btnCancel = document.getElementById('btnCancel');
    const toast = document.getElementById('toast');

    let editName = ''; // 当前编辑的 name（空=新增）
    let activeName = undefined;

    function showToast(text, ok) {
      toast.textContent = text;
      toast.className = ok ? 'ok visible' : 'err visible';
      setTimeout(function () { toast.className = ok ? 'ok' : 'err'; }, 2500);
    }

    function readForm() {
      return {
        name: fName.value.trim(),
        displayName: fDisplay.value.trim(),
        model: fModel.value.trim(),
        baseUrl: fBaseUrl.value.trim(),
        apiKey: fApiKey.value,
      };
    }

    function openModal(name) {
      editName = name || '';
      modalTitle.textContent = editName ? '编辑 API' : '添加 API';
      // 重置上一轮测试结果（每次打开表单都清空，避免残留误导）
      testResult.hidden = true;
      testResult.textContent = '';
      testResult.className = 'test-result';
      btnTest.disabled = false;
      if (editName) {
        // 编辑：从当前列表预填非敏感字段 + 脱敏 key 回显
        const card = list.querySelector('div[data-name="' + CSS.escape(editName) + '"]');
        // 简化：通过 dataset 读取
        fName.value = editName;
        fName.disabled = true;
        fDisplay.value = card ? card.dataset.display : '';
        fModel.value = card ? card.dataset.model : '';
        fBaseUrl.value = card ? card.dataset.baseurl : '';
        fApiKey.value = '';
        fApiKey.placeholder = '留空保持不变';
        // 脱敏回显：标明已配置的 key（如 sk-••••1234），确认无需重新输入
        const masked = card ? card.dataset.maskedkey : '';
        apikeyHint.hidden = !masked;
        apikeyHint.textContent = masked ? '已配置：' + masked + '（留空保持不变）' : '';
      } else {
        fName.value = '';
        fName.disabled = false;
        fDisplay.value = '';
        fModel.value = '';
        fBaseUrl.value = '';
        fApiKey.value = '';
        fApiKey.placeholder = 'sk-…';
        apikeyHint.hidden = true;
        apikeyHint.textContent = '';
      }
      modal.classList.add('visible');
      fName.focus();
    }

    function closeModal() {
      modal.classList.remove('visible');
      editName = '';
    }

    function render(data) {
      if (!data.providers || data.providers.length === 0) {
        list.innerHTML = '<p class="hint">暂未配置任何 API，点击右上角「添加 API」。</p>';
        return;
      }
      activeName = data.activeName;
      list.innerHTML = '';
      data.providers.forEach(function (p) {
        const card = document.createElement('div');
        card.className = 'card' + (p.name === activeName ? ' active' : '');
        card.dataset.name = p.name;
        card.dataset.display = p.displayName || p.name;
        card.dataset.model = p.model;
        card.dataset.baseurl = p.baseUrl;
        card.dataset.maskedkey = p.maskedKey || '';

        const info = document.createElement('div');
        info.className = 'card-info';
        const nameRow = document.createElement('div');
        nameRow.className = 'card-name';
        nameRow.textContent = (p.displayName || p.name) + (p.provider === 'local' ? '（本地）' : '');
        if (p.name === activeName) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = '当前';
          nameRow.appendChild(badge);
        }
        const detail = document.createElement('div');
        detail.className = 'card-detail';
        detail.textContent = p.model + ' · ' + p.baseUrl;
        info.appendChild(nameRow);
        info.appendChild(detail);

        const actions = document.createElement('div');
        actions.className = 'card-actions';
        if (p.name !== activeName) {
          const actBtn = document.createElement('button');
          actBtn.className = 'btn btn-secondary';
          actBtn.textContent = '设为当前';
          actBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'cfg_set_active', name: p.name });
          });
          actions.appendChild(actBtn);
        }
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-secondary';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', function () { openModal(p.name); });
        actions.appendChild(editBtn);
        if (p.name !== activeName) {
          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-danger';
          delBtn.textContent = '删除';
          delBtn.addEventListener('click', function () {
            if (confirm('确定删除服务商 "' + p.name + '"？')) {
              vscode.postMessage({ type: 'cfg_delete', name: p.name });
            }
          });
          actions.appendChild(delBtn);
        }

        card.appendChild(info);
        card.appendChild(actions);
        list.appendChild(card);
      });
    }

    // 消息接收
    window.addEventListener('message', function (event) {
      const msg = event.data;
      if (msg.type === 'cfg_loaded') {
        render(msg);
      } else if (msg.type === 'cfg_result') {
        if (msg.action === 'test') {
          // 测试连接：内联展示结果（成功/失败带色块），比 Toast 更持久可见
          btnTest.disabled = false;
          testResult.hidden = false;
          testResult.className = 'test-result ' + (msg.ok ? 'ok' : 'err');
          testResult.textContent = (msg.ok ? '✅ 连接成功' : '❌ 连接失败') + (msg.message ? '：' + msg.message : '');
        } else {
          if (msg.ok) {
            showToast(msg.message || '操作成功', true);
            if (msg.action === 'save') closeModal();
          } else {
            showToast(msg.message || '操作失败', false);
          }
        }
      }
    });

    btnAdd.addEventListener('click', function () { openModal(''); });
    btnCancel.addEventListener('click', closeModal);
    // 表单提交（Enter 键 / 点击「保存」统一走 submit）：比按钮 click 更符合表单语义
    document.getElementById('cfgForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const config = readForm();
      vscode.postMessage({ type: 'cfg_save', config: config, isEditing: editName !== '' });
    });
    btnTest.addEventListener('click', function () {
      // 测试进行中禁用按钮，避免重复提交；结果在 cfg_result 回来后恢复
      btnTest.disabled = true;
      testResult.hidden = false;
      testResult.className = 'test-result';
      testResult.textContent = '测试中…';
      vscode.postMessage({ type: 'cfg_test', config: readForm() });
    });
    // 点击遮罩关闭
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

    // 初始加载
    vscode.postMessage({ type: 'cfg_load' });
  </script>
</body>
</html>`;
}