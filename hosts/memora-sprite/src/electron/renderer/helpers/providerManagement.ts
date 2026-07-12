/**
 * 多 Provider 管理子系统辅助（从 settingsPanelManager.ts 提取）
 *
 * 职责：
 *   集中管理设置面板中多 Provider 配置的 CRUD、渲染与事件委托，降低
 *   settingsPanelManager.ts 体量。涵盖：
 *   - Provider 列表加载与卡片渲染（含激活徽章、操作按钮）
 *   - 后台归档 Provider 选择框渲染
 *   - Provider 编辑弹窗的显示/隐藏（新增/编辑模式切换）
 *   - Provider 保存（字段校验 + 重复检测 + IPC 持久化）
 *   - Provider 连接测试（复用 testLlmConfig 通道）
 *   - Provider 删除/激活切换（含运行时兜底校验）
 *   - 事件委托绑定（按钮 click + 卡片列表 action 分发）
 *
 * 提取原因：
 *   settingsPanelManager.ts 超 1600 行，多 Provider 管理子系统（L811-1263，
 *   约 453 行）是最大内聚单元，自成闭环：表单 + CRUD + 渲染 + 事件委托，
 *   仅依赖 provider 系 DOM 字段 + cachedProviders 状态 + host 回调。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 ProviderManagementContext 注入
 *   - cachedProviders 状态通过 getter/setter 访问，保持 SettingsPanelManager
 *     作为状态所有者
 *   - DOM 元素通过 readonly 属性暴露（构造时一次性获取，运行时不变）
 *   - 事件监听器通过 ctx.events（EventTracker）注册，cleanup 由主类统一管理
 *   - type-only 导入 SettingsPanelHost 避免运行时循环依赖
 *
 * 先例：
 *   参照 memoryGraphPanel.ts / memoryDetailPanel.ts 的 context 注入模式
 */

import { clearElement } from './domHelpers.js';
import { reportError } from './errorHelpers.js';
import { showFieldError, clearFieldErrors, attachRequiredBlurValidation } from './formValidation.js';
import type { EventTracker } from './eventTracker.js';
import type { LlmProviderConfig } from '../types.js';
// 类型仅导入：运行时不会产生循环依赖（type-only 在编译期擦除）
import type { SettingsPanelHost } from '../panels/settingsPanelManager.js';

// ─── 常量 ──────────────────────────────────────────────────

/**
 * Provider 表单所有可校验字段的 id 数组
 *
 * 用于 clearFieldErrors 批量清空错误状态，避免在多处重复字面量数组。
 * 字段 id 与 HTML 中 input 元素 id 一一对应，错误容器遵循 {id}-error 命名约定。
 */
const PROVIDER_FORM_FIELD_IDS = [
  'cfg-provider-alias',
  'cfg-provider-provider',
  'cfg-provider-model',
  'cfg-provider-api-key',
  'cfg-provider-temperature',
] as const;

/**
 * Provider 表单必填字段 id 与中文标签映射
 *
 * 用于 attachRequiredBlurValidation 附加 blur 即时必填校验。
 * temperature 非必填（有默认值 0.7），不纳入 blur 校验。
 */
const PROVIDER_REQUIRED_FIELDS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'cfg-provider-alias', label: '别名' },
  { id: 'cfg-provider-provider', label: '提供商' },
  { id: 'cfg-provider-model', label: '模型' },
  { id: 'cfg-provider-api-key', label: 'API Key' },
];

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 多 Provider 管理子系统所需的上下文
 *
 * 由 SettingsPanelManager 构建并传入。设计为接口而非直接传入 manager 实例，
 * 避免运行时循环依赖并便于独立测试。
 */
export interface ProviderManagementContext {
  // ─── 宿主能力 ───
  readonly host: SettingsPanelHost;
  /** 事件跟踪器（统一管理监听器注册与清理，避免内存泄漏） */
  readonly events: EventTracker;

