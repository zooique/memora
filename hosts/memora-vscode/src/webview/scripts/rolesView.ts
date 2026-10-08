/**
 * rolesView — 角色子视图 webview 运行时脚本
 *
 * 由 settingsView.ts 挂载（设置视图选项卡合并后角色子视图）：以工厂函数 createRolesView
 * 接收依赖（vscode / window / root）并初始化全部交互，替代「字符串注入脚本」。
 *
 * 职责：
 *   - 渲染角色包卡片列表（激活徽章 + 定位描述 + 能力标签 chips）；
 *   - 「设为当前」→ postMessage roles_set_active（host 切换 + 持久化 + 重推）；
 *   - 监听 roles_loaded 渲染（host resolve 时推送 + 切换后重推）。
 *
 * 由 esbuild 以 browser/iife 打包进 dist/webview/scripts/settingsView.js（经 settingsViewMain
 * 入口），在 webview HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createEmptyState, createGroupTitle } from '../helpers/cardList.js';
import { createPager, PagerController } from './pager.js';
import { getIconSvg } from './icons.js';

/** 「其他角色」每页条数（分页组件；激活角色恒显不参与分页） */
const ROLE_PAGE_SIZE = 8;

/** 角色包卡片条目类型（roles_loaded packs 元素，分页组件泛型用） */
type RolePackItem = RolesPayload['packs'][number];

/** rolesView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface RolesViewDeps {
  /** webview 通信 API（SSOT：由 settingsView 统一 acquireVsCodeApi() 一次后注入，
   *  子视图不各自调用——acquireVsCodeApi 每个 webview 只能调用一次） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
  /** 子视图挂载根容器（设置视图选项卡合并后：查询限定在根内，多子视图 id 空间隔离） */
  root: HTMLElement;
}

/** 角色列表加载完成载荷（roles_loaded）的最小结构 */
interface RolesPayload {
  packs: {
    name: string;
    displayName: string;
    description?: string;
    /** 来源层：builtin=内置（configDir/role-packs），user=用户（globalStorageUri/role-packs） */
    source?: 'builtin' | 'user';
    capabilities: { capability: string; label: string }[];
    traits?: Record<string, number>;
    handoffPrompt?: string;
    strategyHint?: {
      toolReadonly?: 'readonly' | 'full';
      tempGroup?: 'high' | 'mid' | 'low';
      reasoningMode?: 'auto' | 'manual';
      summaryFocus?: string;
      outputLimit?: number;
    };
    interactionType?: 'tool_assistant' | 'companion';
    version?: string;
    /** 兜底契约包标记（BUILTIN_FALLBACK_PACK，宿主 UI 禁删） */
    isFallback?: boolean;
    /** manifest 校验问题（健康徽章，level+message 结构对齐 skills_loaded） */
    issues?: readonly { level: 'error' | 'warning'; message: string }[];
  }[];
  /**
   * 组（会议名单）：组长 + 组员（v0.13 S7）。受损组附加检测字段（读期派生，不落盘）：
   * leaderMissing=组长已卸载（遗留队伍）；missingMembers=已卸载组员名单（缺员标注）。
   */
  teams: {
    leader: string;
    members: string[];
    leaderMissing?: boolean;
    missingMembers?: string[];
  }[];
  activeName: string;
  /** 组员数量上限（内核常量 MAX_TEAM_MEMBERS，由宿主随 roles_loaded 下发；UI 侧禁止写死） */
  maxTeamMembers: number;
  /** 策略键面（内核 describeStrategyKeys 透传；缺省 = 旧载荷，编辑模式不可用） */
  keyface?: KeyFaceItem[];
}

/** 策略键面条目（内核 StrategyKeyFace 的结构镜像：webview 沙箱不直连内核，仅类型层对齐） */
interface KeyFaceItem {
  /** 所属策略阶段（prepare / act / reflect / global） */
  stage: string;
  /** 键名（camelCase） */
  key: string;
  /** UI 控件形态：enum=下拉 / number=数字框 / text=文本框 / multi=多选 */
  kind: 'enum' | 'number' | 'text' | 'multi';
  /** 枚举可选值（kind=enum 时存在） */
  values?: readonly string[];
  /** 多选可选值（kind=multi 时存在） */
  options?: readonly string[];
  /** 数值区间（kind=number；text 时为字符长度区间） */
  range?: { min: number; max: number };
}

/** 单键中文元数据（STRATEGY_KEY_META 值类型）：标签 + 悬停含义 + 可选值中文映射 */
export interface StrategyKeyMetaEntry {
  /** 中文名（格子标签） */
  label: string;
  /** 悬停含义（一句话：这个键管什么 + 留空行为） */
  tip: string;
  /** 枚举值中文映射（enum 键用；缺省显示原文） */
  valueLabels?: Record<string, string>;
  /** 多选选项中文映射（multi 键用；缺省显示原文） */
  optionLabels?: Record<string, string>;
  /** 控件形态覆盖（缺省按键面 kind 渲染）：selfReview 是布尔数字语义（0=关/正整数归一 1），用开关而非数字框呈现 */
  control?: 'switch';
}

/**
 * 策略键中文标签映射（键名 → 中文标签 + 悬停含义）。
 *
 * 为什么在 webview 而非内核：内核领域无关，不背中文文案（四层分工，方案 §2）。
 * 降级保护：内核新键宿主未配标签 → 格子照常出现（数据来自键面），标签/提示兜底显示键名原文。
 * 守卫：键面一致性测试双向锁定本映射键集 ↔ 内核 describeStrategyKeys() 键集，
 * 内核加键漏翻译 / 本表拼错键名都会红（防「键名拼错静默失败」，内核对未知键只 warning）。
 */
