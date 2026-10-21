/**
 * StatusDock 挂载条容器（HOST-SPLIT-1 P2 chatView 第 6 刀 · 域外置工厂范式第 5 次复制）
 *
 * 域职责：StatusDock 上三条「常驻状态条」的渲染与生命周期——待发送区（pendingQueue）/
 * 未确认文件改动条（fileChanges）/ 后台任务条（background）。自 `chatView.ts` 外置
 * （方案见 `tasks/方案-HOST-SPLIT-1-chatView状态条域提取-20261021.md`）。
 *
 * **与 StatusDock 裁决器的分界（ADR-037 形态宪法）**：裁决器（resolveDock / dockEntries /
 * _dockExpanded / dockChip click）是共享基础设施，留在 chatView——pendingQueue /
 * fileChanges / background 三条仍消费它（经 deps.setDockActive / deps.registerDockEntry
 * 上报显隐）。本容器只负责「条内渲染 + 状态投影」，不裁决任何显隐（SSOT 归裁决器）。
 *
 * **跨触点契约（本刀相对前几刀多出的耦合面，须逐一面承接）**：
 *  ① 入：turn_update.pendingQueue 驱动 `updatePendingQueue`（替代原 updatePendingQueueBar）；
 *  ② 入：pending_discarded 事件经 `pushDiscarded` 压入丢弃缓冲（原 chatView L5062 直写
 *     `_pendingDiscardedBuffer`），缓冲随下一帧队列快照 diff 消耗；
 *  ③ 出：sendMessage 插话满员预检读 `getPendingCount()`（原 chatView L5895 读
 *     `_pendingQueueItems.length`，配 MAX_PENDING_INTERJECTIONS）；
 *  ④ 收：清空/切换会话的视图复位经 `reset()` 清两缓冲（原 chatView L4873/4882 直清）。
 * 即 pendingQueue 子域除自身渲染外，还有 3 个外部读/写触点——这就是它不能像
 * fileChanges/background 那样「纯自闭环」搬走的原因，窄接口须额外暴露这 3 个面。
 *
 * @module statusBarsView
 */
import type { BackgroundTaskView } from '../../shared/protocol.js';
import { getIconSvg, populateIcons } from './icons.js';

/** StatusDock 挂载条容器依赖：DOM 锚点 + 裁决器上报 2 面 + 插话回写 + postMessage */
export interface StatusBarsViewDeps {
  /** webview 文档对象（运行期创建三条 bar 用） */
  document: Document;
  /** #inputBar（三条 bar 均插入其之前，与裁决器注册共享同一父节点） */
  inputBar: HTMLElement;
  /** StatusDock 上报：条激活/收纳（窄化为本域合法 id 三选一，禁触其他条） */
  setDockActive: (
    id: 'pendingQueue' | 'fileChanges' | 'background',
    active: boolean,
  ) => void;
  /** StatusDock 注册：懒创建时挂条目（显隐裁决归裁决器） */
  registerDockEntry: (
    id: 'pendingQueue' | 'fileChanges' | 'background',
    el: HTMLElement,
  ) => void;
  /** 待发送区 diff「吸收时上屏」经此回写交互输入行（chatView 闭包局部函数，须注入） */
  appendInteractiveInput: (
    text: string,
    ts: string | undefined,
    kind: 'question-answer' | 'supplement' | 'timeout',
    roundId?: string,
    question?: string,
    options?: string[],
  ) => void;
  /** webview → 宿主消息出口（清空/删除/确认/回退/终止均只发消息，逻辑落 host） */
  postMessage: (msg: unknown) => void;
}

