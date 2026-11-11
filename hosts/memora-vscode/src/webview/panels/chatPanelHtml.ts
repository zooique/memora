/**
 * 聊天面板 webview HTML 骨架（自 `chatPanel.ts` 外置）
 *
 * 为什么外置：`chatPanel.ts` 是 HOST-SPLIT-1 的 TARGET 文件，`eslint max-lines` 只降不升；
 * 本骨架是**纯静态字符串 + 三处 import 插值**（无 `this`、无运行时状态），
 * 与 `settingsPanelHtml` / `settingsSecurityHtml` 同型，外置属结构改善而非凑行数。
 * 红线注释随块迁移（锚点：审批卡不挂 `#messages` 内、历史下拉 tab 与条目容器不可合并）。
 */
import * as vscode from 'vscode';
import { buildDropdownHtml, dropdownStyles } from '../components/dropdown.js';
import { contextMenuStyles } from '../styles/contextMenu.js';
import { chatStyles } from '../styles/chatStyles.js';
import { buildHtmlHead, resolveHtmlLang } from '../helpers/htmlShell.js';

/** 生成 Webview HTML（含消息区 / 输入框 + 模型下拉框 / 主动提问框）
 *  @param scriptUri 外部脚本 chatView.js 的 asWebviewUri（CSP script-src cspSource 加载）
 *  @param cspSource webview 本地资源源（webview.cspSource，供 CSP script-src 放行 asWebviewUri 外部脚本） */
