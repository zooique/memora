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
 *   ④ 写失败 ⇒ 表单带着原输入复开（reqId 随 mcp_status.ack 回传认领；输入不再丢失）；
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
import type {
  ExtensionToWebviewMessage,
  McpOmittedDto,
  McpServerStatusDto,
} from '../../shared/protocol.js';

/** 记录回执的依赖桩 */
function deps(): McpOpsDeps & {
  notices: { level: string; message: string }[];
  connects: number;
  acks: { reqId: string; ok: boolean; error?: string }[];
} {
  const notices: { level: string; message: string }[] = [];
  const acks: { reqId: string; ok: boolean; error?: string }[] = [];
  const bag = {
    notices,
    connects: 0,
    acks,
    pushStatus: (ack?: { reqId: string; ok: boolean; error?: string }) => {
      if (ack) acks.push(ack);
    },
    notice: (level: 'info' | 'error', message: string) => {
      notices.push({ level, message });
    },
    restart: async () => ({ ok: true }),
    connect: async () => {
      bag.connects += 1;
      return { ok: true };
    },
  };
  return bag;
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
  readonly reqId?: string;
  /** 编辑前的原名（新增不发）；宿主重名预检的判据输入 */
  readonly originalName?: string;
}

/**
 * 挂一个 MCP 子视图
 *
 * @param servers 首帧状态快照（可见卡片）
 * @param omitted 被隐藏条目计数（缺省 = 全部可见，与真实派生一致）
 */
