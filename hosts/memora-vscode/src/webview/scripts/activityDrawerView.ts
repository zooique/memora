/**
 * 活动抽屉域容器（HOST-SPLIT-1 P2 chatView 第 4 刀，域外置工厂范式第 4 次复制）
 *
 * 域职责：活动状态三合一（P0 错误瞬态条 / P1 低扰条 / P2 指标）+ 抽屉时间线历史 +
 * 未读位判定。自 `chatView.ts` 外置（方案见
 * `tasks/方案-HOST-SPLIT-1-chatView活动抽屉域提取-20261021.md`）。
 *
 * **与 StatusDock 裁决器的分界（ADR-037 形态宪法）**：裁决器（resolveDock/dockEntries/
 * _dockExpanded/dockChip click）是共享基础设施，留在 chatView——pendingQueue /
 * fileChanges / background / confirm 四条仍消费它，本域只是其 'activity' 一条 entry。
 * 本域对裁决器只有两个合法动作：①经 deps.setDockActive/setDockFixed 上报状态（禁直写
 * 任何 hidden/insertBefore——hidden 与归位只由 resolveDock 裁决）；②只读
 * deps.isDockExpanded（禁反向写折叠轴——「不替用户合抽屉」纪律）。
 *
 * **未读判据边界（2026-10-05 两轮实锤病根）**：未读只由「诊断信号」（metricsSignalOf
 * 五元组）驱动，禁用「推过」「全文 diff」「activityMetrics.hidden 渲染结果」当事实源。
 *
 * **耦合 4 面承接**（上刀占用域方案 §四实测）：renderMetrics 尾调 notifyDockChanged（出）；
 * resolveDock 经 getDockState() 读 timelineReady/hasUnread 判据（入）；dockChip click
 * 拉开时经 markDrawerOpened() 清未读+消费信号（入）；isDockExpanded() 决定未读
 * 「当场消费 vs 标未读」（入）。
 *
 * @module activityDrawerView
 */
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { fmtTime } from '../helpers/fmtTime.js';
import { fmtCompactTokens } from '../helpers/fmtTokens.js';

/** metrics 消息载荷（协议同源取型，禁在容器内手抄字段形状） */
type MetricsMessage = Extract<ExtensionToWebviewMessage, { type: 'metrics' }>;

/** 活动抽屉域容器依赖：DOM 节点 ×3 + StatusDock 上报 2 面 + 裁决器只读面 2 个 */
export interface ActivityDrawerViewDeps {
  /** webview 文档对象（构建时间线行 / 主状态条子节点用） */
  document: Document;
  /** #activityBar 主状态条（瞬态单条；与裁决器注册共享同一节点） */
  activityBar: HTMLElement;
  /** #activityList 抽屉时间线历史列表 */
  activityList: HTMLElement;
  /** #activityMetrics 抽屉指标块 */
  activityMetrics: HTMLElement;
  /**
   * #activityMetricsEmpty 指标空态指引（showMetrics 默认关时指标块永不到达）
   *
   * 只负责解释「为什么空」；首次收到 metrics 即隐藏。不参与 timelineReady 判据
   * （数据面真源仍是 activityMetrics.hidden）。
   */
  activityMetricsEmpty: HTMLElement;
  /** StatusDock 上报：活动条激活/收纳（窄化为本域唯一合法 id 'activity'，禁触其他条） */
  setDockActive: (id: 'activity', active: boolean) => void;
  /** StatusDock 上报：error 豁免恒主位（fail-visible） */
  setDockFixed: (id: 'activity', fixed: boolean) => void;
  /** resolveDock 单点重排（showActivity 入口显式刷新 / renderMetrics 尾部刷新） */
  notifyDockChanged: () => void;
  /** 折叠轴只读（决定未读「当场消费 vs 标未读」；容器不得反向写） */
  isDockExpanded: () => boolean;
}

