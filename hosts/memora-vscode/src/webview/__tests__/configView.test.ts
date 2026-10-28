/**
 * configView 测试 — 大模型配置面板渲染分支
 *
 * 覆盖 UI 重构新增的渲染路径：
 *   - 顶栏统计（statBar：「已配置 N 个 API」）
 *   - 分区标题（group-title：「激活 Provider」/「其他 Provider」）
 *   - 卡片图标（cfg-icon：Provider 首字）
 *   - 空态引导（empty-state）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createConfigView 工厂驱动 render。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createConfigView } from '../scripts/configView.js';
import type { LlmProviderConfig } from '../../shared/protocol.js';

/** 覆盖 createConfigView 全部查询引用的最小 HTML 骨架（子视图挂载在 #config-root 根容器内，
 *  与设置面板选项卡合并后的 id 空间隔离约定一致） */
const HTML = `
  <div id="config-root">
    <div class="header">
      <h2>大模型配置</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <button id="btnAdd" class="btn">添加 API</button>
    </div>
    <div class="cfg-bg">
      <label for="bgModel" class="cfg-bg-label">后台模型（可选）</label>
      <select id="bgModel" class="cfg-bg-select"><option value="">同实时对话</option></select>
      <p class="cfg-bg-hint"></p>
    </div>
    <div id="list"></div>
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle"></h3>
        <form id="cfgForm">
          <input id="f-name" />
          <input id="f-display" />
          <input id="f-model" />
          <input id="f-baseurl" />
          <input id="f-apikey" />
          <select id="f-providertype">
            <option value="cloud">云端 API</option>
            <option value="local">本地运行时</option>
          </select>
          <div id="toolcalling-field" class="field" hidden>
            <label class="checkbox-label" for="f-toolcalling"><input id="f-toolcalling" type="checkbox" /></label>
          </div>
          <!-- 视觉能力位：与 toolcalling 不同，**恒显示**（不随 provider 类型隐显），默认不勾选 -->
          <div id="vision-field" class="field">
            <label class="checkbox-label" for="f-vision"><input id="f-vision" type="checkbox" /></label>
          </div>
          <input id="f-contextwindow" type="text" />
          <div id="f-contextwindow-feedback" hidden></div>
          <input id="f-maxtokens" type="text" />
          <div id="f-maxtokens-feedback" hidden></div>
          <div id="apikeyHint" hidden></div>
          <div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button>
          <button id="btnCancel" type="button"></button>
          <button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
  </div>
`;

/** 挂载 createConfigView 并返回 postMessage mock */
function mountConfigView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const root = document.getElementById('config-root') as HTMLElement;
  createConfigView({
    vscode: { postMessage },
    window: window as unknown as Window,
    root,
  });
  // 记下最后一次挂载：供 lastSavedConfig 回读同一份 postMessage（避免每个用例重复传递返回值）
  lastMount = { postMessage };
  return { postMessage };
}

/** 最近一次 mountConfigView 的挂载产物（同一 tick 内不变） */
let lastMount: { postMessage: ReturnType<typeof vi.fn> };

/** 向 webview 分发一条 cfg_loaded 消息，驱动 render（可选 backgroundName） */
function dispatchLoaded(providers: unknown[], activeName?: string, backgroundName?: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'cfg_loaded', providers, activeName, backgroundName },
    }),
  );
}

/**
 * 构造一个 Provider 对象
 *
 * ⚠️ **不要把这个 helper 写成字段白名单**。它原先逐字列举每个字段，于是每次给
 * `LlmProviderConfig` 加新字段（本次是 supportsVision），这里都会静默吞掉、
 * 导致「新字段永远测不到」——宿主一轮踩的是 `makeRound` 缺 refCount 的同类坑。
 * 改成「默认值对象 + 展开 opts」：以后加字段**只改 implements 的那一处**，
 * 这里无需同步，测试替身不再成为第二份字段清单。
 */
function makeProvider(name: string, opts: Partial<LlmProviderConfig> = {}) {
  return {
    name,
    displayName: name,
    model: name + '-model',
    baseUrl: 'https://api.example.com/v1',
    provider: undefined,
    contextWindow: undefined,
    maxTokens: undefined,
    supportsToolCalling: undefined,
    ...opts,
  } as LlmProviderConfig;
}

