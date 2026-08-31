/**
 * configView 测试 — 大模型配置面板渲染分支（ui-redesign.md §6.2 新增）
 *
 * 覆盖本次 UI 重构新增的渲染路径：
 *   - 顶栏统计（statBar：「已配置 N 个 API」）
 *   - 分区标题（group-title：「激活 Provider」/「其他 Provider」）
 *   - 卡片图标（cfg-icon：Provider 首字）
 *   - 空态引导（empty-state）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createConfigView 工厂驱动 render。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createConfigView } from '../scripts/configView.js';

/** 覆盖 createConfigView 全部查询引用的最小 HTML 骨架（子视图挂载在 #config-root 根容器内，
 *  与设置视图选项卡合并后的 id 空间隔离约定一致） */
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
    <details id="embeddingCfg" class="embedding-cfg">
      <summary>向量检索（Embedding，可选）</summary>
      <div class="embedding-fields">
        <div class="field"><label for="e-model">Embedding 模型</label><input id="e-model" type="text" /></div>
        <div class="field"><label for="e-baseurl">API Base URL</label><input id="e-baseurl" type="url" /></div>
        <div class="field"><label for="e-apikey">API Key</label><input id="e-apikey" type="password" /></div>
        <div class="embedding-actions"><button id="btnSaveEmbedding" class="btn">保存并启用</button><button id="btnClearEmbedding" class="btn btn-secondary">停用</button></div>
        <p id="embeddingStatus" class="embedding-status" hidden></p>
      </div>
    </details>
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
          <input id="f-contextwindow" type="text" />
          <div id="f-contextwindow-feedback" hidden></div>
          <div id="apikeyHint" hidden></div>
          <div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button>
          <button id="btnCancel" type="button"></button>
          <button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
    <div id="toast"></div>
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
  return { postMessage };
}

/** 向 webview 分发一条 cfg_loaded 消息，驱动 render（G5：可选 backgroundName；G1：可选 embedding） */
function dispatchLoaded(providers: unknown[], activeName?: string, backgroundName?: string, embedding?: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'cfg_loaded', providers, activeName, backgroundName, embedding },
    }),
  );
}