  // ─── DOM 元素（构造时一次性获取，运行时不变） ───
  /** Provider 卡片列表容器 */
  readonly providerListEl: HTMLElement | null;
  /** Provider 编辑弹窗根元素 */
  readonly providerModalEl: HTMLElement | null;
  /** Provider 编辑弹窗标题元素 */
  readonly providerModalTitleEl: HTMLElement | null;
  /** Provider 别名输入框（作为持久化 key，编辑时禁用） */
  readonly providerAliasInput: HTMLInputElement | null;
  /** Provider 显示名称输入框 */
  readonly providerDisplayInput: HTMLInputElement | null;
  /** Provider 提供商标识输入框（如 deepseek / openai） */
  readonly providerProviderInput: HTMLInputElement | null;
  /** Provider 模型名称输入框 */
  readonly providerModelInput: HTMLInputElement | null;
  /** Provider API Base URL 输入框 */
  readonly providerBaseUrlInput: HTMLInputElement | null;
  /** Provider API Key 输入框（编辑时显示脱敏值） */
  readonly providerApiKeyInput: HTMLInputElement | null;
  /** Provider Temperature 输入框（0-2） */
  readonly providerTemperatureInput: HTMLInputElement | null;
  /** "添加 API" 按钮 */
  readonly btnAddProvider: HTMLButtonElement | null;
  /** 后台归档 Provider 选择框 */
  readonly backgroundProviderSelect: HTMLSelectElement | null;
  /** Provider 弹窗"保存"按钮 */
  readonly btnProviderSave: HTMLButtonElement | null;
  /** Provider 弹窗"取消"按钮 */
  readonly btnProviderCancel: HTMLButtonElement | null;
  /** Provider 弹窗"测试连接"按钮 */
  readonly btnProviderTest: HTMLButtonElement | null;

  // ─── 状态访问器（getter/setter） ───
  /**
   * 获取缓存的 Provider 列表（编辑时用于填充表单字段，
   * 避免 DOM 解析丢失 temperature/apiKey）
   */
  getCachedProviders(): LlmProviderConfig[];
  /** 设置缓存的 Provider 列表（loadProviderList 时回写） */
  setCachedProviders(providers: LlmProviderConfig[]): void;
}

// ─── Provider 列表加载 ────────────────────────────────────

/**
 * 加载请求版本号（竞态守卫）
 *
 * 每次 loadProviderList 递增，await 返回后比对。
 * 若期间发起了新的加载请求，旧请求的结果将被丢弃，避免旧渲染覆盖新状态。
 */
let loadToken = 0;

/**
 * 加载 Provider 列表并渲染
 *
 * 从主进程获取所有 Provider 配置，渲染为卡片列表。
 * 设置面板初次显示时调用。
 *
 * 竞态守卫：通过版本号丢弃过期的加载结果（UX-0712-5）。
 */
export async function loadProviderList(ctx: ProviderManagementContext): Promise<void> {
  if (!ctx.providerListEl) return;
  const token = ++loadToken;

  // 加载态：await 前显示占位符，避免首次打开时空白（UX-0712-9）
  ctx.providerListEl.innerHTML = '<p class="settings-hint">加载中...</p>';

  try {
    const data = await window.electronAPI.listLlmProviders();
    // 竞态守卫：丢弃过期请求的渲染结果
    if (token !== loadToken) return;
    ctx.setCachedProviders(data.providers); // 缓存供编辑时使用
    renderProviderList(ctx, data.active, data.providers);
    renderBackgroundProviderSelect(ctx, data.providers);
    // 通知宿主 Provider 列表已变更，让 InputAreaManager 刷新输入框选择器
    ctx.host.onProviderChanged?.();
  } catch (error) {
    // 竞态守卫：过期请求的错误也不渲染
    if (token !== loadToken) return;
    // 加载失败时渲染内联错误占位符 + 重试按钮（UX-0712-9）
    clearElement(ctx.providerListEl);
    const errorHint = document.createElement('div');
    errorHint.className = 'settings-hint provider-load-error';
    errorHint.innerHTML = '<p>加载 Provider 列表失败</p>';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-secondary';
    retryBtn.textContent = '重试';
    retryBtn.addEventListener('click', () => {
      void loadProviderList(ctx);
    });
    errorHint.appendChild(retryBtn);
    ctx.providerListEl.appendChild(errorHint);
    reportError('SettingsPanelManager', error);
    ctx.host.showToast('加载 Provider 列表失败，请稍后重试', 'error');
  }
}