/** 活动抽屉域窄接口：chatView 仅经此四面驱动，域内状态/常量/内部函数零暴露 */
export interface ActivityDrawerView {
  /** 显示主状态条 + 入历史 + 标未读（P0 错误 / P1 低扰入口） */
  showActivity(
    level: 'error' | 'info',
    text: string,
    action?: { label: string; onClick: () => void },
    kind?: 'decision',
  ): void;
  /** metrics 消息到达：渲染指标块 + 信号驱动的未读判定 */
  renderMetrics(msg: MetricsMessage): void;
  /** resolveDock 消费的抽屉入口判据：时间段有内容（timelineReady）/ 有未读（hasUnread） */
  getDockState(): { timelineReady: boolean; hasUnread: boolean };
  /** 拉开＝已读：清两个未读位 + 消费指标信号（dockChip click 拉开分支调用） */
  markDrawerOpened(): void;
  /** 清理域内定时器（chatView.dispose 统一调用，防测试跨用例泄漏） */
  dispose(): void;
}

/**
 * 创建活动抽屉域容器。
 *
 * @param deps DOM 节点 ×4（activityBar / activityList / activityMetrics /
 *   activityMetricsEmpty）+ StatusDock 上报面（setDockActive / setDockFixed）+
 *   裁决器只读面（notifyDockChanged / isDockExpanded）
 */
