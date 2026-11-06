/**
 * 面板快照投影（任务看板 / 后台任务 / 上下文占用）——自 chatPanel 外置（max-lines 只降不升）
 *
 * 三者同族：都是「读当前显示会话的 Agent 快照 → 投递给唯一界面」，且都带宿主缓存
 * （后台任务签名 / 用户收起偏好）。判据与文案随方法整体搬走，面板只做依赖注入，
 * 不新增第二份口径。
 *
 * 会话归属纪律（E4 批 2）：`getAgent()` 返回的是**当前显示会话**的实例，因此本域任何
 * 写缓存动作前必须先问 `isBackground()`——后台流调用时若不挡，会把 A 的任务签名写进
 * 宿主缓存，B 的下一轮去重判据随之失真（该形态无测试会红）。
 *
 * 跨会话键控（2026-11-06 修 `BGTASK-DISMISS-CROSSTALK-1`）：`taskId` 是**每实例序号**
 * （`bg-${seq}`），两个会话都会出现 `bg-1` ⇒ 收起偏好与去重签名都必须带会话维度，
 * 否则「A 里收起 bg-1」会连带隐藏 B 的 bg-1（无测试会红）。
 */
import { BACKGROUND_TASK_STATUS_LABELS, estimateOccupancy, type Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 面板注入的能力（本域不持有面板状态，只持有本域自己的两份推送缓存） */
export interface PanelSnapshotDeps {
  /** 当前**显示**会话的实例（未装配返回 undefined） */
  getAgent: () => Agent | undefined;
  /** 面板投递出口（已带「后台流丢弃」闸） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 当前执行栈是否属于后台流（写本域缓存前必须挡） */
  isBackground: () => boolean;
  /**
   * 当前**显示**会话的标识（收起偏好与去重签名的会话维度键）
   *
   * `taskId` 只在单个 Agent 实例内唯一（`bg-${seq}`）⇒ 不带会话维度就无法区分
   * 「A 的 bg-1」与「B 的 bg-1」。
   */
  getSessionId: () => string;
}

/** 任务看板 / 后台任务 / 上下文占用的快照投影器（生命周期 = 面板实例） */
export class PanelSnapshots {
  /**
   * 上次推送给 webview 的后台任务快照**内容签名**（`taskId:status` 拼接串）
   *
   * 纯推送去重守卫，**不是后台任务的真相源**（真相源恒为内核注册表，宿主零副本）。
   * 用签名而非「条数」：`kill` 后 `running → killed` 条数恒为 1 而内容已变，
   * 长度守卫会把这次关键刷新判成 no-op（同 `syncPendingQueue` 长度守卫的反向教训）。
   */
  private _backgroundSignature: string | null = null;

  /**
   * 上面那份签名属于哪个会话（`null` = 尚未推送过）
   *
   * 切会话时签名必须失效：`taskId` 跨实例重名（`bg-1` 在两个会话都存在），沿用旧签名
   * 会把新会话的首推判成 no-op（通常内容恰好相同）⇒ 后台任务条停留在上一会话的内容。
   */
  private _signatureSessionId: string | null = null;

  /**
   * 用户已手动收起的后台任务，**按会话分组**：只存用户偏好，不存任务数据。
   * 放宿主（webview 折叠重建会丢）；生命周期 = 宿主实例。
   *
   * 用例：A 会话收起 `bg-1` 后，B 会话的 `bg-1` 必须仍显示——`taskId` 是每实例序号，
   * 不带会话维度即跨会话串台（`BGTASK-DISMISS-CROSSTALK-1`）。
   */
  private readonly _dismissedBySession = new Map<string, Set<string>>();

  /**
   * @param deps 面板注入的能力（见 `PanelSnapshotDeps`）
   */
  constructor(private readonly _deps: PanelSnapshotDeps) {}

  /**
   * 推送任务看板快照（任务项 + 各任务项推进记录）
   *
   * 任务节点聚合：额外从 checkpoint.planItemLog 提取 planItemId 关联，按任务项分组携带各任务项
   * 推进记录（planItemLog），webview 展开任务节点时展示该任务项下的推进摘要。
   */
  postPlan(): void {
    const agent = this._deps.getAgent();
    // 后台流不推：读的是当前显示会话实例，推出去即串台
    if (!agent || this._deps.isBackground()) return;
    const checkpoint = agent.getCheckpoint();
    // checkpoint 不存在时推空消息让 webview 清看板；plan 为空也推（autoClearPlan 后）
    if (!checkpoint || !checkpoint.plan) {
      this._deps.post({ type: 'plan_update', items: [] });
      return;
    }
    // plan 为空时也推（turn 结束 autoClearPlan 或 LLM 新任务写入空 plan）
    if (checkpoint.plan.length === 0) {
      this._deps.post({ type: 'plan_update', items: [] });
      return;
    }
    // 任务项 → 关联任务项推进记录（planItemLog 的 planItemId 关联，内核已写入，宿主只读消费）
    const planItemLogById = new Map<
      string,
      { planItemId: string; summary: string; completedAt?: number }[]
    >();
    for (const r of checkpoint.planItemLog ?? []) {
      if (!r.planItemId) continue;
      const list = planItemLogById.get(r.planItemId) ?? [];
      list.push({ planItemId: r.planItemId, summary: r.summary, completedAt: r.completedAt });
      planItemLogById.set(r.planItemId, list);
    }
    // 按 order 排序列化（内核 PlanItem 已含 order，防冗余中断序漂移）
    const items = [...checkpoint.plan]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status,
        order: s.order,
        planItemLog: planItemLogById.get(s.id) ?? [],
      }));
    this._deps.post({ type: 'plan_update', items });
  }

  /**
   * 推送后台任务快照（CMD-1 阶段 2 · 见 `docs/方案-后台任务可见性与kill入口-20261004.md`）
   *
   * 真源 = 内核 `agent.listBackgroundTasks()`（只读投影，含进程句柄的字段已被内核剥离）；宿主
   * 零副本、零裁决，只按快照转发。刻意**不下发 `result`**（命令输出）：体量可达 KB~MB 级，
   * UI 不呈现输出——输出归模型消费（经 `kill_command` / 回流通道给 LLM），随包搬运纯属浪费。
   *
   * agent 未就绪时不推（`_agent` 为空 = 未装配，与 `postPlan` 同守卫形态）——不静默推
   * 空快照，否则「未就绪」会被 UI 读成「没有后台任务」。
   *
   * 推送点共五个：`step_boundary` / `background_report` / `background_kill` 后回推 /
   * 内核 `backgroundTaskSettled` 事件 / webview ready（force）。step 边界周期性到达 ⇒
   * 无任务时逐 step 推空快照纯属 IPC 噪音，由签名去重拦掉。
   *
   * @param mode `dedup`（默认）= 周期推送点，走签名去重降噪；`force` = **webview ready 全量
   *   对齐**，绕过去重——签名存于面板实例、跨 webview 重建（折叠/关闭再打开）残留，
   *   不绕则这次补推被自己的守卫吞掉，表现为「面板重开后后台任务条凭空消失，而进程还在跑、
   *   用户也砍不掉」。两者语义不同（降噪 vs 对齐），故不合并成一条判据。
   */
  pushTasks(mode: 'dedup' | 'force' = 'dedup'): void {
    const agent = this._deps.getAgent();
    // 后台流不推：签名是当前会话的 dedup 守卫，被后台任务写脏后判据即错
    if (!agent || this._deps.isBackground()) return;
    // 会话切换即令签名失效：同名 taskId（bg-1）跨会话重复，沿用旧签名会吞掉新会话首推
    const sessionId = this._deps.getSessionId();
    const sessionChanged = sessionId !== this._signatureSessionId;
    this._signatureSessionId = sessionId;
    // 用户已收起的条目不再下发（**只是视图过滤，内核条目与输出都留着**，`kill_command`
    // 随时可取回）。过滤放在**投影出口**而非内核：宿主只存「哪条别显示」这个用户偏好，
    // 真相源恒为内核注册表，零第二份数据。收起偏好按会话隔离（跨会话同名不共用）。
    const dismissed = this._dismissedFor(sessionId);
    const items = agent
      .listBackgroundTasks()
      .filter((t) => !dismissed.has(t.taskId))
      .map((t) => ({
        taskId: t.taskId,
        command: t.command,
        status: t.status,
        // 状态文案真源 = 内核词表（宿主零自建），在此转成字面量下发——
        // webview 只做 type import，值导入内核会把整包打进 bundle
        statusLabel: BACKGROUND_TASK_STATUS_LABELS[t.status],
      }));
    const signature = items.map((t) => `${t.taskId}:${t.status}`).join('|');
    // 会话刚切换时即使签名相同也必须推：条上的内容属于上一会话，不能拿「相同」当「没变」
    if (mode === 'dedup' && !sessionChanged && signature === this._backgroundSignature) return;
    this._backgroundSignature = signature;
    this._deps.post({ type: 'background_tasks', items });
  }

  /**
   * 取（或建）某会话的「已收起任务」集合
   *
   * @param sessionId 会话标识（`taskId` 只在实例内唯一，必须按会话分桶）
   */
  private _dismissedFor(sessionId: string): Set<string> {
    let set = this._dismissedBySession.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this._dismissedBySession.set(sessionId, set);
    }
    return set;
  }

  /**
   * 会话删除时摘除其「已收起任务」桶（纯内存态清理，零行为变化）
   *
   * 不摘的后果：已删会话的 id 永久驻留在 `_dismissedBySession` 里（僵尸状态）；
   * 与 `_asks` / `_runtime` 同生命周期收口，避免「删除只清一半」。
   */
  deleteSession(sessionId: string): void {
    this._dismissedBySession.delete(sessionId);
  }

  /**
   * 收起一条终态任务（webview 终态行的 `×` → `background_kill` + `reason:'dismiss'`）
   *
   * **不碰内核**（不 kill、不清条目）：关掉的是「眼睛」不是「东西」——任务与输出留在
   * 注册表里，`kill_command` 随时能取回。**可逆 > 不可逆**：用户反悔了还能把这条捞回来显示。
   *
   * 「记住了」放宿主而非 webview：放 webview 则面板一折叠即忘，刚收起的行又冒出来
   * （与 ready 全量对齐同源的问题）。进程存活期不设上限，与注册表实例同生命周期。
   *
   * @param taskId 目标后台任务标识
   */
  dismiss(taskId: string): void {
    // 只记到当前会话桶：同名 taskId 属于两个会话的两条不同任务，收起 A 的那条
    // 不得连带隐藏 B 的同名任务（BGTASK-DISMISS-CROSSTALK-1）
    this._dismissedFor(this._deps.getSessionId()).add(taskId);
    // ⚠️ 必须把签名置为**永不可能与真实签名相等的哨兵**再推，不能置空串：
    // 最后一条被收起时过滤后 `items` 为空 ⇒ 签名也是空串，置空串等于「没变」⇒
    // 去重判成 no-op ⇒ UI 根本不更新（实测踩中：条收不起来）。
    this._backgroundSignature = null;
    this.pushTasks();
  }

  /**
   * 后台任务转入终态 → 推一次 UI 快照（事件订阅 · 见方案文档 §5.2.2）
   *
   * 用默认 `dedup` 即可：签名含 `status`，`running → completed` 必判为变化并推送；
   * 重复终态（同 status）判为 no-op，正是去重要的行为。**不需 force**——force 只为
   * 「webview 重建后重新对齐」而存在（签名跨重建残留会误吞），与本路径无关。
   */
  readonly onTaskSettled = (): void => {
    this.pushTasks();
  };

  /**
   * 终止后台任务（webview 浮层「终止」按钮 → `background_kill` 消息）
   *
   * 内核按 Agent 实例隔离 ⇒ 只能杀本会话自起的任务（与 `kill_command` 同一不变量）。
   * 任务已不在返回 `null`，此处按「已终结」处理并照常回推快照（浮层据此刷新为终态），
   * 不弹错误提示——用户视角「点了终止、它没了」就是正确结果。
   *
   * @param taskId 目标后台任务标识
   */
  kill(taskId: string): void {
    const agent = this._deps.getAgent();
    if (!agent) return;
    agent.killBackgroundTask(taskId);
    this.pushTasks();
  }

  /**
   * 推送上下文占用快照（预算可视化 · 输入区常驻指示器）
   *
   * 与 postMetrics 不同：本推送**脱离 memora.showMetrics 开关**，每轮流式结束必推，
   * 供输入区常驻渲染「上下文占用比例条 + hover 明细」。数据来自内核
   * AgentMetrics.context.occupancy（prepare 期真实用量），宿主只透传、不重算。
   */
  postOccupancy(): void {
    const agent = this._deps.getAgent();
    if (!agent || this._deps.isBackground()) return;
    const ctx = agent.getMetrics().context;
    const occ = ctx.occupancy;
    if (!occ) return;
    // 角色包底盘占用可能已在切换时由内核刷新（setRolePackBaseTokens），早于下一轮 prepare；
    // 用最新底盘值覆盖快照中的旧值，使圆环在角色包切换即时反映，无需等到下一轮。
    const freshRolePack = ctx.rolePackBaseTokens;
    if (freshRolePack !== undefined && freshRolePack !== occ.rolePackBaseTokens) {
      this._deps.post({
        type: 'context_occupancy',
        occupancy: estimateOccupancy({
          ...occ,
          rolePackBaseTokens: freshRolePack,
        }),
      });
      return;
    }
    this._deps.post({ type: 'context_occupancy', occupancy: occ });
  }
}