// ─── 渲染方法 ──────────────────────────────────────────────

/**
 * 渲染后台归档 Provider 选择框
 *
 * 使用 createElement + textContent 构建 option，避免 innerHTML 拼接用户输入
 * （provider name/model 来自用户表单输入，存在 XSS 风险）。
 */
export function renderBackgroundProviderSelect(
  ctx: ProviderManagementContext,
  providers: LlmProviderConfig[],
): void {
  if (!ctx.backgroundProviderSelect) return;

  // 保存当前选中值，重建后恢复（避免列表刷新丢失用户选择）
  const currentValue = ctx.backgroundProviderSelect.value;

  clearElement(ctx.backgroundProviderSelect);

  // 默认选项：与实时对话相同
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '与实时对话相同';
  ctx.backgroundProviderSelect.appendChild(defaultOption);

  // Provider 选项（textContent 自动转义，无 XSS 风险）
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = `${p.name} (${p.provider} · ${p.model})`;
    ctx.backgroundProviderSelect.appendChild(opt);
  }

  // 恢复用户之前的选择（若新列表中仍存在该 key）
  if (providers.some((p) => p.key === currentValue)) {
    ctx.backgroundProviderSelect.value = currentValue;
  }
}

/**
 * 渲染 Provider 卡片列表
 *
 * 使用 createElement + textContent 构建卡片，避免 innerHTML 拼接用户输入
 * （provider name/provider/model/key 来自用户表单输入，存在 XSS 风险）。
 * 事件委托在 initProviderListeners 中一次性绑定，此方法仅负责渲染 DOM。
 */
export function renderProviderList(
  ctx: ProviderManagementContext,
  active: string,
  providers: LlmProviderConfig[],
): void {
  if (!ctx.providerListEl) return;

  // 清空旧列表
  clearElement(ctx.providerListEl);

  // 空状态提示
  if (providers.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'settings-hint';
    hint.textContent = '暂未配置任何 API，点击下方按钮添加。';
    ctx.providerListEl.appendChild(hint);
    return;
  }

  // 使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
  const fragment = document.createDocumentFragment();

  for (const p of providers) {
    const isActive = p.key === active;

    const card = document.createElement('div');
    card.className = `provider-card${isActive ? ' active' : ''}`;
    card.dataset.providerKey = p.key;

    // ─── Provider 信息区（名称 + 详情） ──────────────
    const info = document.createElement('div');
    info.className = 'provider-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'provider-name';
    nameSpan.textContent = p.name;
    info.appendChild(nameSpan);

    const detailSpan = document.createElement('span');
    detailSpan.className = 'provider-detail';
    detailSpan.textContent = `${p.provider} · ${p.model}`;
    info.appendChild(detailSpan);

    card.appendChild(info);

    // ─── 激活徽章（仅当前 Provider 显示） ────────────
    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'provider-active-badge';
      badge.textContent = '当前';
      card.appendChild(badge);
    }

    // ─── 操作按钮区 ──────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'provider-actions';

    // 非激活 Provider 显示"设为当前"按钮
    if (!isActive) {
      const activateBtn = document.createElement('button');
      activateBtn.className = 'btn-secondary provider-btn';
      activateBtn.dataset.action = 'activate';
      activateBtn.dataset.key = p.key;
      activateBtn.textContent = '设为当前';
      actions.appendChild(activateBtn);
    }

    // 编辑按钮（所有 Provider 都有）
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-secondary provider-btn';
    editBtn.dataset.action = 'edit';
    editBtn.dataset.key = p.key;
    editBtn.textContent = '编辑';
    actions.appendChild(editBtn);

    // 删除按钮（非激活 Provider 才显示，激活 Provider 不允许删除）
    if (!isActive) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-secondary provider-btn provider-btn-delete';
      deleteBtn.dataset.action = 'delete';
      deleteBtn.dataset.key = p.key;
      deleteBtn.textContent = '删除';
      actions.appendChild(deleteBtn);
    }

    card.appendChild(actions);
    fragment.appendChild(card);
  }

  ctx.providerListEl.appendChild(fragment);
}

