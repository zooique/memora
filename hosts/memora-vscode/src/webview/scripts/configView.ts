/**
 * configView — 大模型配置子视图 webview 运行时脚本（阶段 B P2-1）
 *
 * 由 settingsView.ts 挂载（设置视图选项卡合并后大模型子视图）：以工厂函数
 * createConfigView 接收依赖（vscode / window / root）并初始化全部交互，
 * 替代原「字符串注入脚本」，消除全局污染并具备可测性。
 *
 * 由 esbuild 以 browser/iife 打包进 dist/webview/scripts/settingsView.js（经 settingsViewMain
 * 入口），在 webview HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  EmbeddingInfoDto,
  ExtensionToWebviewMessage,
  LlmProviderConfig,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createEmptyState, createGroupTitle } from '../helpers/cardList.js';
import { fmtTokens, TOKENS_PER_K, TOKENS_PER_M } from '../helpers/fmtTokens.js';

/** configView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface ConfigViewDeps {
  /** webview 通信 API（SSOT：由 settingsView 统一 acquireVsCodeApi() 一次后注入，
   *  子视图不再各自调用——acquireVsCodeApi 每个 webview 只能调用一次） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
  /** 子视图挂载根容器（设置视图选项卡合并后：查询限定在根内，多子视图 id 空间隔离） */
  root: HTMLElement;
}

/** 列表加载完成载荷（cfg_loaded）的最小结构 */
interface ProvidersPayload {
  providers: LlmProviderConfig[];
  activeName: string | undefined;
  /** 后台模型 Provider name（G5：空 = 与实时对话相同） */
  backgroundName?: string;
  /** 向量检索（Embedding）配置回显（G1） */
  embedding?: EmbeddingInfoDto;
}

/**
 * 初始化大模型配置面板 webview 交互（替代原内联 <script>）
 *
 * @param deps 运行时依赖（vscode 通信实例 + window + root）
 */
