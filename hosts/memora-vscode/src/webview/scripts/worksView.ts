/**
 * worksView — 设置面板「作品和规则」子视图（作品投影清单）
 *
 * 职责边界：**只渲染 host 推来的 `work_projection.state`，只上报用户意图**。
 * 「是不是项目规则」「本轮有没有失效」全部是内核已算好的字段，本文件不复算、不补算。
 *
 * 🔴 三条容易踩的伤（本文件逐条钉死）：
 *  1. **清单内容不可信**：name / description / source 来自用户可手改的
 *     `work-projections.json`，一律用 `textContent` / `dataset` / `setAttribute` 写入，
 *     禁 `innerHTML` 拼接（否则一个文件名就能注入 webview）。
 *  2. **行内按钮不得顺带打开文件**：行本身可点（open），行内两颗按钮是 toggle /
 *     unregister。绑定**只在列表容器上做一次委托**，且先判 `button[data-action]` 再判行，
 *     命中按钮即 return —— 靠「判定顺序 + 单一监听点」互斥，不靠 `stopPropagation`
 *     （事件已经冒泡到容器时 stopPropagation 救不了，行级监听器更会双触发）。
 *  3. **root 不写 display**：`works-root` 的显隐由 `hidden` 属性管（settingsView.switchTab），
 *     给 root 写 CSS display 会覆盖 hidden，属结构性假绿。
 */
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import type {
  WorkProjectionAction,
  WorkProjectionRow,
  WorkProjectionViewState,
} from '../../shared/workProjectionDto.js';
import { getIconSvg } from './icons.js';

/** 子视图依赖（结构对齐 `MountFactory`，由 settingsView 统一注入） */
export interface WorksViewDeps {
  // 形参必须与 `MountFactory` 同宽（函数参数逆变）：写成窄 union 会让挂载表编译不过。
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}

/** 行状态 → 图标名（唯一映射点；`lock` 禁用：与会话级钉住撞语义，见设计稿 §9.1） */
function rowIcon(row: WorkProjectionRow): 'warning' | 'check' | 'file' {
  if (row.hasFailure) return 'warning';
  return row.resident ? 'check' : 'file';
}

/** 构造一行（DOM API；所有用户可控文本走 textContent） */
function buildRow(document: Document, row: WorkProjectionRow): HTMLElement {
  const el = document.createElement('div');
  el.className = 'works-row' + (row.hasFailure ? ' is-failure' : '');
  el.dataset.source = row.source;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('title', row.tooltip);
  el.setAttribute('aria-label', `${row.name}，${row.statusText}；单击打开原文件`);

  const icon = document.createElement('span');
  icon.className = 'works-row-icon';
  // 图标是常量表内容，非用户数据 ⇒ 这里用 innerHTML 注入 SVG 安全（与 applyIcon 同源）
  icon.innerHTML = getIconSvg(rowIcon(row));
  el.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'works-row-body';

  // 首行：作品名 + 状态后缀两端对齐（名称长了只截名称，状态始终完整可读）
  const head = document.createElement('div');
  head.className = 'works-row-head';
  const name = document.createElement('span');
  name.className = 'works-row-name';
  name.textContent = row.name;
  const status = document.createElement('span');
  status.className = 'works-row-status';
  status.textContent = row.statusText;
  head.append(name, status);
  body.appendChild(head);

  // 说明只在卡片内显示（不再靠 hover tooltip）；空串不占位——这是渲染决策，不是业务判据
  if (row.description) {
    const description = document.createElement('span');
    description.className = 'works-row-description';
    description.textContent = row.description;
    body.appendChild(description);
  }

  const source = document.createElement('span');
  source.className = 'works-row-source';
  source.textContent = row.source;
  body.appendChild(source);
  el.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'works-row-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost works-row-btn';
  toggle.dataset.action = 'toggle';
  toggle.textContent = row.resident ? '取消项目规则' : '设为项目规则';
  toggle.title = row.resident ? '取消该文件的项目规则态' : '把该文件设为项目规则';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-ghost works-row-btn';
  remove.dataset.action = 'unregister';
  remove.textContent = '移除登记';
  remove.title = '仅从清单移除登记，不删除源文件';
  actions.append(toggle, remove);
  el.appendChild(actions);
  return el;
}

/** 初始化「作品和规则」子视图 */
export function createWorksView({ vscode, window, root }: WorksViewDeps): void {
  const document = window.document;
  const listMaybe = root.querySelector<HTMLElement>('#worksList');
  const noticeMaybe = root.querySelector<HTMLElement>('#worksNotice');
  const countMaybe = root.querySelector<HTMLElement>('#worksCount');
  const refreshMaybe = root.querySelector<HTMLButtonElement>('#btnRefreshWorks');
  if (!listMaybe || !noticeMaybe || !countMaybe || !refreshMaybe) return;
  // 显式收窄成非 null 常量：控制流 narrow 不会带进下面的 render 闭包（TS18047）
  const list: HTMLElement = listMaybe;
  const notice: HTMLElement = noticeMaybe;
  const count: HTMLElement = countMaybe;
  const refresh: HTMLButtonElement = refreshMaybe;

  /** 上报一条动作（source 一律取自行的 dataset，不从按钮文本反推） */
  function send(action: WorkProjectionAction, source: string): void {
    vscode.postMessage({ type: 'work_projection', action, source });
  }

  /** 渲染视图状态（唯一渲染出口） */
  function render(state: WorkProjectionViewState): void {
    list.replaceChildren();
    notice.hidden = true;
    notice.textContent = '';
    count.hidden = true;

    if (state.kind !== 'rows') {
      const p = document.createElement('p');
      p.className =
        'works-empty' + (state.kind === 'malformed' || state.kind === 'error' ? ' is-warning' : '');
      p.textContent = state.message;
      list.appendChild(p);
      return;
    }

    if (state.notice) {
      notice.hidden = false;
      notice.textContent = state.notice.text;
      notice.classList.toggle('is-warning', state.notice.level === 'warning');
    }
    count.hidden = false;
    count.textContent = `${state.rows.length} 条`;
    for (const row of state.rows) list.appendChild(buildRow(document, row));
  }

  // 单一监听点：容器委托。先判按钮、命中即 return ⇒ 点「移除登记」绝不会顺带 open。
  list.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const actionBtn = target?.closest<HTMLButtonElement>('button[data-action]');
    const row = target?.closest<HTMLElement>('.works-row');
    const source = row?.dataset.source;
    if (!row || !source) return;
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === 'toggle' || action === 'unregister') send(action, source);
      return;
    }
    send('open', source);
  });

  // 键盘可达：焦点在「行本身」时 Enter/Space = 打开；焦点在行内按钮时交给原生 click，
  // 此处不重复触发（否则按一次 Enter 会同时 open + toggle）。
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement | null;
    if (!target || target !== target.closest('.works-row')) return;
    const source = target.dataset.source;
    if (!source) return;
    event.preventDefault();
    send('open', source);
  });

  refresh.addEventListener('click', () =>
    vscode.postMessage({ type: 'work_projection', action: 'load' }),
  );

  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'work_projection') render(msg.state);
  });
}
