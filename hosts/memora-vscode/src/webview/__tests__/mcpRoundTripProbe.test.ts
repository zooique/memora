/**
 * 跨层往返探针 — 「表单 → 消息 → 写配置 → 读回」整条链路
 *
 * **为什么要这个文件**：台账第 6 步把两条 P0（清空 args 无效 / 尾随空格被吃掉）的复验
 * 登记为「只能真机点」。真机与这里的差别只有一层：VS Code 的
 * `getConfiguration().update()` 把数组写进 settings.json 再读回，它不改写字符串内容。
 * ⇒ 把 webview 的 DOM 动作（点编辑 / 清空 / 点保存）与 host 的 `applyMcpWrite` 串起来，
 * 就能在 CI 里复现真机动作。
 *
 * 🔴 **环境约束（实测，勿照抄常见写法）**：本文件**必须**用 node 环境 + 显式 JSDOM。
 * 一旦切到 jsdom 环境，`vi.mock('vscode')` 在 import-analysis 阶段就失效——vite 8 先按
 * browser 条件解析 bare module，`vscode` 不存在 ⇒ 直接 `Failed to resolve import "vscode"`，
 * mock 拦不住。所以 DOM 由 `new JSDOM()` 造、经 `createMcpView({ window, root })` 的
 * **注入面**喂进去（该函数依赖全是入参，不读全局）。
 * ⚠️ 本注释里也不能出现完整的环境指令字样：vitest 用文本扫描识别它，写全了会把环境改掉
 * （本文件首次就是这么被自己坑红的）。
 *
 * 覆盖的不变量（缺一条就是「静默改写用户数据」）：
 *   ① 清空 args 后保存 ⇒ 落盘项**没有 args 键**（不是 `args: []`）；
 *   ② `--path=/tmp/x ` 的尾随空格**原样保住**（打开→保存两轮往返）；
 *   ③ 新增表单填了个重名 ⇒ 走「已更新」（覆盖），不是「已添加」；
 *   ④ 写失败时表单已关 ⇒ 用户输入丢失（缺 reqId 的后果，可复现）；
 *   ⑤ `cwd` 的尾随空格同样原样保住（保存只判空、不改写；判据面 = 字段面）；
 *   ⑥ `cwd` 含换行 ⇒ 编辑按钮 disabled（input 会吞换行，指路 settings.json）。
 */
// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** jsdom 无官方类型（仓库未装 @types/jsdom）⇒ 只在此处用一次结构化断言拿构造器 */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