function mount(
  servers: readonly McpServerStatusDto[],
  omitted: McpOmittedDto = { configured: servers.length, missingName: 0, duplicate: 0 },
): {
  root: HTMLElement;
  sent: SentWrite[];
  click(act: string): void;
  field(name: string): HTMLInputElement | HTMLTextAreaElement;
  /** 追推一条宿主消息（测 ack 认领：写后那次 mcp_status 是另一帧，不是首帧） */
  push(message: ExtensionToWebviewMessage): void;
} {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const root = doc.createElement('div');
  root.id = 'mcp-root';
  // 骨架必须与 settingsMcpHtml 一致：视图查不到容器就整体不挂载（返回静默），
  // 少一个 id 的表现是「页面全空」而不是某条断言红——所以这里按真骨架逐项列全。
  root.innerHTML =
    '<button class="mcp-add-btn" type="button"></button>' +
    '<span id="mcpCount"></span>' +
    '<div id="mcpEmpty" hidden>' +
    '<p id="mcpEmptyDefault"></p><p id="mcpEmptyHidden" hidden></p></div>' +
    '<p id="mcpOmitted" hidden></p>' +
    '<div id="mcpList"></div>';
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
  const message: ExtensionToWebviewMessage = { type: 'mcp_status', servers: [...servers], omitted };
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));

  return {
    root,
    sent,
    push(message: ExtensionToWebviewMessage): void {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
    },
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
    await applyMcpWrite(deps(), {
      op: 'upsert',
      server: write!.server,
      originalName: write!.originalName,
    } as never);

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
      await applyMcpWrite(deps(), {
        op: 'upsert',
        server: write!.server,
        originalName: write!.originalName,
      } as never);
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
      await applyMcpWrite(deps(), {
        op: 'upsert',
        server: write!.server,
        originalName: write!.originalName,
      } as never);
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
  it('新增填了已存在的名字 ⇒ 宿主拒绝覆盖（ack 失败 ⇒ 表单复开 + 内联原因，落盘不变）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.root.querySelector<HTMLElement>('.mcp-add-btn')?.click();
    view.field('name').value = 'fs';
    view.field('command').value = 'npx';
    view.click('save');

    // 新增不发 originalName（协议噪音最小化）；宿主见「无原名 + 撞已有名」即拒
    const write = view.sent.find((m) => m.type === 'mcp_write');
    expect(write?.originalName).toBeUndefined();
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: write!.server,
      reqId: write!.reqId,
    } as never);
    expect(d.acks[0]!.ok).toBe(false);
    expect(d.acks[0]!.error).toContain('覆盖');

    // 宿主把拒绝随 mcp_status 带回 ⇒ 视图认领，表单带着刚填的内容复开
    view.push({
      type: 'mcp_status',
      servers: [statusOf(savedServers()[0]!)],
      omitted: { configured: 1, missingName: 0, duplicate: 0 },
      ack: d.acks[0]!,
    });
    expect(view.root.querySelector('[data-field="command"]')).not.toBeNull();
    expect(view.root.querySelector('.mcp-form-error')!.textContent).toContain('覆盖');
    // 落盘未变：旧配置的 command 没有被新表单冲掉（原缺陷：回执说「已更新」，旧配置已遭殃）
    expect(savedServers()[0]!['command']).toBe('node');
  });

  it('写失败 ⇒ 表单带着原输入复开 + 内联失败原因（reqId 认领后输入不再丢失）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('command').value = 'node --experimental';
    h.failing = true;
    view.click('save');

    // 点保存即收表单（以回推为准，不乐观保住旧形态）
    expect(view.root.querySelector('[data-field="command"]')).toBeNull();
    const write = view.sent.find((m) => m.type === 'mcp_write');
    expect(write?.reqId).toBeTruthy();
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: write!.server,
      reqId: write!.reqId,
      originalName: write!.originalName,
    } as never);
    expect(d.acks).toEqual([
      { reqId: write!.reqId, ok: false, error: expect.stringContaining('写入失败') },
    ]);

    // 宿主把 ack 随写后那次 mcp_status 带回 ⇒ 视图认领，表单带着刚才填的内容复开
    view.push({
      type: 'mcp_status',
      servers: [statusOf(savedServers()[0]!)],
      omitted: { configured: 1, missingName: 0, duplicate: 0 },
      ack: d.acks[0]!,
    });

    const command = view.root.querySelector<HTMLInputElement>('[data-field="command"]');
    expect(command).not.toBeNull();
    expect(command!.value).toBe('node --experimental');
    expect(view.root.querySelector('.mcp-form-error')!.textContent).toContain('写入失败');
    // 落盘确实没变（失败 = 未落盘）
    expect(savedServers()[0]!['command']).toBe('node');
  });

  it('写成功 ⇒ ack 认领后表单保持关闭（不把旧输入又弹回来）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('command').value = 'npx';
    view.click('save');
    const write = view.sent.find((m) => m.type === 'mcp_write');
    // 编辑必须带 originalName：否则宿主把「保存自己」当「撞已有名」拒绝
    expect(write?.originalName).toBe('fs');
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: write!.server,
      reqId: write!.reqId,
      originalName: write!.originalName,
    } as never);
    expect(d.acks).toEqual([{ reqId: write!.reqId, ok: true }]);

    view.push({
      type: 'mcp_status',
      servers: [statusOf(savedServers()[0]!)],
      omitted: { configured: 1, missingName: 0, duplicate: 0 },
      ack: d.acks[0]!,
    });

    expect(view.root.querySelector('[data-field="command"]')).toBeNull();
    expect(savedServers()[0]!['command']).toBe('npx');
  });

  it('reqId 不对上不认领：他人触发的状态回推不会把表单弹开', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('command').value = 'npx';
    h.failing = true;
    view.click('save');
    h.failing = false;
    const write = view.sent.find((m) => m.type === 'mcp_write');

    // 别人的回推（reqId 对不上，典型：ready 握手 / 热更 / 运行态变化）
    view.push({
      type: 'mcp_status',
      servers: [statusOf(savedServers()[0]!)],
      omitted: { configured: 1, missingName: 0, duplicate: 0 },
      ack: { reqId: `${write!.reqId}-别人的`, ok: false, error: '写入失败：配置只读' },
    });

    expect(view.root.querySelector('[data-field="command"]')).toBeNull();
  });

  it('两次保存的 reqId 互不相同（认领依据必须唯一）', () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('command').value = 'npx';
    view.click('save');
    const first = view.sent.find((m) => m.type === 'mcp_write')?.reqId;

    view.root.querySelector<HTMLElement>('.mcp-add-btn')?.click();
    view.field('name').value = 'fs';
    view.field('command').value = 'node';
    view.click('save');
    const writes = view.sent.filter((m) => m.type === 'mcp_write');

    expect(writes).toHaveLength(2);
    expect(writes[0]!.reqId).toBeTruthy();
    expect(writes[1]!.reqId).toBeTruthy();
    expect(writes[1]!.reqId).not.toBe(first);
    // 编辑带原名（宿主放行「保存自己」）；新增不带（宿主见撞名即拒）
    expect(writes[0]!.originalName).toBe('fs');
    expect(writes[1]!.originalName).toBeUndefined();
  });

  it('用户已打开新表单时，迟到失败结论不顶掉正在输入的内容', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    view.click('edit');
    view.field('command').value = 'npx';
    h.failing = true;
    view.click('save');
    h.failing = false;
    const first = view.sent.find((m) => m.type === 'mcp_write');

    // 失败结论在路上，用户先打开了一台新表单（此举应使旧结论不再有权复开表单）。
    // ⚠ 模拟真实键入：直接改 .value 不触发 input 事件，重渲染会把值冲回草稿——
    // 真人打字必走 syncDraftFromDom，测试必须同样走一遍才等价。
    view.click('edit');
    const command = view.field('command');
    command.value = 'bun';
    command.dispatchEvent(
      new (command.ownerDocument.defaultView as Window & typeof globalThis).Event('input', {
        bubbles: true,
      }),
    );

    view.push({
      type: 'mcp_status',
      servers: [statusOf(savedServers()[0]!)],
      omitted: { configured: 1, missingName: 0, duplicate: 0 },
      ack: { reqId: first!.reqId!, ok: false, error: '写入失败：配置只读' },
    });

    expect(view.root.querySelector<HTMLInputElement>('[data-field="command"]')!.value).toBe('bun');
  });
});

