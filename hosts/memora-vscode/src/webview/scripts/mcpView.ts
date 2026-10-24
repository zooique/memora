/**
 * mcpView — 设置面板「MCP」选项卡的 webview 子视图（自 settingsView.ts 拆出）
 *
 * 为什么独立成文件：settingsView 是逼近 eslint max-lines 通用闸（1000）的容器，
 * 而 MCP 页要长表单、状态机与确认流程；按域拆文件是本仓既有范式（样式层同样按 root 分文件）。
 *
 * 职责：
 *   - 渲染 `mcp_status`（五态 + 工具清单 + 免确认点选）；
 *   - 服务器增删改停启（**只发 `mcp_write`，不本地乐观翻转**——持久化真源在 host 配置，
 *     UI 只回显 host 回推的结果）；
 *   - 表单可无损呈现性判定（args/env 的文本化是有损的，见 {@link isFormRepresentable}）。
 *
 * 三条纪律：
 *   1. **单一状态源**：`servers` 只由 `mcp_status` 覆盖；`draft` 是瞬时输入草稿，绝不与
 *      `servers` 争真源（保存后重新以回推为准）。
 *   2. **事件委托**：所有按钮走 root 上的 `data-act` 分发——本页卡片是整块重渲染的，
 *      逐个 addEventListener 会在重渲染后全部失效（正是死按钮那类缺陷的温床）。
 *   3. **外部文本一律 escapeHtml**：server 名 / 工具名来自第三方 MCP server。
 */
import type {
  ExtensionToWebviewMessage,
  McpServerDraftDto,
  McpServerState,
  McpServerStatusDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { escapeHtml } from '../helpers/escapeHtml.js';

/** 五态可见名（与 CSS 的 `[data-state]` 取值同源） */
export const STATE_LABELS: Record<McpServerState, string> = {
  running: '已连接',
  failed: '启动失败',
  pending: '待接入',
  disabled: '已停用',
  invalid: '配置不完整',
};

/** 表单草稿（args/env 以**文本**保存：编辑中途不解析，保存时才落成数组/对象） */
export interface McpFormDraft {
  /** server 名（编辑已有 server 时只读：它是工具名前缀与 allowlist 寻址键） */
  name: string;
  /** 命令 */
  command: string;
  /** 参数：一行一个 */
  argsText: string;
  /** 环境变量：一行一个 `KEY=VALUE` */
  envText: string;
  /** 工作目录 */
  cwd: string;
  /** 是否启用 */
  enabled: boolean;
  /** 编辑中的原始 server 名（新增时为空字符串；用于判断「编辑」还是「新增」） */
  originalName: string;
}

/** 参数数组 → 文本（一行一个；空数组 → 空串） */
export function formatArgs(args: readonly string[] | undefined): string {
  return (args ?? []).join('\n');
}

/**
 * 剥掉行尾的单个 `\r`（Windows 换行残留）
 *
 * **只剥 `\r`，不剥空格**：`trimEnd()` 会把参数尾随空格一起吃掉，那是数据。
 * 2026-10-24 实测：`parseArgs(formatArgs(['--path=/tmp/x ']))` 曾返回 `['--path=/tmp/x']`
 * ——「打开表单→保存」静默改写参数，而 `isFormRepresentable` 还宣称「可无损呈现」。
 *
 * @param line 原始行
 */
function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 文本 → 参数数组（一行一个；纯空白行视为分隔符丢弃，其余原样保留）
 *
 * **不做 shell 解析**（不认引号、不认转义）：参数里本来就可以有空格，靠引号猜边界会
 * 制造「看起来对、传过去错」的静默偏差。要表达含换行的参数请走 settings.json（见
 * {@link isFormRepresentable}）。
 *
 * **不做 trimEnd**：尾随空格是参数内容的一部分（`--path=/x ` 与 `--path=/x` 不同）。
 * 纯空白行仍按分隔符丢弃——「整行没有内容」与「内容里有空格」是两件事，前者由
 * {@link isFormRepresentable} 保证不会出现在可编辑配置里。
 */
export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map(stripTrailingCR)
    .filter((line) => line.trim().length > 0);
}