export function createConfigView({ vscode, window, root }: ConfigViewDeps): void {
  const document = window.document;
  // id 空间隔离：查询限定在 root 容器内（设置视图合并后与 roles/memory 子视图共存，
  // 各自根内都有 #list/#statBar 等，不做根内查询会冲突）
  const list = root.querySelector('#list') as HTMLElement;
  const statBar = root.querySelector('#statBar') as HTMLElement;
  const btnAdd = root.querySelector('#btnAdd') as HTMLButtonElement;
  // 后台模型下拉（G5，2026-08-23）：选择后台任务的独立 Provider（空 = 同实时对话）
  const bgModel = root.querySelector('#bgModel') as HTMLSelectElement;
  // 向量检索（Embedding）区（G1，2026-08-23）
  const eModel = root.querySelector('#e-model') as HTMLInputElement;
  const eBaseUrl = root.querySelector('#e-baseurl') as HTMLInputElement;
  const eApiKey = root.querySelector('#e-apikey') as HTMLInputElement;
  const btnSaveEmbedding = root.querySelector('#btnSaveEmbedding') as HTMLButtonElement;
  const btnClearEmbedding = root.querySelector('#btnClearEmbedding') as HTMLButtonElement;
  const embeddingStatus = root.querySelector('#embeddingStatus') as HTMLElement;
  btnAdd.title = '新增一个大模型 API 配置';
  const modal = root.querySelector('#modal') as HTMLElement;
  const modalTitle = root.querySelector('#modalTitle') as HTMLElement;
  const fName = root.querySelector('#f-name') as HTMLInputElement;
  const fDisplay = root.querySelector('#f-display') as HTMLInputElement;
  const fModel = root.querySelector('#f-model') as HTMLInputElement;
  const fBaseUrl = root.querySelector('#f-baseurl') as HTMLInputElement;
  const fApiKey = root.querySelector('#f-apikey') as HTMLInputElement;
  // 上下文窗口上限（per-LLM，可选；留空回落内核默认 120K；支持 K/M 简写输入）
  const fContextWindow = root.querySelector('#f-contextwindow') as HTMLInputElement;
  // 上下文上限输入的即时报错/换算提示（输入非法时展示就地错误，不依赖 host 往返）
  const cwFeedback = root.querySelector('#f-contextwindow-feedback') as HTMLElement;
  const apikeyHint = root.querySelector('#apikeyHint') as HTMLElement;
  const testResult = root.querySelector('#testResult') as HTMLElement;
  const btnTest = root.querySelector('#btnTest') as HTMLButtonElement;
  const btnCancel = root.querySelector('#btnCancel') as HTMLButtonElement;
  const toast = root.querySelector('#toast') as HTMLElement;
  const cfgForm = root.querySelector('#cfgForm') as HTMLFormElement;

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

  /**
   * 解析上下文上限输入串（支持纯数字 / K / M 简写）
   *
   * 换算倍数 K=×1000、M=×1,000,000 的唯一真理源 = fmtTokens.ts 的 TOKENS_PER_K /
   * TOKENS_PER_M 常量（与显示同规，见该文件注释）。容忍千分位 / 下划线 / 空格
   * （配合编辑回显 fmtTokens 的 "65,536" 形式）与小数（如 1.5M）。
   *
   * @param raw 表单原始输入（未 trim）
   * @returns token 数；空串 → undefined（未配置）；无法识别 → NaN
   */
  function parseTokenInput(raw: string): number | undefined {
    const cleaned = raw.replace(/[,＿_\s\u3000]/g, '');
    if (!cleaned) return undefined;
    const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(cleaned);
    if (!m) return NaN;
    const base = Number(m[1]);
    const suffix = m[2].toLowerCase();
    const tokens =
      suffix === 'k' ? base * TOKENS_PER_K : suffix === 'm' ? base * TOKENS_PER_M : base;
    return Math.round(tokens);
  }

  /** 就地设置上下文上限输入提示（text 为空则隐藏；isError 标记错误态样式） */
  function setCwFeedback(text: string, isError: boolean): void {
    cwFeedback.textContent = text;
    cwFeedback.hidden = !text;
    cwFeedback.classList.toggle('err', isError && !!text);
  }

  function readForm(): {
    name: string;
    displayName: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    contextWindow: number | undefined;
  } {
    const parsed = parseTokenInput(fContextWindow.value);
    return {
      name: fName.value.trim(),
      displayName: fDisplay.value.trim(),
      model: fModel.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      apiKey: fApiKey.value,
      // 无法识别（NaN）由 submit 前置校验阻断，此处不落 undefined（避免静默回落默认值）
      contextWindow: Number.isNaN(parsed) ? undefined : parsed,
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
    // 重置上下文上限输入的就地反馈（开新表单时清空上一条错误）
    setCwFeedback('', false);
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
      // 上下文窗口上限回填（per-LLM 真理源；fmtTokens 友好简写回显，如 200K，换算 M 级同理）
      fContextWindow.value = target?.contextWindow ? fmtTokens(target.contextWindow) : '';
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
      fContextWindow.value = '';
    }
    modal.classList.add('visible');
    fName.focus();
  }

  function closeModal(): void {
    modal.classList.remove('visible');
    editName = '';
  }

  function render(data: ProvidersPayload): void {
    // 顶栏统计：已配置 N 个 API（ui-redesign.md §4.2 ①）
    statBar.hidden = false;
    statBar.textContent = `已配置 ${data.providers?.length ?? 0} 个 API`;
    if (!data.providers || data.providers.length === 0) {
      currentProviders = [];
      // 空态引导（SSOT：createEmptyState 纯函数，对齐 rolesView 列表级同构）
      list.textContent = '';
      list.appendChild(createEmptyState(document, { title: '配置你的大模型', hint: '添加一个 API 后即可开始对话' }));
      return;
    }
    activeName = data.activeName;
    // 保存为内存数据源（openModal 编辑回填用；DOM dataset 不再作为数据源，P1-5）
    currentProviders = data.providers;
    list.innerHTML = '';
    // ② 激活 Provider 分区（置顶高亮）
    const active = data.providers.filter((p) => p.name === activeName);
    if (active.length > 0) {
      list.appendChild(createGroupTitle(document, '激活 Provider'));
      active.forEach((p) => list.appendChild(buildCard(p)));
    }
    // ③ 其他 Provider 分区
    const others = data.providers.filter((p) => p.name !== activeName);
    if (others.length > 0) {
      list.appendChild(createGroupTitle(document, '其他 Provider'));
      others.forEach((p) => list.appendChild(buildCard(p)));
    }
    // ④ 后台模型下拉选项（G5）：排除激活 Provider（后台可配置任意已保存的 Provider）
    renderBackground(data.providers, data.backgroundName);
    // ⑤ 向量检索（Embedding）回显（G1）
    renderEmbedding(data.embedding);
  }

  /**
   * 渲染向量检索（Embedding）配置回显（G1）
   *
   * 回填 model/baseUrl；已启用态以状态行提示；apiKey 永不回传真实值。
   */
  function renderEmbedding(embedding?: EmbeddingInfoDto): void {
    eModel.value = embedding?.model ?? '';
    eBaseUrl.value = embedding?.baseUrl ?? '';
    if (embedding?.enabled) {
      const keyText = embedding.keyConfigured ? '已配置 API Key' : '⚠️ 未配置 API Key（点「保存并启用」可补）';
      embeddingStatus.hidden = false;
      embeddingStatus.textContent = `语义检索已启用 · ${keyText} · 重启插件后生效`;
    } else {
      embeddingStatus.hidden = true;
      embeddingStatus.textContent = '';
    }
  }

  /**
   * 渲染后台模型下拉选项（G5 多 Provider 路由）
   *
   * 选项 = 全部已配置 Provider（含激活），另加「同实时对话」默认空项。
   * backgroundName 为空（同实时对话）时选中默认项。
   */
  function renderBackground(providers: LlmProviderConfig[], backgroundName?: string): void {
    // 保留「同实时对话」默认空项
    bgModel.innerHTML = '<option value="">同实时对话</option>';
    providers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.displayName || p.name;
      bgModel.appendChild(opt);
    });
    bgModel.value = backgroundName ?? '';
  }

  /** 构建单个 Provider 卡片（含图标，ui-redesign.md §6.2） */
  function buildCard(p: LlmProviderConfig): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card' + (p.name === activeName ? ' active' : '');

    // 卡片图标：Provider 显示名首字（大写），提升扫读（ui-redesign.md §6.2）
    const icon = document.createElement('div');
    icon.className = 'cfg-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = (p.displayName || p.name).charAt(0).toUpperCase();

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
    // 上下文上限单位显式标注（token 缩写 K 由 fmtTokens 输出，如 128K），呼应表单同单位提示
    detail.textContent =
      p.model + ' · ' + p.baseUrl + (p.contextWindow ? ` · ${fmtTokens(p.contextWindow)} tokens` : '');
    info.appendChild(nameRow);
    info.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (p.name !== activeName) {
      const actBtn = document.createElement('button');
      actBtn.className = 'btn btn-secondary';
      actBtn.textContent = '设为当前';
      actBtn.title = '切换为默认使用的大模型（即时生效，后续对话用此模型）';
      actBtn.addEventListener('click', () =>
        vscode.postMessage({ type: 'cfg_set_active', name: p.name }),
      );
      actions.appendChild(actBtn);
    }
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary';
    editBtn.textContent = '编辑';
    editBtn.title = '修改该 API 的配置（别名 / 模型 / Key 等）';
    editBtn.addEventListener('click', () => openModal(p.name));
    actions.appendChild(editBtn);
    if (p.name !== activeName) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = '删除';
      delBtn.title = '删除该 API 配置（不可恢复）';
      delBtn.addEventListener('click', () => {
        // 危险操作确认在 extension host 侧完成（VSCode webview 禁用原生 confirm()，
        // 由 host 弹原生 modal，避免确认框静默失效 → 按钮无反应，对抗评估 P0-2）
        vscode.postMessage({ type: 'cfg_delete', name: p.name });
      });
      actions.appendChild(delBtn);
    }

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(actions);
    return card;
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
  // G5：后台模型下拉切换 → post cfg_set_background（host 持久化 + 热更新 agent）
  bgModel.addEventListener('change', () => {
    vscode.postMessage({ type: 'cfg_set_background', name: bgModel.value });
  });
  // G1：保存并启用向量检索（Embedding）→ post cfg_save_embedding
  btnSaveEmbedding.addEventListener('click', () => {
    vscode.postMessage({ type: 'cfg_save_embedding', config: { model: eModel.value, baseUrl: eBaseUrl.value, apiKey: eApiKey.value } });
  });
  // G1：停用向量检索 → post cfg_clear_embedding
  btnClearEmbedding.addEventListener('click', () => {
    vscode.postMessage({ type: 'cfg_clear_embedding' });
  });
  btnCancel.addEventListener('click', closeModal);
  // 上下文上限输入改键时实时反馈：换算提示（如 200K → = 200000 tokens）或非法就地报错
  fContextWindow.addEventListener('input', () => {
    setCwFeedback('', false);
    const raw = fContextWindow.value.trim();
    if (!raw) return;
    const parsed = parseTokenInput(raw);
    if (parsed !== undefined && !Number.isNaN(parsed)) {
      setCwFeedback(`= ${parsed.toLocaleString('en-US')} tokens（${fmtTokens(parsed)}）`, false);
    } else {
      setCwFeedback('无法识别：请填整数，或带 K/M 简写（如 200K、1M）', true);
    }
  });
  // 表单提交（Enter 键 / 点击「保存」统一走 submit）：比按钮 click 更符合表单语义
  cfgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // 前置校验：上下文上限输入无法识别时就地报错并阻断提交（防静默回落默认值）
    const cwRaw = fContextWindow.value.trim();
    if (cwRaw) {
      const parsed = parseTokenInput(cwRaw);
      if (parsed === undefined || Number.isNaN(parsed)) {
        setCwFeedback('无法识别：请填整数，或带 K/M 简写（如 200K、1M）', true);
        fContextWindow.focus();
        return;
      }
    }
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
