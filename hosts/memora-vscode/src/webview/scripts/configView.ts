/**
 * configView — 大模型配置子视图 webview 运行时脚本
 *
 * 由 settingsView.ts 挂载（设置视图选项卡合并后大模型子视图）：以工厂函数
 * createConfigView 接收依赖（vscode / window / root）并初始化全部交互，
 * 替代原「字符串注入脚本」，消除全局污染并具备可测性。
 *
 * 由 esbuild 以 browser/iife 打包进 dist/webview/scripts/settingsView.js（经 settingsViewMain
 * 入口），在 webview HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  ExtensionToWebviewMessage,
  LlmProviderConfig,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createEmptyState, createGroupTitle } from '../helpers/cardList.js';
import { fmtTokens, TOKENS_PER_K } from '../helpers/fmtTokens.js';
import { getIconSvg } from './icons.js';

/** configView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface ConfigViewDeps {
  /** webview 通信 API（SSOT：由 settingsView 统一 acquireVsCodeApi() 一次后注入，
   *  子视图不各自调用——acquireVsCodeApi 每个 webview 只能调用一次） */
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
  /** 后台模型 Provider name（空 = 与实时对话相同） */
  backgroundName?: string;
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
  // 后台模型下拉：选择后台任务的独立 Provider（空 = 同实时对话）
  const bgModel = root.querySelector('#bgModel') as HTMLSelectElement;
  btnAdd.title = '新增一个大模型 API 配置';
  const modal = root.querySelector('#modal') as HTMLElement;
  const modalTitle = root.querySelector('#modalTitle') as HTMLElement;
  const fName = root.querySelector('#f-name') as HTMLInputElement;
  const fDisplay = root.querySelector('#f-display') as HTMLInputElement;
  const fModel = root.querySelector('#f-model') as HTMLInputElement;
  const fBaseUrl = root.querySelector('#f-baseurl') as HTMLInputElement;
  const fApiKey = root.querySelector('#f-apikey') as HTMLInputElement;
  // 上下文窗口上限（per-LLM，可选；留空回落内核默认 120K；单一 K 单位输入）
  const fContextWindow = root.querySelector('#f-contextwindow') as HTMLInputElement;
  // 上下文上限输入的即时报错/换算提示（输入非法时展示就地错误，不依赖 host 往返）
  const cwFeedback = root.querySelector('#f-contextwindow-feedback') as HTMLElement;
  // Provider 类型（'cloud' | 'local'）：cloud=云端 API（默认，工具通道走原生 FC）；
  // local=本地运行时（Ollama/LM Studio）——是否支持原生工具调用须用户显式声明（能力位语义）
  const fProviderType = root.querySelector('#f-providertype') as HTMLSelectElement;
  // 本地运行时「是否支持原生工具调用」复选框（仅 provider=local 时显示；勾选 → supportsToolCalling=true）
  const fToolCalling = root.querySelector('#f-toolcalling') as HTMLInputElement;
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
   * 解析上下文上限输入串（单一 K 单位：纯数字 = K 值，可选 k 后缀）
   *
   * K 倍数唯一真理源 = fmtTokens.ts 的 TOKENS_PER_K（×1000，LLM 生态口径）。
   * 收紧自 K/M/纯数字多格式：用户只需填 K 数（如 128 = 128K = 128000），支持小数（如 1.5 = 1500）。
   *
   * @param raw 表单原始输入
   * @returns token 数；空串 → undefined（未配置）；无法识别 → NaN
   */
  function parseTokenInput(raw: string): number | undefined {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned) return undefined;
    // 数字（含小数）+ 可选 k 后缀；M/千分位/裸 token 不识别（K 语义下是混淆源）
    const m = /^(\d+(?:\.\d+)?)k?$/i.exec(cleaned);
    if (!m) return NaN;
    return Math.round(Number(m[1]) * TOKENS_PER_K);
  }

  /** token → K 值输入串（整千整数、非整千保留小数；与 parseTokenInput 的 K 语义对称） */
  function tokensToKValue(tokens: number): string {
    return String(tokens / TOKENS_PER_K);
  }

  /** 就地设置上下文上限输入提示（text 为空则隐藏；isError 标记错误态样式） */
  function setCwFeedback(text: string, isError: boolean): void {
    cwFeedback.textContent = text;
    cwFeedback.hidden = !text;
    cwFeedback.classList.toggle('err', isError && !!text);
  }

  /**
   * 工具能力位字段显隐（本地 LLM 能力声明）：
   * 仅「本地运行时」类型展示该复选框——云 LLM 的 supportsToolCalling 恒回落 undefined（内核默认 true），
   * 无需也不应由用户在表单声明。字段父节点由 id=toolcalling-field 承载，hidden 切换。
   */
  function setToolCallingFieldVisible(): void {
    const field = root.querySelector('#toolcalling-field') as HTMLElement | null;
    if (field) field.hidden = fProviderType.value !== 'local';
  }

  function readForm(): {
    name: string;
    displayName: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    contextWindow: number | undefined;
    provider: 'cloud' | 'local';
    supportsToolCalling: boolean | undefined;
  } {
    const parsed = parseTokenInput(fContextWindow.value);
    // Provider 类型 + 工具能力位（本地 LLM 能力声明）：
    // - cloud（默认）→ 不落 supportsToolCalling（undefined → 内核回落 true，存量云行为不变，零回归）；
    // - local → 显式声明工具能力：勾选=support，取消=不支撑（可观测回落，不静默承诺）。
    //   provider 字段随类型落（卡片已有「（本地）」展示逻辑）。
    const provider = fProviderType.value === 'local' ? 'local' : 'cloud';
    const supportsToolCalling = provider === 'local' ? fToolCalling.checked : undefined;
    return {
      name: fName.value.trim(),
      displayName: fDisplay.value.trim(),
      model: fModel.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      apiKey: fApiKey.value,
      // 上下文上限输入无法识别（NaN）由 submit 与 test 双重前置校验阻断（见 submit/test 处理器），
      // 此处 NaN 分支为类型收窄防御：正常路径下不可达（避免静默回落默认值）
      contextWindow: Number.isNaN(parsed) ? undefined : parsed,
      provider,
      supportsToolCalling,
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
      // 而非从渲染结果 DOM dataset 读取，避免 DOM 作为数据源的数据流反向）
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
      // 上下文窗口上限回填（per-LLM 真理源；K 值回显，整千整数/非整千小数，label 已标 K 单位）
      fContextWindow.value = target?.contextWindow ? tokensToKValue(target.contextWindow) : '';
      // Provider 类型回填：已存 type=local → local，否则默认 cloud（存量云配置零改动）
      fProviderType.value = target?.provider === 'local' ? 'local' : 'cloud';
      // 工具能力位回填：本地类型时按已存声明勾选（缺省勾选=本地默认支持原生 FC）；
      // 云类型该字段不显示、强制回落 undefined（不走 DOM，避免误改云行为）
      fToolCalling.checked = target?.supportsToolCalling !== false;
      setToolCallingFieldVisible();
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
      // 新增默认云类型 + 工具能力默认勾选（local 时为支持原生 FC）
      fProviderType.value = 'cloud';
      fToolCalling.checked = true;
      setToolCallingFieldVisible();
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
      list.appendChild(
        createEmptyState(document, {
          title: '配置你的大模型',
          hint: '添加一个 API 后即可开始对话',
        }),
      );
      return;
    }
    activeName = data.activeName;
    // 保存为内存数据源（openModal 编辑回填用；DOM dataset 不作数据源）
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
    // ④ 后台模型下拉选项：排除激活 Provider（后台可配置任意已保存的 Provider）
    renderBackground(data.providers, data.backgroundName);
  }

  /**
   * 渲染后台模型下拉选项（多 Provider 路由）
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

  /** 构建单个 Provider 卡片（含图标） */
  function buildCard(p: LlmProviderConfig): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card' + (p.name === activeName ? ' active' : '');

    // 卡片图标：Provider 显示名首字（大写），提升扫读
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
      p.model +
      ' · ' +
      p.baseUrl +
      (p.contextWindow ? ` · ${fmtTokens(p.contextWindow)} tokens` : '');
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
        // 由 host 弹原生 modal，避免确认框静默失效 → 按钮无反应）
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
        // 图标语言唯一 = icons.ts 柔和线条 SVG；
        // msg.message 来自宿主 → 文本走 createTextNode（防注入）
        testResult.textContent = '';
        const resultIcon = document.createElement('span');
        resultIcon.className = 'test-result__icon';
        resultIcon.setAttribute('aria-hidden', 'true');
        resultIcon.innerHTML = getIconSvg(msg.ok ? 'check' : 'cancel', 12, 12);
        testResult.appendChild(resultIcon);
        testResult.appendChild(
          document.createTextNode(
            (msg.ok ? '连接成功' : '连接失败') + (msg.message ? '：' + msg.message : ''),
          ),
        );
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
  // 设置后台模型 Provider → post cfg_set_background
  bgModel.addEventListener('change', () => {
    vscode.postMessage({ type: 'cfg_set_background', name: bgModel.value });
  });
  btnCancel.addEventListener('click', closeModal);
  // Provider 类型切换时联动工具能力位字段显隐（本地 LLM 能力声明）
  fProviderType.addEventListener('change', setToolCallingFieldVisible);
  // 上下文上限输入改键时实时反馈：换算提示（如 200K → = 200000 tokens）或非法就地报错
  fContextWindow.addEventListener('input', () => {
    setCwFeedback('', false);
    const raw = fContextWindow.value.trim();
    if (!raw) return;
    const parsed = parseTokenInput(raw);
    if (parsed !== undefined && !Number.isNaN(parsed)) {
      // 下方实时展示转换后的 token 数（单一 K 输入 → 具体 token）
      setCwFeedback(`= ${parsed.toLocaleString('en-US')} tokens`, false);
    } else {
      setCwFeedback('请填 K 单位数字，如 128（= 128,000 tokens）', true);
    }
  });
  /** 上下文上限输入前置校验（submit 与 test 双路径共用，防非法值静默回落）：
   *  非法（NaN）→ 就地报错并聚焦，返回 false 阻断发送；空串合法（回落默认 120K）。 */
  function validateContextWindow(): boolean {
    const cwRaw = fContextWindow.value.trim();
    if (cwRaw) {
      const parsed = parseTokenInput(cwRaw);
      if (parsed === undefined || Number.isNaN(parsed)) {
        setCwFeedback('请填 K 单位数字，如 128（= 128,000 tokens）', true);
        fContextWindow.focus();
        return false;
      }
    }
    return true;
  }

  // 表单提交（Enter 键 / 点击「保存」统一走 submit）：比按钮 click 更符合表单语义
  cfgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // 前置校验：上下文上限输入无法识别时就地报错并阻断提交（防静默回落默认值）
    if (!validateContextWindow()) return;
    const config = readForm();
    vscode.postMessage({ type: 'cfg_save', config, isEditing: editName !== '' });
  });
  btnTest.addEventListener('click', () => {
    // 测试连接同走前置校验：输入非法 K 数时就地报错并阻断（与保存对称，防测错窗口）
    if (!validateContextWindow()) {
      btnTest.disabled = false;
      return;
    }
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