/** 环境变量 → 文本（`KEY=VALUE` 一行一个，保序 = 对象键序） */
export function formatEnv(env: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * 文本 → 环境变量（按**第一个** `=` 切分，值里可以有 `=`）
 *
 * 与 {@link parseArgs} 同一纪律：只剥行尾 `\r`，**不 trimEnd**（值里的尾随空格是数据）。
 *
 * @returns 解析结果与非法行（无 `=` 或有空键的行）；非法行由调用方拦下，不静默丢弃
 */
export function parseEnv(text: string): {
  env: Record<string, string>;
  invalidLines: string[];
} {
  const env: Record<string, string> = {};
  const invalidLines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = stripTrailingCR(raw);
    if (line.trim().length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      invalidLines.push(line);
      continue;
    }
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { env, invalidLines };
}

/**
 * 该 server 能否用表单**无损**编辑
 *
 * 判据（双向：如果存进去的东西再打开一次会变，就是有损）：
 *   - `args` 里任何一项「整项都是空白」或含换行/回车 ⇒ 一行一个的文本格式表达不出来
 *     （纯空白行会被当分隔符丢弃、换行会被当成两项）；
 *   - `env` 的键为空 / 含 `=` / 含换行回车，或值含换行回车 ⇒ 同上。
 *
 * **判据必须与 parse 的实际行为同源**（2026-10-24 修）：parse 曾经 `trimEnd()`，
 * 而判据只查空串/换行 ⇒ 含尾随空格的参数被判「可编辑」，一保存就被静默改写。
 * 现在 parse 只剥 `\r`，判据也只需拒「换行 / 回车 / 纯空白项」。
 *
 * 有损时**不禁用查看、只禁用编辑**并指路 settings.json：静默改写用户配置里的字符，
 * 比不能编辑严重得多（不带伤）。
 *
 * @param server 配置形状（DTO 即可）
 */
export function isFormRepresentable(server: McpServerDraftDto): boolean {
  const args = server.args ?? [];
  if (args.some((arg) => arg.trim().length === 0 || /[\r\n]/.test(arg))) return false;
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (key.length === 0 || key.includes('=') || /[\r\n]/.test(key)) return false;
    if (/[\r\n]/.test(value)) return false;
  }
  return true;
}