// ─── Provider 编辑弹窗 ────────────────────────────────────

/**
 * 显示 Provider 编辑弹窗
 */
export function showProviderForm(ctx: ProviderManagementContext, key: string = ''): void {
  if (!ctx.providerModalEl) return;

  // 清空之前的错误状态（避免上次校验失败残留）
  clearFieldErrors([...PROVIDER_FORM_FIELD_IDS]);

  if (key) {
    // 编辑模式：从缓存中查找 Provider 数据（含 temperature 和脱敏 apiKey）
    const cached = ctx.getCachedProviders().find((p) => p.key === key);
    if (ctx.providerModalTitleEl) ctx.providerModalTitleEl.textContent = '编辑 API';

    if (ctx.providerAliasInput) {
      ctx.providerAliasInput.value = key;
      ctx.providerAliasInput.disabled = true;
    }
    if (ctx.providerDisplayInput) ctx.providerDisplayInput.value = cached?.name ?? key;
    if (ctx.providerProviderInput) ctx.providerProviderInput.value = cached?.provider ?? '';
    if (ctx.providerModelInput) ctx.providerModelInput.value = cached?.model ?? '';
    if (ctx.providerBaseUrlInput) ctx.providerBaseUrlInput.value = cached?.baseUrl ?? '';
    // 编辑时显示脱敏后的 API Key（前4后4），而非清空
    if (ctx.providerApiKeyInput) ctx.providerApiKeyInput.value = cached?.apiKey ?? '';
    if (ctx.providerTemperatureInput) ctx.providerTemperatureInput.value = String(cached?.temperature ?? 0.7);
  } else {
    // 新增模式：清空所有字段
    if (ctx.providerModalTitleEl) ctx.providerModalTitleEl.textContent = '添加 API';
    if (ctx.providerAliasInput) { ctx.providerAliasInput.value = ''; ctx.providerAliasInput.disabled = false; }
    if (ctx.providerDisplayInput) ctx.providerDisplayInput.value = '';
    if (ctx.providerProviderInput) ctx.providerProviderInput.value = '';
    if (ctx.providerModelInput) ctx.providerModelInput.value = '';
    if (ctx.providerBaseUrlInput) ctx.providerBaseUrlInput.value = '';
    if (ctx.providerApiKeyInput) ctx.providerApiKeyInput.value = '';
    if (ctx.providerTemperatureInput) ctx.providerTemperatureInput.value = '';
  }

  ctx.providerModalEl.classList.remove('hidden');
  ctx.providerModalEl.dataset.editKey = key;
}

/**
 * 隐藏 Provider 编辑弹窗
 */
export function hideProviderForm(ctx: ProviderManagementContext): void {
  if (!ctx.providerModalEl) return;
  ctx.providerModalEl.classList.add('hidden');
  ctx.providerModalEl.dataset.editKey = '';
}

// ─── Provider CRUD ────────────────────────────────────────

/**
 * 保存 Provider（新增/更新）
 *
 * 校验：必填字段 + 别名格式（仅允许字母数字.-_） + Temperature 范围 + 重复 key 检测
 * 反馈：字段级 aria-invalid + aria-describedby 错误文本，失败时聚焦首个错误字段
 */
