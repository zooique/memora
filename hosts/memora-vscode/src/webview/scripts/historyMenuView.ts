/**
 * 历史菜单（会话记录 / 留存区）渲染域容器
 *
 * 自 `chatView.ts` 外置（HOST-SPLIT-1 chatView 第 2 刀，方案见
 * `tasks/方案-HOST-SPLIT-1-chatView历史菜单域提取-20261021.md`）。
 *
 * **开合交互不在本域**：浮层开合 / 外部点击收起 / Escape / 条目点击委托全部由
 * `initDropdowns`（treedd 组件，`components/dropdown.js`）管理——本域只管
 * 「数据进来怎么渲染」（SSOT 单一职责：treedd 管交互状态、本域管数据）。
 *
 * 四条设计约束（chatView 内联时期已定案，随域迁移，不在两处重述）：
 *   ① **分组形态（留存区）**：列表只有一份数据，分组切换是**前端过滤**——
 *      `sessions` 全量 + `archivedIds` 标记，切 tab 只重渲染当前容器，不回 host 请求。
 *      这样两个分组不可能出现「同一会话两边都有 / 两边都没有」的归属漂移，
 *      也避免把菜单项集合变成两份（dropdown 的键盘导航取全部 `.treedd__item`，
 *      多容器显隐会让方向键跳到不可见条目）。
 *   ② 分组视图的改变时机**只有两处**：① tab 点击（用户主动）；② 打开浮层
 *      （新一轮浏览回到默认分组，即 `openFresh`）。数据下发（含归档/移回后的
 *      列表刷新）只按**当前视图**渲染——若在下发时机强制重置，留存区里点
 *      「移回」会把用户踢回会话记录，连续管理被打断。
 *   ③ 日期真源 = sessionId 前缀（「YYYY-MM-DD-name」，契约锚定内核
 *      `buildSessionId`/`splitSessionId`，不新加协议字段——加了就是第二真相源）。
 *   ④ 空态两分：搜索无匹配 ≠ 分组为空，文案必须区分（否则搜不到会被误读成「分组是空的」）。
 *
 * 状态（`sessionListView` / `sessionSearchQuery` / `lastSessionList` /
 * `lastArchivedIds` / `currentArchiveMode`）全部封装在工厂闭包内，
 * view 侧只经窄接口读写。
 *
 * @module historyMenuView
 */

import type { ArchiveMode } from '@zooique/memora';
import { getIconSvg } from './icons.js';

/** 会话条目形状契约 = protocol `session_list_data.sessions`（结构化兼容，协议演进时同步本表） */
export interface SessionSummaryDto {
  sessionId: string;
  title: string;
  updatedAt: string;
  keyTopics?: string[];
  summary?: string;
  messageCount?: number;
}

/** 本域经 postMessage 发出的消息型（窄联合：历史菜单的全部出口动作） */
type HistoryMenuMessage =
  | { type: 'session_list' }
  | { type: 'restore_session'; sessionId: string }
  | { type: 'archive_session'; sessionId: string }
  | { type: 'delete_session'; sessionId: string };

/** 工厂依赖：文档对象 + 5 个专属 DOM 节点 + 消息窄通道 */
export interface HistoryMenuViewDeps {
  /** webview 文档对象（构建条目节点用） */
  document: Document;
  /** #historyMenu：条目容器（treedd 菜单体，开合由 treedd 管，本域只填充） */
  menuEl: HTMLElement;
  /** #historyTabRecent：「会话记录」分组 tab */
  tabRecent: HTMLButtonElement;
  /** #historyTabArchived：「留存区」分组 tab */
  tabArchived: HTMLButtonElement;
  /** #historyArchivedCount：留存区计数徽标 */
  archivedCountEl: HTMLElement;
  /** #historySearch：FD-3-A 元数据搜索框（标题 / 主题 / 摘要） */
  searchInput: HTMLInputElement;
  /** 消息通道（view 侧包一层 `vscode.postMessage`；本域不 import vscode） */
  postMessage: (msg: HistoryMenuMessage) => void;
}

