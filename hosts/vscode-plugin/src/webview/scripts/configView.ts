/**
 * configView — 大模型配置面板 webview 运行时脚本（阶段 B P2-1）
 *
 * 由 providerConfigPanel.ts 的 buildHtml 内联 <script> 迁移而来：以工厂函数
 * createConfigView 接收依赖（acquireVsCodeApi / window）并初始化全部交互，
 * 替代原「字符串注入脚本」，消除全局污染并具备可测性。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/configView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  ExtensionToWebviewMessage,
  LlmProviderConfig,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

/** configView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface ConfigViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
}

/** 列表加载完成载荷（cfg_loaded）的最小结构 */
interface ProvidersPayload {
  providers: LlmProviderConfig[];
  activeName: string | undefined;
}

/**
 * 初始化大模型配置面板 webview 交互（替代原内联 <script>）
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createConfigView({ acquireVsCodeApi, window }: ConfigViewDeps): void {
  const document = window.document;
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list') as HTMLElement;
  const btnAdd = document.getElementById('btnAdd') as HTMLButtonElement;
  const modal = document.getElementById('modal') as HTMLElement;
  const modalTitle = document.getElementById('modalTitle') as HTMLElement;
  const fName = document.getElementById('f-name') as HTMLInputElement;
  const fDisplay = document.getElementById('f-display') as HTMLInputElement;
  const fModel = document.getElementById('f-model') as HTMLInputElement;
  const fBaseUrl = document.getElementById('f-baseurl') as HTMLInputElement;
  const fApiKey = document.getElementById('f-apikey') as HTMLInputElement;
  const apikeyHint = document.getElementById('apikeyHint') as HTMLElement;
  const testResult = document.getElementById('testResult') as HTMLElement;
  const btnTest = document.getElementById('btnTest') as HTMLButtonElement;
  const btnCancel = document.getElementById('btnCancel') as HTMLButtonElement;
  const toast = document.getElementById('toast') as HTMLElement;
  const cfgForm = document.getElementById('cfgForm') as HTMLFormElement;

  let editName = ''; // 当前编辑的 name（空=新增）
  let activeName: string | undefined;
  // 最近一次 cfg_loaded 的 Provider 列表 —— 编辑回填的单一数据源（内存，而非 DOM dataset）
  let currentProviders: LlmProviderConfig[] = [];

  function showToast(text: string, ok: boolean): void {
    toast.textContent = text;
    toast.className = ok ? 'ok visible' : 'err visible';
    window.setTimeout(() => {
      toast.className = ok ? 'ok' : 'err';
    }, 2500);
  }

  function readForm(): {
    name: string;
    displayName: string;
    model: string;
    baseUrl: string;
    apiKey: string;
  } {
    return {
      name: fName.value.trim(),
      displayName: fDisplay.value.trim(),
      model: fModel.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      apiKey: fApiKey.value,
    };
  }

  function openModal(name?: string): void {
    editName = name || '';
    modalTitle.textContent = editName ? '编辑 API' : '添加 API';
    // 重置上一轮测试结果（每次打开表单都清空，避免残留误导）
    testResult.hidden = true;
    testResult.textContent = '';
    testResult.className = 'test-result';
    btnTest.disabled = false;
    if (editName) {
      // 编辑：从内存中的 providers 列表回填（单一真理源：cfg_loaded 数据，
      // 而非从渲染结果 DOM dataset 读取，避免 DOM 作为数据源的数据流反向，
      // 对抗评估 P1-5）
      const target = currentProviders.find((p) => p.name === editName);
      fName.value = editName;
      fName.disabled = true;
      fDisplay.value = target?.displayName || '';
      fModel.value = target?.model || '';
      fBaseUrl.value = target?.baseUrl || '';
      fApiKey.value = '';
      fApiKey.placeholder = '留空保持不变';
      // 脱敏回显：标明已配置的 key（如 sk-••••1234），确认无需重新输入
      const masked = target?.maskedKey || '';
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

  function closeModal(): void {
    modal.classList.remove('visible');
    editName = '';
  }

  function render(data: ProvidersPayload): void {
    if (!data.providers || data.providers.length === 0) {
      currentProviders = [];
      list.innerHTML = '<p class="hint">暂未配置任何 API，点击右上角「添加 API」。</p>';
      return;
    }
    activeName = data.activeName;
    // 保存为内存数据源（openModal 编辑回填用；DOM dataset 不再作为数据源，P1-5）
    currentProviders = data.providers;
    list.innerHTML = '';
    data.providers.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'card' + (p.name === activeName ? ' active' : '');

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
        actBtn.addEventListener('click', () =>
          vscode.postMessage({ type: 'cfg_set_active', name: p.name }),
        );
        actions.appendChild(actBtn);
      }
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => openModal(p.name));
      actions.appendChild(editBtn);
      if (p.name !== activeName) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
          // 危险操作确认在 extension host 侧完成（VSCode webview 禁用原生 confirm()，
          // 由 host 弹原生 modal，避免确认框静默失效 → 按钮无反应，对抗评估 P0-2）
          vscode.postMessage({ type: 'cfg_delete', name: p.name });
        });
        actions.appendChild(delBtn);
      }

      card.appendChild(info);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  // 消息接收
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'cfg_loaded') {
      render(msg);
    } else if (msg.type === 'cfg_result') {
      if (msg.action === 'test') {
        // 测试连接：内联展示结果（成功/失败带色块），比 Toast 更持久可见
        btnTest.disabled = false;
        testResult.hidden = false;
        testResult.className = 'test-result ' + (msg.ok ? 'ok' : 'err');
        testResult.textContent =
          (msg.ok ? '✅ 连接成功' : '❌ 连接失败') + (msg.message ? '：' + msg.message : '');
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

  btnAdd.addEventListener('click', () => openModal());
  btnCancel.addEventListener('click', closeModal);
  // 表单提交（Enter 键 / 点击「保存」统一走 submit）：比按钮 click 更符合表单语义
  cfgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const config = readForm();
    vscode.postMessage({ type: 'cfg_save', config, isEditing: editName !== '' });
  });
  btnTest.addEventListener('click', () => {
    // 测试进行中禁用按钮，避免重复提交；结果在 cfg_result 回来后恢复
    btnTest.disabled = true;
    testResult.hidden = false;
    testResult.className = 'test-result';
    testResult.textContent = '测试中…';
    vscode.postMessage({ type: 'cfg_test', config: readForm() });
  });
  // 点击遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // 初始加载
  vscode.postMessage({ type: 'cfg_load' });
}