/** 由落盘配置造一份「待接入」状态（Agent 未装配时宿主派生的就是它） */
function pendingOf(config: Record<string, unknown>): McpServerStatusDto {
  return { ...statusOf(config), state: 'pending' };
}

describe('待接入卡片 · 接入入口（pending 的唯一出路）', () => {
  it('pending 卡片有「接入」，点击发 mcp_write{op:connect} 并由宿主按当前配置追平', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([pendingOf(savedServers()[0]!)]);
    const button = view.root.querySelector<HTMLButtonElement>('[data-act="connect"]');
    expect(button).not.toBeNull();

    view.click('connect');
    const write = view.sent.find((m) => m.type === 'mcp_write');
    expect(write).toMatchObject({ type: 'mcp_write', op: 'connect', name: 'fs' });

    const d = deps();
    await applyMcpWrite(d, write as never);
    expect(d.connects).toBe(1);
    expect(d.notices).toHaveLength(0);
  });

  it('pending 卡片**不**渲染「重启」（restart 只恢复已有运行时，给了就是假动作）', () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([pendingOf(savedServers()[0]!)]);

    expect(view.root.querySelector('[data-act="restart"]')).toBeNull();
  });

  it('running 卡片不渲染「接入」（已接入的台归「重启」管，再给接入 = 两个按钮同一件事）', () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const view = mount([statusOf(savedServers()[0]!)]);

    expect(view.root.querySelector('[data-act="connect"]')).toBeNull();
  });
});

describe('隐藏条目可见性（配置里存在、列表画不出来的那部分）', () => {
  it('配置 2 条只显示 1 条 ⇒ 统计条明说「1 条未显示」，解释行给出原因', () => {
    h.data['mcpServers'] = [
      { name: 'fs', command: 'node' },
      { name: 'fs ', command: 'node' },
    ];
    const view = mount([statusOf(savedServers()[0]!)], {
      configured: 2,
      missingName: 0,
      duplicate: 1,
    });

    const count = view.root.querySelector('#mcpCount')!;
    expect(count.textContent).toContain('2 台');
    expect(count.textContent).toContain('1 条未显示');
    const omitted = view.root.querySelector<HTMLElement>('#mcpOmitted')!;
    expect(omitted.hidden).toBe(false);
    expect(omitted.textContent).toContain('重名的 1 条');
  });

  it('全部被隐藏 ⇒ 不说「还没有配置」，改说「有配置但显示不出来」', () => {
    const view = mount([], { configured: 2, missingName: 2, duplicate: 0 });

    expect(view.root.querySelector<HTMLElement>('#mcpEmpty')!.hidden).toBe(false);
    expect(view.root.querySelector<HTMLElement>('#mcpEmptyDefault')!.hidden).toBe(true);
    expect(view.root.querySelector<HTMLElement>('#mcpEmptyHidden')!.hidden).toBe(false);
    expect(view.root.querySelector('#mcpOmitted')!.textContent).toContain('缺名称的 2 条');
  });

  it('无隐藏 ⇒ 解释行隐藏且用默认空态文案（不制造噪音）', () => {
    const view = mount([], { configured: 0, missingName: 0, duplicate: 0 });

    expect(view.root.querySelector<HTMLElement>('#mcpOmitted')!.hidden).toBe(true);
    expect(view.root.querySelector<HTMLElement>('#mcpEmptyDefault')!.hidden).toBe(false);
    expect(view.root.querySelector<HTMLElement>('#mcpEmptyHidden')!.hidden).toBe(true);
  });
});