/** vscode 替身：内存配置表（`failing` 打开后 update 拒绝，模拟只读配置） */
const h = vi.hoisted(() => ({ data: {} as Record<string, unknown>, failing: false }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in h.data ? h.data[key] : fallback),
      update: (key: string, value: unknown) => {
        if (h.failing) return Promise.reject(new Error('配置只读'));
        h.data[key] = value;
        return Promise.resolve();
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import { applyMcpWrite, type McpOpsDeps } from '../panels/mcpServerOps.js';
import { createMcpView } from '../scripts/mcpView.js';
import type { ExtensionToWebviewMessage, McpServerStatusDto } from '../../shared/protocol.js';

/** 记录回执的依赖桩 */
function deps(): McpOpsDeps & { notices: { level: string; message: string }[] } {
  const notices: { level: string; message: string }[] = [];
  return {
    notices,
    pushStatus: () => undefined,
    notice: (level: 'info' | 'error', message: string) => {
      notices.push({ level, message });
    },
    restart: async () => ({ ok: true }),
  };
}

/** 已落盘的配置项（读替身里的真值，等价于读回 settings.json） */
function savedServers(): Record<string, unknown>[] {
  return (h.data['mcpServers'] as Record<string, unknown>[] | undefined) ?? [];
}

/** 由落盘配置造一份状态快照（真机上由 getMcpServerStatus 产出；本文件只关心往返） */
function statusOf(config: Record<string, unknown>): McpServerStatusDto {
  return {
    name: String(config['name']),
    command: String(config['command']),
    ...(Array.isArray(config['args']) ? { args: config['args'] as string[] } : {}),
    ...(config['env'] ? { env: config['env'] as Record<string, string> } : {}),
    ...(typeof config['cwd'] === 'string' && config['cwd'] ? { cwd: config['cwd'] } : {}),
    state: 'running',
    enabled: config['enabled'] !== false,
    toolCount: 0,
    tools: [],
  };
}

/** 一条 mcp_write 消息（webview 侧产物） */
interface SentWrite {
  readonly type: string;
  readonly op?: string;
  readonly server?: Record<string, unknown>;
}

/**
 * 挂一个 MCP 子视图
 *
 * @param servers 首帧状态快照
 */
function mount(servers: readonly McpServerStatusDto[]): {
  root: HTMLElement;
  sent: SentWrite[];
  click(act: string): void;
  field(name: string): HTMLInputElement | HTMLTextAreaElement;
} {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const root = doc.createElement('div');
  root.id = 'mcp-root';
  root.innerHTML =
    '<button class="mcp-add-btn" type="button"></button>' +
    '<span id="mcpCount"></span><div id="mcpEmpty" hidden></div><div id="mcpList"></div>';
  doc.body.appendChild(root);

  const sent: SentWrite[] = [];
  createMcpView({
    vscode: {
      postMessage: (msg) => {
        sent.push(msg as unknown as SentWrite);
      },
    },
    window: dom.window,
    root,
  });
  const message: ExtensionToWebviewMessage = { type: 'mcp_status', servers: [...servers] };
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));

  return {
    root,
    sent,
    click(act: string): void {
      const button = root.querySelector<HTMLElement>(`[data-act="${act}"]`);
      if (!button) throw new Error(`按钮不存在：${act}`);
      button.click();
    },
    field(name: string): HTMLInputElement | HTMLTextAreaElement {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-field="${name}"]`,
      );
      if (!el) throw new Error(`字段不存在：${name}`);
      return el;
    },
  };
}

beforeEach(() => {
  h.data = {};
  h.failing = false;
});

describe('往返探针 · 清空 args（P0-1 用户视角）', () => {
  it('清空参数后保存 ⇒ 落盘项没有 args 键', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node', args: ['-y', '/srv'] }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('argsText').value = '';
    view.click('save');

    const write = view.sent.find((m) => m.type === 'mcp_write');
    expect(write?.op).toBe('upsert');
    await applyMcpWrite(deps(), { op: 'upsert', server: write!.server } as never);

    expect(savedServers()[0]).toEqual({ name: 'fs', command: 'node', enabled: true });
  });
});

describe('往返探针 · 尾随空格（P0-2 用户视角）', () => {
  it('打开表单原样保存两轮 ⇒ 尾随空格不丢', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node', args: ['--path=/tmp/x ', 'a'] }];

    for (let round = 0; round < 2; round += 1) {
      const view = mount([statusOf(savedServers()[0]!)]);
      view.click('edit');
      view.click('save');
      const write = view.sent.find((m) => m.type === 'mcp_write');
      await applyMcpWrite(deps(), { op: 'upsert', server: write!.server } as never);
    }

    expect(savedServers()[0]!['args']).toEqual(['--path=/tmp/x ', 'a']);
  });
});

describe('往返探针 · cwd（判据面 = 字段面）', () => {
  it('cwd 带尾随空格 ⇒ 打开→保存两轮仍原样（保存只判空、不改写）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node', cwd: '/tmp/x ' }];

    for (let round = 0; round < 2; round += 1) {
      const view = mount([statusOf(savedServers()[0]!)]);
      view.click('edit');
      view.click('save');
      const write = view.sent.find((m) => m.type === 'mcp_write');
      await applyMcpWrite(deps(), { op: 'upsert', server: write!.server } as never);
    }

    // 原先 `save()` 里 `draft.cwd.trim()` 会把空格吃掉，而判据只查 args/env ⇒ 谎称无损
    expect(savedServers()[0]!['cwd']).toBe('/tmp/x ');
  });

  it('cwd 含换行 ⇒ 编辑按钮 disabled（input 会吞换行，指路 settings.json）', () => {
    const view = mount([{ ...statusOf({ name: 'fs', command: 'node' }), cwd: 'a\nb' }]);
    const edit = view.root.querySelector<HTMLButtonElement>('[data-act="edit"]');
    expect(edit).not.toBeNull();
    expect(edit!.disabled).toBe(true);
  });

  it('cwd 只有尾随空格（无换行）⇒ 编辑按钮可用（尾随空格不是不可表达）', () => {
    const view = mount([{ ...statusOf({ name: 'fs', command: 'node' }), cwd: '/tmp/x ' }]);
    const edit = view.root.querySelector<HTMLButtonElement>('[data-act="edit"]');
    expect(edit!.disabled).toBe(false);
  });
});

describe('往返探针 · 重名与失败回执', () => {
  it('新增表单填了个已存在的名字 ⇒ 覆盖并回执「已更新」', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.root.querySelector<HTMLElement>('.mcp-add-btn')?.click();
    view.field('name').value = 'fs';
    view.field('command').value = 'npx';
    view.click('save');

    const write = view.sent.find((m) => m.type === 'mcp_write');
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: write!.server } as never);

    expect(savedServers()).toHaveLength(1);
    expect(savedServers()[0]!['command']).toBe('npx');
    expect(d.notices.map((n) => n.message)).toContain('已更新「fs」');
  });

  it('写失败 ⇒ 表单已关且输入不留痕（缺 reqId 的后果）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('command').value = 'node --experimental';
    h.failing = true;
    view.click('save');

    // webview 侧：点保存即收起表单，不保留草稿
    expect(view.root.querySelector('[data-field="command"]')).toBeNull();
    const write = view.sent.find((m) => m.type === 'mcp_write');
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: write!.server } as never);

    expect(d.notices).toEqual([{ level: 'error', message: expect.stringContaining('写入失败') }]);
    // 落盘没变，界面也没有「刚才填的」痕迹 ⇒ 输入确实丢了
    expect(savedServers()[0]!['command']).toBe('node');
    expect(view.root.textContent).not.toContain('--experimental');
  });
});