/** StatusBarsView 窄接口：chatView 仅经此七面驱动，域内状态/常量/内部函数零暴露 */
export interface StatusBarsView {
  /** 待发送区渲染（turn_update.pendingQueue 驱动；空数组=撤出） */
  updatePendingQueue: (items: readonly string[]) => void;
  /** 插话丢弃信号入缓冲（pending_discarded 事件；随下一帧快照 diff 消耗） */
  pushDiscarded: (items: readonly string[]) => void;
  /** 当前待发送投影长度（sendMessage 插话满员预检用） */
  getPendingCount: () => number;
  /** 未确认文件改动条渲染（空数组=撤出） */
  updateFileChanges: (files: readonly string[]) => void;
  /** 后台任务条渲染（空数组=撤出） */
  updateBackgroundTasks: (items: readonly BackgroundTaskView[]) => void;
  /** 清空/切换会话：清两投影缓冲（防跨会话残留误吞/误拦；不碰 DOM bar，与原 reset 等价） */
  reset: () => void;
  /** 清理三条 bar DOM（chatView.dispose 统一调用，防测试跨用例 detached-node 泄漏） */
  dispose: () => void;
}

/**
 * 创建 StatusDock 挂载条容器。
 *
 * @param deps document / inputBar / setDockActive / registerDockEntry /
 *   appendInteractiveInput / postMessage
 */