export async function saveProvider(ctx: ProviderManagementContext): Promise<void> {
  const alias = ctx.providerAliasInput?.value.trim();
  const provider = ctx.providerProviderInput?.value.trim();
  const model = ctx.providerModelInput?.value.trim();
  const baseUrl = ctx.providerBaseUrlInput?.value.trim() || '';
  const apiKey = ctx.providerApiKeyInput?.value.trim();
  // 读取 temperature：空值表示使用默认值，不传 temperature 字段
  const tempRaw = ctx.providerTemperatureInput?.value.trim();
  const temperature = tempRaw ? parseFloat(tempRaw) : undefined;

  // 清空之前的错误状态（开始新一轮校验）
  clearFieldErrors([...PROVIDER_FORM_FIELD_IDS]);

  // 必填字段校验：逐字段标记 aria-invalid，聚焦首个错误字段
  let firstErrorField: HTMLElement | null = null;
  if (!alias) {
    firstErrorField = showFieldError('cfg-provider-alias', '请填写别名');
  }
  if (!provider) {
    firstErrorField ??= showFieldError('cfg-provider-provider', '请填写提供商');
  }
  if (!model) {
    firstErrorField ??= showFieldError('cfg-provider-model', '请填写模型');
  }
  if (!apiKey) {
    firstErrorField ??= showFieldError('cfg-provider-api-key', '请填写 API Key');
  }
  if (firstErrorField) {
    firstErrorField.focus();
    return;
  }

  // 别名格式校验：仅允许 ASCII 字母数字 . - _，长度 ≤ 50
  // Provider 别名作为持久化 key（文件名/IPC 标识），限制 ASCII 避免 path traversal
  if (!/^[a-zA-Z0-9._-]{1,50}$/.test(alias as string)) {
    const field = showFieldError('cfg-provider-alias', '仅支持英文、数字、点、短横线、下划线，最长 50 字符');
    field.focus();
    return;
  }

  // Temperature 范围校验：0-2（与 HTML input min/max 一致，防止绕过 HTML 校验）
  if (temperature !== undefined && (Number.isNaN(temperature) || temperature < 0 || temperature > 2)) {
    const field = showFieldError('cfg-provider-temperature', 'Temperature 必须在 0-2 之间');
    field.focus();
    return;
  }

  // 重复 key 检测：新增时检查别名是否已存在
  const isEditing = (ctx.providerModalEl?.dataset.editKey ?? '') !== '';
  if (!isEditing) {
    try {
      const data = await window.electronAPI.listLlmProviders();
      if (data.providers.some((p) => p.key === alias)) {
        const field = showFieldError('cfg-provider-alias', `别名 "${alias}" 已存在，请更换`);
        field.focus();
        return;
      }
    } catch (error) {
      // 获取列表失败不阻塞保存，由主进程处理重复，但记录日志便于排查
      reportError('SettingsPanelManager 保存前检查重复别名', error);
    }
  }

  // 必填字段校验已保证 alias/provider/model/apiKey 非空，但 TypeScript 无法通过间接 flag 收窄类型
  // 此处使用 ! 断言是因为校验块已 contractually 保证非空（失败则 return）
  const saveBtn = ctx.btnProviderSave;
  const originalText = saveBtn?.textContent ?? '保存';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
  }
  try {
    const result = await window.electronAPI.saveLlmProvider(alias!, { provider: provider!, model: model!, baseUrl, apiKey: apiKey!, temperature });
    if (result.success) {
      ctx.host.showToast('Provider 保存成功');
      hideProviderForm(ctx);
      await loadProviderList(ctx);
    } else {
      ctx.host.showToast(result.error ?? '保存失败', 'error');
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  }
}

/**
 * 测试 Provider 连接——从表单读取配置，调用 testLlmConfig 验证
 *
 * 复用已有 LLM_CONFIG_TEST 通道，无需新增 IPC。
 * 测试时禁用按钮防止重复点击，完成后恢复。
 */