export function createActivityDrawerView(deps: ActivityDrawerViewDeps): ActivityDrawerView {
  const { document, activityBar, activityList, activityMetrics, activityMetricsEmpty } = deps;

  /** 详情历史最大条数（有界，防长期使用累积） */
  const MAX_ACTIVITY_HISTORY = 20;
  /** 活动历史记录：level=error 时标红、info 时灰显；仅用于详情回溯，不含指标 */
  interface ActivityRecord {
    level: 'error' | 'info';
    text: string;
    ts: string;
    /** 时间线第三类事件「决策记录」（C2）：批准/拒绝/超时自动拒，只记工具面+裁决结果 */
    kind?: 'decision';
  }
  const activityHistory: ActivityRecord[] = [];

  /**
   * 详情「有未读」标记（P4 / UI-CONFIRM-P10 治本）
   *
   * 🔴 旧判据是「历史非空即显示」而历史**从不清空**（只 shift 截断到MAX 条）⇒ 出现过
   * 任意一条活动后折叠区永久可见，即用户反馈的「基本常驻」。C1 起事实与呈现分离：
   * 历史非空只决定**入口可达**（chip 显「活动」），是否提示由未读位决定——
   * 用户点开抽屉看过即消（唯一折叠轴 #dockChip 点击回调，拉开＝已读）。
   *
   * 为何不用「历史空才隐藏」：那只是把常驻改成「最后一次活动后才消」，用户读过之后
   * 仍常驻 ⇒ 换壳不换病。
   */
  let activityUnread = false;

  /**
   * 指标未读位（与 activityUnread 同构，判据的第二个事实源）
   *
   * 🔴 病根（2026-10-05 审查实锤）：旧判据把 `activityMetrics.hidden`（**渲染结果**，
   * 且只置 false 从不复位）当「有没有指标要看」的事实喂给显隐判据 ⇒ 首次 metrics
   * 之后详情区恒显形。第二版改喂「渲染全文快照对比」仍错——宿主每轮都推 metrics，
   * 而 llmCallCount / token 是**累计计数**、每轮必涨 ⇒ 全文每轮都不同 ⇒ 退化成
   * 「每轮弹一次」，换壳不换病。
   *
   * 定案修法：未读只由**诊断信号**驱动（失败数 / 截断数 / 未解析意图数 / 安全审计数 /
   * 指纹变化，见 `metricsSignalOf`）——累计计数是仪表盘读数，不是「新闻」。
   * 指标块本身的显隐仍归 `activityMetrics.hidden`（渲染职责，两件事互不侵占）。
   */
  let metricsUnread = false;
  /** 最近一次 metrics 的诊断信号（每次推送都更新；展开中现场消费的依据） */
  let metricsSignalLatest = '';
  /** 用户已读的诊断信号快照（空串 = 从未读过；与 latest 不同 ⇒ 有未读信号） */
  let metricsSignalSeen = '';

  let activityTimer: number | null = null;

  /**
   * 渲染时间段的活动历史列表（内容职责；C1 起不再裁决任何显隐——
   * 时间线可见性是 #dockPanel.hidden 的纯函数，徽章/入口显隐归 resolveDock）。
   */
  function renderActivityDetail(): void {
    // 历史列表：textContent 构建防注入（全部来自内核/宿主文案或用户输入）
    activityList.textContent = '';
    for (const r of activityHistory) {
      const row = document.createElement('div');
      row.className = 'activity-list__row ' + r.level + (r.kind === 'decision' ? ' decision' : '');
      const text = document.createElement('span');
      text.className = 'activity-list__text';
      text.textContent = r.text;
      const time = document.createElement('span');
      time.className = 'activity-list__time';
      time.textContent = r.ts;
      row.appendChild(text);
      row.appendChild(time);
      activityList.appendChild(row);
    }
  }

  /**
   * 显示主状态条（P0 错误 / P1 低扰）
   *
   * 优先级：P0 显示期间 P1 不覆盖（错误优先保护，P1 仅记历史）；新 P0 覆盖旧 P0。
   * 停留时长按档位分级——error 醒目停留更久，info 低扰短暂（对齐排雷雷-4 语义分离）。
   *
   * 支持可选 action 按钮：当宿主标记错误为「可重试」时，action.label 显示按钮文案、
   * action.onClick 绑定重试回调。当前宿主暂未接入（框架先行就绪），不传 action 时该能力不生效。
   */
  function showActivity(
    level: 'error' | 'info',
    text: string,
    action?: { label: string; onClick: () => void },
    kind?: 'decision',
  ): void {
    // 全部活动先入历史（被覆盖的提示不丢失，详情可回溯）
    const record: ActivityRecord = {
      level,
      text,
      ts: fmtTime(new Date().toISOString()),
      ...(kind ? { kind } : {}),
    };
    activityHistory.push(record);
    if (activityHistory.length > MAX_ACTIVITY_HISTORY) activityHistory.shift();
    // 新活动 ⇒ 标未读（抽屉收起态才标；拉开着说明用户正在看，不标）。
    // 未读只亮 #dockChip 徽章、不弹时间线（宪法④）；事实位在此，呈现在 resolveDock。
    if (!deps.isDockExpanded()) {
      activityUnread = true;
    }
    renderActivityDetail();
    // 入口显式刷新（必须在 P0 早退判据**之前**）：history 与未读位是 resolveDock 的输入，
    // 但重复通知时 active/fixed 往往没变——setDockActive/setDockFixed 判重 no-op 不触发裁决，
    // 不补这一下则「收抽屉后第二条通知到达，徽章不亮」（与 renderMetrics 尾部同款刷新）。
    // 紧接着的 setter 若状态真变化会再裁决一次：两次同帧、幂等，head 有免重排守卫不搬。
    deps.notifyDockChanged();

    // P0 保护：当前显示 error 时，后续 info 不打断（仅进历史，主条保持错误可见）
    if (level === 'info' && activityBar.dataset.level === 'error') return;

    activityBar.dataset.level = level;
    activityBar.className = 'activity-bar ' + level;
    // 文本 + 可选操作按钮：action 存在时用 span 包裹文本 + button，否则纯 textContent
    if (action) {
      activityBar.textContent = '';
      const textSpan = document.createElement('span');
      textSpan.className = 'activity-bar__text';
      textSpan.textContent = text;
      activityBar.appendChild(textSpan);
      const btn = document.createElement('button');
      btn.className = 'activity-bar__action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      activityBar.appendChild(btn);
    } else {
      activityBar.textContent = text;
    }
    // StatusDock 接线：error 豁免恒主位（fail-visible），非错误态参与收纳（垫底优先级）。
    // hidden 归 resolveDock 裁决（setDockActive 触发全量重排），此处不直写。
    deps.setDockActive('activity', true);
    deps.setDockFixed('activity', level === 'error');
    if (activityTimer) window.clearTimeout(activityTimer);
    activityTimer = window.setTimeout(
      () => {
        delete activityBar.dataset.level;
        // 自动消失 → 撤出收纳器（fixed 随之撤销；hidden 与归位由 resolveDock 统一裁决）
        deps.setDockActive('activity', false);
        deps.setDockFixed('activity', false);
      },
      level === 'error' ? 8000 : 2500,
    );
  }

  /**
   * 从 metrics 载荷提取**诊断信号**（未读判据唯一事实源）。
   *
   * 口径：只收「出了事 / 配置变了」的量——工具失败、上下文截断、未解析工具意图、
   * 路径守卫**拒绝数**、系统提示指纹。判据不是「累计 vs 瞬时」，而是
   * **「正常轮次这个值会不会变」**：fail/trunc/unparsed/denied 只在异常时增长，
   * 正常轮次恒定；llmCallCount / token / budget 每轮必涨。
   *
   * 🔴 血训（2026-10-05 真机触发链复核实锤）：audit 字段**只准用 denied，不准用 total**。
   * 内核 SecurityGuard 对**白名单正常放行也发 path-allow 审计**，宿主 total 无条件累加
   * （含 allow）⇒ AI 真实编码每轮都读文件 ⇒ total 每轮必涨，与 llmCallCount 同病。
   * v3 曾误收 total，变异测试因构造数据没让审计数逐轮涨而漏网；守卫用例见
   * `chatView.test.ts`「P4 补审 A」审计守卫条。total 仍在指标块正常展示（仪表盘读数），
   * 只是不入信号。trace 是操作流镜像，同样不是新闻。
   */
  function metricsSignalOf(msg: MetricsMessage): string {
    return JSON.stringify({
      fp: msg.fingerprints.systemPromptHash ?? '',
      fail: msg.metrics.toolFailureCount ?? 0,
      trunc: msg.metrics.truncationCount ?? 0,
      unparsed: msg.metrics.unparsedToolIntentCount ?? 0,
      // 只认拒绝数：total 含每轮必发生的 path-allow，入信号 = 每轮弹一次（见函数头血训）
      audit: msg.securityAudit?.denied ?? 0,
    });
  }

  /**
   * 渲染活动指标详情（P2：§13.x 透明面板 + §5.2.1 指纹可见）
   *
   * 指纹（系统提示 hash 前 12 位）+ 累计指标（LLM / 工具失败 / 截断）。
   * textContent 赋值防注入；指标只进详情折叠区，不占用主状态条。
   * 注：「附着记忆条数 / 召回命中率」已退役——自动记忆注入与
   * recall 指标随自动召回退役恒零（假指标），显示即误导。
   */
  function renderMetrics(msg: MetricsMessage): void {
    const fp = msg.fingerprints;
    const lines = [
      // 指纹行：只显示 hash，不显示内容（可追溯性边界）
      '本轮指纹：' + (fp.systemPromptHash ? '系统提示 ' + fp.systemPromptHash : '系统提示 -'),
      // 累计指标行（未解析工具意图累计，诊断面板可见文本 tool_call 静默失败）
      '累计：LLM ' +
        msg.metrics.llmCallCount +
        ' 次 · 工具失败 ' +
        msg.metrics.toolFailureCount +
        (msg.metrics.unparsedToolIntentCount && msg.metrics.unparsedToolIntentCount > 0
          ? ' · 未解析工具意图 ' + msg.metrics.unparsedToolIntentCount
          : '') +
        ' · 截断 ' +
        msg.metrics.truncationCount,
      // token 用量（可选字段，缺省不显示）：估算口径。「入」为**累计**（同轮详情执行指标
      // 同源，勿据其判窗口占用）；「出」只计正文、不含思考——防推理模型下把正文数
      // 误读成总输出
      'Tokens（估算）：' +
        (typeof msg.metrics.llmTokenIn === 'number'
          ? '入 ' + msg.metrics.llmTokenIn + ' 累计'
          : '入 -') +
        ' / 正文 ' +
        (typeof msg.metrics.llmTokenOut === 'number'
          ? msg.metrics.llmTokenOut + '（不含思考）'
          : '-'),
      // ④ 预算分配构成（可选字段，缺省不显示）——窗口内空间如何被 锚点/对话层 瓜分
      ...(msg.metrics.budget
        ? [
            '预算：可用 ' +
              fmtCompactTokens(msg.metrics.budget.availableTokens) +
              ' · 锚点 ' +
              fmtCompactTokens(msg.metrics.budget.anchorTokens) +
              ' · 对话层 ' +
              fmtCompactTokens(msg.metrics.budget.dialogueBudgetTokens) +
              ' · 剩余 ' +
              fmtCompactTokens(msg.metrics.budget.remainingTokens),
          ]
        : []),
      // B9 可观测补齐：最近操作流（span 标签新→旧，指标区末尾渲染，缺省不显示）
      ...(msg.trace && msg.trace.length > 0
        ? ['操作流：', ...msg.trace.map((t) => '  › ' + t.label)]
        : []),
      // 安全/装配透明：路径守卫审计概要（有审计事件才显示；basename 路径）
      ...(msg.securityAudit && msg.securityAudit.total > 0
        ? [
            '安全审计 ' +
              msg.securityAudit.total +
              ' 次 · 拒绝 ' +
              msg.securityAudit.denied +
              (msg.securityAudit.recent.length > 0
                ? ' · 最近：' +
                  msg.securityAudit.recent
                    .map((r) => r.type + ' ' + r.path + (r.reason ? ' (' + r.reason + ')' : ''))
                    .join(', ')
                : ''),
          ]
        : []),
    ];
    const next = lines.join('\n');
    activityMetrics.textContent = next;
    activityMetrics.hidden = false;
    // 指标已到达 ⇒ 空态指引让位（只解释「为什么空」，不占指标位）
    activityMetricsEmpty.hidden = true;
    // 未读由**诊断信号变化**驱动（不是「推过」、不是渲染全文 diff——见 metricsSignalOf）。
    // 抽屉拉开中到达的新信号当场消费（更新已读快照），避免用户现场看过、收起后反被标未读。
    const signal = metricsSignalOf(msg);
    metricsSignalLatest = signal;
    if (signal !== metricsSignalSeen) {
      if (deps.isDockExpanded()) {
        metricsSignalSeen = signal;
      } else {
        metricsUnread = true;
      }
    }
    renderActivityDetail();
    // metrics 路径不经过 setDockActive（活动瞬态条可能根本没激活），徽章/入口状态
    // 必须在此显式刷新：首推 metrics 即让入口可达（内容已渲染、信号未读 ⇒ 亮「活动」徽章，
    // 但抽屉仍不自动弹——可见性只由用户点击翻转）。
    deps.notifyDockChanged();
  }

  // ── 窄接口 ──

  return {
    showActivity,
    renderMetrics,
    /** 抽屉入口判据（resolveDock 消费）：时间段有内容（历史有界保留 / metrics 渲染后
     *  常驻）⇒ 入口首次出现后常驻——C1 闭合的最后残余缺口（台账 P15 病③）。 */
    getDockState: () => ({
      timelineReady: activityHistory.length > 0 || !activityMetrics.hidden,
      hasUnread: activityUnread || metricsUnread,
    }),
    /** 拉开＝已读（唯一折叠轴 #dockChip click 拉开分支调用）：清两个未读位 +
     *  现场消费指标信号（已读快照对齐最新信号，收起后不再反标未读）。 */
    markDrawerOpened: () => {
      activityUnread = false;
      metricsUnread = false;
      metricsSignalSeen = metricsSignalLatest;
    },
    /** 清理瞬态条撤出计时器（chatView.dispose 统一调用；原域内状态，随域收口清理面） */
    dispose: () => {
      if (activityTimer !== null) window.clearTimeout(activityTimer);
    },
  };
}