export function buildHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `${buildHtmlHead({
    lang: resolveHtmlLang(vscode.env?.language),
    cspSource,
    styles: `${chatStyles}\n${dropdownStyles}\n${contextMenuStyles}`,
    // P1 基建：宿主译文随 HTML 内联（默认语言 bundle 为 undefined ⇒ 不注入）；
    // `?.` 守测试侧 vscode mock 未提供 l10n 的场景，真实 API 恒存在
    l10nBundle: vscode.l10n?.bundle,
  })}
<body>
  <!-- SSOT：面板无顶部身份条，角色切换在「角色」视图。
       角色/模型/状态职责归位：模型选择在输入区 composer（model-picker），生成状态由
       思考折叠块 + 发送按钮承载，「谁在回答」由 AI 消息头部标签 msg-ai-label 表达。
       面板结构为三层：消息区 → 活动区 → 输入区。 -->

  <!-- 消息流：日期分隔线 + 消息 + 空状态引导 -->
  <!-- 会话标题条：
       左侧 = 会话标题 + 改名笔；右侧 = 新建会话「＋」+ 历史记录按钮。
       无「清空对话」入口（删除会话记录覆盖该需求），会话导航全量在标题条。 -->
  <div id="sessionTitleBar" class="session-title-bar">
    <!-- ⚠️ title 只挂在内层标题文本上：容器级 title 会被所有无 title 的后代继承显示
         （历史下拉菜单挂在标题条内，空摘要条目悬停会误显示容器的「当前会话」） -->
    <span id="sessionTitleText" class="session-title-bar__text" title="${vscode.l10n.t('Current session')}"></span>
    <button id="renameSessionBtn" class="session-title-bar__btn" title="${vscode.l10n.t('Rename conversation')}" aria-label="${vscode.l10n.t('Rename conversation')}">
      <span class="btn-icon" data-icon="edit"></span>
    </button>
    <span class="session-title-bar__spacer"></span>
    <button id="newSessionBtn" class="session-title-bar__btn" title="${vscode.l10n.t('New session')}" aria-label="${vscode.l10n.t('New session')}">
      <span class="btn-icon" data-icon="plus"></span>
    </button>
    <!-- 历史记录下拉（SSOT）：复用 treedd 组件——trigger=历史按钮，
         菜单紧挨按钮下方弹出（无遮罩、轻量），开合/外部关闭/Escape 由 initDropdowns 管理 -->
    <div id="historyDd" class="treedd session-history" data-treedd data-on-select="__historyOnSelect">
      <button id="historyBtn" class="treedd__trigger" title="${vscode.l10n.t('Session history')}" aria-label="${vscode.l10n.t('Session history')}" aria-haspopup="menu">
        <span class="btn-icon" data-icon="history"></span>
        <!-- 入口角标：等待处理的会话数（0 时 hidden；数据源 = session_activity 快照） -->
        <span id="historyPendingBadge" class="session-history__entry-badge" hidden></span>
      </button>
      <!-- 下拉面板 = 分组切换器 + 条目容器（**两者不可合并**，勿合并这两个 div）：
           ① tab 必须在 .treedd__menu 内——菜单是绝对定位面板，其之外的内容不随菜单显隐；
           ② 条目容器 #historyMenu 必须独立于 tab——renderHistoryMenu 每次整块重建条目
              （textContent=''），tab 若在其内会被一并清掉。
           注意：tab 按钮**绝不可带 .treedd__item 类**：dropdown 的点击委托命中该类后立即
              收起菜单，带了会导致「点 tab 即关浮层」。
           role 取舍（如实登记，不伪装合规）：面板保留 role="menu"（下拉组件与条目
           role="menuitem" 依赖它），其内嵌 role="tablist" 在严格 ARIA 下非标准组合；
           为不破坏既有下拉语义与键盘模型，此处保留该组合并登记为已知取舍。 -->
      <div class="treedd__menu" role="menu">
        <div id="historyTabs" class="session-tabs" role="tablist" aria-label="${vscode.l10n.t('Session list groups')}">
          <button id="historyTabRecent" class="session-tab is-active" type="button" role="tab" aria-selected="true" data-view="recent">${vscode.l10n.t('Sessions')}</button>
          <button id="historyTabArchived" class="session-tab" type="button" role="tab" aria-selected="false" data-view="archived">${vscode.l10n.t('Retained')}<span id="historyArchivedCount" class="session-tab__count"></span></button>
        </div>
        <!-- FD-3-A 元数据搜索框（匹配域：标题 / 主题 / 摘要）：
             ① 必须独立于 #historyMenu——renderHistoryView 每次清空重建条目，放里面会被一并清掉；
             ② 与 tab 同样禁带 .treedd__item 类（点击委托命中即收起浮层）；
             ③ 键盘行为随 dropdown 既有模型：字符输入不受拦截，方向键跳条目，Escape 收起浮层。 -->
        <input id="historySearch" class="session-search" type="text" placeholder="${vscode.l10n.t('Search sessions (title / topic / summary)')}" aria-label="${vscode.l10n.t('Search sessions')}" autocomplete="off" />
        <div id="historyMenu"></div>
      </div>
    </div>
  </div>
  <!-- 任务进度常驻条（单轨）：与 #messages **同级**的固定插槽——
       #messages 是 overflow-y:auto 滚动容器，插进它内部一滚即消失；默认一行
       N/M + 进度条 + 当前任务项，点击展开锚定浮层看全量。隐藏态由 chatView 控制。 -->
  <div id="planBar" class="plan-bar" hidden>
    <button id="planBarHead" class="plan-bar__head" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="planBarPanel">
      <span id="planBarCount" class="plan-bar__count"></span>
      <span class="plan-bar__progress"><span id="planBarFill" class="plan-bar__fill"></span></span>
      <span id="planBarCurrent" class="plan-bar__current"></span>
      <span id="planBarChevron" class="plan-bar__chevron" aria-hidden="true"></span>
    </button>
    <div id="planBarPanel" class="plan-bar__panel" hidden></div>
  </div>
  <div id="messages">
    <!-- 空状态引导：标题 + 提示 + 示例提问 chips（点击填入输入框，主动引导新用户）。
         标题/提示加 id：由 chatView 随激活角色包动态更新，
         切换角色不产生定位错位；示例 chips 由 chatView 随 showcase 角色动态渲染
         （白话方案设计师展示"种子收敛"引导，其余角色回退通用打磨引导），容器留空由脚本填充。 -->
    <div id="emptyState" class="empty-state" hidden>
      <!-- 标题/提示**不留静态文案**：emptyStateView.updateRole（chatView init 末尾同步调用）
           是唯一真源。留默认值 = 第二套语言真源，且旧默认「开始打磨你的设计文档」与运行期
           的「Chat with {0}」早已漂移 ⇒ 迁移时应删而非翻（翻 = 造一个永远被覆盖的僵尸键）。
           注：本模板串内的注释禁用反引号——反引号会提前闭合模板，采集器与编译器同时错位。 -->
      <div id="emptyTitle" class="empty-title"></div>
      <div id="emptyHint" class="empty-hint"></div>
      <div id="emptySuggestions" class="empty-suggestions"></div>
    </div>
    <!-- 写入审批卡已于 2026-10-05 移出本容器（见下方 #writeConfirmCard 处说明）。
         红线：#messages 是 overflow-y:auto 滚动容器（chatStyles.ts 内 #messages 规则），
         任何「需要用户即时看见/操作」的交互 UI 都**不得**挂在其内部——插进去会被 12 处
         appendChild 顶到消息流最顶端，一滚即不可见（chatView.test.ts 审批卡锚点守卫用例
         锁定本约束）。 -->
  </div>

  <!-- UI-TOAST-1 浮层槽：零高度锚不占流高；activity 主位由 resolveDock 搬入本槽上浮 --><div id="activityToastSlot"></div>
  <!-- 会话大纲导航条（HOST-NAV-1）：右缘按轮锚点外壳，条列/浮层由 chatView 经
       helpers/roundNav.ts 动态构建；不足两轮或不可滚动时整条 hidden。
       🔴 挂 #messages 之外（同 scrollToBottomBtn 血训：滚动容器内 absolute 随内容滚走）；
       🔴 panel 不挂 hidden 属性（显形走 :hover/:focus-within，全局 [hidden]!important
       会压死 CSS 显形，见 chatStyles .round-nav 段注释）。
       🔴 两层结构不可合并（HOST-NAV-1 四轮）：.round-nav__panel = 命中盒（紧贴条列、
       无 margin/overflow），.round-nav__list = 视觉盒 + 滚动容器。合并即重建「视觉间隙
       里没有元素接住指针 → 浮层闪退」的原缺陷，见 chatStyles 同名注释与守卫用例。 -->
  <div id="roundNav" class="round-nav" hidden>
    <div class="round-nav__track"></div>
    <div class="round-nav__panel"><div class="round-nav__list"></div></div>
  </div>

  <!-- 活动状态条（错误/低扰通知的**瞬态单条**：info 2500ms / error 8000ms 自动撤）。
       归位/显隐由 resolveDock 单点裁决。历史与指标**不在本条**——固定归下方
       #dockPanel 的时间段（C1，2026-10-05）：本条再怎么生灭，时间线都不陪葬。
       不把时间段做成本条子节点的原因不变：showActivity 每次整体重置
       activityBar.textContent，嵌套即被销毁。 -->
  <div id="activityBar" class="activity-bar" hidden></div>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" type="text" placeholder="${vscode.l10n.t("Answer the Agent's question, then press Enter to submit")}" aria-label="${vscode.l10n.t("Answer the Agent's question")}" />
      <button id="clarifySend">${vscode.l10n.t('Submit answer')}</button>
    </div>
  </div>
  <!-- 审批卡（A 类决策面板）：classifyCommand 裁决需确认 / 脚本确认 / guest 写入时触发
       （owner 写文件已退役为直接落盘）。host 推送 write_confirm_request，webview 渲染此卡；
       用户确认/拒绝回传 write_confirm_answer。默认隐藏，由脚本按需显示（fail-closed：超时即拒）。
       位置红线（2026-10-05 实锤修复）：本卡原挂 #messages **内部**，是 #messages 的第 2 个
       子节点（紧跟 #emptyState）；#messages 是 overflow-y:auto 滚动容器且流式全程吸底
       （helpers/scrollToBottom.ts），视口钉在底部 ⇒ 卡永远停在消息流最顶端、视口之上，
       表现为「确认 UI 根本没弹」，超时后 fail-closed 自动拒绝（命令确认首跑即翻车；
       当时超时为 30s，2026-10-05 已放宽至 CONFIRM_TIMEOUT_MS = 30 分钟）。
       现归位到输入区紧上方（对齐 Cline / Roo 的「输入区上方动作区」形态）——与 #messages
       同级、不在其内，恒定可见。守卫：chatView.test.ts「审批卡锚点守卫」。 -->
  <div id="writeConfirmCard" class="write-confirm-card" hidden>
    <div class="write-confirm-card__body">
      <div class="write-confirm-card__head">
        <span class="write-confirm-card__tool" id="writeConfirmTool"></span>
        <span class="write-confirm-card__path" id="writeConfirmPath"></span>
      </div>
      <div class="write-confirm-card__desc" id="writeConfirmDesc"></div>
      <div class="write-confirm-card__countdown" id="writeConfirmCountdown" hidden></div>
      <details class="write-confirm-card__diff">
        <summary>${vscode.l10n.t('View content')}</summary>
        <pre id="writeConfirmDiff"></pre>
      </details>
      <!-- 等待态提示（2026-10-05 P5 落地 A）：点击裁决后**不收卡**，等宿主推下一条
           （write_confirm_request 覆盖渲染）或 write_confirm_closed 收卡。
           原实现点击即同步 closeWriteConfirmCard（现收口于 writeConfirmCardView.closeIfMatches）、
           下一条由宿主异步推 ⇒ 中间空档 = 闪烁；
           且队列无下一条时卡片会带旧内容滞留，形成重复提交窗口（宿主 pending 已delete，
           第二个 answer 静默丢弃 ⇒ 用户视角「点了没反应」）。本提示 + 按钮 disabled 消解之。 -->
      <div class="write-confirm-card__hint" id="writeConfirmHint" hidden></div>
      <div class="write-confirm-card__actions">
        <button id="writeConfirmReject" class="write-confirm-card__btn write-confirm-card__btn--reject">${vscode.l10n.t('Reject')}</button>
        <button id="writeConfirmOk" class="write-confirm-card__btn write-confirm-card__btn--ok">${vscode.l10n.t('Confirm')}</button>
      </div>
    </div>
  </div>
  <!-- 状态抽屉（C1 · ADR-037 形态宪法的结构落点）：
       唯一常驻状态面 = 入口 #dockChip——被收纳的活跃条 >0 时显「+N」，
       仅有时间段内容时显「活动」；未读挂 is-unread 徽章。从不自动弹（宪法④）。
       下拉体 #dockPanel 分两段：#dockControls 控件段（被收纳的活跃条由
       resolveDock 单实例搬运）+ #activityDetail 时间段（活动历史/诊断指标，
       静态固定，不再随瞬态条进出——P4 follower 机制在 C1 整组拆除）。
       静态序 chip → panel → inputBar：主位条归位插 inputBar 前，恒紧贴输入框，
       抽屉开合不挤占 A 类确认卡位置。 -->
  <button id="dockChip" class="status-dock__chip" type="button" title="${vscode.l10n.t('Status and activity')}" aria-expanded="false" hidden></button>
  <div id="dockPanel" class="status-dock__panel" hidden>
    <div id="dockControls" class="status-dock__controls" hidden></div>
    <div id="activityDetail" class="status-dock__timeline">
      <div id="activityList" class="activity-list"></div>
      <!-- 指标空态指引（showMetrics 默认关时指标块永不到达）：只解释「为什么空」，
           不参与时间线/未读判据（数据面真源仍是 activityMetrics 的渲染结果）。 -->
      <div id="activityMetricsEmpty" class="activity-metrics-empty">
        <span>${vscode.l10n.t('Metrics are hidden by default (developer debug info).')}</span>
        <button id="activityMetricsEmptyOpen" class="activity-metrics-empty__open" type="button">${vscode.l10n.t('Enable in settings')}</button>
      </div>
      <div id="activityMetrics" class="activity-metrics" hidden></div>
    </div>
  </div>
  <div id="inputBar">
    <!-- 一键到底（对齐 TRAE App / TraeWork「上滚后回到底部」）：真机反馈 2026-10-01——
         原挂在 #messages 内：#messages 是 overflow-y:auto 滚动容器，absolute 子元素随内容
         滚动（与 #planBar 注释警告过的同款错），表现为「和会话记录一起滚走」。挪到
         #inputBar 内（已 position:relative）锚定其顶边（bottom: calc(100% + sp-4)）=
         恒钉消息区可视框右下角，输入区多行增高时自动跟随，零补偿逻辑。守卫测试锁定：
         按钮不得是 #messages 后代（scroll-to-bottom-anchored 用例）。 -->
    <button id="scrollToBottomBtn" class="scroll-to-bottom" hidden
      title="${vscode.l10n.t('Back to bottom')}" aria-label="${vscode.l10n.t('Back to bottom')}">
      <span class="btn-icon" data-icon="scroll-bottom"></span>
    </button>
    <div id="inputWrap">
      <!-- 附件行（选择态行）：你亲手选的能力（skill）排在盒内文字上方——面单贴在信封上；
           盒外留给系统运行时条，两种来源由物理位置分界，不混住。空态 hidden 零高度。
           ⚠️ 能力选择 ≠ 附件：技能行保持独立（差异清单见台账 HOST-ATT-1） -->
      <div id="skillChips" class="skill-chip-row" hidden></div>
      <!-- 附件行（运行时挂载）：活动文件 / 注入 / 图片 / 引用回复 / 引用 chip 单点渲染
           （attachmentRowView）。原图片行 #imageChips 已并入本行（2026-11-11 汇流），
           不许再拆出第二条运行时行 -->
      <div id="refChips" class="skill-chip-row" hidden></div>
      <textarea id="input" rows="1" placeholder="${vscode.l10n.t('@ to reference files, / to pick a skill; Enter to send, Shift+Enter for newline')}" aria-label="${vscode.l10n.t('Message input')}"></textarea>
      <div id="inputFooter">
        <!-- Row 1 · 一级直面：左侧功能群 + 右侧唯一发送按钮（发送突出化） -->
        <div class="composer-row composer-row--main">
          <!-- 左侧功能群：Skill + 模型选择 + 润色（次级功能，弱化展示） -->
          <div class="composer-left">
            <!-- Skill 选择器：单图标（bolt SVG，图标语言唯一 = icons.ts 柔和线条）胶囊触发器，与模型选择器共用 capsule 变体；选择后作为 system prompt 传给 LLM。
                 Skill 名不常显（节省窄窗横向空间），当前项由触发器 .ctl--on（accent 图标染色）、菜单内 is-active 高亮、输入盒内 skill chip 与 title 兜底
                 触发器带 .ctl（输入区无边框基类），边框由 --dd-trigger-border 变量取值清零（见 chatStyles .composer-left），禁止在此另写 border 规则 -->
            ${buildDropdownHtml([], {
              extraClass: 'skill-picker treedd--capsule',
              triggerClass: 'ctl',
              onSelect: '__skillPickerOnSelect',
              triggerLabel: '<span class="btn-icon" data-icon="bolt"></span>',
              triggerTitle: vscode.l10n.t('Select skill'),
              triggerAriaLabel: vscode.l10n.t('Select skill'),
            })}
            <!-- 模型选择器：共用 capsule 变体，名称省略/菜单尺寸由 .model-picker 差异定制；触发器带 .ctl 去边框 -->
            ${buildDropdownHtml([], {
              extraClass: 'model-picker treedd--capsule',
              triggerClass: 'ctl',
              onSelect: '__modelPickerOnSelect',
              triggerLabel: vscode.l10n.t('Select model'),
              triggerTitle: vscode.l10n.t('Select model'),
              triggerAriaLabel: vscode.l10n.t('Select model'),
            })}
            <!-- 文本润色按钮：图标化，降低视觉权重（.ctl 无边框基类） -->
            <button id="polishBtn" class="polish-btn-icon ctl" title="${vscode.l10n.t('Polish input')}" aria-label="${vscode.l10n.t('Polish')}">
              <span class="btn-icon" data-icon="edit"></span>
            </button>
            <!-- 上传图片按钮（常驻，D27）：有视觉能力→发 image_pick_request；未声明→置灰可点跳设置。绑定/状态归 imageCapture，此处只出骨架 -->
            <button id="imageAttachBtn" class="image-attach-btn is-vision-off ctl" aria-disabled="true" title="${vscode.l10n.t('Image input is disabled for the current model — click to enable it in settings')}" aria-label="${vscode.l10n.t('Add image')}">
              <span class="btn-icon" data-icon="paperclip"></span>
            </button>
          </div>
          <!-- 右侧：主发送按钮（单图标三态：发送↑ / 停止■ / 继续▶，均无文字省空间）
               + 生成中另行暴露「暂停」软控制（Gap A），与「停止」并列、可经「继续」恢复 -->
          <div class="composer-right">
            <!-- 暂停按钮（Gap A）：仅生成中显隐（setStatus 控制 hidden），软暂停当前 Agent 执行。
                 「停止」丢弃本次流、「暂停」落检查点可恢复，二者语义区分、视觉同级弱化展示（.ctl 无边框基类） -->
            <button id="pauseBtn" class="pause-btn ctl" title="${vscode.l10n.t('Pause generation')}" aria-label="${vscode.l10n.t('Pause generation')}" hidden>
              <span class="btn-icon" data-icon="pause"></span>
            </button>
            <button id="send" class="send-btn-primary" title="${vscode.l10n.t('Send (Enter)')}" aria-label="${vscode.l10n.t('Send')}">
              <span class="send-icon" data-icon="send"></span>
              <span class="stop-icon" data-icon="stop"></span>
              <span class="play-icon" data-icon="play"></span>
            </button>
          </div>
        </div>
        <!-- Row 2 · 状态行：左角色/能力徽章 + 右上下文占用圆环（两端分布；占用属状态信息归本行，
             不干扰 Row 1 主操作；hover/聚焦**向上**弹卡片出「分层明细文字 + 占用构成条 +
             本轮注入回执行」，避免向下展开挤压面板底部）
             角色徽章 = button（可点跳转角色管理视图，open_settings_tab(roles) → memora.openSettings('roles')）：
             外观与旧 span 徽章完全一致（零常驻视觉增量，仅 hover 反馈 + title 提示可点），
             id 保持 currentRoleBadge 不变 ⇒ 现有 chat_role_pack 消费链路（含测试断言）零改动。 -->
        <div class="composer-row composer-row--status">
          <div class="composer-status">
            <button id="currentRoleBadge" class="role-badge" type="button" title="${vscode.l10n.t('Manage role packs')}"></button>
            <span id="currentCapabilityBadge" class="capability-badge" hidden></span>
          </div>
          <!-- 上下文占用圆环：常驻不占行，非噪点；首帧由 chat_providers 渲染所选模型容量上限，
               真实分层占用由首轮后 context_occupancy 覆盖。
               hover 卡片 = 分层明细文字（上）+ 占用构成条（中）+ 本轮注入回执行（最下）。
               构成条（HOST-S3-2）2026-10-18 由状态行常驻**移入卡片底部**：圆环（总量占比）与
               构成条（分段构成）同吃 context_occupancy，在输入条并排 = 同源信号双渲染
               （真机反馈「功能冲突」）⇒ 输入条只留圆环一个进度信号，构成一瞥改驻 hover 卡片，
               能力不撤。 -->
          <div id="contextOccupancy" class="context-ring" hidden>
            <svg class="context-ring__svg" viewBox="0 0 40 40" aria-hidden="true">
              <circle class="context-ring__track" cx="20" cy="20" r="16" />
              <circle class="context-ring__fill" id="occFill" cx="20" cy="20" r="16" />
            </svg>
            <span class="context-ring__percent" id="occPercent">0%</span>
            <div class="context-ring__tip" id="occTip" role="tooltip">
              <div class="context-ring__tip-text" id="occTipText"></div>
              <div id="occSegments" class="context-segments" hidden></div>
              <!-- 本轮注入回执行（HOST-CTX-4 ②）：2026-10-21 由状态行徽记迁入卡片底部——
                   状态行是稳定身份徽章的行，随挂载忽隐忽现的数字 pill 混入其中突兀（真机反馈）；
                   而它是预算归因数、与圆环同域 ⇒ 回位 hover 卡片，分项明细同屏可见。 -->
              <div id="occInjection" class="context-ring__injection" hidden></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- 运行时脚本由外部 chatView.js 提供（CSP script-src cspSource 加载） -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