describe('configView 渲染分支（ui-redesign §6.2）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发送 cfg_load 初始拉取列表', () => {
    const { postMessage } = mountConfigView();
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_load' });
  });

  it('空列表：渲染顶栏统计 + 空态引导，无分区标题', () => {
    mountConfigView();
    dispatchLoaded([]);

    const statBar = document.getElementById('statBar') as HTMLElement;
    expect(statBar.hidden).toBe(false);
    expect(statBar.textContent).toBe('已配置 0 个 API');

    const list = document.getElementById('list') as HTMLElement;
    expect(list.querySelector('.empty-state')).not.toBeNull();
    expect(list.querySelector('.empty-title')?.textContent).toBe('配置你的大模型');
    expect(list.querySelector('.group-title')).toBeNull();
  });

  it('单 Provider：渲染「激活 Provider」分区 + 卡片图标 + 当前徽章', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek')], 'deepseek');

    const list = document.getElementById('list') as HTMLElement;
    // 分区标题：仅激活分区
    const titles = list.querySelectorAll('.group-title');
    expect(titles.length).toBe(1);
    expect(titles[0].textContent).toBe('激活 Provider');

    const card = list.querySelector('.card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.classList.contains('active')).toBe(true);
    // 卡片图标：首字大写
    const icon = card.querySelector('.cfg-icon') as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.textContent).toBe('D');
    // 当前徽章
    expect(card.querySelector('.badge')?.textContent).toBe('当前');
  });

  it('多 Provider：激活与其他分区分离渲染', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
    );

    const list = document.getElementById('list') as HTMLElement;
    const titles = Array.from(list.querySelectorAll('.group-title')).map((t) => t.textContent);
    expect(titles).toEqual(['激活 Provider', '其他 Provider']);

    // 卡片顺序：激活在前，其他在后
    const icons = Array.from(list.querySelectorAll('.cfg-icon')).map((i) => i.textContent);
    expect(icons).toEqual(['D', '本']);
  });

  it('详情报文：保留 model · baseUrl 拼接', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek')], 'deepseek');

    const list = document.getElementById('list') as HTMLElement;
    const detail = list.querySelector('.card-detail') as HTMLElement;
    expect(detail.textContent).toBe('deepseek-model · https://api.example.com/v1');
  });

  // ─── per-LLM 上下文上限（contextWindow） ───

  it('详情报文：带 contextWindow 时附加「 · N tokens」标注（单位显式，缩写 K）', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek', { contextWindow: 128000 })], 'deepseek');
    const detail = document.querySelector('.card-detail') as HTMLElement;
    expect(detail.textContent).toBe('deepseek-model · https://api.example.com/v1 · 128K tokens');
  });

  it('详情报文：未配置 contextWindow 时不附加 tokens 标注（回落内核默认窗口）', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek')], 'deepseek');
    const detail = document.querySelector('.card-detail') as HTMLElement;
    expect(detail.textContent).toBe('deepseek-model · https://api.example.com/v1');
  });

  it('编辑打开弹窗：回填 contextWindow 到表单', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek', { contextWindow: 64000 })], 'deepseek');
    // 激活卡仅有「编辑」按钮（.btn-secondary）
    (document.querySelector('.card .btn-secondary') as HTMLButtonElement).click();
    const cw = document.getElementById('f-contextwindow') as HTMLInputElement;
    // K 值回显（label 已标 K 单位，输入框填 K 数字）
    expect(cw.value).toBe('64');
  });

  it('编辑打开弹窗：非整千 contextWindow 回显为小数 K（保精度）', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek', { contextWindow: 65536 })], 'deepseek');
    (document.querySelector('.card .btn-secondary') as HTMLButtonElement).click();
    const cw = document.getElementById('f-contextwindow') as HTMLInputElement;
    expect(cw.value).toBe('65.536');
  });

  it('保存提交：表单 contextWindow 随 cfg_save 上报（填值）', () => {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('f-display') as HTMLInputElement).value = 'DeepSeek';
    (document.getElementById('f-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('f-apikey') as HTMLInputElement).value = 'sk-test';
    // K 值输入：128（= 128K）→ 上报 128000
    (document.getElementById('f-contextwindow') as HTMLInputElement).value = '128';
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const sent = (postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as unknown[])[0] as {
      config: { contextWindow?: number };
    };
    expect(sent.config.contextWindow).toBe(128000);
  });

  it('保存提交：contextWindow 留空 → 上报 undefined（回落内核默认窗口）', () => {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('f-display') as HTMLInputElement).value = 'DeepSeek';
    (document.getElementById('f-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('f-apikey') as HTMLInputElement).value = 'sk-test';
    (document.getElementById('f-contextwindow') as HTMLInputElement).value = '';
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const sent = (postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as unknown[])[0] as {
      config: { contextWindow?: number };
    };
    expect(sent.config.contextWindow).toBeUndefined();
  });

  // ─── 上下文上限输入（单一 K 单位：纯数字 = K 值，可选 k 后缀） ───

  /** 打开「添加 API」弹窗并提交，返回 cfg_save 载荷（null = 未发出保存） */
  function submitWithContextWindow(raw: string) {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('f-display') as HTMLInputElement).value = 'DeepSeek';
    (document.getElementById('f-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('f-apikey') as HTMLInputElement).value = 'sk-test';
    (document.getElementById('f-contextwindow') as HTMLInputElement).value = raw;
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const call = postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as
      unknown[] | undefined;
    // 非法输入被阻断不发出 cfg_save → call 为 undefined → 返回 undefined
    return (call?.[0] as { config: { contextWindow?: number } } | undefined)?.config.contextWindow;
  }

  it('保存「200K」→ 上报 200000（K=×1000，对齐 LLM 生态口径）', () => {
    expect(submitWithContextWindow('200K')).toBe(200000);
  });

  it('保存「200」（纯数字 = K 值）→ 上报 200000（单一 K 单位：用户只填 K 数）', () => {
    expect(submitWithContextWindow('200')).toBe(200000);
  });

  it('保存「1M」→ 不再识别（M 单位已移除，收紧为单一 K）', () => {
    expect(submitWithContextWindow('1M')).toBeUndefined();
  });

  it('保存小写「64k」→ 上报 64000（后缀大小写不敏感）', () => {
    expect(submitWithContextWindow('64k')).toBe(64000);
  });

  it('保存「1024K」→ 上报 1024000（K 恒为 ×1000，不因数值近似 M 而歧义）', () => {
    expect(submitWithContextWindow('1024K')).toBe(1024000);
  });

  it('保存小数「1.5K」→ 上报 1500（支持小数 K）', () => {
    expect(submitWithContextWindow('1.5K')).toBe(1500);
  });

  it('保存「65.536」（非整千小数 K）→ 上报 65536（回显/提交往返保精度）', () => {
    expect(submitWithContextWindow('65.536')).toBe(65536);
  });

  it('保存「65,536」→ 不再识别（K 语义下千分位是混淆源，应填 K 值如 65.5）', () => {
    expect(submitWithContextWindow('65,536')).toBeUndefined();
  });

  // ─── 输出上限输入（T1：per-LLM 输出预算，与 contextWindow 统一 ×1000 K 单位） ───

  /** 打开「添加 API」弹窗并提交，返回 cfg_save 载荷的 maxTokens（undefined = 未发出或留空） */
  function submitWithMaxTokens(raw: string) {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('f-display') as HTMLInputElement).value = 'DeepSeek';
    (document.getElementById('f-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('f-apikey') as HTMLInputElement).value = 'sk-test';
    (document.getElementById('f-maxtokens') as HTMLInputElement).value = raw;
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const call = postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as
      unknown[] | undefined;
    // 非法输入被阻断不发出 cfg_save → call 为 undefined → 返回 undefined
    return (call?.[0] as { config: { maxTokens?: number } } | undefined)?.config.maxTokens;
  }

  it('保存「64」（K 单位）→ 上报 64000（×1000 统一口径，T1 验收锚点）', () => {
    expect(submitWithMaxTokens('64')).toBe(64000);
  });

  it('保存「64k」（小写后缀）→ 上报 64000（大小写不敏感，与 contextWindow 同构）', () => {
    expect(submitWithMaxTokens('64k')).toBe(64000);
  });

  it('保存留空 → 上报 undefined（不传 max_tokens，回服务端默认）', () => {
    expect(submitWithMaxTokens('')).toBeUndefined();
  });

  it('非法输出上限「abc」→ 就地报错并阻断提交（不发出 cfg_save，防静默回落）', () => {
    expect(submitWithMaxTokens('abc')).toBeUndefined();
  });

  it('编辑回填：maxTokens 整 K 值精确回显（64000 → 「64」，×1000 口径往返保真）', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('mimo', { maxTokens: 64000 })], 'mimo');
    (document.querySelector('.card .btn-secondary') as HTMLButtonElement).click();
    const mt = document.getElementById('f-maxtokens') as HTMLInputElement;
    expect(mt.value).toBe('64');
  });

  it('详情报文：配置 maxTokens 时附加「输出上限」标注（K 单位显式）', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('mimo', { maxTokens: 64000 })], 'mimo');
    const detail = document.querySelector('.card-detail') as HTMLElement;
    expect(detail.textContent).toContain('输出上限');
  });

  it('非法输入「abc」→ 就地报错并阻断提交（不发出 cfg_save，防静默回落默认值）', () => {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('f-display') as HTMLInputElement).value = 'DeepSeek';
    (document.getElementById('f-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('f-apikey') as HTMLInputElement).value = 'sk-test';
    (document.getElementById('f-contextwindow') as HTMLInputElement).value = 'abc';
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cfg_save' }));
    const feedback = document.getElementById('f-contextwindow-feedback') as HTMLElement;
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toContain('请填 K 单位数字');
  });

  it('非法 contextWindow 点「测试连接」→ 就地报错并阻断发送（不发出 cfg_test，防以默认窗口测错配置）', () => {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('f-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('f-contextwindow') as HTMLInputElement).value = 'abc';
    (document.getElementById('btnTest') as HTMLButtonElement).click();
    // 必须经校验再发送（坑：btnTest 直接 readForm() 未经校验时 NaN 落 undefined，会静默以内核默认窗口测连接）
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cfg_test' }));
    const feedback = document.getElementById('f-contextwindow-feedback') as HTMLElement;
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toContain('请填 K 单位数字');
  });

  it('输入合法简写时实时反馈换算（200K → = 200,000 tokens）', () => {
    mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    const cw = document.getElementById('f-contextwindow') as HTMLInputElement;
    const feedback = document.getElementById('f-contextwindow-feedback') as HTMLElement;
    cw.value = '200K';
    cw.dispatchEvent(new Event('input'));
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toContain('200,000 tokens');
  });

  it('卡片按钮 tooltip：解释各操作语义（可发现性，对齐角色卡）', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
    );
    const list = document.getElementById('list') as HTMLElement;
    const cards = list.querySelectorAll('.card');
    // 激活卡：仅「编辑」按钮带 tooltip
    const activeCard = cards[0] as HTMLElement;
    expect(activeCard?.querySelector('.btn-secondary')?.getAttribute('title')).toContain(
      '修改该 API 的配置',
    );
    // 其他卡：设为当前 / 编辑 / 删除 均带 tooltip
    const otherCard = cards[1] as HTMLElement;
    const titles = Array.from(otherCard.querySelectorAll('.btn')).map((b) =>
      b.getAttribute('title'),
    );
    expect(titles.some((t) => t && t.includes('默认使用的大模型'))).toBe(true);
    expect(titles.some((t) => t && t.includes('不可恢复'))).toBe(true);
    expect(titles.some((t) => t && t.includes('修改该 API 的配置'))).toBe(true);
    // 头部「添加 API」按钮 tooltip
    expect(document.getElementById('btnAdd')?.getAttribute('title')).toContain(
      '新增一个大模型 API 配置',
    );
  });

  // ─── 后台模型通道 ───

  it('cfg_loaded 渲染后台模型下拉选项（全部 Provider + 默认同实时对话）', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
    );
    const bg = document.getElementById('bgModel') as HTMLSelectElement;
    // 默认空项 + 两个 Provider 选项
    expect(bg.options.length).toBe(3);
    expect(bg.options[0]?.value).toBe('');
    expect(bg.options[0]?.textContent).toBe('同实时对话');
    expect(bg.options[1]?.textContent).toBe('deepseek');
    expect(bg.options[2]?.textContent).toBe('本地');
    // 未配置后台 → 选中默认空项
    expect(bg.value).toBe('');
  });

  it('cfg_loaded 带 backgroundName → 后台下拉回显所选 Provider', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
      'local',
    );
    const bg = document.getElementById('bgModel') as HTMLSelectElement;
    expect(bg.value).toBe('local');
  });

  it('cfg_loaded 某 Provider 带 keyError → 卡片渲染读取失败痕迹（SEC-READ-1 展示面）', () => {
    mountConfigView();
    dispatchLoaded(
      [
        { ...makeProvider('broken'), keyError: 'API Key「broken」读取 失败：凭证服务未运行' },
        makeProvider('healthy'),
      ],
      'healthy',
    );
    // 失败条：卡片内有 card-key-error 痕迹，文案原样上屏（host 单点派生，webview 不加工）
    // （渲染分区把激活 Provider 置顶 ⇒ cards[0]=healthy、cards[1]=broken）
    const cards = document.querySelectorAll('#list .card');
    expect(cards).toHaveLength(2);
    const healthyCard = cards[0] as HTMLElement;
    expect(healthyCard.querySelector('.card-key-error')).toBeNull();
    const brokenCard = cards[1] as HTMLElement;
    const marker = brokenCard.querySelector('.card-key-error');
    expect(marker?.textContent).toContain('API Key「broken」读取 失败：凭证服务未运行');
  });

  it('后台模型下拉切换（选 Provider）→ postMessage cfg_set_background', () => {
    const { postMessage } = mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
    );
    const bg = document.getElementById('bgModel') as HTMLSelectElement;
    bg.value = 'local';
    bg.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_set_background', name: 'local' });
  });

  it('后台模型下拉切回「同实时对话」→ postMessage cfg_set_background 空串', () => {
    const { postMessage } = mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
      'local',
    );
    const bg = document.getElementById('bgModel') as HTMLSelectElement;
    bg.value = '';
    bg.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_set_background', name: '' });
  });
});