/** 列表一行的命令摘要（command + args；不含 env 值——env 常放密钥） */
function summaryOf(server: McpServerDraftDto): string {
  const text = [server.command, ...(server.args ?? [])].join(' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 新建草稿（空表单） */
function emptyDraft(): McpFormDraft {
  return {
    name: '',
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    enabled: true,
    originalName: '',
  };
}

/** 由配置生成草稿（编辑已有 server） */
function draftOf(server: McpServerStatusDto): McpFormDraft {
  return {
    name: server.name,
    command: server.command,
    argsText: formatArgs(server.args),
    envText: formatEnv(server.env),
    cwd: server.cwd ?? '',
    enabled: server.enabled,
    originalName: server.name,
  };
}

/**
 * 统计条文案（页头那行「N 台 · X 已连接 · …」）
 *
 * **纯函数 + 单测**（不内联在 render 里）：汇总与卡片分家是观察面最典型的谎言——
 * 「3 台 · 1 已连接 · 0 失败」而页面上明明还有「配置不完整」的卡。口径写死在这里：
 *   - `需处理` = failed + invalid（两者都要求用户动手）；
 *   - `待接入` = pending（装配前的正常态，不算故障但必须说出来）；
 *   - `已连接` = running；`disabled` 只进台数（用户主动停的，不需处理）。
 *
 * @param servers 状态快照
 * @returns 统计文案（空列表 = 空串，由调用方隐藏）
 */
export function formatServerSummary(servers: readonly McpServerStatusDto[]): string {
  if (servers.length === 0) return '';
  const countOf = (predicate: (item: McpServerStatusDto) => boolean): number =>
    servers.filter(predicate).length;
  const parts = [`${servers.length} 台`, `${countOf((item) => item.state === 'running')} 已连接`];
  const bad = countOf((item) => item.state === 'failed' || item.state === 'invalid');
  if (bad > 0) parts.push(`${bad} 需处理`);
  const pending = countOf((item) => item.state === 'pending');
  if (pending > 0) parts.push(`${pending} 待接入`);
  parts.push(`${servers.reduce((sum, item) => sum + item.toolCount, 0)} 个工具`);
  return parts.join(' · ');
}

/** createMcpView 依赖 */
export interface McpViewDeps {
  /** webview 通信（共享 acquireVsCodeApi 实例，禁子视图自取） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window */
  window: Window;
  /** 本子视图根容器（`#mcp-root`） */
  root: HTMLElement;
}

/**
 * 初始化 MCP 子视图
 *
 * @param deps 依赖（vscode / window / root）
 */
export function createMcpView({ vscode, window, root }: McpViewDeps): void {
  // 骨架缺失（宿主 HTML 未含 mcp-root）时静默不挂载：容器层 `getElementById` 的 cast 在
  // 运行期可能是 null，此处早退比抛错更诚实（也不让 try/catch 把它伪装成「挂载异常」）
  if (!root) return;
  const listEl = root.querySelector<HTMLElement>('#mcpList');
  const emptyEl = root.querySelector<HTMLElement>('#mcpEmpty');
  const countEl = root.querySelector<HTMLElement>('#mcpCount');
  if (!listEl || !emptyEl || !countEl) return;

  /** 状态真源（只由 mcp_status 覆盖） */
  let servers: readonly McpServerStatusDto[] = [];
  /** 编辑态草稿（null = 没有表单打开） */
  let draft: McpFormDraft | null = null;
  /** 待确认删除的 server 名（二次确认：删除是改配置里不可撤销的动作） */
  let confirmingDelete: string | null = null;
  /** 表单内联错误（保存前校验失败时显示，不打断已填内容） */
  let formError = '';
  /** 是否收到过首帧状态（未收到前保留骨架里的「加载中…」，不谎报空态） */
  let received = false;

  /** 渲染工具行（只在 running 态有内容） */
  function toolRows(server: McpServerStatusDto): string {
    if (server.tools.length === 0) return '';
    return `<ul class="mcp-tool-list">${server.tools
      .map((tool) => {
        const renamed = tool.derivedName !== tool.originalName;
        return `<li class="mcp-tool-row">
          <div class="mcp-tool-name">
            <code>${escapeHtml(tool.derivedName)}</code>
            ${renamed ? `<span class="mcp-tool-orig">（工具原名 ${escapeHtml(tool.originalName)}）</span>` : ''}
          </div>
          <label class="mcp-allow-toggle" title="免确认：不再弹窗，但每次调用仍写审计">
            <input type="checkbox" class="mcp-allow-check" data-allow-key="${escapeHtml(tool.allowKey)}" aria-label="${escapeHtml(tool.derivedName)} 免确认" ${tool.allowlisted ? 'checked' : ''} />
            <span>免确认</span>
          </label>
        </li>`;
      })
      .join('')}</ul>`;
  }

  /** 表单（新增或编辑共用；name 在编辑态只读——它是身份键） */
  function formHtml(current: McpFormDraft): string {
    const isEdit = current.originalName !== '';
    return `<form class="mcp-form" data-form="1">
      <div class="mcp-field">
        <label class="mcp-label" for="mcpFName">名称</label>
        <input id="mcpFName" class="mcp-input" data-field="name" type="text" value="${escapeHtml(current.name)}" ${isEdit ? 'readonly' : ''} placeholder="例如 filesystem" />
        ${isEdit ? '<span class="mcp-hint">名称是工具名前缀与免确认寻址键，改名请删除后重建</span>' : ''}
      </div>
      <div class="mcp-field">
        <label class="mcp-label" for="mcpFCommand">命令</label>
        <input id="mcpFCommand" class="mcp-input" data-field="command" type="text" value="${escapeHtml(current.command)}" placeholder="例如 npx" />
      </div>
      <div class="mcp-field">
        <label class="mcp-label" for="mcpFArgs">参数<span class="mcp-hint">一行一个</span></label>
        <textarea id="mcpFArgs" class="mcp-input mcp-textarea" data-field="argsText" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir">${escapeHtml(current.argsText)}</textarea>
      </div>
      <div class="mcp-field">
        <label class="mcp-label" for="mcpFEnv">环境变量<span class="mcp-hint">一行一个 KEY=VALUE</span></label>
        <textarea id="mcpFEnv" class="mcp-input mcp-textarea" data-field="envText" rows="2" placeholder="TOKEN=xxx">${escapeHtml(current.envText)}</textarea>
      </div>
      <div class="mcp-field">
        <label class="mcp-label" for="mcpFCwd">工作目录<span class="mcp-hint">可留空</span></label>
        <input id="mcpFCwd" class="mcp-input" data-field="cwd" type="text" value="${escapeHtml(current.cwd)}" placeholder="缺省继承扩展宿主目录" />
      </div>
      <label class="mcp-check"><input type="checkbox" data-field="enabled" ${current.enabled ? 'checked' : ''} />启用</label>
      <p class="mcp-warn">保存后立即生效：面板会拉起这个命令并把它暴露的工具注册给模型。只填你信任的服务器。</p>
      <p class="mcp-form-error"${formError ? '' : ' hidden'}>${escapeHtml(formError)}</p>
      <div class="mcp-form-actions">
        <button class="btn btn-primary" type="button" data-act="save">保存</button>
        <button class="btn btn-secondary" type="button" data-act="cancel">取消</button>
      </div>
    </form>`;
  }

  /** 单台卡片 */
  function cardHtml(server: McpServerStatusDto): string {
    const state = server.state;
    const editing = draft !== null && draft.originalName === server.name;
    const editable = isFormRepresentable(server);
    const actions: string[] = [];

    if (state === 'running' || state === 'failed') {
      actions.push(
        '<button class="btn btn-secondary" type="button" data-act="restart">重启</button>',
      );
    }
    // 编辑对**所有态**开放：invalid（缺 command）正需要补字段，藏了编辑等于逼用户手写 JSON
    actions.push(
      `<button class="btn btn-secondary" type="button" data-act="edit"${editable ? '' : ' disabled title="参数或环境变量含空项/换行，表单无法无损呈现；请用页脚的 settings.json 入口编辑"'}${editing ? ' hidden' : ''}>编辑</button>`,
    );
    // 启停只对「配置完整」的台有意义：invalid 永远起不来，给个「启用」是假动作
    if (state !== 'invalid') {
      actions.push(
        `<button class="btn btn-secondary" type="button" data-act="toggle">${server.enabled ? '停用' : '启用'}</button>`,
      );
    }
    if (confirmingDelete === server.name) {
      actions.push(
        '<button class="btn btn-danger" type="button" data-act="delete-confirm">确认删除</button>',
      );
      actions.push(
        '<button class="btn btn-secondary" type="button" data-act="delete-cancel">取消</button>',
      );
    } else {
      actions.push('<button class="btn btn-ghost" type="button" data-act="delete">删除</button>');
    }

    return `<div class="mcp-server card" data-name="${escapeHtml(server.name)}">
      <div class="mcp-server-head">
        <span class="mcp-dot" data-state="${state}" aria-hidden="true"></span>
        <h3 class="mcp-server-name">${escapeHtml(server.name)}</h3>
        <code class="mcp-server-cmd" title="${escapeHtml(summaryOf(server))}">${escapeHtml(summaryOf(server))}</code>
        <span class="mcp-server-state" data-state="${state}">${STATE_LABELS[state]}</span>
        <span class="mcp-server-count">${server.toolCount} 个工具</span>
      </div>
      ${state === 'failed' ? `<p class="mcp-server-error">${escapeHtml(server.error ?? '')}</p>` : ''}
      ${state === 'invalid' ? `<p class="mcp-server-error">${escapeHtml(server.problem ?? '')}</p>` : ''}
      ${state === 'pending' ? '<p class="mcp-server-note">尚未接入：打开对话面板即按当前配置连接并注册工具</p>' : ''}
      ${toolRows(server)}
      <div class="mcp-actions">${actions.join('')}</div>
      ${editing && draft ? formHtml(draft) : ''}
    </div>`;
  }

  /** 整块重渲染（卡片是纯回推渲染；草稿在 state 里，重渲染不丢已填内容） */
  function render(): void {
    if (!received && draft === null) return;
    const has = servers.length > 0 || draft !== null;
    emptyEl!.hidden = has;
    listEl!.hidden = !has;
    countEl!.hidden = servers.length === 0;
    if (servers.length > 0) {
      // 口径集中在 formatServerSummary（有单测守；内联再算一遍 = 两份判据）
      countEl!.textContent = formatServerSummary(servers);
    } else {
      countEl!.textContent = '';
    }
    const newForm =
      draft !== null && draft.originalName === ''
        ? `<div class="mcp-server card">${formHtml(draft)}</div>`
        : '';
    listEl!.innerHTML = newForm + servers.map(cardHtml).join('');
  }

  /** 读取表单当前值（受控：以 DOM 为准回填草稿，避免重渲染丢输入） */
  function syncDraftFromDom(): void {
    if (!draft) return;
    const form = listEl!.querySelector<HTMLFormElement>('.mcp-form');
    if (!form) return;
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (!field) return;
      if (field === 'enabled') draft!.enabled = (el as HTMLInputElement).checked;
      else if (field === 'name') draft!.name = el.value;
      else if (field === 'command') draft!.command = el.value;
      else if (field === 'argsText') draft!.argsText = el.value;
      else if (field === 'envText') draft!.envText = el.value;
      else if (field === 'cwd') draft!.cwd = el.value;
    });
  }

  /** 保存：先本地快校验（不为空 / env 行合法），再交给 host 权威裁决 */
  function save(): void {
    syncDraftFromDom();
    if (!draft) return;
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!name || !command) {
      formError = '名称与命令都不能为空';
      render();
      return;
    }
    const { env, invalidLines } = parseEnv(draft.envText);
    if (invalidLines.length > 0) {
      formError = `环境变量行缺少 KEY=：${invalidLines.join(' / ')}`;
      render();
      return;
    }
    formError = '';
    const payload: McpServerDraftDto = {
      name,
      command,
      enabled: draft.enabled,
    };
    const args = parseArgs(draft.argsText);
    if (args.length > 0) payload.args = args;
    if (Object.keys(env).length > 0) payload.env = env;
    const cwd = draft.cwd.trim();
    if (cwd.length > 0) payload.cwd = cwd;
    vscode.postMessage({ type: 'mcp_write', op: 'upsert', server: payload });
    // 关表单、以回推为准（不乐观插入一条「我以为保存成功了」的卡片）
    draft = null;
    render();
  }

  /** 按钮分发（单点；卡片重渲染后依然有效） */
  listEl.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    const card = button.closest<HTMLElement>('.mcp-server');
    const name = card?.dataset.name ?? draft?.originalName ?? '';
    const server = servers.find((item) => item.name === name);

    if (act === 'save') return save();
    if (act === 'cancel') {
      draft = null;
      formError = '';
      render();
      return;
    }
    if (act === 'edit' && server) {
      draft = draftOf(server);
      confirmingDelete = null;
      formError = '';
      render();
      return;
    }
    if (act === 'restart') {
      vscode.postMessage({ type: 'mcp_write', op: 'restart', name });
      return;
    }
    if (act === 'toggle' && server) {
      vscode.postMessage({
        type: 'mcp_write',
        op: 'setEnabled',
        name,
        enabled: !server.enabled,
      });
      return;
    }
    if (act === 'delete') {
      confirmingDelete = name;
      render();
      return;
    }
    if (act === 'delete-cancel') {
      confirmingDelete = null;
      render();
      return;
    }
    if (act === 'delete-confirm') {
      confirmingDelete = null;
      vscode.postMessage({ type: 'mcp_write', op: 'remove', name });
      render();
    }
  });

  /** 新增：两处入口（页头按钮 + 空态 CTA）共用一个 class ⇒ 委托一次即可 */
  root.addEventListener('click', (event) => {
    const add = (event.target as Element | null)?.closest<HTMLElement>('.mcp-add-btn');
    if (!add) return;
    draft = emptyDraft();
    confirmingDelete = null;
    formError = '';
    render();
    listEl!.querySelector<HTMLInputElement>('#mcpFName')?.focus();
  });

  /** 免确认勾选：只上报，不本地翻转（等 host 回推；否则 UI 又变成一份「我以为生效了」的状态） */
  listEl.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !target.classList.contains('mcp-allow-check')) return;
    const key = target.dataset.allowKey;
    if (!key) return;
    vscode.postMessage({ type: 'mcp_write', op: 'allow', key, allowlisted: target.checked });
    target.checked = !target.checked;
  });

  /** 表单输入实时回填草稿（重渲染时由草稿回显，输入不丢） */
  listEl.addEventListener('input', () => {
    if (draft) syncDraftFromDom();
  });
  listEl.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.dataset?.field === 'enabled' && draft) syncDraftFromDom();
  });

  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    if (event.data.type !== 'mcp_status') return;
    received = true;
    servers = event.data.servers;
    // 被编辑/待删的那台如果已经不在配置里（他处改了配置），收起表单与确认态
    const editingName = draft?.originalName ?? '';
    if (editingName !== '' && !servers.some((item) => item.name === editingName)) draft = null;
    if (confirmingDelete && !servers.some((item) => item.name === confirmingDelete)) {
      confirmingDelete = null;
    }
    render();
  });
}