export const STRATEGY_KEY_META: Record<string, StrategyKeyMetaEntry> = {
  summaryFocus: {
    label: '提炼视角',
    tip: '告诉记忆摘要往哪个方向提炼（如 code、creative），最长 500 字符；留空用通用摘要',
  },
  toolMode: {
    label: '工具模式',
    tip: 'allow = 允许使用工具；block = 纯对话不执行任何工具',
    valueLabels: { allow: '允许工具', block: '禁止工具' },
  },
  temperature: {
    label: '生成温度',
    tip: '越高越有创意、越低越稳定（0.0~2.0）；留空用默认 0.7',
  },
  outputLimit: {
    label: '输出上限',
    tip: '单轮回答的最大 token 数；0 或留空 = 不干预（交给模型/服务商默认）',
  },
  toolStepLimit: {
    label: '工具步数上限',
    tip: '单轮最多执行多少步工具（0 = 不限制）；留空用默认',
  },
  providerRouting: {
    label: '模型路由',
    tip: 'auto = 按任务自动选模型；fixed = 固定当前模型',
    valueLabels: { auto: '自动路由', fixed: '固定模型' },
  },
  multiStepReasoning: {
    label: '多步推理',
    tip: 'auto = 复杂任务自动深入思考；manual = 快速直接回答',
    valueLabels: { auto: '自动推理', manual: '手动推理' },
  },
  toolReadonly: {
    label: '工具权限',
    tip: 'full = 完整读写；readonly = 仅只读操作（更安全）',
    valueLabels: { full: '完整权限', readonly: '只读模式' },
  },
  summary: {
    label: '记忆摘要',
    tip: 'on = 每轮对话后生成记忆摘要；off = 不生成',
    valueLabels: { on: '开启', off: '关闭' },
  },
  selfReview: {
    label: '完成自审',
    tip: '开启后回答完成前先自查一次再交付；关闭 = 不自查',
    control: 'switch',
  },
  userFollowup: {
    label: '追问策略',
    tip: 'ask = 任务说不清时主动反问；silent = 只等用户输入',
    valueLabels: { ask: '主动追问', silent: '静默等待' },
  },
  askOn: {
    label: '主动提问时机',
    tip: '允许角色向你提问的情形，可多选组合；全部不勾 = 不主动提问',
    optionLabels: {
      ambiguity: '任务有歧义时',
      decision: '要做决定时',
      missing_info: '信息不足时',
      confirm: '执行前确认',
    },
  },
  askLimit: {
    label: '提问次数上限',
    tip: '单轮回答最多主动提问几次（1~10）',
  },
  errorHandling: {
    label: '出错处理',
    tip: '工具/模型出错时怎么办：retry=重试，degrade=降级继续，stop=终止本轮',
    valueLabels: { retry: '重试', degrade: '降级继续', stop: '终止' },
  },
  contextLimit: {
    label: '上下文上限',
    tip: '角色自设的上下文规模（token），与模型窗口取小值；0 或留空 = 跟随模型窗口',
  },
  stepBudget: {
    label: '步数预算',
    tip: '这轮对话最多跑多少次「思考+用工具」（10~500）；0 或留空 = 用默认 50',
  },
};

/** 策略阶段中文标题（键面分组的组头；顺序 = 键面出现序） */
const STAGE_LABELS: Record<string, string> = {
  prepare: '回答前（Prepare）',
  act: '回答中（Act）',
  reflect: '回答后（Reflect）',
  global: '全局',
};

/** 详情值渲染：数组（askOn 多选）走选项中文映射，枚举走值中文映射，其余原样字符串化（对象 JSON 兜底） */
function formatDetailValue(meta: StrategyKeyMetaEntry | undefined, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => meta?.optionLabels?.[String(v)] ?? String(v)).join(' / ');
  }
  const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return meta?.valueLabels?.[s] ?? s;
}

/** 表单快照单元（收集 strategy 前的中间形态）：DOM 读取薄封装后的纯数据 */
export interface StrategyFormCell {
  /** 所属策略阶段 */
  stage: string;
  /** 键名 */
  key: string;
  /** 控件形态（switch = 布尔数字键的开关覆盖形态） */
  kind: 'enum' | 'number' | 'text' | 'multi' | 'switch';
  /** 控件原始值：enum/number/text=字符串（''=空格子）/ multi=勾选值数组 / switch=布尔 */
  raw: string | readonly string[] | boolean;
}

/**
 * 从表单快照收集 strategy 段（纯函数，保存链路可测）。
 *
 * 语义纪律（方案 §3）：
 *   - 空格子 = 不写入该键（保持「未声明」语义，不是写 0）；
 *   - 多选全不勾 = 不写入（空数组会被内核 isAskOn 判错，等价「未声明」）；
 *   - 开关未勾 = 不写入（selfReview 默认 0=关，未声明与 0 同语义，不固化 0）；
 *   - preserved：原文中键面未覆盖的键（内核新增键宿主未升级 / 未知键）原样并入，
 *     防止「整段替换 strategy」时静默丢数据（保真红线）。
 */
export function collectStrategyFromForm(
  cells: readonly StrategyFormCell[],
  preserved?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of cells) {
    let value: unknown;
    if (c.kind === 'multi') {
      const arr = [...(c.raw as readonly string[])];
      if (arr.length === 0) continue;
      value = arr;
    } else if (c.kind === 'switch') {
      if (c.raw !== true) continue;
      value = 1;
    } else {
      const s = (c.raw as string).trim();
      if (s === '') continue;
      if (c.kind === 'number') {
        // 输入框原文转数值；type=number 输入框坏值表现为 ''（上方已挡），此处再防 NaN
        const n = Number(s);
        if (!Number.isFinite(n)) continue;
        value = n;
      } else {
        value = s;
      }
    }
    (out[c.stage] ??= {})[c.key] = value;
  }
  // 键面未覆盖的原文键原样保留（透明保真，不静默丢弃）
  if (preserved) {
    for (const [stage, kv] of Object.entries(preserved)) {
      for (const [key, v] of Object.entries(kv)) {
        (out[stage] ??= {})[key] = v;
      }
    }
  }
  return out;
}

/**
 * 初始化角色管理面板 webview 交互
 *
 * @param deps 运行时依赖（vscode 通信实例 + window + root）
 */