// ─── 本地 LLM 能力声明 ───

describe('configView 本地 LLM 能力声明（provider 类型 + 工具能力位）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 打开「添加 API」弹窗 → 填基础字段 → 提交，返回 cfg_save 的 config */
  function submitConfig(extra: () => void = () => void 0): {
    provider?: string;
    supportsToolCalling?: boolean;
    supportsVision?: boolean;
  } {
    const { postMessage } = mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    (document.getElementById('f-name') as HTMLInputElement).value = 'local-ollama';
    (document.getElementById('f-display') as HTMLInputElement).value = '本地 Ollama';
    (document.getElementById('f-model') as HTMLInputElement).value = 'qwen3';
    (document.getElementById('f-baseurl') as HTMLInputElement).value = 'http://localhost:11434/v1';
    (document.getElementById('f-apikey') as HTMLInputElement).value = 'local';
    extra();
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const call = postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as
      unknown[] | undefined;
    return (
      (
        call?.[0] as {
          config: { provider?: string; supportsToolCalling?: boolean; supportsVision?: boolean };
        }
      )?.config ?? {}
    );
  }

  it('默认（云类型）：provider=cloud，且不落 supportsToolCalling（undefined → 内核回落 true，云行为不变）', () => {
    const config = submitConfig();
    expect(config.provider).toBe('cloud');
    expect(config.supportsToolCalling).toBeUndefined();
  });

  it('切换 local：工具能力位字段显隐联动（切本地显示、切回云隐藏）', () => {
    mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    const sel = document.getElementById('f-providertype') as HTMLSelectElement;
    const field = document.getElementById('toolcalling-field') as HTMLElement;
    // 默认云 → 字段隐藏
    expect(field.hidden).toBe(true);
    // 切本地 → 字段显示
    sel.value = 'local';
    sel.dispatchEvent(new Event('change'));
    expect(field.hidden).toBe(false);
    // 切回云 → 字段隐藏
    sel.value = 'cloud';
    sel.dispatchEvent(new Event('change'));
    expect(field.hidden).toBe(true);
  });

  it('local + 工具能力勾选（默认）→ provider=local，supportsToolCalling=true', () => {
    const config = submitConfig(() => {
      (document.getElementById('f-providertype') as HTMLSelectElement).value = 'local';
      (document.getElementById('f-toolcalling') as HTMLInputElement).checked = true;
    });
    expect(config.provider).toBe('local');
    expect(config.supportsToolCalling).toBe(true);
  });

  it('local + 取消工具能力勾选 → supportsToolCalling=false（显式声明不支持，回落文本通道）', () => {
    const config = submitConfig(() => {
      (document.getElementById('f-providertype') as HTMLSelectElement).value = 'local';
      (document.getElementById('f-toolcalling') as HTMLInputElement).checked = false;
    });
    expect(config.provider).toBe('local');
    expect(config.supportsToolCalling).toBe(false);
  });
});

