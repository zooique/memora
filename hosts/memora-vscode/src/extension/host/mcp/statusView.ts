/**
 * statusView — MCP 状态观察面的**派生**（配置 + 运行态 → 面板 DTO）
 *
 * 为什么独立成文件（与 failureLedger / mcpConfigGuard 同款理由）：runtime 贴 eslint
 * max-lines 上限（1000，只降不升），而观察面还要随状态位继续长；把纯派生搬出来既能
 * 给 runtime 让出余量，也让「配置 + 运行态 → DTO」这件事可以脱离模块单例单独测。
 *
 * **判据仍然只有一份**：runtime 的 `getMcpServerStatus` 只是把模块级单例喂进来的薄包装，
 * 真正的筛选/归并逻辑全在本文件的 {@link deriveMcpServerStatus}。
 */
import type { McpServerConfig } from './connectionManager.js';
import { configProblem, normalizeServerName, resolveTransportMode } from './mcpConfigGuard.js';
import { allowlistKey, serverAllowlistKey, type McpToolAllowlist } from './policy.js';
import type { McpToolBinding } from './toolRegistry.js';
// 五态词汇与隐藏计数的 DTO 真源在 shared/protocol（面板与宿主共用，禁各写一份字面量）
import type { McpOmittedDto, McpServerState, McpTransport } from '../../../shared/protocol.js';

/**
 * 单个 MCP 工具的可观测状态（设置面板 MCP 选项卡的数据面）
 *
 * **`allowKey` 由调用 `policy.allowlistKey` 现算下发，UI 侧不得自行拼字符串**：键格式的
 * 真源只有一处（server 原名 + 工具原名），历史上「按模型列表里的显示名写 allowlist」是会
 * **静默失效**的坑——面板把它做成点选，就是为了让用户不再需要知道这个键长什么样。
 */
export interface McpToolStatus {
  /** server 侧原始工具名（调用时回传的名字，也是 allowlist 寻址的一半） */
  readonly originalName: string;
  /** 注册进内核的派生名（模型列表里那个；与原名对比展示，解释「为什么两处不一样」） */
  readonly derivedName: string;
  /** 免确认寻址键（可直接写进 `memora.mcpToolAllowlist`） */
  readonly allowKey: string;
  /**
   * 当前是否已免确认（**生效态**，= 工具级键 ∪ server 级键命中）
   *
   * ⚠️ 这是"实际会不会弹窗"的派生事实，不是"这条键有没有被勾上"的存储事实：
   * 整台免确认（server 级键）打开时，未单独勾选的工具**实际已免确认**，此处必须
   * 报 true——报 false 就是 UI 说谎（显示未勾、实则不弹）。面板据此把单工具勾
   * 置为「已勾 + 禁用」，取消路径只有一个：关掉整台勾（避免"点了没反应"）。
   */
  readonly allowlisted: boolean;
}

/** 一台 server 的可观测状态 */
export interface McpServerStatus {
  /** server 名（配置里的 name） */
  readonly name: string;
  /** 配置里的可执行命令（远程配置没有命令 ⇒ 缺省） */
  readonly command?: string;
  /** 传输形态（只在远程时下发；缺省 stdio 不下发，面板据此判断是否显示「远程」标记） */
  readonly transport?: McpTransport;
  /** 远程服务器地址（只在 transport=http 时下发，用于卡片副标题） */
  readonly url?: string;
  /** 配置里的命令参数（表单回显用；缺失 = 无参数） */
  readonly args?: string[];
  /** 配置里的环境变量（表单回显用；**列表不展示**，只在编辑表单里出现） */
  readonly env?: Record<string, string>;
  /** 配置里的工作目录 */
  readonly cwd?: string;
  /** 连接状态（五态语义见 shared/protocol 的 McpServerState） */
  readonly state: McpServerState;
  /** 配置启用位（缺省 true）；与 state 正交 */
  readonly enabled: boolean;
  /** 已注册工具数（非 running 态恒 0） */
  readonly toolCount: number;
  /**
   * 整台免确认的寻址键（`mcp__<server>__*`，由 `policy.serverAllowlistKey` 现算下发）
   *
   * 与工具级 `allowKey` 同理：**UI 不得自行拼这个字符串**（键格式真源只有一处）。
   */
  readonly serverAllowKey: string;
  /** 整台是否已免确认（server 级键命中；true ⇒ 该台全部工具生效态为免确认） */
  readonly serverAllowlisted: boolean;
  /** 工具明细（顺序 = 注册顺序） */
  readonly tools: readonly McpToolStatus[];
  /** state='failed' 的失败原因 */
  readonly error?: string;
  /** state='invalid' 缺什么（判据 = 本文件的 configProblem） */
  readonly problem?: string;
}