export function createStatusBarsView(deps: StatusBarsViewDeps): StatusBarsView {
  // ─── 待发送区（pendingQueue）───
  let _pendingQueueBar: HTMLElement | null = null;
  /** 队列快照投影（diff 上一帧）：空队列也要落缓存，否则满员预检读到上一次残留长度 */
  let _pendingQueueItems: readonly string[] = [];
  /** 丢弃信号缓冲（pending_discarded 事件载荷暂存）：diff 分流的依据——
   *  消失条目命中缓冲 = 丢弃（不上屏）；未命中 = 消费（内核已落盘 → 上屏「你补充」行）。
   *  生命周期 = 一帧（宿主契约：信号后必跟新快照，随下帧 diff 消耗）；视图复位时清空。 */
  let _pendingDiscardedBuffer: string[] = [];

  function updatePendingQueue(items: readonly string[]): void {
    // —— 吸收时上屏：队列快照 diff（必须在缓存覆盖前取上一帧）——
    // 消失条目 = 上帧有、本帧无（内容可能重复，按出现次数消耗）；再扣除丢弃缓冲，
    // 剩余 = 被内核消费（appendUserMessage 已落盘）→ 按 prev 顺序逐条上屏「你补充」行。
    // ts 用检测时刻 ≈ 内核落盘时刻（与重放排序同相）；行形态复用 appendInteractiveInput
    // 过程条目行（与 thought/tool 同源同序），不进消息流、不打断正文单块续写。
    const prevItems = _pendingQueueItems;
    if (prevItems.length > 0) {
      const remain = new Map<string, number>();
      for (const t of items) remain.set(t, (remain.get(t) ?? 0) + 1);
      const gone: string[] = [];
      for (const t of prevItems) {
        const c = remain.get(t) ?? 0;
        if (c > 0) remain.set(t, c - 1);
        else gone.push(t);
      }
      for (const t of gone) {
        const bi = _pendingDiscardedBuffer.indexOf(t);
        if (bi >= 0) {
          _pendingDiscardedBuffer.splice(bi, 1); // 丢弃：缓冲消耗，不上屏
        } else {
          deps.appendInteractiveInput(t, new Date().toISOString(), 'supplement');
        }
      }
    }
    // 投影缓存先于一切：空队列也要落缓存，否则满员预检读到上一次的残留长度
    _pendingQueueItems = [...items];
    // 空态在懒创建之前返回（与 updateFileChanges 同范式）：dock 注册初值 active=false，
    // 若先创建再以空数组 setDockActive(false) 属状态未变 no-op，resolveDock 永不裁决该节点，
    // 裸插入的空条会永久可见且任何后续空投影都关不掉。未创建 = DOM 中无此条，无需撤出。
    if (items.length === 0) {
      if (_pendingQueueBar) deps.setDockActive('pendingQueue', false); // 显隐裁决归 StatusDock（SSOT）
      return;
    }
    if (!_pendingQueueBar) {
      // 懒创建：顶行（徽章 + 标题 + 清空按钮）+ 列表（每条可独立删除）
      // 计数为圆形徽章（视觉聚焦），结构保持轻量无重造
      _pendingQueueBar = deps.document.createElement('div');
      _pendingQueueBar.className = 'pending-queue-bar';
      _pendingQueueBar.innerHTML = `
        <div class="pending-queue-bar__head">
          <span class="pending-queue-bar__badge"></span>
          <span class="pending-queue-bar__label">待发送</span>
          <span class="pending-queue-bar__hint">补充将紧随当前步骤后注入</span>
          <button class="pending-queue-bar__clear" type="button" title="清空全部" aria-label="清空全部待发送"><span class="btn-icon" data-icon="close"></span></button>
        </div>
        <div class="pending-queue-bar__list"></div>
      `;
      deps.inputBar.parentNode?.insertBefore(_pendingQueueBar, deps.inputBar);
      // 本节点运行期创建 → 初始化时的 populateIcons（document.body）未覆盖 → 此处补填充 data-icon
      populateIcons(_pendingQueueBar);
      deps.registerDockEntry('pendingQueue', _pendingQueueBar);
      const clearBtn = _pendingQueueBar.querySelector('.pending-queue-bar__clear');
      clearBtn?.addEventListener('click', () => {
        // 清空全部 interject（宿主层 chatPanel 清 _pendingQueue 并 post 空队列通知）
        deps.postMessage({ type: 'clear_pending_queue' });
      });
    }
    // 顶部：计数徽章（圆形，数字）+ 标题
    const badgeEl = _pendingQueueBar.querySelector('.pending-queue-bar__badge')!;
    badgeEl.textContent = String(items.length);
    // 列表容器重建（每次全量重渲染，items.length 小时成本可忽略）
    const listEl = _pendingQueueBar.querySelector('.pending-queue-bar__list')!;
    listEl.innerHTML = '';
    items.forEach((text, idx) => {
      const row = deps.document.createElement('div');
      row.className = 'pending-queue-bar__item';
      // 序号（1. / 2. / 3.）
      const num = deps.document.createElement('span');
      num.className = 'pending-queue-bar__num';
      num.textContent = `${idx + 1}.`;
      // 文本（过长截断，title 悬停看全文）
      const preview = deps.document.createElement('span');
      preview.className = 'pending-queue-bar__text';
      preview.textContent = text.length > 100 ? text.slice(0, 100) + '…' : text;
      preview.title = text;
      // 单条删除按钮
      const delBtn = deps.document.createElement('button');
      delBtn.className = 'pending-queue-bar__item-del';
      delBtn.type = 'button';
      delBtn.title = '删除这条';
      // 图标语言唯一 = icons.ts 柔和线条 SVG（注意 × 兼作语义乘号，
      // 如「工具×3」——“乘号”与“关闭图标”须靠位置区分，不可机械替换）
      delBtn.innerHTML = getIconSvg('close', 10, 10);
      delBtn.addEventListener('click', () => {
        deps.postMessage({ type: 'remove_pending_item', index: idx });
      });
      row.append(num, preview, delBtn);
      listEl.appendChild(row);
    });
    deps.setDockActive('pendingQueue', true); // 显隐裁决归 StatusDock（SSOT）
  }

  // ─── 文件改动常驻条（DIFF-1）───
  let _fileChangesBar: HTMLElement | null = null;
  /**
   * 未确认文件改动常驻条（懒创建，与 pending-queue-bar 同范式：插在输入栏之前）
   *
   * 两个动作按钮**不自己实现逻辑**，只 postMessage 给宿主 → 宿主 executeCommand 复用已注册命令
   * （与文件内 CodeLens / 状态栏 QuickPick / 命令面板同一实现，SSOT，无第二份清理逻辑）。
   * 「全部回退」是破坏性操作，宿主侧必弹模态二次确认——webview 不做前置拦截（拦截逻辑只能落 host）。
   * 计数只在宿主推来 file_changes 时更新：**webview 不自维护副本**（真源 = 宿主 tracker）。
   */
  function updateFileChanges(files: readonly string[]): void {
    if (files.length === 0) {
      if (_fileChangesBar) deps.setDockActive('fileChanges', false); // 显隐裁决归 StatusDock（SSOT）
      return;
    }
    if (!_fileChangesBar) {
      _fileChangesBar = deps.document.createElement('div');
      _fileChangesBar.className = 'file-changes-bar';
      _fileChangesBar.innerHTML = `
        <span class="file-changes-bar__badge"></span>
        <span class="file-changes-bar__label">个文件有未确认改动</span>
        <span class="file-changes-bar__spacer"></span>
        <button class="file-changes-bar__confirm" type="button" title="确认全部改动（仅清除本提示，不改文件内容）">全部确认</button>
        <button class="file-changes-bar__revert" type="button" title="回退全部改动到 agent 之前（不可撤销，需二次确认）">全部回退</button>
      `;
      deps.inputBar.parentNode?.insertBefore(_fileChangesBar, deps.inputBar);
      deps.registerDockEntry('fileChanges', _fileChangesBar);
      _fileChangesBar.querySelector('.file-changes-bar__confirm')?.addEventListener('click', () => {
        deps.postMessage({ type: 'confirm_all_file_changes' });
      });
      _fileChangesBar.querySelector('.file-changes-bar__revert')?.addEventListener('click', () => {
        deps.postMessage({ type: 'revert_all_file_changes' });
      });
    }
    const badge = _fileChangesBar.querySelector('.file-changes-bar__badge');
    if (badge) badge.textContent = String(files.length);
    // 悬停看完整文件清单（相对路径由宿主下发，webview 只展示不解析）
    _fileChangesBar.title = files.join('\n');
    deps.setDockActive('fileChanges', true); // 显隐裁决归 StatusDock（SSOT）
  }

  // ─── 后台任务条（CMD-1 阶段 2 · 方案-后台任务可见性与kill入口-20261004.md）───
  let _backgroundBar: HTMLElement | null = null;
  /**
   * 后台命令任务条（懒创建，与 pending-queue-bar 同范式）
   *
   * **webview 零自维护副本**：任务列表与状态标签（`statusLabel`，extension 侧读内核
   * `BACKGROUND_TASK_STATUS_LABELS` 填充后下发）全部来自快照，webview 只做「取数 → 渲染」。
   * 状态文案不下发枚举再自转（那要建第二套词表 = 双源漂移）。
   *
   * 「终止」按钮**不自己实现终止**：只 `postMessage` 回宿主（杀进程是宿主侧能力，
   * 且内核按 Agent 实例隔离——同 `confirm_all_file_changes` 的「拦截/执行只能落 host」定案）。
   *
   * 刻意不做：批量「全部终止」——破坏性批量操作，且内核只提供单任务 `kill`，超出本缺口。
   */
  function updateBackgroundTasks(items: readonly BackgroundTaskView[]): void {
    if (items.length === 0) {
      if (_backgroundBar) deps.setDockActive('background', false); // 显隐裁决归 StatusDock（SSOT）
      return;
    }
    if (!_backgroundBar) {
      _backgroundBar = deps.document.createElement('div');
      _backgroundBar.className = 'background-tasks-bar';
      _backgroundBar.innerHTML = `
        <div class="background-tasks-bar__head">
          <span class="background-tasks-bar__badge"></span>
          <span class="background-tasks-bar__label">后台任务</span>
        </div>
        <div class="background-tasks-bar__list"></div>
      `;
      deps.inputBar.parentNode?.insertBefore(_backgroundBar, deps.inputBar);
      deps.registerDockEntry('background', _backgroundBar);
    }
    const badge = _backgroundBar.querySelector('.background-tasks-bar__badge');
    if (badge) badge.textContent = String(items.length);
    // 列表容器全量重建（条数是个位数，成本可忽略）
    const listEl = _backgroundBar.querySelector('.background-tasks-bar__list')!;
    listEl.innerHTML = '';
    for (const task of items) {
      const row = deps.document.createElement('div');
      row.className = 'background-tasks-bar__item';
      // 命令原文（过长截断，title 悬停看全文）——不解析、不改写
      const text = deps.document.createElement('span');
      text.className = 'background-tasks-bar__text';
      text.textContent =
        task.command.length > 100 ? `${task.command.slice(0, 100)}…` : task.command;
      text.title = task.command;
      const status = deps.document.createElement('span');
      status.className = 'background-tasks-bar__status';
      status.textContent = task.statusLabel;
      row.append(text, status);
      // 终态行不给「终止」按钮：已结束的任务点终止 → 宿主 kill 返回 null（按「已终结」处理），
      // 按钮留着即「点了没反应」的僵尸交互
      if (task.status === 'running') {
        const killBtn = deps.document.createElement('button');
        killBtn.className = 'background-tasks-bar__kill';
        killBtn.type = 'button';
        killBtn.textContent = '终止';
        killBtn.title = '终止这条后台命令';
        killBtn.addEventListener('click', () => {
          deps.postMessage({ type: 'background_kill', taskId: task.taskId });
        });
        row.appendChild(killBtn);
      } else {
        // 终态行给 `×` 收起。⚠️ running 行**刻意不给收起**：进程在跑必须始终可见
        //（这正是本缺口最初的样子：「派了人出去办事，却不知道他还在不在」）。
        // 收起只对已结束的行开放，且**只关掉「眼睛」**——任务与输出仍在宿主侧，
        // `kill_command` 随时可取回（可逆 > 不可逆）。
        const dismissBtn = deps.document.createElement('button');
        dismissBtn.className = 'background-tasks-bar__dismiss';
        dismissBtn.type = 'button';
        dismissBtn.textContent = '×';
        dismissBtn.title = '从列表收起这条（不终止进程，输出仍可取回）';
        dismissBtn.setAttribute('aria-label', '收起这条后台任务');
        dismissBtn.addEventListener('click', () => {
          deps.postMessage({
            type: 'background_kill',
            taskId: task.taskId,
            reason: 'dismiss',
          });
        });
        row.appendChild(dismissBtn);
      }
      listEl.appendChild(row);
    }
    deps.setDockActive('background', true); // 显隐裁决归 StatusDock（SSOT）
  }

  // ── 窄接口（含跨触点面）──

  return {
    updatePendingQueue,
    pushDiscarded: (items: readonly string[]) => {
      // 插话丢弃信号：压入缓冲，随下一帧队列快照 diff 消耗（消失条目命中缓冲 = 丢弃不上屏）。
      // 时序契约：宿主保证本事件先于携带新快照的 turn_update 到达（postMessage FIFO）。
      _pendingDiscardedBuffer.push(...items);
    },
    getPendingCount: () => _pendingQueueItems.length,
    updateFileChanges,
    updateBackgroundTasks,
    /** 清空/切换会话：清两投影缓冲（防跨会话残留误吞/误拦 sendMessage 预检）。
     *  不碰 DOM bar——与原 reset 直清数组等价，bar 显隐由下次 update 或会话 DOM 重建接管。 */
    reset: () => {
      _pendingQueueItems = [];
      _pendingDiscardedBuffer = [];
    },
    /** 清理三条 bar DOM（chatView.dispose 统一调用；原域内状态随域收口清理面） */
    dispose: () => {
      for (const bar of [_pendingQueueBar, _fileChangesBar, _backgroundBar]) {
        bar?.parentNode?.removeChild(bar);
      }
      _pendingQueueBar = null;
      _fileChangesBar = null;
      _backgroundBar = null;
      _pendingQueueItems = [];
      _pendingDiscardedBuffer = [];
    },
  };
}