// ─── 视觉能力位（审查 IMG-3 · 失败必闭） ───

describe('configView 视觉能力位 supportsVision（与工具能力位**取值策略不同**）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 从 cfg_save 报文中取回本次保存的 config（未发则为 {}） */
  function lastSavedConfig(): Record<string, unknown> {
    const { postMessage } = lastMount;
    const call = postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as
      unknown[] | undefined;
    return (call?.[0] as { config: Record<string, unknown> })?.config ?? {};
  }

  /** 打开「新增」弹窗 → 可改字段 → 提交，返回 cfg_save 的 config */
  function addNew(extra: () => void = () => void 0): Record<string, unknown> {
    mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    extra();
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    return lastSavedConfig();
  }

  /** 用既有 provider 打开「编辑」弹窗，返回表单 DOM 已回填的状态（不提交） */
  function openEdit(opts: { supportsVision?: boolean } = {}): void {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek', opts as never)], 'deepseek');
    // 激活卡仅有「编辑」按钮（.btn-secondary）
    (document.querySelector('.card .btn-secondary') as HTMLButtonElement).click();
  }

  it('新增默认 → supportsVision=false（**不是 undefined**；视觉能力的缺省方向是「不支持」）', () => {
    mountConfigView();
    dispatchLoaded([]);
    (document.getElementById('btnAdd') as HTMLButtonElement).click();
    expect((document.getElementById('f-vision') as HTMLInputElement).checked).toBe(false);
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(lastSavedConfig().supportsVision).toBe(false);
  });

  it('云类型下也提交 false（视觉能力位**不随 provider 类型回落 undefined**，与工具能力位分野）', () => {
    const config = addNew();
    // 对照：工具能力位在 cloud 下是 undefined；视觉能力位恒显式 false
    expect(config.provider).toBe('cloud');
    expect(config.supportsVision).toBe(false);
  });

  it('勾选 → supportsVision=true（用户显式声明看得懂图）', () => {
    const config = addNew(() => {
      (document.getElementById('f-vision') as HTMLInputElement).checked = true;
    });
    expect(config.supportsVision).toBe(true);
  });

  it('编辑回填：存量（supportsVision 缺失）→ **不勾选**（防「一开编辑框就静默授予全量旧配置视觉能力」）', () => {
    // 该断言是 `target?.supportsVision === true` 而非 `!== false` 的锁：
    // 写成后者，存量 undefined 会被回填成勾选，等于替用户承诺了模型能力。
    openEdit();
    expect((document.getElementById('f-vision') as HTMLInputElement).checked).toBe(false);
  });

  it('编辑回填：已声明 supportsVision=true → 勾选（保存的声明能原样回显）', () => {
    openEdit({ supportsVision: true });
    expect((document.getElementById('f-vision') as HTMLInputElement).checked).toBe(true);
  });

  it('回填后未改动直接保存 → 原值保真（true 不被 false 覆盖）', () => {
    openEdit({ supportsVision: true });
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(lastSavedConfig().supportsVision).toBe(true);
  });

  it('存量（未声明）保存后维持 false —— 不因编辑动作升级为真', () => {
    openEdit();
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(lastSavedConfig().supportsVision).toBe(false);
  });
});