/**
 * 历史菜单窄接口（view 侧唯一可触面）
 *
 * 两个数据入口（列表下发 / 归档模式运行时真值）+ 一个浏览重置入口。
 * tab 切换 / 搜索过滤的监听器随域注册在本工厂内（元素专属域，见方案 §2.2 判据）；
 * `historyBtn` 的 click 监听**留在 view**（同元素双监听器时序敏感）。
 */
export interface HistoryMenuView {
  /** 渲染历史菜单（对 `session_list_data` 的应答）：存快照并按当前视图渲染 */
  renderMenu(sessions: SessionSummaryDto[], archivedIds: string[]): void;
  /** 归档模式运行时真值（对 `chat_archive_mode` 的应答）：驱动留存按钮文案；
   *  已有数据则就地重渲染（title/aria 由归档模式派生），无数据不重建空菜单 */
  setArchiveMode(mode: ArchiveMode): void;
  /** 打开浮层时的「重新开始浏览」：回默认分组 + 清搜索词 + 请求最新列表 */
  openFresh(): void;
}

/**
 * 创建历史菜单渲染域
 *
 * @param deps 工厂依赖（document + DOM 节点 + 消息窄通道）
 * @returns 窄接口（状态封装在闭包内）
 */
export function createHistoryMenuView(deps: HistoryMenuViewDeps): HistoryMenuView {
  const { document, menuEl, tabRecent, tabArchived, archivedCountEl, searchInput, postMessage } =
    deps;

  /** 当前分组视图：recent=会话记录 / archived=留存区 */
  let sessionListView: 'recent' | 'archived' = 'recent';
  /** 当前搜索词（FD-3-A 元数据搜索）：空串 = 不过滤；只作用于当前分组的渲染 */
  let sessionSearchQuery = '';
  /** 最近一次下发的全量会话列表（切 tab 的前端过滤数据源；keyTopics/summary 为搜索匹配域） */
  let lastSessionList: SessionSummaryDto[] = [];
  /** 最近一次下发的留存区标记（**单一真源**：分组归属只认它） */
  let lastArchivedIds: string[] = [];
  /**
   * 会话归档模式**运行时**真值（回显源 = host 推送的 `chat_archive_mode`，初值 'full' = 内核缺省）。
   *
   * ⚠️ 不可改用持久偏好值：偏好保存后运行时可能顺延未生效，文案会在顺延窗口内说谎。
   */
  let currentArchiveMode: ArchiveMode = 'full';

  // ── 渲染（函数名零改名，自 chatView 平移）──

  /**
   * 渲染历史菜单（对 session_list_data 的应答）：复用 treedd 组件——
   * 条目为 .treedd__item（id=sessionId，点击走 initDropdowns 选择委托加载会话并收起）；
   * 内嵌动作（span，点击 stopPropagation 阻断选择委托，菜单保持展开）；
   * 空态为非 item 文本（委托不命中，纯展示）。
   */
  function renderHistoryMenu(sessions: SessionSummaryDto[], archivedIds: string[]): void {
    lastSessionList = sessions;
    lastArchivedIds = archivedIds;
    renderHistoryView(); // 按当前视图渲染新数据（视图重置不挂下发时机，见模块头 ②）
  }

  /** 切换分组并同步 tab 高亮（含 aria-selected），随后重渲染条目 */
  function setSessionListView(view: 'recent' | 'archived'): void {
    sessionListView = view;
    tabRecent.classList.toggle('is-active', view === 'recent');
    tabArchived.classList.toggle('is-active', view === 'archived');
    tabRecent.setAttribute('aria-selected', String(view === 'recent'));
    tabArchived.setAttribute('aria-selected', String(view === 'archived'));
    renderHistoryView();
  }

  /** FD-3-A 元数据匹配：标题 / 主题 / 摘要任一命中即匹配（大小写不敏感，空词恒真） */
  function matchesSessionSearch(s: SessionSummaryDto, q: string): boolean {
    if (!q) return true;
    const haystack = [s.title, s.summary ?? '', (s.keyTopics ?? []).join(' ')].join(' ');
    return haystack.toLowerCase().includes(q);
  }

  /** 渲染当前分组的条目（单容器，一次只渲染一组；搜索词在组内二次过滤）。
   *
   * **按日期分组（2026-10-17）**：条目在日期组头下按 sessionId 前缀归组——
   * 日期真源 = sessionId 前缀（契约锚定内核 `buildSessionId`/`splitSessionId`
   * 「YYYY-MM-DD-name」格式，与 `fmtRelativeTime` 末尾 `slice(0, 10)` 同款派生，
   * **不新加协议字段**——加了就是第二真相源，格式调整时必漂移）。
   * 组头是**非 `.treedd__item` 的纯展示元素**：dropdown 键盘导航取全部
   * `.treedd__item`，组头若长成 item 会让方向键跳到不可选中的组头。
   * 组间按 ISO 日期降序（字符串可比，与 updatedAt 降序同向：最新活跃的日期组在前），
   * 组内保持 updatedAt 降序（沿用下发顺序）。 */
  function renderHistoryView(): void {
    const archived = new Set(lastArchivedIds);
    const q = sessionSearchQuery.trim().toLowerCase();
    const visible = lastSessionList.filter((s) => {
      const inGroup =
        sessionListView === 'archived' ? archived.has(s.sessionId) : !archived.has(s.sessionId);
      return inGroup && matchesSessionSearch(s, q);
    });
    // 留存区计数（0 条时不显数字，避免「留存区 0」的噪音）
    archivedCountEl.textContent = lastArchivedIds.length > 0 ? ` ${lastArchivedIds.length}` : '';
    menuEl.textContent = '';
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-history__empty';
      // 搜索无匹配 ≠ 分组为空：两种空态语义不同，文案必须区分（否则搜不到会被误读成「分组是空的」）
      empty.textContent = q
        ? sessionListView === 'archived'
          ? `留存区中没有匹配「${sessionSearchQuery.trim()}」的会话`
          : `没有匹配「${sessionSearchQuery.trim()}」的会话`
        : sessionListView === 'archived'
          ? '留存区还是空的——把不想看的会话移进来，内容不会丢'
          : '暂无历史会话，新建会话后自动归档到此';
      menuEl.appendChild(empty);
      return;
    }
    // 按日期前缀分组（Map 保插入序，再按日期降序排组——ISO 日期字符串可直接比较）
    const byDay = new Map<string, typeof visible>();
    for (const s of visible) {
      const day = s.sessionId.slice(0, 10);
      const arr = byDay.get(day);
      if (arr) arr.push(s);
      else byDay.set(day, [s]);
    }
    for (const [day, items] of [...byDay].sort(([a], [b]) => b.localeCompare(a))) {
      const head = document.createElement('div');
      head.className = 'session-history__date-group';
      // 会话是多个 turn 的集合，「N 条会话」的「条」易误读为消息条数（行内「· N 条」才是消息数）
      // ⇒ 2026-10-18 真机反馈订正：日期头只计数不量词
      head.textContent = `${day} · ${items.length} 会话`;
      menuEl.appendChild(head);
      for (const s of items) {
        renderHistoryItem(s);
      }
    }
  }

  /** 渲染单条历史会话条目（treedd__item 富内容：标题 + 时间/计数 + 归档 + 删除） */
  function renderHistoryItem(s: SessionSummaryDto): void {
    const item = document.createElement('button');
    item.className = 'treedd__item';
    item.dataset.treeddId = s.sessionId; // treedd 选择委托据此回调 __historyOnSelect
    item.setAttribute('role', 'menuitem');
    // 悬停摘要（原生 title，与 keepBtn 同款惯例）：summary/keyTopics 已随列表下发
    // （FD-3-A 搜索域复用，零新协议），浏览态也可感知；截断防长摘要炸 tooltip
    const topics = (s.keyTopics ?? []).slice(0, 5).join(' · ');
    const brief = (s.summary ?? '').slice(0, 100) + ((s.summary ?? '').length > 100 ? '…' : '');
    const tip = [topics, brief].filter(Boolean).join('\n');
    if (tip) item.title = tip;
    const titleEl = document.createElement('span');
    titleEl.className = 'session-history__item-title';
    titleEl.textContent = s.title; // textContent 防注入
    const timeEl = document.createElement('span');
    timeEl.className = 'session-history__item-time';
    // 计数并槽（messageCount 缺省 = 旧会话未生成，只显示时间不显示 0）
    timeEl.textContent =
      typeof s.messageCount === 'number' && s.messageCount > 0
        ? `${fmtRelativeTime(s.updatedAt)} · ${s.messageCount} 条`
        : fmtRelativeTime(s.updatedAt);
    // 分组动作：会话记录 → 移入留存区；留存区 → 移回会话记录。
    // 两者都**不是删除**（数据一字不动），故图标与文案都不用删除类语言。
    // 用 span 而非 button：treedd__item 本身是 button，HTML 规范 button 内不可嵌套 button
    const keepBtn = document.createElement('span');
    keepBtn.className = 'session-history__item-keep';
    // 文案随归档模式：manual 模式下本按钮**兼做归档触发**（顺带生成会话摘要），
    // 文案必须说全两件事——只写「移入留存区」等于瞒报了一次 LLM 调用（本项目禁 UI 说谎）。
    // full 模式文案一字不动（自动归档已在离场时跑过；按钮纯留存）。
    keepBtn.title =
      sessionListView === 'archived'
        ? '移回会话记录'
        : currentArchiveMode === 'manual'
          ? '归档并留存：生成会话摘要并移入留存区（内容不丢，只是换个位置）'
          : '移入留存区（内容不丢，只是换个位置）';
    keepBtn.setAttribute('role', 'button');
    keepBtn.setAttribute('aria-label', keepBtn.title);
    keepBtn.innerHTML = getIconSvg(sessionListView === 'archived' ? 'restore' : 'archive', 14, 14);
    keepBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      postMessage({
        type: sessionListView === 'archived' ? 'restore_session' : 'archive_session',
        sessionId: s.sessionId,
      });
    });
    // 删除用 span 而非 button：同上（button 内不可嵌套 button）
    const delBtn = document.createElement('span');
    delBtn.className = 'session-history__item-del';
    delBtn.title = '删除会话';
    delBtn.setAttribute('role', 'button');
    delBtn.setAttribute('aria-label', '删除会话');
    delBtn.innerHTML = getIconSvg('trash', 14, 14);
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 阻断冒泡到 menu 的选择委托，仅触发删除（菜单保持展开可连续删）
      postMessage({ type: 'delete_session', sessionId: s.sessionId });
    });
    item.append(titleEl, timeEl, keepBtn, delBtn);
    menuEl.appendChild(item);
  }

  /** 相对时间（历史列表副标题，本地辅助；重复 3 次再提取 helper——规则豁免的已知态，台账在册） */
  function fmtRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff) || diff < 0) return '';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    return iso.slice(0, 10);
  }

  // ── 域内监听（挂专属元素；归属判据见方案 §2.2）──

  // 分组 tab 切换：**只用点击 + 原生 Enter/Space 激活**——
  // ⚠️ 不得依赖 Tab 键移动焦点：dropdown 把菜单内 Tab 处理为「收起菜单」，
  // 依赖它会导致切 tab 时浮层关闭。
  tabRecent.addEventListener('click', () => setSessionListView('recent'));
  tabArchived.addEventListener('click', () => setSessionListView('archived'));
  // FD-3-A 搜索：输入即过滤（纯前端，数据已在内存），作用于当前分组视图；
  // 数据下发（归档/移回后的刷新）不清词——用户常在搜索结果上连续操作
  searchInput.addEventListener('input', () => {
    sessionSearchQuery = searchInput.value;
    renderHistoryView();
  });

  // ── 窄接口 ──

  return {
    renderMenu: renderHistoryMenu,
    setArchiveMode(mode: ArchiveMode): void {
      currentArchiveMode = mode;
      // 已渲染则就地重渲染（按钮 title/aria 由归档模式派生，无数据时不重建空菜单）
      if (lastSessionList.length > 0) renderHistoryMenu(lastSessionList, lastArchivedIds);
    },
    openFresh(): void {
      // 视图重置挂「打开浮层」时机（新一轮浏览回默认分组），不挂数据下发——
      // 否则归档/移回后的列表刷新会把用户踢出当前分组（见模块头 ②）
      setSessionListView('recent');
      // 新一轮浏览同样清搜索词（与视图重置同批：都是「重新开始浏览」语义）
      sessionSearchQuery = '';
      searchInput.value = '';
      postMessage({ type: 'session_list' });
    },
  };
}