export async function testProviderConnection(ctx: ProviderManagementContext): Promise<void> {
  const provider = ctx.providerProviderInput?.value.trim();
  const model = ctx.providerModelInput?.value.trim();
  const baseUrl = ctx.providerBaseUrlInput?.value.trim() || '';
  const apiKey = ctx.providerApiKeyInput?.value.trim();

  if (!provider || !model || !apiKey) {
    ctx.host.showToast('请填写提供商、模型和 API Key', 'error');
    return;
  }

  const btn = ctx.btnProviderTest;
  if (!btn) return;

  // 禁用按钮防止重复点击
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '测试中...';

  try {
    const result = await window.electronAPI.testLlmConfig({
      provider,
      model,
      baseUrl: baseUrl || '',
      apiKey,
    });

    if (result.success) {
      ctx.host.showToast('连接成功', 'success');
    } else {
      ctx.host.showToast(result.error ?? '连接失败', 'error');
    }
  } catch (err) {
    reportError('SettingsPanelManager', err);
    ctx.host.showToast('测试异常，请检查网络', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/**
 * 删除 Provider
 *
 * 前端保护：已隐藏激活 Provider 的删除按钮，此方法作为运行时兜底。
 */
export async function deleteProvider(ctx: ProviderManagementContext, key: string): Promise<void> {
  // 运行时兜底：禁止删除当前激活的 Provider
  try {
    const data = await window.electronAPI.listLlmProviders();
    if (data.active === key) {
      ctx.host.showToast('不能删除当前激活的 Provider，请先切换到其他 Provider', 'error');
      return;
    }
  } catch (error) {
    // 获取激活状态失败时不阻塞删除，但记录日志便于排查（主进程仍有兜底校验）
    reportError('SettingsPanelManager', error);
  }

  // 使用项目统一的 showConfirmDialog（支持主题/焦点/键盘），替代原生 confirm()
  const confirmed = await ctx.host.showConfirmDialog({
    title: '删除 Provider',
    message: `确定删除 Provider "${key}"？`,
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;

  const result = await window.electronAPI.deleteLlmProvider(key);
  if (result.success) {
    ctx.host.showToast('Provider 已删除');
    await loadProviderList(ctx);
  } else {
    ctx.host.showToast(result.error ?? '删除失败', 'error');
  }
}

/**
 * 切换激活 Provider
 */
export async function setActiveProvider(ctx: ProviderManagementContext, key: string): Promise<void> {
  const result = await window.electronAPI.setActiveLlmProvider(key);
  if (result.success) {
    ctx.host.showToast(result.warning ?? '已切换 Provider', result.warning ? 'warning' : 'success');
    await loadProviderList(ctx);
  } else {
    ctx.host.showToast(result.error ?? '切换失败', 'error');
  }
}

// ─── 事件监听器初始化 ─────────────────────────────────────

/**
 * 初始化 Provider 管理事件监听器
 *
 * 包含：
 * - 添加/保存/取消/测试按钮的 click 监听
 * - Provider 卡片列表的事件委托（activate/edit/delete）
 *
 * 事件委托一次性绑定到 providerListEl，避免每次 renderProviderList 重新绑定
 * 导致监听器累积泄漏。通过 EventTracker 统一管理，cleanup 时自动清理。
 */
export function initProviderListeners(ctx: ProviderManagementContext): void {
  // 所有 Provider 管理按钮均为可选元素，若缺失则静默降级
  if (!ctx.btnAddProvider && !ctx.btnProviderSave && !ctx.btnProviderCancel && !ctx.btnProviderTest) {
    return;
  }
  if (ctx.btnAddProvider) {
    ctx.events.addEventListener(ctx.btnAddProvider, 'click', () => {
      showProviderForm(ctx, '');
    });
  }
  if (ctx.btnProviderSave) {
    ctx.events.addEventListener(ctx.btnProviderSave, 'click', async () => {
      await saveProvider(ctx);
    });
  }
  if (ctx.btnProviderCancel) {
    ctx.events.addEventListener(ctx.btnProviderCancel, 'click', () => {
      hideProviderForm(ctx);
    });
  }
  // Provider 连接测试：从表单读取当前配置，调用 testLlmConfig 验证
  if (ctx.btnProviderTest) {
    ctx.events.addEventListener(ctx.btnProviderTest, 'click', async () => {
      await testProviderConnection(ctx);
    });
  }

  // Provider 卡片列表事件委托（一次性绑定，避免每次渲染重绑）
  // 通过 closest 定位点击的按钮，根据 data-action 分发到对应处理方法
  if (ctx.providerListEl) {
    ctx.events.addEventListener(ctx.providerListEl, 'click', async (e: Event) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('button[data-action]');
      if (!(btn instanceof HTMLButtonElement)) return;

      const action = btn.dataset.action;
      const key = btn.dataset.key;
      if (!key) return;

      if (action === 'activate') {
        await setActiveProvider(ctx, key);
      } else if (action === 'edit') {
        showProviderForm(ctx, key);
      } else if (action === 'delete') {
        await deleteProvider(ctx, key);
      }
    });
  }

  // 必填字段 blur 即时校验（UX-0712-6）
  attachRequiredBlurValidation(PROVIDER_REQUIRED_FIELDS, ctx.events);
}