// ─── UI-TOAST-1：操作反馈 toast 走共享单一实现 ───

describe('configView 操作反馈 toast（UI-TOAST-1 三面收口：与 settings notice 同单一实现）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 分发一条 cfg_result（非 test 动作）驱动 toast 分支 */
  function dispatchResult(ok: boolean, message?: string): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'cfg_result', action: 'save', ok, message },
      }),
    );
  }

  it('保存成功 ⇒ #settings-toast info 态（.show、无 .error），2.5s 自动隐藏', () => {
    mountConfigView();
    dispatchResult(true, '已保存');
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.className).toBe('settings-toast show');
    expect(toast.textContent).toBe('已保存');
    vi.advanceTimersByTime(2500);
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('保存失败 ⇒ error 态（.error），文案缺省时兜底「操作失败」', () => {
    mountConfigView();
    dispatchResult(false);
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.className).toBe('settings-toast error show');
    expect(toast.textContent).toBe('操作失败');
  });

  it('🔴 不再查询根内 #toast（平行形态已删：ok/err/visible 旧类名契约整体退役）', () => {
    // 防回归：若共享 helper 被改回「根内预埋节点 + ok/err/visible」旧契约，本用例红。
    // 旧契约的两个失效签名：① 根内查询不到节点（helper 懒建在 body）；② 旧类名不再出现。
    mountConfigView();
    dispatchResult(true, 'x');
    expect(document.querySelector('#config-root #toast')).toBeNull();
    expect(document.querySelector('#toast.visible')).toBeNull();
    expect(document.querySelector('#toast.ok')).toBeNull();
    expect(document.querySelector('#settings-toast')).not.toBeNull();
  });
});