/** 构造一个 Provider 对象 */
function makeProvider(name: string, opts: { displayName?: string; model?: string; baseUrl?: string; contextWindow?: number } = {}) {
  return {
    name,
    displayName: opts.displayName || name,
    model: opts.model || name + '-model',
    baseUrl: opts.baseUrl || 'https://api.example.com/v1',
    provider: 'remote',
    contextWindow: opts.contextWindow,
  };
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

  // ─── 2026-08-29 per-LLM 上下文上限（contextWindow） ───

  it('详情报文：带 contextWindow 时附加「 · N tokens」标注（单位显式，缩写 K）', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek', { contextWindow: 128000 })], 'deepseek');
    const detail = document.querySelector('.card-detail') as HTMLElement;
    expect(detail.textContent).toBe('deepseek-model · https://api.example.com/v1 · 128K tokens');
  });

  it('详情报文：未配置 contextWindow 时不附加 tokens 标注（回落默认 120K）', () => {
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
    expect(cw.value).toBe('64K');
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
    (document.getElementById('f-contextwindow') as HTMLInputElement).value = '128000';
    (document.getElementById('cfgForm') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const sent = (postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as unknown[])[0] as { config: { contextWindow?: number } };
    expect(sent.config.contextWindow).toBe(128000);
  });

  it('保存提交：contextWindow 留空 → 上报 undefined（回落默认 120K）', () => {
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
    const sent = (postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as unknown[])[0] as { config: { contextWindow?: number } };
    expect(sent.config.contextWindow).toBeUndefined();
  });

  // ─── 2026-08-31 上下文上限简写输入（K/M 换算，对齐 fmtTokens 显示同规） ───

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
    const sent = (postMessage.mock.calls.find((c) => c[0].type === 'cfg_save') as unknown[])[0] as { config: { contextWindow?: number } } | undefined;
    return sent?.config.contextWindow;
  }

  it('保存「200K」→ 上报 200000（K=×1000，对齐 LLM 生态口径）', () => {
    expect(submitWithContextWindow('200K')).toBe(200000);
  });

  it('保存「1M」→ 上报 1000000（M=×1,000,000）', () => {
    expect(submitWithContextWindow('1M')).toBe(1000000);
  });

  it('保存小写「64k」→ 上报 64000（后缀大小写不敏感）', () => {
    expect(submitWithContextWindow('64k')).toBe(64000);
  });

  it('保存「1024K」→ 上报 1024000（K 恒为 ×1000，不因数值近似 M 而歧义）', () => {
    expect(submitWithContextWindow('1024K')).toBe(1024000);
  });

  it('保存小数「1.5K」→ 上报 1500（支持小数简写）', () => {
    expect(submitWithContextWindow('1.5K')).toBe(1500);
  });

  it('保存「65,536」（编辑回显千分位形式）→ 上报 65536（容忍千分位/下划线/空格）', () => {
    expect(submitWithContextWindow('65,536')).toBe(65536);
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
    expect(feedback.textContent).toContain('无法识别');
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
    expect(activeCard?.querySelector('.btn-secondary')?.getAttribute('title')).toContain('修改该 API 的配置');
    // 其他卡：设为当前 / 编辑 / 删除 均带 tooltip
    const otherCard = cards[1] as HTMLElement;
    const titles = Array.from(otherCard.querySelectorAll('.btn')).map((b) => b.getAttribute('title'));
    expect(titles.some((t) => t && t.includes('默认使用的大模型'))).toBe(true);
    expect(titles.some((t) => t && t.includes('不可恢复'))).toBe(true);
    expect(titles.some((t) => t && t.includes('修改该 API 的配置'))).toBe(true);
    // 头部「添加 API」按钮 tooltip
    expect(document.getElementById('btnAdd')?.getAttribute('title')).toContain('新增一个大模型 API 配置');
  });

  // ─── G5 后台模型通道（2026-08-23） ───

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

  // ─── G1 向量检索（Embedding）区（2026-08-23） ───

  it('cfg_loaded 未配置 embedding → 状态行隐藏', () => {
    mountConfigView();
    dispatchLoaded([]);
    const status = document.getElementById('embeddingStatus') as HTMLElement;
    expect(status.hidden).toBe(true);
  });

  it('cfg_loaded 已配置 embedding → 回填 model/baseUrl + 状态行（含 keyConfigured）', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek')],
      'deepseek',
      undefined,
      { enabled: true, model: 'text-embedding-3-small', baseUrl: 'https://api.example.com/v1', keyConfigured: true },
    );
    expect((document.getElementById('e-model') as HTMLInputElement).value).toBe('text-embedding-3-small');
    expect((document.getElementById('e-baseurl') as HTMLInputElement).value).toBe('https://api.example.com/v1');
    const status = document.getElementById('embeddingStatus') as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('语义检索已启用');
    expect(status.textContent).toContain('已配置 API Key');
  });

  it('已配置但缺 API Key → 状态行提示未配置 key', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek')],
      'deepseek',
      undefined,
      { enabled: true, model: 'm', baseUrl: 'https://api.example.com/v1', keyConfigured: false },
    );
    const status = document.getElementById('embeddingStatus') as HTMLElement;
    expect(status.textContent).toContain('未配置 API Key');
  });

  it('点「保存并启用」→ postMessage cfg_save_embedding（组装表单值）', () => {
    const { postMessage } = mountConfigView();
    (document.getElementById('e-model') as HTMLInputElement).value = 'text-embedding-3-small';
    (document.getElementById('e-baseurl') as HTMLInputElement).value = 'https://api.example.com/v1';
    (document.getElementById('e-apikey') as HTMLInputElement).value = 'sk-test';
    (document.getElementById('btnSaveEmbedding') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'cfg_save_embedding',
      config: { model: 'text-embedding-3-small', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' },
    });
  });

  it('点「停用」→ postMessage cfg_clear_embedding', () => {
    const { postMessage } = mountConfigView();
    (document.getElementById('btnClearEmbedding') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_clear_embedding' });
  });
});