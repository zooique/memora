/**
 * 对话面板 · 会话事件出口（自 `chatPanel.ts` 按 op 组外置 · B9-D）
 *
 * 职责：把内核 `Agent` 的**会话级事件 / 后台事件**转成 webview 的通知条（notice），
 * 以及少数必须同点触发的派生投影刷新（骨架 / 技能清单 / 上下文占用 / 会话列表 / 归档模式）。
 *
 * 为什么外置（而不是在面板里逐个 `l10n.t`）：
 *   1. `chatPanel.ts` 行数贴死 eslint `max-lines`，新增文案只能落在外置文件；
 *   2. 这一组处理器是**纯「事件 → 输出」映射**，依赖面只有 11 个窄接口（下面 `deps`），
 *      与面板内部的流控制 / 锁 / 装配状态无耦合——按语义切得开，才搬得干净。
 *
 * 注入纪律：处理器只经 `deps` 读写面板状态，**不反向持有 provider 实例**（销毁顺序无隐患，
 * 与 `confirmCoordinator` / `activeFileTracker` 同范式）。`onRolePackSwitched` 的
 * 读改写 `_activeRolePack` 也走 getter / setter，不在本模块存第二份激活角色。
 *
 * 本地化：全部可见文案走 `vscode.l10n.t`，键 = 英文源文案本身（宿主机契约）。
 * ⚠️ 两处载荷仍是**内核中文散文**，属内核公开面、本批只登记不动：
 *   - `inputTooLarge.hint`（内核 `contextPreparer` 写死中文建议）；
 *   - `COMPRESS_TARGET_LABELS`（压缩目标中文标签）。
 */
import * as vscode from 'vscode';
import { COMPRESS_TARGET_LABELS, type AgentEventMap, type CompressTarget } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/**
 * 事件出口的注入面（唯一构造点 = 面板字段初始化处）
 *
 * 只放处理器真正会用到的方法：多注入一个等于给这个域开一扇多余的门。
 */
export interface ChatNoticeOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 重算并推送 turn 骨架投影（暂停/恢复事件的投影刷新点） */
  postTurnUpdate: () => void;
  /** 推送当前激活角色包显示名 */
  postActiveRolePack: (name: string | undefined) => void;
  /** 推送工具权限徽章 */
  postCapabilityBadge: () => void;
  /** 推送技能清单（角色切换会改变「启用角色包」技能源） */
  pushSkillList: () => void;
  /** 推送上下文占用快照（角色包底盘占用随切换变化） */
  postContextOccupancy: () => void;
  /** 重拉历史会话列表（归档写入成功后补摘要） */
  pushSessionList: () => void;
  /** 推送归档模式运行时真值（留存按钮文案随之切换） */
  pushArchiveModeRuntime: () => void;
  /** 读当前显示会话 id（标题同步事件需要判归属） */
  getCurrentSessionId: () => string;
  /** 读面板当前激活角色包（判双发用） */
  getActiveRolePack: () => string | undefined;
  /** 写面板当前激活角色包（事件是激活态真值的唯一同步点之一） */
  setActiveRolePack: (name: string) => void;
}

/** 会话事件处理器集合（引用稳定：同一面板实例只构造一次，供 off/on 幂等绑定） */
export interface ChatNoticeOps {
  onSessionError: (info: { cause: string }) => void;
  onSessionResumeFailed: (info: { reason: string }) => void;
  onSessionResumeBlocked: (info: { reason: string }) => void;
  onSessionPauseTimedOut: () => void;
  onContextTruncated: (info: { skippedCount: number; keptCount: number }) => void;
  onContextCompressed: (info: {
    target: CompressTarget;
    replacedCount: number;
    summaryLength: number;
  }) => void;
  onArchiveFailed: (info: { stage: string; message: string }) => void;
  onSessionArchived: () => void;
  onInputTooLarge: (info: { inputLength: number; remainingTokens: number; hint: string }) => void;
  onSessionForked: (info: { from: string; to: string; roundCount: number }) => void;
  onSessionPaused: (info: { reason: string; source: string; sessionId?: string }) => void;
  onSessionResumed: (info: { sessionId?: string }) => void;
  onSessionRecovered: (info: { sessionId?: string }) => void;
  onSessionTitleUpdated: (info: { sessionId: string; title: string }) => void;
  onRolePackSwitched: (info: { from: string | null; to: string }) => void;
  onWorkProjectionGenerated: (info: { sourcePath: string; summary: string }) => void;
  onConfigReloaded: (info: { source: string }) => void;
  onArchiveModeChanged: (info: { from: string; to: string }) => void;
  onRolePackSwitchLocked: (info: { reason: string; lockedSeconds: number }) => void;
  onMemoryRecalled: (info: AgentEventMap['memoryRecalled']) => void;
}