export function createRolesView({ vscode, window, root }: RolesViewDeps): void {
  const document = window.document;
  // id 空间隔离：查询限定在 root 容器内（设置视图合并后与 config/memory 子视图共存，
  // 各自根内都有 #list/#statBar，不做根内查询会冲突）
  const list = root.querySelector('#list') as HTMLElement;
  const statBar = root.querySelector('#statBar') as HTMLElement;

  // 「打开用户角色包目录」入口（对齐技能目录入口）
  const openDirBtn = root.querySelector<HTMLButtonElement>('#btnOpenRolePacksDir');
  if (openDirBtn) {
    openDirBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'roles_open_dir' });
    });
  }

  // 「刷新角色包列表」入口（对齐技能刷新按钮）：请求 host 重扫用户角色包目录对账内存池，
  // host 完成后回发 notice（对账结果）+ roles_loaded（最新列表）
  const refreshBtn = root.querySelector<HTMLButtonElement>('#btnRefreshRolePacks');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'roles_refresh' });
    });
  }

  let activeName: string | undefined;
  /** 最近一次 roles_loaded 载荷（分页渲染需 teams 等上下文；每次 render 刷新） */
  let lastData: RolesPayload | null = null;
  /** 策略键面（roles_loaded 下发；编辑表单的唯一数据源，缺省 = 编辑不可用） */
  let keyface: KeyFaceItem[] = [];
  /** 当前详情弹窗数据（roles_detail_data 写入；弹窗重渲染共用） */
  let detail: {
    name: string;
    source: 'builtin' | 'user';
    strategy?: Record<string, Record<string, unknown>>;
  } | null = null;
  /** 当前打开的详情弹窗 overlay（编辑/查看模式切换时整弹窗重建；null = 未打开） */
  let detailOverlay: HTMLElement | null = null;
  /** 「其他角色」全量数组（分页组件前端切片数据源） */
  let othersAll: RolesPayload['packs'] = [];
  /** 「其他角色」整页容器（render 时创建，renderOthersPage 每次重建防翻页叠加） */
  let othersHost = document.createElement('div');
  /** 分页条插入锚点：footer-hint 之前（在卡片列表之后、页脚提示之前；不被 render 清空 list 影响） */
  const footerHint = root.querySelector('.footer-hint') as HTMLElement | null;

  /** 分页组件 renderPage 回调：渲染「其他角色」当前页卡片（分组标题 + 卡片；空数组跳过不残留）。
   *  容器 othersHost 每次整页重建（textContent='' ）——翻页不叠加旧页卡片。 */
  function renderOthersPage(items: readonly RolePackItem[]): void {
    othersHost.textContent = '';
    if (!items || items.length === 0) return;
    othersHost.appendChild(createGroupTitle(document, '其他角色'));
    items.forEach((p) => othersHost.appendChild(buildCard(p, lastData!)));
  }

  // 分页组件：「其他角色」全量前端分页；激活角色恒显不参与。单页自动隐藏。
  let pagerCtrl: PagerController<RolePackItem> | null = null;
  const pager = createPager<RolePackItem>({
    root,
    mountRoot: root,
    anchor: footerHint ?? undefined,
    pageSize: ROLE_PAGE_SIZE,
    renderPage: (items) => renderOthersPage(items),
    fetchPage: (page, pageSize) => {
      const start = (page - 1) * pageSize;
      pagerCtrl!.show(page, othersAll.slice(start, start + pageSize), othersAll.length);
    },
  });
  pagerCtrl = pager;

  /** 渲染角色包列表：激活角色置顶常显，其余角色分页展示（对齐 config 面板分组） */
  function render(data: RolesPayload): void {
    statBar.hidden = false;
    statBar.textContent = `已加载 ${data.packs?.length ?? 0} 个角色`;
    list.textContent = '';
    lastData = data;
    // 键面随载荷刷新（内核加键自动跟随；缺省保留旧值防瞬时载荷抖动清空）
    if (data.keyface) keyface = data.keyface;
    if (!data.packs || data.packs.length === 0) {
      // 空态引导：无角色包时提示（SSOT：createEmptyState 纯函数，对齐 configView 列表级同构）
      list.appendChild(
        createEmptyState(document, {
          title: '暂无角色包',
          hint: '请先打开一个工作区，或安装角色包后重新加载',
        }),
      );
      return;
    }
    activeName = data.activeName;
    // 遗留队伍置顶（异常可见性优先）：组长已卸载的组不会出现在任何角色卡片上
    // （组长卡片不存在），必须独立区块承载——标注 + 用户主动清理，宿主不静默删除
    const legacy = buildLegacyTeams(data);
    if (legacy) list.appendChild(legacy);
    // 激活角色置顶（主动可见：用户一眼看到当前定位）——恒显不参与分页
    const active = data.packs.filter((p) => p.name === activeName);
    if (active.length > 0) {
      list.appendChild(createGroupTitle(document, '当前角色'));
      active.forEach((p) => list.appendChild(buildCard(p, data)));
    }
    // 「其他角色」归口整页容器（renderOthersPage 重建，翻页不叠加）
    othersHost = document.createElement('div');
    othersHost.className = 'roles-others';
    list.appendChild(othersHost);
    // 全量交给分页组件切片渲染（数量大时避免全量堆叠）
    othersAll = data.packs.filter((p) => p.name !== activeName);
    pager.show(1, othersAll.slice(0, ROLE_PAGE_SIZE), othersAll.length);
  }

  /**
   * ② 遗留队伍区块（组长已卸载的组，检测视图置顶展示）。
   * 组长卡片不存在 → 该组无法经 buildTeamRibbon 呈现，独立区块标注「遗留」状态；
   * 「清理」按钮复用 roles_team_delete（用户主动触发，宿主不静默删用户数据）。
   * 无遗留组时不渲染（返回 null）。
   */
  function buildLegacyTeams(data: RolesPayload): HTMLElement | null {
    const legacyTeams = (data.teams ?? []).filter((t) => t.leaderMissing);
    if (legacyTeams.length === 0) return null;
    const block = document.createElement('div');
    block.className = 'legacy-teams';
    const title = document.createElement('div');
    title.className = 'legacy-teams-title';
    title.textContent = `遗留队伍（${legacyTeams.length}）`;
    title.title =
      '这些队伍的组长角色包已不存在（如内置包收紧、用户包被删除）。' +
      '队伍数据已保留，确认不需要后可清理。';
    block.appendChild(title);
    for (const t of legacyTeams) {
      const row = document.createElement('div');
      row.className = 'legacy-teams-row';
      const missing = new Set(t.missingMembers ?? []);
      // 组长名按包名原样展示（组长包已卸载，无 displayName 可查）
      const memberNames = t.members
        .map((m) => {
          const label = data.packs.find((x) => x.name === m)?.displayName ?? m;
          return missing.has(m) ? `${label}（已卸载）` : label;
        })
        .join(' / ');
      const label = document.createElement('span');
      label.className = 'legacy-teams-label';
      label.textContent = `组长「${t.leader}」已卸载 · 组员：${memberNames || '（无）'}`;
      const clean = document.createElement('button');
      clean.className = 'btn btn-danger legacy-teams-btn';
      clean.textContent = '清理';
      clean.title = '删除该遗留队伍（移除会议名单记录）';
      clean.addEventListener('click', () => {
        vscode.postMessage({ type: 'roles_team_delete', leader: t.leader });
      });
      row.appendChild(label);
      row.appendChild(clean);
      block.appendChild(row);
    }
    return block;
  }

  /**
   * ② 卡片级小组条（以角色包为单位组队）：卡片底部展示该角色包的队伍阵容 + 组队/编辑入口。
   * 缺省显示「暂无队伍」；组数据契约 { leader, members } 不变（复用 roles_team_save/delete）。
   */
  function buildTeamRibbon(p: RolesPayload['packs'][number], data: RolesPayload): HTMLElement {
    const ribbon = document.createElement('div');
    ribbon.className = 'team-ribbon';
    const label = document.createElement('span');
    label.className = 'team-ribbon-label';
    const leadTeam = data.teams?.find((t) => t.leader === p.name);
    if (leadTeam) {
      // 缺员标注（检测视图）：已卸载组员名后缀「（已卸载）」——保留原名单展示（不静默隐去），
      // 用户可「编辑队伍」保存即修复（弹窗仅列现存包，缺员项不勾选即剔除）
      const missing = new Set(leadTeam.missingMembers ?? []);
      const names = leadTeam.members
        .map((m) => {
          const label = data.packs.find((x) => x.name === m)?.displayName ?? m;
          return missing.has(m) ? `${label}（已卸载）` : label;
        })
        .join(' / ');
      label.textContent = `队伍：${names}`;
      // 超限/缺员组（存量/外部数据）：内核会议消费端先截断后过滤缺员（不回补），
      // 参会计数须与该口径一致，不虚报（名单原样展示，用户可自行删减/修复）。
      const truncated = leadTeam.members.slice(0, data.maxTeamMembers);
      const active = truncated.filter((m) => !missing.has(m)).length;
      label.title =
        leadTeam.members.length > data.maxTeamMembers
          ? `${active} 名组员参与小组会议（名单共 ${leadTeam.members.length} 名，超出上限的 ${leadTeam.members.length - data.maxTeamMembers} 名不参与）`
          : `${active} 名组员参与小组会议（表层装配发言）`;
    } else {
      label.textContent = '暂无队伍';
    }
    const action = document.createElement('button');
    action.className = 'btn btn-secondary team-ribbon-btn';
    action.textContent = leadTeam ? '编辑队伍' : '创建队伍';
    // 上限值统一取宿主下发的内核常量（两处文案口径对齐：队长 1 + 组员 ≤ maxTeamMembers）
    action.title = leadTeam
      ? `修改队伍组员（${data.maxTeamMembers + 1} 人组上限：队长 1 + 组员 ≤ ${data.maxTeamMembers}）`
      : `以当前角色为队长创建队伍（${data.maxTeamMembers + 1} 人组上限：队长 1 + 组员 ≤ ${data.maxTeamMembers}）`;
    action.addEventListener('click', () => launchTeamModal(p, data));
    ribbon.appendChild(label);
    ribbon.appendChild(action);
    return ribbon;
  }

  /**
   * ② 卡片组队弹窗（以卡片为单位）：电话本式勾选除当前队长外的所有角色
   * （最多 maxTeamMembers 名组员，上限值由宿主下发，本地不写死）。
   * 编辑既有队伍时回显已选组员；复用 roles_team_save 保存契约。
   * 默认保留「当前角色已是别队成员」的共享说明（内核当前无互斥限制，组员可复用）。
   */
  function launchTeamModal(p: RolesPayload['packs'][number], data: RolesPayload): void {
    const overlay = document.createElement('div');
    overlay.className = 'team-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'team-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `为「${p.displayName}」创建队伍`);

    const head = document.createElement('div');
    head.className = 'team-modal-head';
    const title = document.createElement('span');
    title.className = 'team-modal-title';
    title.textContent = `创建队伍 · 队长 ${p.displayName}`;
    const close = document.createElement('button');
    close.className = 'btn team-modal-close';
    close.innerHTML = getIconSvg('close', 12, 12);
    close.title = '关闭';
    close.addEventListener('click', () => overlay.remove());
    head.appendChild(title);
    head.appendChild(close);
    modal.appendChild(head);

    const current = data.teams?.find((t) => t.leader === p.name);
    const selected = new Set(current?.members ?? []);
    // 组员上限：内核常量 MAX_TEAM_MEMBERS 经宿主从 roles_loaded 下发（SSOT 单一来源，禁止本地字面量）
    const LIMIT = data.maxTeamMembers;

    const list = document.createElement('div');
    list.className = 'team-modal-list';
    const picks = data.packs.filter((x) => x.name !== p.name);
    for (const x of picks) {
      const item = document.createElement('label');
      item.className = 'team-modal-item' + (selected.has(x.name) ? ' checked' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = x.name;
      cb.checked = selected.has(x.name);
      const txt = document.createElement('span');
      txt.textContent = x.displayName + (x.isFallback ? '（兜底）' : '');
      item.appendChild(cb);
      item.appendChild(txt);
      // 已达 5 人上限（4 名组员）时禁止继续勾选；取消勾选始终允许
      cb.addEventListener('change', () => {
        if (cb.checked && list.querySelectorAll('input:checked').length > LIMIT) {
          cb.checked = false;
          return;
        }
        item.classList.toggle('checked', cb.checked);
      });
      // 整行点击切换（行为对齐 checkbox 语义，可访问性由原 checkbox 承担）
      item.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).tagName !== 'INPUT') cb.click();
      });
      list.appendChild(item);
    }
    modal.appendChild(list);

    // 反馈区：5 人上限提示（默认）+ 当前角色已是别队成员时的共享说明
    const hint = document.createElement('div');
    hint.className = 'team-modal-hint';
    const sharedLeader = data.teams?.find((t) => t.leader !== p.name && t.members.includes(p.name));
    hint.textContent = !sharedLeader
      ? `${LIMIT + 1} 人组上限：队长 1 + 组员 ≤ ${LIMIT}（勾选超过 ${LIMIT} 名自动拒绝）`
      : `当前角色已作为「${sharedLeader.leader}」的队伍成员参与会议；创建自己队伍后仍保留原参与。`;
    modal.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'team-modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = current ? '保存队伍' : '创建队伍';
    save.addEventListener('click', () => {
      const members = Array.from(list.querySelectorAll('input:checked')).map(
        (el) => (el as HTMLInputElement).value,
      );
      vscode.postMessage({ type: 'roles_team_save', leader: p.name, members });
      overlay.remove();
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    // ② 编辑态删除队伍：仅当已有队伍时提供（解散队伍 = 移除会议名单，不影响角色日常）
    if (current) {
      const del = document.createElement('button');
      del.className = 'btn btn-danger team-modal-del';
      del.textContent = '删除队伍';
      del.title = '解散该队伍（移除会议名单，不影响任何角色日常使用）';
      del.addEventListener('click', () => {
        vscode.postMessage({ type: 'roles_team_delete', leader: p.name });
        overlay.remove();
      });
      actions.appendChild(del);
    }
    modal.appendChild(actions);

    // 点击遮罩空白处关闭
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) overlay.remove();
    });
    overlay.appendChild(modal);
    // 挂载到注入 root（id 空间隔离约定：不用 document.getElementById 全局查找，
    // 与 createRolesView 收受依赖的 root 一致——测试/多实例下 root 可能非 #roles-root）
    root.appendChild(overlay);
  }

  // ════════════════ 角色配置详情弹窗（RP-EDIT-1：键面查看与编辑）════════════════
  //
  // 数据流（方案 §2）：点卡片 → roles_detail → 宿主读 manifest 原文回发 roles_detail_data
  // → 查看模式（有啥渲染啥：声明键才出现 = 走默认，不是留空）→ 编辑模式（全键格子表单，
  // 键面驱动）→ roles_save 交宿主校验写回。内置包弹只读提示（真拒绝在宿主 extension 侧）。

  /**
   * 详情弹窗骨架（复用 team-modal 弹窗 token）：head（标题+关闭）+ body + actions。
   * 查看/编辑模式切换 = 整弹窗重建（detailOverlay 先摘后挂，防叠加）。
   */
  function mountDetailModal(body: HTMLElement, actions: HTMLElement[]): void {
    if (!detail) return;
    detailOverlay?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'team-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'team-modal role-detail';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const pack = lastData?.packs.find((p) => p.name === detail!.name);
    const title = document.createElement('span');
    title.className = 'team-modal-title';
    title.textContent = `角色配置 · ${pack?.displayName ?? detail.name}`;
    const close = document.createElement('button');
    close.className = 'btn team-modal-close';
    close.innerHTML = getIconSvg('close', 12, 12);
    close.title = '关闭';
    close.addEventListener('click', () => {
      detailOverlay = null;
      overlay.remove();
    });
    const head = document.createElement('div');
    head.className = 'team-modal-head';
    head.appendChild(title);
    head.appendChild(close);
    modal.appendChild(head);
    modal.appendChild(body);
    const actionRow = document.createElement('div');
    actionRow.className = 'team-modal-actions';
    for (const b of actions) actionRow.appendChild(b);
    modal.appendChild(actionRow);
    // 点击遮罩空白处关闭
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) {
        detailOverlay = null;
        overlay.remove();
      }
    });
    overlay.appendChild(modal);
    root.appendChild(overlay);
    detailOverlay = overlay;
  }

  /** 以当前 detail 重挂弹窗（查看态）：声明键渲染 + 内置只读提示 / 用户包编辑入口 */
  function renderDetailView(): void {
    if (!detail) return;
    const body = document.createElement('div');
    body.className = 'role-detail-body';
    const declared = detail.strategy ?? {};
    const stageNames = Object.keys(declared).filter(
      (s) => Object.keys(declared[s] ?? {}).length > 0,
    );
    if (stageNames.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'team-modal-hint';
      empty.textContent = '该角色未自定义任何策略键，全部走默认行为。';
      body.appendChild(empty);
    }
    for (const stage of stageNames) {
      const stageHead = document.createElement('div');
      stageHead.className = 'role-detail-stage';
      stageHead.textContent = STAGE_LABELS[stage] ?? stage;
      body.appendChild(stageHead);
      for (const [key, value] of Object.entries(declared[stage] ?? {})) {
        const meta = STRATEGY_KEY_META[key];
        const row = document.createElement('div');
        row.className = 'role-detail-row';
        // 悬停含义：meta.tip 优先；未知键兜底显示键名原文（降级安全，方案 §2）
        row.title = meta?.tip ?? `未识别的策略键：${key}`;
        const label = document.createElement('span');
        label.className = 'role-detail-label';
        label.textContent = meta?.label ?? key;
        const val = document.createElement('span');
        val.className = 'role-detail-value';
        val.textContent = formatDetailValue(meta, value);
        row.appendChild(label);
        row.appendChild(val);
        body.appendChild(row);
      }
    }
    const actions: HTMLElement[] = [];
    if (detail.source === 'user') {
      const edit = document.createElement('button');
      edit.className = 'btn btn-primary';
      edit.textContent = '编辑配置';
      edit.title = '打开全键表单（留空 = 走默认值；悬停键名查看含义）';
      edit.addEventListener('click', () => openDetailEditor());
      actions.push(edit);
    } else {
      // 内置包：只读呈现 + 指路（真拒绝在宿主 extension 侧，直接发 roles_save 也被拒）
      const hint = document.createElement('span');
      hint.className = 'team-modal-hint role-detail-readonly-hint';
      hint.textContent = '内置角色包为只读展示；复制到用户角色包目录后可编辑';
      actions.push(hint);
    }
    mountDetailModal(body, actions);
  }

  /**
   * 单键表单行：按键面 kind 构建控件（meta.control='switch' 覆盖为开关）+ 登记读取器。
   * 初值只读 manifest 原文（调用方传入），禁读装配值（防默认值固化，红线 1）。
   */
  function buildFormRow(
    face: KeyFaceItem,
    meta: StrategyKeyMetaEntry | undefined,
    initial: unknown,
    refs: { cell: StrategyFormCell; read: () => string | readonly string[] | boolean }[],
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'role-detail-form-row';
    const kind = meta?.control === 'switch' ? 'switch' : face.kind;
    const label = document.createElement('label');
    label.className = 'role-detail-label';
    label.textContent = meta?.label ?? face.key;
    // 悬停含义：中文 tip；数值键追加合法范围（来自键面 range，与内核同源）
    const rangeSuffix =
      face.range && kind === 'number' ? `（合法范围 ${face.range.min}–${face.range.max}）` : '';
    label.title = (meta?.tip ?? `未识别的策略键：${face.key}`) + rangeSuffix;
    row.appendChild(label);

    if (kind === 'enum') {
      const sel = document.createElement('select');
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '留空（用默认）';
      sel.appendChild(emptyOpt);
      for (const v of face.values ?? []) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = meta?.valueLabels?.[v] ?? v;
        sel.appendChild(opt);
      }
      sel.value = initial === undefined || initial === null ? '' : String(initial);
      // 原文越界值不在枚举内 → 追加展示原文选项，防「回填即改值」（保真）
      if (sel.value === '' && initial !== undefined && initial !== null) {
        const rawOpt = document.createElement('option');
        rawOpt.value = String(initial);
        rawOpt.textContent = `${String(initial)}（原文值）`;
        sel.appendChild(rawOpt);
        sel.value = String(initial);
      }
      refs.push({
        cell: { stage: face.stage, key: face.key, kind: 'enum', raw: '' },
        read: () => sel.value,
      });
      row.appendChild(sel);
      return row;
    }
    if (kind === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      // 区间属性来自键面（内核 describeStrategyKeys 折算过 0 哨兵），UI 不另写死
      if (face.range) {
        input.min = String(face.range.min);
        input.max = String(face.range.max);
        input.step = face.key === 'temperature' ? '0.1' : '1';
      }
      input.placeholder = '留空 = 用默认值';
      input.title = (meta?.tip ?? '') + rangeSuffix;
      if (typeof initial === 'number') input.value = String(initial);
      refs.push({
        cell: { stage: face.stage, key: face.key, kind: 'number', raw: '' },
        read: () => input.value,
      });
      row.appendChild(input);
      return row;
    }
    if (kind === 'multi') {
      const wrap = document.createElement('div');
      wrap.className = 'role-detail-multi';
      // askOn 初值兼容两种形态：单枚举字符串或组合数组（isAskOn 双形态）
      const selected = new Set(
        Array.isArray(initial)
          ? initial.map(String)
          : typeof initial === 'string' && initial !== ''
            ? [initial]
            : [],
      );
      for (const opt of face.options ?? []) {
        const item = document.createElement('label');
        item.className = 'role-detail-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt;
        cb.checked = selected.has(opt);
        const txt = document.createElement('span');
        txt.textContent = meta?.optionLabels?.[opt] ?? opt;
        item.appendChild(cb);
        item.appendChild(txt);
        wrap.appendChild(item);
      }
      refs.push({
        cell: { stage: face.stage, key: face.key, kind: 'multi', raw: [] },
        read: () =>
          Array.from(wrap.querySelectorAll('input:checked')).map(
            (el) => (el as HTMLInputElement).value,
          ),
      });
      row.appendChild(wrap);
      return row;
    }
    // switch（selfReview 布尔数字语义）：勾选 = 写 1；未勾 = 不写入（默认 0=关，同语义不固化 0）。
    // 原文正整数（3、5…）内核归一为 1，回显按开处理，保存后归一落盘。
    const toggle = document.createElement('label');
    toggle.className = 'role-detail-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = typeof initial === 'number' && initial > 0;
    const txt = document.createElement('span');
    txt.textContent = '开启';
    toggle.appendChild(cb);
    toggle.appendChild(txt);
    refs.push({
      cell: { stage: face.stage, key: face.key, kind: 'switch', raw: false },
      read: () => cb.checked,
    });
    row.appendChild(toggle);
    return row;
  }

  /** 编辑模式：全键格子表单（键面驱动，宿主零清单）；键面未覆盖的原文键保存时原样并入 */
  function openDetailEditor(): void {
    if (!detail) return;
    // 键面未下发（旧载荷/时序未到）→ 编辑不可用，不给假表单（静默失败防线）
    if (keyface.length === 0) return;
    const refs: { cell: StrategyFormCell; read: () => string | readonly string[] | boolean }[] = [];
    const body = document.createElement('div');
    body.className = 'role-detail-body';
    // 键面未覆盖的原文键（内核新键宿主未升级 / 未知键）→ preserved，保存时原样并入（透明保真）
    const preserved: Record<string, Record<string, unknown>> = {};
    for (const [stage, kv] of Object.entries(detail.strategy ?? {})) {
      for (const [key, v] of Object.entries(kv)) {
        if (!keyface.some((f) => f.stage === stage && f.key === key)) {
          (preserved[stage] ??= {})[key] = v;
        }
      }
    }
    // 按键面阶段顺序分组渲染（阶段序 = 内核 STRATEGY_KEY_RULES 序）
    const stages = [...new Set(keyface.map((f) => f.stage))];
    for (const stage of stages) {
      const stageHead = document.createElement('div');
      stageHead.className = 'role-detail-stage';
      stageHead.textContent = STAGE_LABELS[stage] ?? stage;
      body.appendChild(stageHead);
      for (const face of keyface.filter((f) => f.stage === stage)) {
        const initial = detail.strategy?.[stage]?.[face.key];
        body.appendChild(buildFormRow(face, STRATEGY_KEY_META[face.key], initial, refs));
      }
    }
    const hint = document.createElement('div');
    hint.className = 'team-modal-hint';
    hint.textContent = '留空的键不写入（= 走默认值）；悬停键名查看含义。';
    body.appendChild(hint);
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = '保存';
    save.title = '校验通过后写回 manifest 原文（仅替换 strategy 段，其余字段原样保留）';
    save.addEventListener('click', () => {
      // 收集：DOM 读取薄封装 → 纯函数收集（空格子不写入）；弹窗保持打开——
      // 成功 → 宿主回发 roles_detail_data 切回查看态；失败 → notice 留在编辑态
      const cells = refs.map(({ cell, read }) => ({ ...cell, raw: read() }));
      const strategy = collectStrategyFromForm(cells, preserved);
      vscode.postMessage({ type: 'roles_save', name: detail!.name, strategy });
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = '取消';
    cancel.title = '放弃修改，回到查看模式（不写盘）';
    cancel.addEventListener('click', () => renderDetailView());
    mountDetailModal(body, [save, cancel]);
  }

  /**
   * 构建单个角色包卡片（紧凑堆叠布局）
   *
   * 布局结构（三层分类法）：
   *   - 顶部标题行（一级直面）：图标 + 名称 + 当前/兜底标签 + 操作按钮
   *   - 中部信息区（次级信息）：描述 + 能力标签 + 策略指示器 + 组员标注
   *   - 卡片级小组条（二级信息）：队伍阵容 + 创建/编辑队伍入口
   *   - 底部折叠区（专家挖掘）：性格特征 + 版本号
   */
  function buildCard(p: RolesPayload['packs'][number], data: RolesPayload): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card' + (p.name === activeName ? ' active' : '');

    // ===== 顶部标题行（一级直面）=====
    const header = document.createElement('div');
    header.className = 'card-header';

    // 卡片图标：角色显示名首字（紧凑尺寸 24x24）
    const icon = document.createElement('div');
    icon.className = 'role-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = p.displayName.charAt(0);
    header.appendChild(icon);

    // 角色名 + 当前标签
    const nameEl = document.createElement('span');
    nameEl.className = 'card-name';
    nameEl.textContent = p.displayName;
    header.appendChild(nameEl);

    // 来源徽章（对齐技能层徽章）：用户角色包标「用户」，内置角色包不标（内置为默认）
    if (p.source === 'user') {
      const srcBadge = document.createElement('span');
      srcBadge.className = 'badge badge-source-user';
      srcBadge.textContent = '用户';
      srcBadge.title = '用户自建角色包：位于用户角色包目录，可编辑';
      header.appendChild(srcBadge);
    }

    if (p.name === activeName) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '当前';
      header.appendChild(badge);
    }
    // 兜底标记已合并至下方策略区的「系统兜底」chip（避免重复）

    // 操作按钮（右侧，margin-left: auto）
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    // 「带入对话」：所有角色均可一键切换并跳转到对话
    const handoffBtn = document.createElement('button');
    handoffBtn.className = 'btn btn-primary';
    handoffBtn.textContent = '带入对话';
    handoffBtn.title =
      '切换角色并跳到对话视图：已在输入框预填一句过渡语（不自动发送，可编辑后再发）';
    handoffBtn.addEventListener('click', () =>
      vscode.postMessage({ type: 'roles_handoff', name: p.name }),
    );
    actions.appendChild(handoffBtn);

    // 「设为当前」：仅非激活角色展示
    if (p.name !== activeName) {
      const actBtn = document.createElement('button');
      actBtn.className = 'btn btn-secondary';
      actBtn.textContent = '设为当前';
      actBtn.title = '仅切换默认角色，停留在设置页（不跳转到对话）';
      actBtn.addEventListener('click', () =>
        vscode.postMessage({ type: 'roles_set_active', name: p.name }),
      );
      actions.appendChild(actBtn);
    }
    header.appendChild(actions);
    card.appendChild(header);

    // ===== 中部信息区（次级信息）=====
    const info = document.createElement('div');
    info.className = 'card-info';

    // 定位描述（manifest.description，可选，2 行截断）
    if (p.description) {
      const desc = document.createElement('div');
      desc.className = 'card-detail';
      desc.textContent = p.description;
      info.appendChild(desc);
    }

    // 能力标签 chips（紧凑单行）
    if (p.capabilities && p.capabilities.length > 0) {
      const caps = document.createElement('div');
      caps.className = 'cap-chips';
      p.capabilities.forEach((c) => {
        const chip = document.createElement('span');
        chip.className = 'cap-chip';
        chip.textContent = c.label;
        chip.title = c.capability;
        caps.appendChild(chip);
      });
      info.appendChild(caps);
    }

    // 策略指示器 + 兜底定位（紧凑单行）：完整工具/自动执行/平衡等策略 chips + 「系统兜底」chip（isFallback）
    if (p.strategyHint || p.isFallback) {
      const strategy = document.createElement('div');
      strategy.className = 'role-strategy';
      const hint = p.strategyHint;

      if (hint?.toolReadonly) {
        const chip = document.createElement('span');
        chip.className =
          'strategy-chip ' + (hint.toolReadonly === 'readonly' ? 'readonly' : 'full');
        chip.textContent = hint.toolReadonly === 'readonly' ? '只读模式' : '完整工具';
        strategy.appendChild(chip);
      }
      if (hint?.tempGroup) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip temp-' + hint.tempGroup;
        const tempLabel = { high: '高创意', mid: '平衡', low: '低温度' };
        chip.textContent = tempLabel[hint.tempGroup] ?? hint.tempGroup;
        strategy.appendChild(chip);
      }
      if (hint?.reasoningMode) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip reasoning-' + hint.reasoningMode;
        chip.textContent = hint.reasoningMode === 'auto' ? '自动推理' : '手动推理';
        strategy.appendChild(chip);
      }
      if (hint?.summaryFocus) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip';
        chip.textContent = `聚焦: ${hint.summaryFocus}`;
        strategy.appendChild(chip);
      }
      if (hint?.outputLimit && hint.outputLimit > 0) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip output-limit';
        chip.textContent = `输出上限: ${hint.outputLimit}k`;
        strategy.appendChild(chip);
      }
      // 兜底契约包定位（能力标签区）：以 chip 呈现系统兜底，
      // 替代描述区的长开发说明（manifest.description 已精简，机制说明移入 title）
      if (p.isFallback) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip fallback';
        chip.textContent = '系统兜底';
        chip.title =
          '内核兜底契约包（BUILTIN_FALLBACK_PACK）：领域无关通用助手，名字锁定、系统内置不可删除、构建期校验';
        strategy.appendChild(chip);
      }

      if (strategy.children.length > 0) {
        info.appendChild(strategy);
      }
    }

    card.appendChild(info);

    // ② 卡片级小组条（队伍状态 + 组队入口；组长侧队伍展示，组员侧不感知被引用）
    card.appendChild(buildTeamRibbon(p, data));

    // ===== 健康区（manifest 校验问题，镜像技能徽章模式）=====
    // error=不可装载/特性缺失（红徽章）；warning=可装载但提示（黄徽章）；问题列表默认折叠展开
    if (p.issues && p.issues.length > 0) {
      const hasError = p.issues.some((i) => i.level === 'error');
      const hasWarn = p.issues.some((i) => i.level === 'warning');
      const health = document.createElement('div');
      health.className = 'role-health';
      const badge = document.createElement('span');
      badge.className = `role-health-badge ${hasError ? 'health-error' : hasWarn ? 'health-warn' : ''}`;
      badge.textContent = hasError ? '配置异常' : '可优化';
      health.appendChild(badge);
      const list = document.createElement('ul');
      list.className = 'role-problems';
      p.issues.forEach((i) => {
        const li = document.createElement('li');
        li.className = `prob-${i.level}`;
        li.textContent = i.message;
        list.appendChild(li);
      });
      health.appendChild(list);
      card.appendChild(health);
    }

    // ===== 底部折叠区（专家挖掘）=====
    const hasTraits = p.traits && Object.keys(p.traits).length > 0;
    const hasVersion = !!p.version;

    if (hasTraits || hasVersion) {
      const details = document.createElement('details');
      details.className = 'card-details';

      const summary = document.createElement('summary');
      summary.textContent = '详情';
      details.appendChild(summary);

      const content = document.createElement('div');
      content.className = 'details-content';

      // 性格特征 (Traits)
      if (hasTraits) {
        const traits = document.createElement('div');
        traits.className = 'role-traits';
        const labelMap: Record<string, string> = {
          precision: '精准',
          creativity: '创意',
          rigor: '严谨',
          empathy: '共情',
          speed: '速度',
        };
        Object.entries(p.traits!).forEach(([key, value]) => {
          const trait = document.createElement('div');
          trait.className = 'trait';
          const label = document.createElement('span');
          label.className = 'trait-label';
          label.textContent = labelMap[key] ?? key;
          const bar = document.createElement('div');
          bar.className = 'trait-bar';
          const fill = document.createElement('div');
          fill.className = 'trait-fill';
          fill.style.width = `${Math.round(value * 100)}%`;
          fill.title = `${label.textContent}: ${value.toFixed(2)}`;
          bar.appendChild(fill);
          trait.appendChild(label);
          trait.appendChild(bar);
          traits.appendChild(trait);
        });
        content.appendChild(traits);
      }

      // 版本号
      if (hasVersion) {
        const ver = document.createElement('div');
        ver.className = 'card-version';
        ver.textContent = `v${p.version}`;
        content.appendChild(ver);
      }

      details.appendChild(content);
      card.appendChild(details);
    }

    // 点击卡片空白区打开配置详情（RP-EDIT-1）：按钮/输入/折叠区等交互元素除外（交给各自行为）
    card.classList.add('roles-card-clickable');
    card.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('button, input, select, textarea, label, a, summary')) return;
      vscode.postMessage({ type: 'roles_detail', name: p.name });
    });

    return card;
  }

  // 消息接收：roles_loaded 渲染列表 + roles_detail_data 驱动详情弹窗
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'roles_loaded') render(msg);
    // 详情数据：更新 detail 后无条件重挂弹窗——roles_detail_data 只有两个发送点：
    // ① roles_detail 应答（用户点卡片，此时弹窗未开 → 首挂查看态）；
    // ② roles_save 成功回发（弹窗必然开着 → 先摘后挂回显新原文）。
    // mountDetailModal 幂等（detailOverlay?.remove()），两场景同函数通吃；
    // 若判「弹窗已开才重挂」，场景①永远不弹（详情/编辑功能整体不可达）。
    if (msg.type === 'roles_detail_data') {
      detail = { name: msg.name, source: msg.source, strategy: msg.strategy };
      renderDetailView();
    }
  });
}