/**
 * 状态观察面的一次快照（列表 + 被隐藏条目的计数）
 *
 * 两者必须同源返回：`servers` 的筛选规则就是 `omitted` 的计数规则，拆成两次调用 =
 * 两份判据（见 {@link deriveMcpServerStatus} 的不变量）。
 */
export interface McpStatusSnapshot {
  /** 可寻址 server 的状态（顺序 = 配置顺序） */
  readonly servers: McpServerStatus[];
  /** 配置里存在、但列表渲染不出来的条目（缺 name / 重名） */
  readonly omitted: McpOmittedDto;
}

/**
 * 读取 MCP 服务器状态（**列表基线 = 配置；状态 = 运行态 ∪ 失败表**）
 *
 * 两个真源分工（混用必错，本页两版各错一次）：
 *   - **有哪些** ⇒ 调用方传入的**当前配置**（`readMcpServers()` 原值）。只按运行态出列表
 *     会漏掉「配了但还没装配」的台：设置面板先于对话面板打开时 Agent 尚未装配，面板会
 *     显示「还没有配置任何服务器」，用户添加一台、拿到「已添加」回执，卡片**仍不出现**
 *     ——点完没反应的第二种成因（第一种是死按钮）。
 *   - **怎么样** ⇒ 运行态（running）∪ 失败表（failed）。「已进 applied 但不在运行」= failed；
 *     「配置在、该名还没进 applied（装配/热更都没跑到它）」= pending（不谎报失败，也不是「停用」——用户没这意图）。
 *
 * 只看 `running` 的另一个反例：失败的那台会整条消失，而那恰好是用户最需要看见的一条
 * （「为什么模型没有 MCP 工具」的答案就在那里）。
 *
 * 顺序 = 配置顺序（用户写的顺序就是列表顺序，不按 map 迭代序漂移）。重名按**先到先得**
 * 只保留第一条（与 indexValidConfigs 的启动语义一致）；**缺 name 的条目无寻址键，不入列表**
 * （启动侧会告警跳过，面板指路 settings.json）。
 *
 * ⚠️ 归一化后再比名（`"fs"` 与 `"fs "` 算重名）：重名后者的真实形态是**整条不出现**，
 * 不是「显示成某个态」——两者归一化后同名，被下面的 `seen` 去重掉，启动侧也按同一规则
 * 跳过。所以 `state === 'failed'` 的兜底文案不许再写「可能被重名规则跳过」：那是到不了的
 * 假设，把用户指向一个不存在的原因（2026-10-24 实测：该分支只在「进过装配但既无运行态
 * 也无失败记录」时触发，而 `startOneServer` 失败恒写失败表）。
 *
 * **为什么返回值带 `omitted` 而不是只给数组**（2026-10-24）：上面两条「不入列表」的规则会让
 * 配置条目数 > 卡片数，而面板原先无从知晓 ⇒ 「配置 2 条、显示 1 条」与「配置 1 条」渲染
 * 完全一致。计数**必须与本循环同源**：另写一个 `countOmitted()` 就是第二份 skip 判据，
 * 迟早出现「卡片 1 + 隐藏 1 ≠ 配置 2」。不变量（本函数保证，测试断言）：
 * `servers.length + omitted.missingName + omitted.duplicate === omitted.configured`。
 *
 * @returns 每台可寻址 server 的状态 + 被隐藏条目的计数（配置为空 = 空数组 + 全 0 = 合法空态）
 */
/** 派生所需的运行态上下文（由 runtime 注入；本模块不认识模块级单例，故以参数传入） */
export interface McpStatusContext {
  /** 运行态集合（键 = 归一化 server 名；null = 运行时未启动） */
  readonly running: ReadonlyMap<
    string,
    { bindings: readonly McpToolBinding[]; allowKeys: McpToolAllowlist }
  > | null;
  /** 最近一次**应用**的配置原值（判「该名进过 applied」；空数组 = 一次都没应用过） */
  readonly applied: readonly McpServerConfig[];
  /** 失败表查询（server 名已归一化；无记录 = undefined） */
  readonly failureOf: (name: string) => { readonly error: string } | undefined;
}