/**
 * 构造会话事件出口
 *
 * @param deps 面板注入的窄接口（见 {@link ChatNoticeOpsDeps}）
 */
export function createChatNoticeOps(deps: ChatNoticeOpsDeps): ChatNoticeOps {
  return {
    // ─── 会话异常出口（错误级 notice） ───
    // 错误不插入消息区，避免污染对话历史。

    /** sessionError：会话异常（LLM 超时等） */
    onSessionError: (info) => {
      deps.post({
        type: 'notice',
        level: 'error',
        message: vscode.l10n.t('Session error: {0}', info.cause),
      });
    },

    /** sessionResumeFailed：恢复操作执行失败（如存储层异常） */
    onSessionResumeFailed: (info) => {
      deps.post({
        type: 'notice',
        level: 'error',
        message: vscode.l10n.t('Session resume failed: {0}', info.reason),
      });
    },

    /** sessionResumeBlocked：恢复被阻止（暂停超时检查点已清理） */
    onSessionResumeBlocked: (info) => {
      deps.post({
        type: 'notice',
        level: 'error',
        message: vscode.l10n.t('Session cannot be resumed: {0}', info.reason),
      });
    },

    /** sessionPauseTimedOut：暂停超时，需重新开始 */
    onSessionPauseTimedOut: () => {
      deps.post({
        type: 'notice',
        level: 'error',
        message: vscode.l10n.t('Session pause timed out; please start again'),
      });
    },

    // ─── 低扰信息出口（info 级 notice） ───
    // 上下文截断 / 记忆归档失败 —— 「知晓即可」的低频信息；提示条独立于消息区，不随 chunk 重建。

    /** contextTruncated：上下文窗口截断（消息超出 token 上限被裁剪） */
    onContextTruncated: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t(
          'Context truncated: {0} skipped, {1} kept',
          info.skippedCount,
          info.keptCount,
        ),
      });
    },

    /** contextCompressed：LLM 主动压缩上下文（第二级压缩，与内核自动截断区分） */
    onContextCompressed: (info) => {
      // target→标签引内核 COMPRESS_TARGET_LABELS（穷尽 Record），
      // 禁在本处写三元/else——枚举增补时三元会把新值落到旧标签上，对用户说谎
      // （2026-10-03 CTX-WIN-2 落地时实证：earliest_steps 曾被三元显示成「最大工具结果摘要」）。
      const targetText = COMPRESS_TARGET_LABELS[info.target];
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t(
          'Context compressed: {0}, {1} messages replaced, summary {2} tokens',
          targetText,
          info.replacedCount,
          info.summaryLength,
        ),
      });
    },

    /** archiveFailed：记忆归档失败（内核 stage 为 'session' 会话归档阶段，无 'insight' 阶段） */
    onArchiveFailed: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Memory archiving failed ({0}): {1}', info.stage, info.message),
      });
    },

    /**
     * sessionArchived：会话归档写入成功 → 重拉会话列表。
     * 修「最后一公里」缺口：切走时的列表快照拿不到异步完成的 summary/keyTopics，
     * 无此重拉则历史条目悬停 tooltip 恒空（载荷暂无消费——全量重拉，不按 sessionId 寻址）。
     */
    onSessionArchived: () => {
      deps.pushSessionList();
    },

    // ─── 高价值事件 ───

    /**
     * inputTooLarge：装配前输入预算判负（剩余 token 不足以支撑至少一轮正文）
     *
     * 内核 ContextPreparer 在装配前检测输入是否超出预算，触发此事件时通常意味着直接把
     * 大文件内容粘到了对话里。展示 hint（如「建议用 read_file 分段读取」）给用户降级路径。
     * ⚠️ `hint` 是内核写死的中文散文（公开面），英文界面下这句仍是中文——已登记内核文案债。
     */
    onInputTooLarge: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t(
          'Input too large ({0} characters); remaining budget is insufficient. {1}',
          info.inputLength,
          info.hint,
        ),
      });
    },

    /**
     * sessionForked：会话分叉成功（内核 SessionManager.forkSession 完成后触发）
     *
     * 补充通知路径：host 在 `forkCurrentSession()` 中直接处理分叉结果（同步切换 + 回放），
     * 此事件监听作为安全网——任何未来不经过 `forkCurrentSession` 的分叉路径都能获得一致反馈。
     */
    onSessionForked: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Forked new session "{0}" ({1} turns)', info.to, info.roundCount),
      });
    },

    // ─── 低价值事件（状态冗余确认） ───

    /** sessionPaused：对话被暂停（状态可视化补充 + 骨架投影刷新）
     *
     * ⚠ 投影刷新点（SSOT）：sessionPaused 是状态机真正翻 PAUSED 的事件信号，
     * 骨架必须在此刻重投影——否则 `_turnState` 停留在翻转前的值，暂停按钮不切「继续」。
     * 只读真源（status / isPausePending / 运行态 streaming / ask 域在途提问）+ 幂等；
     * chat 路径不 emit 本事件，故零影响。 */
    onSessionPaused: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Conversation paused ({0})', info.reason),
      });
      deps.postTurnUpdate();
    },

    /** sessionResumed：对话恢复执行（状态反馈 + 骨架投影刷新 + 待发送区同步）
     *
     * ⚠ 投影刷新点（SSOT）：sessionResumed 是状态机真正翻 RUNNING 的事件信号。
     * 必须用 postTurnUpdate 而非 syncPendingQueue——后者带长度守卫（纯续跑无 interject 时
     * 队列长度恒 0 → 不推），会让 `_turnState` 钉死在 `waiting(pause)`，续跑全程按钮停在
     * 「继续」（用户实测 Bug 根因）。postTurnUpdate 自带 pendingQueue 载荷（双职责一次推完），
     * 故不再叠加 syncPendingQueue。 */
    onSessionResumed: () => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Conversation resumed'),
      });
      deps.postTurnUpdate();
    },

    /** sessionRecovered：对话异常恢复完成（自动恢复反馈） */
    onSessionRecovered: () => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Conversation recovered from the error; continuing'),
      });
    },

    /**
     * sessionTitleUpdated：会话标题被 LLM 自动更新（SSOT 同步）
     *
     * 当 SessionNamer 完成标题生成后，Agent 发射此事件。
     * 宿主检查是否为当前会话，若是则推送 session_title 到 webview 刷新顶部标题。
     * 这确保了"对话记录已更新，但顶部未同步"的问题得到解决。
     */
    onSessionTitleUpdated: (info) => {
      // 仅当更新的是当前会话时才推送（其他会话的标题更新不影响当前 UI）
      if (info.sessionId === deps.getCurrentSessionId()) {
        deps.post({ type: 'session_title', title: info.title });
      }
    },

    /**
     * rolePackSwitched：角色包切换（内核 emit：手动切换 activate / 检查点恢复激活）
     *
     * 内核在手动切换或恢复激活角色包时 emit rolePackSwitched，此处转发为现有
     * chat_role_pack 协议消息（复用，不新增类型），webview 即时刷新。
     *
     * 同步推送 capability_badge —— 工具权限徽章，展示当前角色的工具模式与能力列表。
     */
    onRolePackSwitched: (info) => {
      // 防双发：手动切换经「activate 回调 + rolePackSwitched 事件」两次到达；与当前值相同即已处理
      if (info.to === deps.getActiveRolePack()) return;
      // SSOT：同一事件维护内部激活角色（= 内核 activeName），是 replaySession 的真相源；
      // 只 post 不更新会让视图重解析时读到陈旧值 → 徽章与设置面板分叉。
      deps.setActiveRolePack(info.to);
      // 仅转发切换后的角色显示名（to），触发角色选择器 + AI 消息标签同步（视图存活时）
      deps.postActiveRolePack(info.to);
      // 同步推送工具权限徽章（角色切换后能力面随之变化）
      deps.postCapabilityBadge();
      // 角色切换后「启用角色包」技能源变化 → 刷新技能清单（composer 动态下拉与设置面板同步，SSOT）
      deps.pushSkillList();
      // 角色包底盘占用随切换实时反映到输入区圆环（内核已在切换时重算 setRolePackBaseTokens，
      // 此处直接推当前占用快照即可，不重算、不依赖跑 prepare——切角色包即刷新占用）
      deps.postContextOccupancy();
    },

    /**
     * workProjectionGenerated：工作投影生成（内核后台投影完成时 emit）
     *
     * 转发为 notice info 级提示条，告知用户当前工作投影已更新。
     * 内核事件形状：{ sourcePath: string; summary: string }
     */
    onWorkProjectionGenerated: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Work projection generated: {0}', info.summary ?? info.sourcePath),
      });
    },

    // ─── 后台事件（调试可观测性） ───

    /** configReloaded：配置热重载完成 */
    onConfigReloaded: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Configuration reloaded (source: {0})', info.source),
      });
    },

    /**
     * archiveModeChanged：归档模式切换（内核 setArchiveMode **成功**才发 ⇒ 即运行时真值已变）
     *
     * 顺带把运行时真值推给 chat webview：留存按钮文案随之切换（manual 模式按钮兼做归档触发）。
     * 拒切（busy）不发本事件 ⇒ 偏好已存而运行时未生效的窗口内，文案保持旧值——**如实**，
     * 与「点击时真实发生什么」一致（偏好改了但按钮还按 full 行事，就该显示 full 的文案）。
     */
    onArchiveModeChanged: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t('Archive mode changed: {0} → {1}', info.from, info.to),
      });
      deps.pushArchiveModeRuntime();
    },

    /**
     * rolePackSwitchLocked：角色包切换被**限流锁定**时提示用户（消除 silent failure——用户在
     * 角色视图点「设为当前」触达限流阈值时，若无本事件则点击无任何反馈）。
     *
     * 触发面：内核 activate() 仅在**触发锁定**的那一次切换发射本事件（该次切换成功）；
     * 被锁期间的后续切换直接返回 false 且不发射，其提示由 settingsPanel.activateRole 经
     * getRolePackSwitchLockStatus() 分支补发。
     */
    onRolePackSwitchLocked: (info) => {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t(
          'Role pack switching is locked: {0}; try again in {1} seconds',
          info.reason,
          info.lockedSeconds,
        ),
      });
    },

    /**
     * memoryRecalled：LLM 查询记忆库命中 N 条相关记忆
     *
     * HOST-S3-1 / MEM-EVENT-2：由 notice 条数提示升级为**透明转发** memory_hits——命中明细
     * （hits）由 webview 收进对应那次 search_memories 调用的工具折叠块（按 toolCallId 配对；
     * 无 ID / 行未就绪则回退轮次级聚合行）。
     * - 宿主零加工（不截断、不改写、不做配对决策）：载荷形态真源 = 内核
     *   AgentEventMap['memoryRecalled']（含 toolCallId），明细上限由内核 parseLimit（50）单点钳制。
     * - hits / toolCallId 均可选 = 跨 dist 契约：老内核不发这些字段（类型层强制 webview 容错）。
     *   配对与否、落位退化的分支**全在 webview 渲染层**，宿主只搬字段。
     * 唯一触发位 = search_memories 工具命中（assembler 接线），
     * 对齐内核 builtinToolHandlers.searchMemories 命中点。
     */
    onMemoryRecalled: (info) => {
      deps.post({
        type: 'memory_hits',
        count: info.count,
        query: info.query,
        hits: info.hits,
        toolCallId: info.toolCallId,
      });
    },
  };
}