/**
 * 派生 MCP 服务器状态快照（纯函数：入参 = 配置 + 运行态上下文）
 *
 * 与运行时的关系：runtime 只负责把模块级单例（running / appliedConfigs / failureOf）
 * 喂进来——**绑定点只有一处**，判据全在这里（拆文件是为了 max-lines，不是为了分家）。
 *
 * @param configured 当前用户配置原值
 * @param ctx 运行态上下文
 * @returns 可见列表 + 被隐藏条目计数
 */
export function deriveMcpServerStatus(
  configured: readonly McpServerConfig[],
  ctx: McpStatusContext,
): McpStatusSnapshot {
  // 「进过装配」的判据：最近一次应用的配置（start / 热更 / restart 写入）
  const applied = new Set<string>();
  for (const config of ctx.applied) {
    const name = normalizeServerName(config?.name);
    if (name) applied.add(name);
  }

  const seen = new Set<string>();
  const list: McpServerStatus[] = [];
  /** 缺 name 的条数（无寻址键，面板给不出卡片） */
  let missingName = 0;
  /** 归一化后与前面重名的条数（面板只显示先到的那条） */
  let duplicate = 0;
  for (const config of configured) {
    const name = normalizeServerName(config?.name);
    if (!name) {
      missingName += 1;
      continue;
    }
    if (seen.has(name)) {
      duplicate += 1;
      continue;
    }
    seen.add(name);

    const problem = configProblem(config);
    const enabled = config.enabled !== false;
    const live = ctx.running?.get(name);
    const failure = ctx.failureOf(name);

    let state: McpServerState;
    if (problem) state = 'invalid';
    else if (!enabled) state = 'disabled';
    else if (live) state = 'running';
    else if (applied.has(name)) state = 'failed';
    // 配置在、该名还没进 applied（装配/热更都没跑到它）⇒ 待接入，不谎报失败
    else state = 'pending';

    // server 级键现算一次（同循环内派生，与工具级共用同一份 allowKeys ⇒ 无第二判据）
    const serverKey = serverAllowlistKey(name);
    const serverAllowlisted = live ? live.allowKeys.has(serverKey) : false;

    list.push({
      name,
      ...(typeof config.command === 'string' && config.command.length > 0
        ? { command: config.command }
        : {}),
      // 远程标记只下发形态与 url；**headers 刻意不下发**——它是用户手填的凭据面，
      // 推进 webview 等于把明文令牌塞进消息通道。显式挑字段（而非展开 config）就是为了
      // 让「将来新增字段」默认不泄露；测试钉住了「DTO 里没有 headers」。
      ...(resolveTransportMode(config.transport) === 'http'
        ? {
            transport: 'http' as const,
            ...(typeof config.url === 'string' && config.url.length > 0 ? { url: config.url } : {}),
          }
        : {}),
      ...(Array.isArray(config.args)
        ? { args: config.args.filter((a) => typeof a === 'string') }
        : {}),
      ...(config.env && typeof config.env === 'object' ? { env: { ...config.env } } : {}),
      ...(typeof config.cwd === 'string' && config.cwd ? { cwd: config.cwd } : {}),
      state,
      enabled,
      toolCount: live ? live.bindings.length : 0,
      serverAllowKey: serverKey,
      serverAllowlisted,
      tools: live
        ? live.bindings.map((binding) => {
            const key = allowlistKey(name, binding.originalName);
            return {
              originalName: binding.originalName,
              derivedName: binding.derivedName,
              allowKey: key,
              // 生效态：工具级命中 ∪ 整台命中（整台命中时未单独勾选的工具也是 true）
              allowlisted: live.allowKeys.has(key) || serverAllowlisted,
            };
          })
        : [],
      // 失败原因只在该状态出现；禁用/非法不冒充「失败」（三种原因要分得清）
      ...(state === 'failed'
        ? { error: failure?.error ?? '未连接（本次装配没有这台 server 的记录）' }
        : {}),
      ...(state === 'invalid' && problem ? { problem } : {}),
    });
  }
  return {
    servers: list,
    omitted: { configured: configured.length, missingName, duplicate },
  };
}
