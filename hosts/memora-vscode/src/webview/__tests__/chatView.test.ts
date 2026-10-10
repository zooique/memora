/**
 * chatView 测试 — clear_ok 消息区清理 + 过程事件单形态（v1.5）
 *
 * clear_ok 必须同时清 type=msg 消息与 .round-block 过程块，否则切换历史/清空后
 * 旧过程块残留 DOM。渲染层为单一形态：process_event（运行时增量）与 turn_update
 * （replay:true，RoundView.processEvents 整批）汇入同一 events[]，由 renderRoundBlock
 * 统一渲染（SSOT：无 tool-card / review-block / thought-block 独立卡片）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REAL_ROUND,
  PLAN_SNAPSHOTS,
  buildRealRoundTimeline,
} from './fixtures/realRound-1789565571934.js';
import {
  collectAllBodyText,
  dispatch,
  dispatchTurn,
  mountChatView,
} from './helpers/chatViewTestEnv.js';
// 断言与真源同源：上限值消费 shared/constants.ts（非字面量复制）
import {
  MAX_ASK_ANSWER_CHARS,
  MAX_INPUT_CHARS,
  MAX_PENDING_INTERJECTIONS,
} from '../../shared/constants.js';
import type {
  RoundView,
  BackgroundTaskView,
  ExtensionToWebviewMessage,
} from '../../shared/protocol.js';
import type { InteractiveInputKind } from '@zooique/memora';
import type { ProcessEvent } from '@zooique/memora';

/**
 * 2b-2b 换真源：发送 `turn_update` 状态快照（按钮语义唯一真源）
 *
 * 换源后按钮语义（loading/icon/title/disabled）只由 `turn_update.state` 驱动，
 * legacy `status` / `pause_pending` 不再参与骨架容器。本辅助统一收口各用例的
 * 驱动消息构造，rounds 取空数组（按钮语义不消费 rounds）。
 */

// ─── 重放驱动辅助：单条 turn_update(replay:true) 承载 rounds ─────────
//
// 会话重放真源为「单条 turn_update，replay:true 且 rounds[] 承载整批轮」（webview 不消费
// 旧 wire 消息）。下列辅助按「构造 RoundView → 单条 turn_update 分发」驱动重放断言，
// 渲染语义对齐 chatView.ts renderReplayRound（见 protocol.ts turn_update 注释）。

/**
 * 构造单轮 RoundView 工厂（重放断言驱动）
 *
 * 各段未显式声明时走空态（无用户输入 / 无正文 / 无过程事件），渲染侧按内容缺省跳过。
 */
function makeRound(over: {
  id?: string;
  user?: { content: string; ts?: string };
  assistantLog?: { content: string; ts?: string }[];
  interactiveInputs?: {
    content: string;
    ts?: string;
    kind: InteractiveInputKind;
    question?: string;
    options?: string[];
  }[];
  assistantMessage?: { content: string; ts?: string };
  processEvents?: unknown[];
  status?: 'pending' | 'complete' | 'error' | 'interrupted';
}): RoundView {
  const roundId = over.id ?? 'round-x';
  return {
    id: roundId,
    // userMessage 内核必填：无用户输入用例以空 content 占位（renderReplayRound 按 content 跳过渲染）
    userMessage: over.user
      ? {
          id: `${roundId}-user`,
          role: 'user',
          content: over.user.content,
          timestamp: over.user.ts ?? '',
        }
      : { id: `${roundId}-placeholder-user`, role: 'user', content: '', timestamp: '' },
    ...(over.assistantLog
      ? {
          // 前序 assistant 段数组（UI 上与 final 区分，同 roundId 同容器）
          assistantLog: over.assistantLog.map((a, i) => ({
            id: `${roundId}-seg-${i}`,
            role: 'assistant' as const,
            content: a.content,
            timestamp: a.ts ?? '',
          })),
        }
      : {}),
    ...(over.interactiveInputs
      ? {
          // 交互输入行（qa/supplement/timeout），渲染端按 ts 与前序段交织排序
          interactiveInputs: over.interactiveInputs.map((it, i) => ({
            id: `${roundId}-ii-${i}`,
            role: 'user' as const,
            content: it.content,
            timestamp: it.ts ?? '',
            kind: it.kind,
            ...(it.question ? { question: it.question } : {}),
            ...(it.options ? { options: it.options } : {}),
          })),
        }
      : {}),
    ...(over.assistantMessage
      ? {
          // 末段回答（仅 complete 轮挂正文）
          assistantMessage: {
            id: `${roundId}-reply`,
            role: 'assistant' as const,
            content: over.assistantMessage.content,
            timestamp: over.assistantMessage.ts ?? '',
          },
        }
      : {}),
    ...(over.processEvents ? { processEvents: over.processEvents as ProcessEvent[] } : {}),
    status: over.status ?? 'complete',
    createdAt: over.user?.ts ?? '',
    ...(over.assistantMessage ? { completedAt: over.assistantMessage.ts ?? '' } : {}),
  };
}

/** 分发一条重放快照：单条 turn_update（replay:true，rounds 单轮承载） */
function dispatchReplay(view: RoundView): void {
  dispatch({
    type: 'turn_update',
    rounds: [view],
    state: { phase: 'settled', roundId: view.id, status: view.status },
    replay: true,
  });
}

/** 分发一条重放快照：单条 turn_update（replay:true，rounds 整批承载） */
function dispatchReplayMany(views: RoundView[]): void {
  dispatch({
    type: 'turn_update',
    rounds: views,
    state: {
      phase: 'settled',
      roundId: views[0]?.id ?? '',
      status: views[0]?.status ?? 'complete',
    },
    replay: true,
  });
}

describe('chatView clear_ok 消息区清理', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发送 ready 通知 extension 会话可安全回放', () => {
    const { postMessage } = mountChatView();
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('chat_role_pack 渲染当前角色到输入区左侧角色徽章（只读状态展示，2026-08-17）', () => {
    mountChatView();
    const badge = document.getElementById('currentRoleBadge') as HTMLElement;
    // 初始无角色名 → 徽章隐藏
    expect(badge.hidden).toBe(true);

    // 推送当前角色（personaSwitched / 会话回放路径）
    dispatch({ type: 'chat_role_pack', rolePack: '文档打磨' });

    // 徽章显示角色显示名（textContent 赋值防注入）
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('文档打磨');

    // 切回空名 → 徽章重新隐藏
    dispatch({ type: 'chat_role_pack', rolePack: '' });
    expect(badge.hidden).toBe(true);
  });

  it('小组会议图标单例幂等：chat_role_pack 重复到达不重复创建（身份即单例引用，非字符串复查找回）', () => {
    mountChatView();
    const icons = () => document.querySelectorAll('.team-meeting-icon');

    // 无队伍 → 懒创建不触发，不渲染图标（不白占 DOM）
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(icons()).toHaveLength(0);

    // 带队伍推送 → 创建 1 个图标并显示，tooltip 给出组长/组员
    const team = { leader: '共鸣小说家', members: ['编辑', '评论家'] };
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家', team });
    expect(icons()).toHaveLength(1);
    const icon = icons()[0] as HTMLElement;
    expect(icon.parentElement?.classList.contains('composer-status')).toBe(true);
    expect(icon.hidden).toBe(false);
    expect(icon.title).toContain('组长：共鸣小说家');
    expect(icon.title).toContain('组员：编辑、评论家');

    // 点击 → 输入框填充「小组会议：」前缀（启动小组会议的唯一交互入口）
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '讨论选题';
    (icon as HTMLButtonElement).click();
    expect(input.value).toBe('小组会议：讨论选题');

    // 回归（启动时 replaySession + 装配后补推各推一次）→ 复用同一元素，不得出现第 2 个图标
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家', team });
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家', team });
    expect(icons()).toHaveLength(1);
    expect(icon.isConnected).toBe(true);

    // 队员名单变化 → 复用同一元素，仅刷新 tooltip
    dispatch({
      type: 'chat_role_pack',
      rolePack: '共鸣小说家',
      team: { leader: '共鸣小说家', members: ['校对'] },
    });
    expect(icons()).toHaveLength(1);
    expect(icons()[0]).toBe(icon);
    expect(icon.title).toContain('组员：校对');

    // 队伍清空（切到非组长 / 无队伍）→ 隐藏但保留单例（再次推送仍复用）
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(icon.hidden).toBe(true);
    expect(icons()).toHaveLength(1);
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家', team });
    expect(icon.hidden).toBe(false);
    expect(icons()).toHaveLength(1);
  });

  it('clear_ok 同时清空 .msg 与 .round-block 残留，并恢复空状态', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const emptyState = document.getElementById('emptyState') as HTMLElement;

    // 预先塞入一条消息 + 过程折叠区（模拟历史回放后残留）
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    messages.appendChild(msg);
    const block = document.createElement('details');
    block.className = 'round-block';
    messages.appendChild(block);
    expect(messages.querySelectorAll('.msg, .round-block')).toHaveLength(2);

    dispatch({ type: 'clear_ok' });

    // 消息与过程折叠区都必须被清空，且空状态提示恢复显示
    expect(messages.querySelectorAll('.msg, .round-block')).toHaveLength(0);
    expect(emptyState.hidden).toBe(false);
  });

  it('clear_ok 保留 #emptyState 占位（不整段清空 messages）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'clear_ok' });
    // 占位节点不被删除，仅消息类节点被清理
    expect(messages.querySelector('#emptyState')).not.toBeNull();
  });

  it('self_review 过程事件进入 round-block § 自审查输出（v1.5 单形态）', () => {
    mountChatView();
    // meta 开新轮 → 正文块（挂载 round-block）→ 自审查过程事件 → 收尾渲染
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '回答' });
    dispatch({
      type: 'process_event',
      event: { type: 'self_review', seq: 2, ts: '', payload: {} },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    expect(rb.textContent).toContain('自审查终审');
    // summary 也有审查计数
    expect(rb.textContent).toContain('审查 1 次');
  });

  it('流式 chunk 与 process_event 交错后仍追加到同一条 assistant 消息（P0-1 锚点）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // 模拟「文本 → 工具过程事件 → 文本」循环：过程事件到达不应拆散同一条回复
    dispatch({ type: 'chunk', content: '思考第一段' });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 1,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok' },
      },
    });
    dispatch({ type: 'chunk', content: '思考第二段' });
    dispatch({ type: 'chunk', content: '思考第三段' });
    // 流式结束（触发最终收敛渲染，节流渲染未到时也由 done 兜底）
    dispatch({ type: 'done' });

    // 同一条回复应只有一条 assistant 消息，三段文本拼接在其内
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    // 多段模式：正文可能拆分到多个 .msg-content 段，取所有 body 文本拼接（SSOT 断言结构无关）
    expect(collectAllBodyText(assistants[0])).toBe('思考第一段思考第二段思考第三段');
  });

  it('暂停→继续全时序：resume 的 meta 不建新骨架，chunk 原位续写暂停块（双块分裂防回归）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮生成：meta 建骨架 + 首段正文（roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '暂停前正文', roundId: 'r1' });
    // ② 暂停：记录暂停块锚点（activeAssistantEl 存为 pausedAssistantEl）
    dispatch({ type: 'paused' });
    // ③ resume 后 host 重新 emit meta（真实链路 consumeFlow 每次 runFlow 重发 meta，
    //    pausedResume 分支须不建骨架、保留锚点——若无条件 prepareFlowShell 建块 B，会劫持
    //    后续 chunk → 视觉上两个独立 LLM 回答（坑））
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // ④ resume 后首 text chunk（同 roundId）：应原位续写暂停块，不新建第 2 块
    dispatch({ type: 'chunk', content: '暂停后正文', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });

    // 同一问答闭环只有一个 assistant 块，两段正文拼接缝合
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('暂停前正文暂停后正文');
  });

  it('暂停后中断（interrupted）：清暂停锚点，下轮新闭环 meta 正常建骨架（对称雷防回归）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮：meta + 正文（roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '暂停前半', roundId: 'r1' });
    // ② 暂停 → 中断（用户放弃暂停态，直接停止）
    dispatch({ type: 'paused' });
    dispatch({ type: 'interrupted', roundId: 'r1' });
    // ③ 新闭环：user（无 kind，新问题）+ meta + chunk —— 应新建骨架块（锚点已清，不残留续写）
    dispatch({ type: 'user', text: '新问题', ts: '2026-09-07T10:00:00.000Z' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '新回答', roundId: 'r2' });
    dispatch({ type: 'done', roundId: 'r2' });

    // 两块各自独立：暂停前的半截块（收尾）+ 新闭环新块（不误续写到旧暂停块）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    // 第二个块 = 新回答（未拼接旧正文）
    expect(collectAllBodyText(assistants[1])).toBe('新回答');
  });

  it('暂停态补充输入：user(kind=supplement) → resume meta 分块续接（SSOT 收窄 2026-09-08：与重放穿插同构）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮生成：meta 建骨架 + 首段正文（roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '暂停前正文', roundId: 'r1' });
    // ② 暂停
    dispatch({ type: 'paused' });
    // ③ 暂停态补充输入（宿主 handleSend paused 分支：post user(kind=supplement) + resumeExecution(input)）
    dispatch({
      type: 'user',
      text: '补充：成本标准改 <¥0.5',
      ts: '2026-09-07T11:00:00.000Z',
      kind: 'supplement',
    });
    // ④ resume 重发 meta——交互 resume 一律原位续写同回合：pausedResume 判定优先
    //   （无 `!interactiveRowInserted` 门控），补充行作 turn 内过程、不进续接骨架分块
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // ⑤ resume 后正文 chunk（同 roundId）：原位续写原暂停块（单一折叠块语义，与重放整 round 折叠同构）
    dispatch({ type: 'chunk', content: '已按补充调整成本标准', roundId: 'r1' });
    // done 收敛：单一折叠块重渲染（流式渲染 150ms 节流，断言放 done 后读全量聚合）
    dispatch({ type: 'done', roundId: 'r1' });
    // 补充行作 turn 内过程随折叠块折入，正文原位续写合并为单块
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('暂停前正文已按补充调整成本标准');
    const qaRow = messages.querySelector('.round-block__input') as HTMLElement;
    expect(qaRow).not.toBeNull();
  });

  it('error 后可继续：补充行已插 → resume 前 error → 再 resume 原位续写（2026-09-15 方案 C 撤销分块门控）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮正文（roundId r1）→ 块1（activeAssistantEl=块1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '前序正文', roundId: 'r1' });
    // ② 暂停（置 pausedAssistantEl=块1）
    dispatch({ type: 'paused' });
    // ③ 暂停态补充输入（交互行上屏，无骨架——resume 尚未开始）
    dispatch({ type: 'user', text: '补充', ts: '2026-09-07T11:05:00.000Z', kind: 'supplement' });
    // ④ resume 流启动即失败（宿主 runFlow 同步抛错路径：error 在 meta 前到达）——
    //    error 属可恢复中断
    dispatch({ type: 'error', message: 'boom' });
    // ⑤ 用户再次继续 → resume meta：无分块门控 → pausedResume 原位续写原暂停块
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '错误后续写', roundId: 'r1' });
    // done 收敛：单一折叠块重渲染（流式渲染 150ms 节流，断言放 done 后读全量聚合）
    dispatch({ type: 'done', roundId: 'r1' });
    // 块1 被原位续写合并
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants.length).toBe(1);
    expect(collectAllBodyText(assistants[0])).toBe('前序正文错误后续写');
    const qaRow = messages.querySelector('.round-block__input') as HTMLElement;
    expect(qaRow).not.toBeNull();
  });

  it('暂停补充后再追问：补充轮原位续写、下轮不误续写（2026-09-15 方案 C：resumePending 已消费）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮：meta + 正文（roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '第一段', roundId: 'r1' });
    // ② 暂停 → 补充输入（置 resumePending）
    dispatch({ type: 'paused' });
    dispatch({ type: 'user', text: '补充', ts: '2026-09-07T11:01:00.000Z', kind: 'supplement' });
    // ③ resume meta：pausedResume 优先原位续写（消费 resumePending，不建续接骨架）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '续写', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // ④ 新闭环（无 kind）：真新轮应清空锚点建新骨架（不受残留 resumePending 影响）
    dispatch({ type: 'user', text: '新问题', ts: '2026-09-07T11:02:00.000Z' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '新回答', roundId: 'r2' });
    dispatch({ type: 'done', roundId: 'r2' });

    // 补充轮合并为 1 块（原位续写→单一折叠块语义）、新问题独立建块不误续写
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    expect(collectAllBodyText(assistants[0])).toBe('第一段续写');
    expect(collectAllBodyText(assistants[1])).toBe('新回答');
  });

  it('ask_user 问答：paused → QA 行 → resume meta 原位续写（QA 作 turn 内过程，2026-09-15 方案 C）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 提问前正文：meta 建骨架 + 首段正文（roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '提问前正文', roundId: 'r1' });
    // ② LLM 调用 ask_user 暂停 → 提问块（ask-inline）挂出（消息流渲染，此处省略交互 DOM）
    dispatch({ type: 'paused' });
    // ③ 用户回答：宿主 post user(kind=question-answer)（运行时无 question 回顾行，仅回答行）
    dispatch({
      type: 'user',
      text: '选方案 A',
      ts: '2026-09-07T12:00:00.000Z',
      kind: 'question-answer',
      roundId: 'r1',
    });
    // ④ resume 重发 meta——pausedResume 优先原位续写（不移除 QA 锚、不开续接骨架分块）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // ⑤ resume 后正文 chunk（同 roundId）：原位续写原暂停块（单一折叠块语义，与重放整 round 折叠同构）
    dispatch({ type: 'chunk', content: '已按方案 A 执行完毕', roundId: 'r1' });
    // done 收敛：单一折叠块重渲染（流式渲染 150ms 节流，断言放 done 后读全量聚合）
    dispatch({ type: 'done', roundId: 'r1' });
    // 单一连续正文块 + QA 行作 turn 内过程随折叠块折入（不分段）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('提问前正文已按方案 A 执行完毕');
    // 你答行进入本轮折叠块（过程位，随折叠折入）
    const qaRow = messages.querySelector('.round-block__input') as HTMLElement;
    expect(qaRow).not.toBeNull();
    expect(qaRow.querySelector('.round-block__input-tag')?.textContent).toBe('你答');
  });

  it('同轮连环 ask：resume 无正文再问 → 第二轮 QA 恒插第一轮后（运行时=重放 ts 序，2026-09-09 T2）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首段正文 + 首次 ask 挂起（块A 暂停锚，roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '第一问前正文', roundId: 'r1' });
    dispatch({ type: 'paused' });
    // ② 第一答（带 question → 「问」行 + 「你答」折叠块）
    dispatch({
      type: 'user',
      text: '选方案 A',
      ts: '2026-09-08T10:00:00.000Z',
      kind: 'question-answer',
      roundId: 'r1',
      question: '选哪个方案？',
      options: ['方案 A', '方案 B'],
    });
    // ③ resume：meta → 续接骨架挂第一问答对之后；LLM 无正文、直接二次 ask_user 再挂起
    //    （骨架空正文，二次回答提交时被 user 分支移除 → activeAssistantEl 回退块A = 倒挂根源）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'paused' });
    // ④ 第二答（同样带 question）——第二轮 QA 对不得被顶到第一轮之前（锁顺序）
    dispatch({
      type: 'user',
      text: '选方案 B',
      ts: '2026-09-08T10:01:00.000Z',
      kind: 'question-answer',
      roundId: 'r1',
      question: '确认改为 B？',
      options: ['方案 B', '方案 A'],
    });
    // 运行时形态（done 前）：第二轮 QA 条目必须归属本轮 process-flow 过程容器、紧跟第一轮之后——
    // 不得因 assistant 锚回退/失效散落消息流层（形态甲：QA 按 ts 归位过程容器，SSOT 无第二渲染体系）
    const flowRun = document.querySelector<HTMLElement>('.process-flow');
    expect(flowRun).not.toBeNull();
    const flowInputsRun = flowRun
      ? Array.from(flowRun.querySelectorAll<HTMLElement>('.round-block__input'))
      : [];
    expect(flowInputsRun).toHaveLength(2);
    const strayRun = Array.from(messages.children).filter(
      (el) => el instanceof HTMLElement && el.classList.contains('round-block__input'),
    );
    expect(strayRun).toHaveLength(0);

    // ⑤ resume → 续跑正文 → done
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '已按方案 B 继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });

    // 期望 = 重放 ts 交织序：[块A] → 条目1（问1+你答1）→ 条目2（问2+你答2）→ [正文续接]（运行时=重放同构）
    // 形态甲：问行+答行合并为单条目（.round-block__input 内含 .input-q 回顾行），按 ts 归位
    const inputs = Array.from(document.querySelectorAll<HTMLElement>('.round-block__input'));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.querySelector('.round-block__input-q')?.textContent).toContain(
      '选哪个方案？',
    );
    expect(inputs[1]!.querySelector('.round-block__input-q')?.textContent).toContain(
      '确认改为 B？',
    );
    expect(
      inputs[0]!.querySelector('.round-block__input-row .round-block__input-tag')?.textContent,
    ).toBe('你答');
    // 时序断言（文档树序，ts 归位）：条目1 在 条目2 前（运行时=重放 ts 序不倒挂）
    const seq = Array.from(document.querySelectorAll<HTMLElement>('.round-block__input'));
    expect(seq.indexOf(inputs[0] as HTMLElement)).toBeLessThan(
      seq.indexOf(inputs[1] as HTMLElement),
    );
  });

  it('交互行渲染异常 → 兜底降级可见：用户输入不丢，resume 后原位续写（ensureUserInputVisible，2026-09-15 方案 C）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // ① 首轮：meta + 正文（roundId r1）—— 建立 activeAssistantEl 锚点（块A）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '前序正文', roundId: 'r1' });
    // ② ask_user 暂停（pausedAssistantEl = 块A）
    dispatch({ type: 'paused' });
    // ③ 注入 DOM 异常：qa 条目经 appendChild 渲染时抛错（形态甲：条目构建走 appendChild/append，
    //    仅拦截下一次调用）
    const spy = vi.spyOn(Element.prototype, 'appendChild').mockImplementationOnce(() => {
      throw new Error('injected-dom-failure');
    });
    dispatch({
      type: 'user',
      text: '我的回答',
      ts: '2026-09-08T15:00:00.000Z',
      kind: 'question-answer',
      roundId: 'r1',
    });
    spy.mockRestore();

    // ④ 兜底降级块可见（输入恒不丢）+ 取证 console.warn 已调用
    const fb = messages.querySelector('.msg-user-fallback') as HTMLElement;
    expect(fb).not.toBeNull();
    expect(fb.textContent).toBe('我的回答');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memora] 用户输入渲染失败'),
      expect.anything(),
    );

    // ⑤ resume 后原位续写原暂停块（渲染异常不破坏单一折叠块语义）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '最终正文', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('前序正文最终正文');

    warnSpy.mockRestore();
  });

  it('clear_ok 后流式锚点失效，后续 chunk 重建一条 assistant 消息（P0-1）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    dispatch({ type: 'chunk', content: '第一段' });
    dispatch({ type: 'clear_ok' });
    dispatch({ type: 'chunk', content: '重放后' });

    // 清空后仅剩重建的一条 assistant 消息（旧锚点已失效，不残留）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('重放后');
  });

  it('对话后新建会话：clear_ok 清空全部消息与空骨架（无顶部空白残留）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    // 会话 A 对话：用户消息（包 .msg-wrapper）+ AI 回答 + 空骨架轮
    dispatch({ type: 'user', text: '问题A', ts: '2026-08-14T10:00:00.000Z' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '回答A' });
    dispatch({ type: 'done', roundId: 'r1' });
    dispatch({ type: 'user', text: '问题B', ts: '2026-08-14T10:01:00.000Z' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'done', roundId: 'r2' });
    // 断言：清空前用户消息外层 .msg-wrapper 存在
    expect(messages.querySelectorAll('.msg-wrapper').length).toBe(2);
    // 新建会话 B：clear_ok 应清空全部（.msg 与 .msg-wrapper 外层都不残留）
    dispatch({ type: 'clear_ok' });
    expect(messages.querySelectorAll('.msg, .msg-wrapper').length).toBe(0);
  });

  it('无缝插话：流式中收到 user 复位锚点，下条 chunk 开新助手块且排在用户消息之后（缺口 B 排序）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // 生成中用户 Enter 补充（宿主 handleSend → agent.interject → UI 上屏 user）
    dispatch({ type: 'chunk', content: '第一段' }); // 开始流式：assistant 锚点
    dispatch({ type: 'user', text: '补充要求', ts: '2026-08-14T10:00:00.000Z' }); // 插话复位锚点
    dispatch({ type: 'chunk', content: '第二段' }); // 下一条 chunk：开新助手块
    dispatch({ type: 'done' }); // 结束流式（幂等）

    // 应拆成「两块助手 + 一条用户插话」，顺序：assistant → user → assistant
    const order = Array.from(messages.querySelectorAll('.msg')).map((m) => m.className);
    expect(order).toEqual(['msg assistant', 'msg user', 'msg assistant']);
    // 插话后内容落在新的助手块（不与「第一段」拼接）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    expect(collectAllBodyText(assistants[0])).toBe('第一段');
    expect(collectAllBodyText(assistants[1])).toBe('第二段');
  });

  it('历史切换重建：clear_ok 后重放 user/assistant 消息正常渲染（ui-redesign 历史加载链路）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const emptyState = document.getElementById('emptyState') as HTMLElement;

    // 会话重放由单条 turn_update(replay:true) 承载——rounds 内同时含用户输入 + 最终回答
    dispatchReplay(
      makeRound({
        id: 'round-yesterday',
        user: { content: '昨天的问题', ts: '2026-08-14T09:00:00.000Z' },
        assistantMessage: { content: '昨天的回答', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );

    // 重放的两条消息都应渲染，且空状态隐藏
    const msgs = messages.querySelectorAll('.msg');
    expect(msgs).toHaveLength(2);
    expect(messages.querySelector('.msg.user .msg-body')?.textContent).toBe('昨天的问题');
    // assistant 经 Markdown 渲染（marked 包 <p>）→ 修剪尾换行后比对原文
    expect(messages.querySelector('.msg.assistant .msg-body')?.textContent?.trim()).toBe(
      '昨天的回答',
    );
    expect(emptyState.hidden).toBe(true);
  });

  it('thinking 过程事件：流式中进入 round-block 实时相位行（进行中展开），收尾后归档 § 过程轨迹', () => {
    mountChatView();
    // 生成中先有 meta → 正文块挂载 round-block；thinking 事件流式中实时投影相位行
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '回答' });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'assembling' } },
    });
    // 流式中（v1.8 剪枝）：无 round-block 壳，过程平铺在 .process-flow——thinking 相位轻量行实时显示
    const rbRunning = document.querySelector('.process-flow') as HTMLElement;
    expect(rbRunning).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时绝无大折叠壳
    const phaseRow = rbRunning.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow).not.toBeNull();
    expect(phaseRow.textContent).toContain('装配上下文中');
    // 收尾后：折叠区收起（open=false）、相位行移除；§ 过程轨迹保留相位时间线
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 3, ts: '', payload: { phase: 'llm_calling' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 4, ts: '', payload: { phase: 'archiving' } },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLDetailsElement;
    expect(rb.classList.contains('is-running')).toBe(false);
    expect(rb.open).toBe(false);
    expect(rb.querySelector('.round-block__phase')).toBeNull();
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('装配上下文中');
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('调用模型中');
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('归档记忆中');
  });

  it('过程轨迹聚合：同一 thinking 相位 N 次压缩为「相位 ×N」一行，去视觉噪点（2026-09-09）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正文' });
    // 同一相位「调用模型中」连续 5 次（LLM 多轮调用）+ 单次「装配上下文中」——模拟真实冗长轨迹
    for (let i = 0; i < 5; i++) {
      dispatch({
        type: 'process_event',
        event: { type: 'thinking', seq: 2 + i, ts: '', payload: { phase: 'llm_calling' } },
      });
    }
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 8, ts: '', payload: { phase: 'assembling' } },
    });
    dispatch({ type: 'done' });
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const rows = Array.from(details.querySelectorAll('.round-block__row')).map(
      (r) => r.textContent,
    );
    // 聚合：同相位合并计次（×5；phaseLabel 输出含「…」省略号），单次相位直显不赘 ×1；
    // 行数 = 相位种类（2），不随事件数（6）膨胀
    expect(rows.some((r) => r.includes('×5'))).toBe(true);
    expect(rows.some((r) => r.includes('装配上下文'))).toBe(true);
    expect(details.querySelectorAll('.round-block__row')).toHaveLength(2);
  });

  it('metrics 渲染 token 用量与记忆治理字段（alignment-iteration.md D）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123' },
      metrics: {
        llmCallCount: 3,
        toolFailureCount: 1,
        truncationCount: 0,
        llmTokenIn: 1000,
        llmTokenOut: 500,
      },
    });
    expect(metrics.hidden).toBe(false);
    expect(metrics.textContent).toContain('入 1000');
    // 口径标注：输出只计正文、不含思考（旧断言「出 500」对应未标注的误导形态）
    expect(metrics.textContent).toContain('正文 500（不含思考）');
  });

  it('收起态 dockChip 收为左侧小气泡（is-collapsed），展开态恢复全宽 pill（用户诉求 2026-10-07）', () => {
    mountChatView();
    const dockChip = document.getElementById('dockChip') as HTMLElement;
    // 推一条 metrics ⇒ 时间线有内容 ⇒ 入口常驻可见，且处于收起态
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123' },
      metrics: { llmCallCount: 1, toolFailureCount: 0, truncationCount: 0 },
    });
    expect(dockChip.hidden).toBe(false);
    expect(dockChip.classList.contains('is-collapsed')).toBe(true);
    expect(document.body.classList.contains('dock-collapsed')).toBe(true);
    // 点开抽屉 = 展开态：is-collapsed 撤销，恢复现状全宽 pill + 抽屉
    dockChip.click();
    expect(dockChip.classList.contains('is-collapsed')).toBe(false);
    expect(document.body.classList.contains('dock-collapsed')).toBe(false);
  });

  it('metrics 渲染预算分配构成（④ 策略可视化，可选字段缺省不显示）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: {
        llmCallCount: 1,
        toolFailureCount: 0,
        truncationCount: 0,
        llmTokenIn: 1000,
        llmTokenOut: 500,
        budget: {
          availableTokens: 97_000,
          anchorTokens: 200,
          remainingTokens: 96_800,
          dialogueBudgetTokens: 87_120,
        },
      },
    });
    expect(metrics.hidden).toBe(false);
    // 预算行展示：可用/锚点/对话层/剩余（k 缩写）
    expect(metrics.textContent).toContain('预算：可用 97k');
    expect(metrics.textContent).toContain('锚点 200');
    expect(metrics.textContent).toContain('对话层 87k');
    expect(metrics.textContent).toContain('剩余 97k');
  });

  it('metrics 缺省 budget 时不显示预算行（可选字段非必填）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: { llmCallCount: 0, toolFailureCount: 0, truncationCount: 0 },
    });
    expect(metrics.textContent).not.toContain('预算：');
  });

  it('metrics 渲染最近操作流（B9 透明面板 trace 展示）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123' },
      metrics: {
        llmCallCount: 3,
        toolFailureCount: 1,
        truncationCount: 0,
      },
      trace: [{ label: '响应生成' }, { label: '工具·read_file' }, { label: '压缩摘要' }],
    });
    expect(metrics.hidden).toBe(false);
    expect(metrics.textContent).toContain('操作流');
    expect(metrics.textContent).toContain('› 响应生成');
    expect(metrics.textContent).toContain('› 工具·read_file');
    expect(metrics.textContent).toContain('› 压缩摘要');
  });

  it('metrics 无操作流时渲染不受影响（trace 缺省）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123' },
      metrics: {
        llmCallCount: 1,
        toolFailureCount: 0,
        truncationCount: 0,
      },
    });
    expect(metrics.hidden).toBe(false);
    // 未携带 trace / trace 为空 → 不出现「操作流」段
    expect(metrics.textContent).not.toContain('操作流');
  });
});

describe('chatView 打断能力（mvp-scope stop / 插话）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('生成中（status thinking）输入框保持可用（支持插话）', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    // 插话能力前提：生成中不禁用输入框，用户可输入新消息 → Enter 打断当前生成并重发
    expect(input.disabled).toBe(false);
  });

  it('运行时（thinking）禁用会话导航类控件：新建/历史/删除按钮全 disabled', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'thinking' });
    expect((document.getElementById('newSessionBtn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('historyBtn') as HTMLButtonElement).disabled).toBe(true);
    // 已渲染的 AI 消息删除按钮同样被锁（重放单条 turn_update 渲染消息，锁态因 thinking 生效）
    dispatchReplay(
      makeRound({
        id: 'round-x',
        assistantMessage: { content: '回答', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('非运行时（done）恢复会话导航类控件：新建/历史/删除按钮全 enabled', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'thinking' });
    dispatchReplay(
      makeRound({
        id: 'round-x',
        assistantMessage: { content: '回答', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );
    dispatch({ type: 'status', state: 'done' });
    expect((document.getElementById('newSessionBtn') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('historyBtn') as HTMLButtonElement).disabled).toBe(false);
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    expect(del.disabled).toBe(false);
  });

  it('暂停态（paused）同样禁用会话导航类控件（运行时挂起从严）', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'paused' });
    expect((document.getElementById('newSessionBtn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('historyBtn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('生成中发送按钮切换为停止态，点击发送 stop 消息', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    // 2b-2b 换真源：按钮语义由 turn_update.state 快照驱动（status 只负责控件锁/焦点）
    dispatchTurn({ phase: 'running' });
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.title).toBe('停止生成');
    send.click();
    // 生成中点击按钮 = 停止（不是发送），发 stop 消息由 host 中断当前流
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('生成中暴露暂停按钮，点击发 pause 消息（缺口 A · 用户主动暂停）', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    // 初始（空闲）暂停按钮收回
    expect(pauseBtn.hidden).toBe(true);
    dispatchTurn({ phase: 'running' });
    // 生成中：暂停按钮暴露（软暂停入口），发送按钮仍为「停止」
    expect(pauseBtn.hidden).toBe(false);
    expect(send.title).toBe('停止生成');
    pauseBtn.click();
    // 点击暂停 → 发 pause 消息，host 调 agent.requestPause() step 边界软暂停（可经「继续」恢复）
    expect(postMessage).toHaveBeenCalledWith({ type: 'pause' });
  });

  it('暂停申请在途态：按钮即时切「继续」形态可反悔（2026-09-07 缺口修复 1）', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const icon = pauseBtn.querySelector('.btn-icon') as HTMLElement;
    dispatchTurn({ phase: 'running' });
    // 初始：暂停（‖）形态
    expect(icon.dataset.icon).toBe('pause');
    // host 推 turn_update(waiting pausePending)（申请已入队，step 未到）→ 按钮即时切「继续 ▶」可反悔
    dispatchTurn({ phase: 'waiting', reason: 'pause', pausePending: true });
    expect(icon.dataset.icon).toBe('play');
    expect(pauseBtn.title).toContain('取消暂停申请');
    // 申请态再点 → 仍发 pause 消息（host 侧 isPausePending → cancelPauseRequest 反悔）
    postMessage.mockClear();
    pauseBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'pause' });
    // host 推 turn_update(running)（取消成功）→ 恢复「暂停」形态
    dispatchTurn({ phase: 'running' });
    expect(icon.dataset.icon).toBe('pause');
    expect(pauseBtn.title).toBe('暂停生成');
  });

  it('暂停态双按钮：暂停按钮换「继续」▶、发送按钮保持「停止」■', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatchTurn({ phase: 'running' });
    // 生成中 pause 申请获批（step 边界）→ host 推 turn_update(waiting pause)
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    // 已暂停：pauseBtn 换 play ▶（继续），sendBtn 保持 stop ■（硬停止）——双按钮并存
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.title).toContain('停止生成');
    // pauseBtn 发 resume，sendBtn 发 stop
    postMessage.mockClear();
    pauseBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'input', kind: 'resume' });
    postMessage.mockClear();
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('paused 态暂停按钮图标运行时注入 play SVG（2026-09-07：populateIcons 仅初始化跑一次）', () => {
    mountChatView();
    const icon = document.querySelector('#pauseBtn .btn-icon') as HTMLElement;
    // 初始化由 populateIcons 注入 pause 双竖线 SVG
    expect(icon.innerHTML).toContain('x="5" y="3.5" width="2"');
    dispatchTurn({ phase: 'running' });
    // thinking：applyIcon('pause') 显式注入（图标保持暂停语义）
    expect(icon.dataset.icon).toBe('pause');
    expect(icon.innerHTML).toContain('x="5" y="3.5" width="2"');
    // paused：applyIcon('play') 运行时切换 → innerHTML 实时更新为三角（bug 根因：仅改 data-icon 不重注入 SVG）
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    expect(icon.dataset.icon).toBe('play');
    expect(icon.innerHTML).toContain('M5 3.5l7 4.5-7 4.5z');
  });

  it('done 恢复发送态（loading 移除 + 发送提示）', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatchTurn({ phase: 'running' });
    // 流尾 → turn_update(settled)：发送按钮即时恢复（不等 status done）
    dispatchTurn({ phase: 'settled', roundId: 'round-1', status: 'complete' });
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.title).toBe('发送 (Enter)');
  });

  it('空闲点击发送按钮发送输入内容', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    input.value = '打磨这段';
    input.dispatchEvent(new Event('input', { bubbles: true })); // 输入后按钮解除禁用
    expect(send.disabled).toBe(false);
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'input', kind: 'send', text: '打磨这段' });
  });

  it('生成中按 Enter 仍发送（插话语义：打断当前生成并重发）', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    input.value = '补充要求';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'input', kind: 'send', text: '补充要求' });
  });

  it('中文输入法组合确认按 Enter 不误触发送（isComposing 守卫）', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '选字中';
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    );
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'input', kind: 'send', text: '选字中' });
  });

  it('中文输入法在澄清输入框按 Enter 不触发澄清答复', () => {
    const { postMessage } = mountChatView();
    // 触发澄清交互后澄清输入框存在
    dispatch({ type: 'clarify', question: '需要补充什么？' });
    const clarifyInput = document.getElementById('clarifyInput') as HTMLTextAreaElement;
    clarifyInput.value = '补一段';
    clarifyInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    );
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'input',
      kind: 'answer',
      answers: ['补一段'],
    });
  });

  it('interrupted 渲染「已停止生成」提示条', () => {
    mountChatView();
    dispatch({ type: 'interrupted' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('已停止生成');
  });

  it('输入为空时发送按钮禁用（空闲态），输入后解除禁用', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    // 初始输入为空 → 禁用
    expect(send.disabled).toBe(true);
    // 输入内容 → 解除禁用
    input.value = '打磨这段';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(send.disabled).toBe(false);
    // 清空 → 重新禁用
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(send.disabled).toBe(true);
  });

  it('生成中/暂停态发送按钮不因输入为空禁用（停止/继续语义始终可用）', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    // 生成中（loading）：即使输入为空，停止按钮仍可点击
    dispatchTurn({ phase: 'running' });
    expect(send.disabled).toBe(false);
    // 暂停态（paused）：继续按钮仍可点击（空输入继续恢复执行）
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    expect(send.disabled).toBe(false);
    // 回到空闲（settled 且输入为空）：恢复禁用
    dispatchTurn({ phase: 'settled', roundId: 'round-1', status: 'complete' });
    expect(send.disabled).toBe(true);
  });
});

describe('chatView Phase 4 按钮矩阵（会话态 × 输入内容）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── thinking × 输入内容 ───

  it('thinking + 空输入 → 停止方块（loading），禁用态为 false（可停止）', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'running' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.disabled).toBe(false);
  });

  it('thinking + 有输入 → 发送图标（无 loading/paused），可用态', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'running' });
    input.value = '我插一句话';
    input.dispatchEvent(new Event('input'));
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.disabled).toBe(false);
  });

  // ─── paused × 输入内容 ───

  it('paused + 空输入 → send 保持 stop ■（loading 类），pauseBtn 换 play ▶', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    // sendBtn 在 paused 态始终是硬停止
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.disabled).toBe(false);
    // pauseBtn 显示 play ▶（继续）
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
  });

  it('paused + 有输入 → send 保持 stop ■，pauseBtn 换 play ▶ + 补充提示', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    input.value = '补充一下';
    input.dispatchEvent(new Event('input'));
    // sendBtn 在 paused 态始终是硬停止
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.disabled).toBe(false);
    // pauseBtn 显示 play ▶ + 补充提示
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
    expect(pauseBtn.title).toContain('补充');
  });

  it('ask + 空输入 → pauseBtn 隐藏（纯续跑死键不宣告），send 保持 stop ■', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'waiting', reason: 'ask' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    // ask 相位 resume 路由只收 pause → 空输入纯续跑是死键，按钮不渲染（锚点）
    expect(pauseBtn.hidden).toBe(true);
    expect(send.classList.contains('loading')).toBe(true);
  });

  it('ask + 有输入 → pauseBtn 显示 play ▶「发送补充并继续」（带补充续跑走 send 路由，真能力）', () => {
    mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'waiting', reason: 'ask' });
    input.value = '不回答，先补充背景';
    input.dispatchEvent(new Event('input'));
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
    expect(pauseBtn.title).toContain('补充');
  });

  // ─── done × 输入内容 ───

  it('done + 空输入 → 发送禁用', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'settled', roundId: 'round-1', status: 'complete' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.disabled).toBe(true);
  });

  it('done + 有输入 → 发送启用', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'settled', roundId: 'round-1', status: 'complete' });
    input.value = '开始吧';
    input.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(false);
  });

  // ─── pauseBtn 纯投影会话状态机（图标永远 pause，不做本地 toggle） ───

  it('thinking 态 pauseBtn 显示 pause ‖ 图标，点击 post pause 消息', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const icon = pauseBtn.querySelector<HTMLElement>('.btn-icon');
    // done 初始：隐藏
    expect(pauseBtn.hidden).toBe(true);
    // thinking 态：显示 pause 图标（永远不变）
    dispatchTurn({ phase: 'running' });
    expect(pauseBtn.hidden).toBe(false);
    expect(icon?.dataset.icon).toBe('pause');
    expect(pauseBtn.title).toBe('暂停生成');
    // 点击 → 只 post pause 消息，不做任何视觉变化
    pauseBtn.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'pause' });
    expect(pauseBtn.hidden).toBe(false);
    expect(icon?.dataset.icon).toBe('pause'); // 图标不变
  });

  it('running / paused 态 pauseBtn 显示，done 态隐藏（状态机驱动）', () => {
    mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    dispatchTurn({ phase: 'running' });
    expect(pauseBtn.hidden).toBe(false);
    // paused 态：显示（换 play ▶ 继续图标，与 sendBtn stop ■ 并列）
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    expect(pauseBtn.hidden).toBe(false);
    // done 态：隐藏
    dispatchTurn({ phase: 'settled', roundId: 'round-1', status: 'complete' });
    expect(pauseBtn.hidden).toBe(true);
  });

  // ─── pending-queue-bar DOM 渲染（pendingQueue 并入 turn_update 单通道） ───

  it('turn_update.pendingQueue → 懒创建 .pending-queue-bar 并渲染全部条目', () => {
    mountChatView();
    // 待发送区渲染真源由 turn_update.pendingQueue 承载（pending_queue_update 已删）
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'running' },
      pendingQueue: ['我插一句话', '再来一句'],
    });
    const bar = document.querySelector('.pending-queue-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(false);
    // 列表模式渲染全部条目 + 序号 + 计数
    const items = bar.querySelectorAll('.pending-queue-bar__item');
    expect(items.length).toBe(2);
    expect(items[0]!.querySelector('.pending-queue-bar__num')!.textContent).toBe('1.');
    expect(items[0]!.querySelector('.pending-queue-bar__text')!.textContent).toBe('我插一句话');
    expect(items[1]!.querySelector('.pending-queue-bar__num')!.textContent).toBe('2.');
    expect(items[1]!.querySelector('.pending-queue-bar__text')!.textContent).toBe('再来一句');
    // 计数为圆形徽章（badge）
    expect(bar.querySelector('.pending-queue-bar__badge')!.textContent).toBe('2');
    expect(bar.querySelector('.pending-queue-bar__label')!.textContent).toBe('待发送');
    // 清空 → 隐藏
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' }, pendingQueue: [] });
    expect(bar.hidden).toBe(true);
  });

  it('首帧 pendingQueue 为空数组 → 不创建待发送区（面板打开零队列零残留）', () => {
    mountChatView();
    // 宿主 postTurnUpdate 恒带 pendingQueue 快照，面板 ready 首帧即空数组（真机回归路径）
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'settled' }, pendingQueue: [] });
    expect(document.querySelector('.pending-queue-bar')).toBeNull();
    // 连续空帧同样不得懒创建（空投影不得留下任何可残留节点）
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' }, pendingQueue: [] });
    expect(document.querySelector('.pending-queue-bar')).toBeNull();
  });

  it('空态首帧后入队正常创建显示，再清空隐藏（空态提前返回不得阻断后续懒创建）', () => {
    mountChatView();
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' }, pendingQueue: [] });
    expect(document.querySelector('.pending-queue-bar')).toBeNull();
    // 空 → 非空：懒创建 + StatusDock 裁决显示
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'running' },
      pendingQueue: ['插话'],
    });
    const bar = document.querySelector('.pending-queue-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(false);
    expect(bar.querySelectorAll('.pending-queue-bar__item').length).toBe(1);
    // 非空 → 空：撤出裁决（true→false 触发 resolveDock）
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' }, pendingQueue: [] });
    expect(bar.hidden).toBe(true);
  });

  it('pending-queue-bar 清空按钮 → post clear_pending_queue', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'running' },
      pendingQueue: ['插队内容'],
    });
    const clearBtn = document.querySelector('.pending-queue-bar__clear') as HTMLButtonElement;
    clearBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'clear_pending_queue' });
  });

  it('运行期创建节点的图标走 SVG 补填充（图标语言唯一 = icons.ts，2026-09-19）', () => {
    // pending-queue-bar 由 chatView **运行期**创建 → 初始化时的 populateIcons(document.body)
    // 覆盖不到，故在插入 DOM 后显式 populateIcons(_pendingQueueBar) 补填充。
    // 本断言锁死这条链路：若补填充丢失，按钮会静默变成空白（坑）。
    mountChatView();
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'running' },
      pendingQueue: ['插队内容'],
    });
    const clearBtn = document.querySelector('.pending-queue-bar__clear') as HTMLElement;
    expect(
      clearBtn.querySelector('svg'),
      '清空按钮缺 SVG 图标 → populateIcons 补填充链路已断',
    ).not.toBeNull();
    expect(clearBtn.textContent, '清空按钮不应再有字符图标').toBe('');
  });

  // ─── file-changes-bar DOM 渲染（file_changes 单通道 · DIFF-1 对话区常驻条） ───

  it('file_changes → 懒创建 .file-changes-bar 并渲染计数与文件清单', () => {
    mountChatView();
    dispatch({ type: 'file_changes', count: 2, files: ['src/a.md', 'src/b.ts'] });
    const bar = document.querySelector('.file-changes-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(false);
    // 计数徽章 + 固定标签（数字由宿主快照驱动，webview 不自维护副本）
    expect(bar.querySelector('.file-changes-bar__badge')!.textContent).toBe('2');
    expect(bar.querySelector('.file-changes-bar__label')!.textContent).toBe('个文件有未确认改动');
    // 悬停清单 = 宿主下发的相对路径（webview 只展示不解析）
    expect(bar.title).toBe('src/a.md\nsrc/b.ts');
    // count 归零 → 隐藏（宿主「全部确认」后推 0）
    dispatch({ type: 'file_changes', count: 0, files: [] });
    expect(bar.hidden).toBe(true);
  });

  it('常驻条插在输入栏之前（与 pending-queue-bar 同位置范式）', () => {
    mountChatView();
    dispatch({ type: 'file_changes', count: 1, files: ['a.md'] });
    const bar = document.querySelector('.file-changes-bar') as HTMLElement;
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    // 位置断言：插到 inputBar 的**前一个兄弟**（若实现改成 append 会立即变红）
    expect(bar.nextElementSibling).toBe(inputBar);
  });

  it('「全部确认」按钮 → post confirm_all_file_changes', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'file_changes', count: 1, files: ['a.md'] });
    (document.querySelector('.file-changes-bar__confirm') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'confirm_all_file_changes' });
  });

  it('「全部回退」按钮 → post revert_all_file_changes（二次确认在 host 侧，webview 不做前置拦截）', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'file_changes', count: 1, files: ['a.md'] });
    (document.querySelector('.file-changes-bar__revert') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'revert_all_file_changes' });
  });

  // ─── send click 路由统一（验证宿主路由契约） ───

  it('thinking + 空输入点击 send → post stop（停止）', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatchTurn({ phase: 'running' });
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('paused + 空输入点击 send → post stop（丢弃检查点，硬停止）', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatchTurn({ phase: 'waiting', reason: 'pause' });
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('thinking + 有输入点击 send → post send（宿主路由 interject）', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatchTurn({ phase: 'running' });
    input.value = '插队';
    input.dispatchEvent(new Event('input'));
    send.click();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input', kind: 'send', text: '插队' }),
    );
  });
});

describe('chatView 事件流对齐（P1 事件流 / P2 活动指标）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // chatView.ts 无 type: 'handoff' handler（handoff → 消息已并入 done chunk）

  it('retry 渲染「LLM 重试 n/m」低扰提示条', () => {
    mountChatView();
    dispatch({ type: 'retry', attempt: 1, maxRetries: 3, delayMs: 200, error: 'ECONNRESET' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('重试 1/3');
  });

  it('paused 渲染「Agent 已暂停」提示条', () => {
    mountChatView();
    dispatch({ type: 'paused' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('已暂停');
  });

  it('guardrailBlocked chunk 不再弹提示条、文本正常追加（排雷 2026-08-17，阻断文案由内核 content 承载）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '被阻断的回复', guardrailBlocked: true });
    // 阻断提示不弹 banner（避免与消息体文案双份 + 输入/输出语义错位），提示条保持隐藏
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(true);
    // 文本正常追加到 assistant 消息（阻断 ≠ 丢弃内容）
    const body = document.querySelector('.msg.assistant .msg-body');
    expect(body?.textContent?.trim()).toBe('被阻断的回复');
  });

  it('metrics 首推渲染进抽屉时间段：入口亮未读徽章，但抽屉不自动弹（C1 宪法④）', () => {
    mountChatView();
    const chip = document.querySelector('.status-dock__chip') as HTMLButtonElement;
    const panel = document.querySelector('.status-dock__panel') as HTMLElement;
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    // 未推送前：入口/抽屉体皆隐藏（时间线节点静态在骨架中，随 panel 一起不可见）
    expect(chip.hidden).toBe(true);
    expect(panel.hidden).toBe(true);

    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'a1b2c3d4e5f6' },
      metrics: { llmCallCount: 5, toolFailureCount: 1, truncationCount: 0 },
    });

    // metrics 只进抽屉时间段，不占用主状态条（P2 不占主条）
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(true);
    expect(metrics.hidden).toBe(false);
    // C1：首推只让入口可达 + 亮未读徽章，抽屉体仍隐藏（宪法④ 不自动弹）
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('活动');
    expect(chip.classList.contains('is-unread')).toBe(true);
    expect(panel.hidden).toBe(true);
    // 用户主动拉开后才看到内容
    chip.click();
    expect(panel.hidden).toBe(false);
    expect(metrics.textContent).toContain('系统提示 a1b2c3d4e5f6');
    expect(metrics.textContent).toContain('LLM 5 次');
  });

  it('P0 错误显示期间 P1 低扰不打断（错误优先保护，P1 仅进详情历史）', () => {
    mountChatView();
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    const list = document.getElementById('activityList') as HTMLElement;
    // 先发错误（P0）
    dispatch({ type: 'notice', level: 'error', message: '会话异常：超时' });
    expect(activityBar.textContent).toContain('会话异常');
    expect(activityBar.className).toContain('error');
    // 错误显示期间来低扰 info → 不覆盖主条，仅进历史
    dispatch({
      type: 'process_event',
      event: {
        type: 'memory_added',
        seq: 1,
        ts: '',
        payload: { id: 'm1', name: '决策：数据库用 PG', source: 'round-summary' },
      },
    });
    expect(activityBar.textContent).toContain('会话异常'); // 主条仍保持错误
    expect(activityBar.className).toContain('error');
    // 低扰信息进入详情历史（不丢失）
    expect(list.textContent).toContain('已沉淀：决策：数据库用 PG');
    // 新错误覆盖旧错误（P0 覆盖 P0）
    dispatch({ type: 'notice', level: 'error', message: '护栏规则未生效' });
    expect(activityBar.textContent).toContain('护栏规则未生效');
  });

  it('活动历史有界回溯：被覆盖的提示全部记录进详情（含时间戳）', () => {
    mountChatView();
    const list = document.getElementById('activityList') as HTMLElement;
    dispatch({ type: 'retry', attempt: 1, maxRetries: 3, delayMs: 200, error: 'ECONNRESET' });
    dispatch({
      type: 'process_event',
      event: {
        type: 'memory_added',
        seq: 1,
        ts: '',
        payload: { id: 'm1', source: 'round-summary', name: '决策：数据库用 PG' },
      },
    });
    dispatch({ type: 'paused' });
    // 历史累积三条，全部可见（不互相覆盖丢失）
    expect(list.textContent).toContain('重试 1/3');
    expect(list.textContent).toContain('决策：数据库用 PG');
    expect(list.textContent).toContain('已暂停');
    // 每条带时间戳（.activity-list__time 存在）
    expect(list.querySelectorAll('.activity-list__time').length).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════
// P4 · 状态抽屉 C1：时间线静态固定 + 未读只亮入口徽章（UI-CONFIRM-P10 收口）
// ═══════════════════════════════════════════════════════════
// 止血版（follower）两处旧伤：①#activityDetail 是随 #activityBar 进出的随从节点——
// 条 2500ms 自动撤，详情被一起陪葬（条撤后历史不可达）；②「详情有自己的 <details>.open
// 折叠轴 + 抽屉展开轴」两套折叠语义并存，靠 reconcileActivityDetailVisibility 缝合。
// C1 终态（ADR-037 四宪法）：时间线**静态固定**在 #dockPanel 第二段，永不参与搬运；
// details 退化为普通 div，折叠轴只剩 #dockChip 点击翻转的 _dockExpanded 一个；
// 未读只亮入口徽章，抽屉从不自动弹；入口在「rest>0 ‖ 历史非空 ‖ metrics 已渲染」时常驻。
describe('P4 状态抽屉：时间线静态固定 + 未读只亮入口徽章（C1 · UI-CONFIRM-P10）', () => {
  const detail = (): HTMLElement => document.getElementById('activityDetail') as HTMLElement;
  const actBar = (): HTMLElement => document.getElementById('activityBar') as HTMLElement;
  const panel = (): HTMLElement => document.querySelector('.status-dock__panel') as HTMLElement;
  const chip = (): HTMLButtonElement =>
    document.querySelector('.status-dock__chip') as HTMLButtonElement;
  const controls = (): HTMLElement => document.getElementById('dockControls') as HTMLElement;

  /** 触发一条info 活动（进历史 + 收起态标未读），不与其他 B 类条争主位 */
  function pushActivity(text: string): void {
    dispatch({ type: 'notice', level: 'info', message: text });
  }

  /**
   * 模拟用户点抽屉入口（C1 唯一折叠轴；旧 details 的 open/toggle 已整组拆除，
   * jsdom 不再需要手动派发 toggle——chip 点击监听就是生产真实链路）。
   * 每调一次翻转一次：展开＝已读，再调＝收起。
   */
  function toggleDrawer(): void {
    chip().click();
  }

  it('🔴 未读治本：新活动只亮入口徽章、抽屉不自动弹；拉开已读，收起后入口常驻但不提示', () => {
    mountChatView();
    // 初始：入口/抽屉体皆不可达
    expect(chip().hidden).toBe(true);
    expect(panel().hidden).toBe(true);
    pushActivity('正在思考');
    // 未读 ⇒ 入口可达 + 亮徽章 + 文案「活动」（单条活跃无收纳，rest=0）；抽屉体仍隐藏
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toBe('活动');
    expect(chip().classList.contains('is-unread')).toBe(true);
    expect(chip().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hidden).toBe(true); // 宪法④：不自动弹
    // 用户拉开 ⇒ 抽屉体显形、徽章消（拉开＝已读）；内容没丢（历史在时间段里）
    toggleDrawer();
    expect(panel().hidden).toBe(false);
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    expect(chip().classList.contains('is-unread')).toBe(false);
    expect(detail().querySelector('#activityList')?.textContent).toContain('正在思考');
    // 🔴 治「基本常驻」的关键：收起后抽屉体隐藏；但与旧 details 时代不同——
    // 历史非空 ⇒ 入口**常驻可达**（只是不亮徽章），随时能再拉开
    toggleDrawer();
    expect(panel().hidden).toBe(true);
    expect(chip().hidden).toBe(false);
    expect(chip().classList.contains('is-unread')).toBe(false);
    expect(chip().textContent).toBe('活动');
  });

  it('新活动重新标未读（未读不是一次性开关），但始终不自动弹', () => {
    mountChatView();
    pushActivity('第一条');
    toggleDrawer(); // 拉开（已读）
    expect(panel().hidden).toBe(false);
    toggleDrawer(); // 收起
    expect(panel().hidden).toBe(true);
    // 真实交互链：读过 → 收起 → 新活动到达 ⇒ 徽章重新亮，抽屉体仍隐藏
    pushActivity('第二条');
    expect(chip().classList.contains('is-unread')).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it('展开态收到新活动不重复标未读（用户正在看，别在他眼皮底下亮徽章）', () => {
    mountChatView();
    pushActivity('第一条');
    toggleDrawer(); // 拉开＝已读
    // 仍展开 ⇒ 新活动不再标未读，抽屉体保持展开
    pushActivity('第二条');
    expect(chip().classList.contains('is-unread')).toBe(false);
    expect(panel().hidden).toBe(false);
  });

  it('🔴 控件段收容：activity 被收纳时条进 #dockControls；时间线始终静态固定在抽屉体（变异：条搬进 panel 根或时间线随搬必红）', () => {
    mountChatView();
    // fileChanges(priority 3) 压过 activity(priority 1) ⇒ activity 降为被收纳
    pushActivity('正在思考');
    dispatch({ type: 'file_changes', files: ['a.md'] });
    const fcBar = document.querySelector('.file-changes-bar') as HTMLElement;
    // 主位是 fileChanges：可见、在抽屉体外
    expect(fcBar.hidden).toBe(false);
    expect(panel().contains(fcBar)).toBe(false);
    // 🔴 被收纳的是**条**：进控件段（直接父 = #dockControls）
    expect(controls().contains(actBar())).toBe(true);
    expect(actBar().parentElement).toBe(controls());
    // 🔴 时间线不参与任何搬运：直接父恒为抽屉体，且不在控件段内（两段分离）
    expect(detail().parentElement).toBe(panel());
    expect(controls().contains(detail())).toBe(false);
    // chip = +1（rest=1：被收纳的 activity 条）
    expect(chip().textContent).toBe('+1');
  });

  it('抽屉收起态：被收纳条随抽屉隐藏；时间线可见性也只随抽屉体（不出现「条没了详情还在」）', () => {
    mountChatView();
    pushActivity('正在思考');
    dispatch({ type: 'file_changes', files: ['a.md'] });
    // 抽屉默认收起：体隐藏、被收纳条隐藏（时间线节点本身不挂 hidden，它随 panel 不可见）
    expect(panel().hidden).toBe(true);
    expect(actBar().hidden).toBe(true);
    // 拉开：条与时间线同时可见
    toggleDrawer();
    expect(panel().hidden).toBe(false);
    expect(actBar().hidden).toBe(false);
    // 收起：一起藏回
    toggleDrawer();
    expect(panel().hidden).toBe(true);
    expect(actBar().hidden).toBe(true);
  });

  it('activity 条升主位时只条移出控件段；时间线静态不动（C1 与 follower 时代的根本差异）', () => {
    mountChatView();
    pushActivity('正在思考');
    dispatch({ type: 'file_changes', files: ['a.md'] });
    expect(controls().contains(actBar())).toBe(true);
    expect(detail().parentElement).toBe(panel());
    // fileChanges 撤出 ⇒ activity 升主位
    dispatch({ type: 'file_changes', files: [] });
    expect(actBar().hidden).toBe(false);
    expect(controls().contains(actBar())).toBe(false);
    // 🔴 时间线仍在抽屉体——它不再有「随条回主位区」这回事
    expect(detail().parentElement).toBe(panel());
    expect(panel().hidden).toBe(true); // 不自动弹
    // 历史入口仍可达
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toBe('活动');
  });

  it('静态链：主位条紧邻 inputBar，其上恒为静态抽屉体/入口（C1 链 = 非活跃条 → chip → panel → head → inputBar）', () => {
    mountChatView();
    pushActivity('正在思考');
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    // head 插 anchor 前 = 落在静态 #dockPanel 之后，恒紧贴输入框
    expect(inputBar.previousElementSibling).toBe(actBar());
    expect(actBar().previousElementSibling).toBe(panel());
    expect(panel().previousElementSibling).toBe(chip());
    // 时间线是抽屉体的静态子节点，永不跑到主位链上
    expect(detail().parentElement).toBe(panel());
  });

  it('🔴 免重排真行为锁：主位构成不变时主位条不被搬动（判据退化必红）', () => {
    // 静态断言锁不住「有没有搬」：insertBefore 搬一个已在位的节点，终态 DOM 完全相同 ⇒
    // 终态断言天生抓不到（探针实测：把判据退回错误写法时静态断言仍全绿，而真机上主位条
    // 每轮瞬移= P8 修掉的闪烁复发）。本条改为**行为观测**：拦截父节点 insertBefore。
    //
    // 🔴 场景选「主位**独占**」而非「加一条低优先级 B 类条」：后者会让 head 移入
    // #dockControls（主位换成另一条），属**必要**重排，不是免重排判据要管的事。
    // 只让主位独占时，任何 insertBefore(head) 都是纯浪费 = 闪烁。
    mountChatView();
    pushActivity('正在思考');
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    const act = actBar();
    const parent = inputBar.parentNode as HTMLElement;
    const orig = parent.insertBefore.bind(parent);
    const moved: Node[] = [];
    parent.insertBefore = function patched<T extends Node>(n: T, ref: Node | null): T {
      moved.push(n);
      return orig(n, ref);
    } as typeof parent.insertBefore;
    try {
      // 再来一条同类活动：activity 仍active、仍独占主位、fixed 仍 false ⇒ 链不变
      pushActivity('仍在思考');
    } finally {
      parent.insertBefore = orig;
    }
    // 主位条一次都不该被搬
    expect(moved).not.toContain(act);
    expect(inputBar.previousElementSibling).toBe(act);
  });

  it('🔴 结构纪律：主位条必须物理紧邻 inputBar（非活跃条退到 chip 之上，变异必红）', () => {
    // 非活跃条统一 insertBefore(#dockChip)——若错误地退到 anchor 前，隐藏节点会夹在
    // 「主位条 ↔ inputBar」中间：免重排判据恒假（退化成每轮重排 = P8 修掉的闪烁复发），
    // 且破坏「主位条紧贴输入区」的位置范式（点击穿透、点击区错位）。
    // 判据用**物理相邻**（不「跳过隐藏节点」）：隐藏节点夹在中间一样破坏位置范式。
    mountChatView();
    pushActivity('正在思考');
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    expect(inputBar.previousElementSibling).toBe(actBar());
  });

  it('🔴 结构纪律：有第二个 dock 条同活时主位条仍物理紧邻 inputBar（收纳走控件段，不顶主位）', () => {
    // 上一条只覆盖「主位独占」；本条覆盖有被收纳条时：rest 进 #dockControls（静态节点），
    // 主位与输入框之间的物理相邻不受任何影响。
    mountChatView();
    pushActivity('正在思考');
    // 加一条更低的 B 类条（background 垫底）⇒ chip 显 +1，但主位仍是 activity
    dispatch({
      type: 'background_tasks',
      items: [{ id: 'bg1', command: 'ls', status: 'running' }],
    });
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    expect(inputBar.previousElementSibling).toBe(actBar());
  });

  // ═══════════════════════════════════════════════════════════
  // P4 补审 · 止血期三处残余缺陷在 C1 的落点（信号口径原样保留）
  // ═══════════════════════════════════════════════════════════
  // ① 未读判据曾把 activityMetrics.hidden（**渲染结果**，只置 false 从不复位）当事实，
  //    第二版改「渲染全文快照 diff」仍错：宿主每轮推 metrics，llmCallCount/token 是累计
  //    计数、每轮必涨 ⇒ 每轮弹一次 = 换壳常驻。定案：未读只由**诊断信号**驱动
  //    （metricsSignalOf：失败/截断/未解析意图/安全审计 denied/指纹）。C1 只换呈现面——
  //    从「详情区显形」改为「入口徽章亮」，信号口径一个字段没动。
  // ② ③的止血机制（details.open 第二轴 / follower 随从显隐）已在 C1 整组拆除，
  //    对应守卫改写成「不自动弹 + 时间线静态存活 + 不替用户合抽屉」，见补审 B。
  describe('P4 补审 A：metrics 诊断信号量驱动入口徽章（累计计数不是新闻）', () => {
    const metrics = (): HTMLElement => document.getElementById('activityMetrics') as HTMLElement;

    /**
     * 推一条 metrics（默认指纹与诊断量固定，llmCallCount 单独可控）。
     * 便于构造「只有累计计数变」与「诊断信号真变」两种场景。
     */
    function pushMetrics(llmCallCount: number, extra?: Record<string, unknown>): void {
      dispatch({
        type: 'metrics',
        fingerprints: { systemPromptHash: 'a1b2c3d4e5f6' },
        metrics: { llmCallCount, toolFailureCount: 1, truncationCount: 0, ...extra },
      });
    }

    /** 模拟用户拉开抽屉读过、再收起（真实「读过」动作链；C1 唯一折叠轴 = chip 点击） */
    function readAndCollapse(): void {
      chip().click();
      chip().click();
    }

    it('🔴 核心守卫：读过后仅累计计数增长不重新亮徽章（变异：llmCallCount 纳入信号必红）', () => {
      mountChatView();
      pushMetrics(5);
      // 首推信号出现 ⇒ 入口亮未读徽章，但抽屉体不自动弹
      expect(chip().classList.contains('is-unread')).toBe(true);
      expect(panel().hidden).toBe(true);
      readAndCollapse();
      // 🔴 llmCallCount 5→9 只是仪表盘读数滚动，信号未变 ⇒ **不得**重新亮徽章，
      // 否则「每轮都推 + 每轮必涨」把 metricsUnread 喂成常驻（换壳不换病）
      pushMetrics(9);
      expect(chip().classList.contains('is-unread')).toBe(false);
      expect(panel().hidden).toBe(true);
    });

    it('同信号重复推送不标未读（新闻按信号判，不按「推过」判）', () => {
      mountChatView();
      pushMetrics(5);
      readAndCollapse();
      // 完全相同的信号再推一次 ⇒ 无新东西 ⇒ 不提示
      pushMetrics(5);
      expect(chip().classList.contains('is-unread')).toBe(false);
    });

    it('🔴 诊断信号变化（失败数 / 指纹）收起态重新亮徽章（变异：信号漏收 fail 或 fp 必红）', () => {
      mountChatView();
      pushMetrics(5);
      readAndCollapse();
      // 失败数 1→2 = 真出了事 ⇒ 重新唤起（徽章亮，仍不自动弹）
      pushMetrics(9, { toolFailureCount: 2 });
      expect(chip().classList.contains('is-unread')).toBe(true);
      expect(panel().hidden).toBe(true);
      // 指纹变化（系统提示换了）同属诊断信号 ⇒ 读过后仍应再次唤起
      readAndCollapse();
      dispatch({
        type: 'metrics',
        fingerprints: { systemPromptHash: 'f0e1d2c3b4a5' },
        metrics: { llmCallCount: 10, toolFailureCount: 2, truncationCount: 0 },
      });
      expect(chip().classList.contains('is-unread')).toBe(true);
    });

    it('拉开中到达的新信号当场消费：看着它发生，收起后不反标未读', () => {
      mountChatView();
      pushMetrics(5);
      chip().click(); // 拉开
      // 展开态下诊断信号变化（失败数 1→2）⇒ 当场记为已读，不亮徽章
      pushMetrics(42, { toolFailureCount: 2 });
      expect(chip().classList.contains('is-unread')).toBe(false);
      expect(metrics().textContent).toContain('工具失败 2'); // 内容照常刷新
      // 收起后不反标；同信号继续推也安静
      chip().click();
      pushMetrics(43, { toolFailureCount: 2 });
      expect(chip().classList.contains('is-unread')).toBe(false);
    });

    it('新活动仍能重新亮徽章（metrics 修好不牵连活动路径）', () => {
      mountChatView();
      pushMetrics(5);
      readAndCollapse();
      // 收起态来一条活动 ⇒ 活动未读位标未读（徽章统一在入口）
      dispatch({ type: 'notice', level: 'info', message: '正在思考' });
      expect(chip().classList.contains('is-unread')).toBe(true);
      expect(panel().hidden).toBe(true);
    });

    it('指标块渲染与抽屉显隐解耦（渲染职责不被未读判据劫持）', () => {
      // 回归锁：判据一度拿 activityMetrics.hidden 当事实源 ⇒ 渲染结果反向污染显隐决策。
      // 本条锁住「指标块画出来了（hidden=false）但读过收起后抽屉体可独立隐藏」这个组合。
      mountChatView();
      pushMetrics(5);
      expect(metrics().hidden).toBe(false); // 指标块已渲染
      readAndCollapse();
      expect(metrics().hidden).toBe(false); // 指标块仍在（内容不丢）
      expect(panel().hidden).toBe(true); // 但抽屉体收起
      expect(chip().hidden).toBe(false); // 入口仍在（metrics 常驻时间段）
    });

    it('🔴 审计守卫：path-allow 正常累计（total 涨/denied 不涨）不重亮；新增拒绝才唤起（变异：信号用 total 必红）', () => {
      mountChatView();
      // 局部 helper：模拟内核真实行为——AI 每轮读文件，白名单放行也发 path-allow 审计，
      // 宿主 total 无条件累加；只有 path-deny/write-decline 才让 denied 涨。
      const pushAudit = (llmCalls: number, total: number, denied: number): void => {
        dispatch({
          type: 'metrics',
          fingerprints: { systemPromptHash: 'a1b2c3d4e5f6' },
          metrics: { llmCallCount: llmCalls, toolFailureCount: 1, truncationCount: 0 },
          securityAudit: {
            total,
            denied,
            recent:
              denied > 0
                ? [{ type: 'path-deny', path: 'out.js', reason: '路径越界，不在白名单内' }]
                : [{ type: 'path-allow', path: 'foo.ts' }],
          },
        });
      };
      // 首轮 3 次审计全放行（denied=0）：首推因信号首次出现亮徽章，读过后收起
      pushAudit(3, 3, 0);
      readAndCollapse();
      // 下一轮 AI 又读 4 个文件：llmCallCount 3→7、total 3→7，但 denied 恒 0
      // ⇒ 全是正常操作，**不得**重新亮徽章（total 入信号则此处必红 = 每轮弹一次）
      pushAudit(7, 7, 0);
      expect(chip().classList.contains('is-unread')).toBe(false);
      // 真被拒一次：denied 0→1 = 出了安全事件 ⇒ 重新唤起
      pushAudit(8, 8, 1);
      expect(chip().classList.contains('is-unread')).toBe(true);
    });
  });

  describe('P4 补审 B：条自动撤时时间线存活 + 唯一折叠轴不被裁决翻转（C1 终态）', () => {
    // info 条 2500ms 自动撤是本组的触发源，统一切假钟，afterEach 还原防污染他组
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('🔴 拉开态：未读消费后抽屉保持展开（变异：resolveDock 按未读位强制合抽屉必红）', () => {
      mountChatView();
      pushActivity('正在思考');
      toggleDrawer(); // 拉开即消费未读
      expect(chip().classList.contains('is-unread')).toBe(false);
      // 未读位已空，抽屉仍必须保持展开——折叠轴只由用户点击翻转，裁决不替用户合
      expect(panel().hidden).toBe(false);
      expect(chip().getAttribute('aria-expanded')).toBe('true');
    });

    it('🔴 条 2500ms 自动撤：入口与时间线不陪葬，未读徽章仍在；拉开可见历史、收起后入口常驻（变异：入口判据退回 rest>0 必红）', () => {
      mountChatView();
      pushActivity('正在思考');
      expect(actBar().hidden).toBe(false);
      // info 条 2500ms 到期撤出收纳器
      vi.advanceTimersByTime(2500);
      expect(actBar().hidden).toBe(true);
      // 🔴 C1 闭合的核心缺口：条没了，入口仍可达（历史非空）、文案退为「活动」、未读仍亮
      expect(chip().hidden).toBe(false);
      expect(chip().textContent).toBe('活动');
      expect(chip().classList.contains('is-unread')).toBe(true);
      expect(panel().hidden).toBe(true); // 不自动弹
      // 用户拉开 ⇒ 历史内容在（条死了历史不死）
      toggleDrawer();
      expect(panel().hidden).toBe(false);
      expect(detail().querySelector('#activityList')?.textContent).toContain('正在思考');
      // 收起 ⇒ 徽章已消、入口常驻
      toggleDrawer();
      expect(panel().hidden).toBe(true);
      expect(chip().hidden).toBe(false);
      expect(chip().classList.contains('is-unread')).toBe(false);
    });

    it('🔴 抽屉拉开时条自动撤：抽屉不被强制合上（变异：空 rest 时无条件收抽屉必红）', () => {
      mountChatView();
      pushActivity('正在思考');
      toggleDrawer(); // 用户正在看
      vi.advanceTimersByTime(2500); // 条撤
      expect(actBar().hidden).toBe(true);
      // 正在看的东西不许消失：唯一折叠轴不被 resolveDock 替用户翻回
      expect(panel().hidden).toBe(false);
      expect(chip().getAttribute('aria-expanded')).toBe('true');
      // 入口从「+N」语义退为「活动」（rest 清空，时间段仍在）
      expect(chip().textContent).toBe('活动');
    });

    it('控件段随抽屉开合：被收纳条在 #dockControls 内显隐随抽屉，时间线同在抽屉体内', () => {
      mountChatView();
      pushActivity('正在思考');
      // fileChanges(priority 3) 压过 activity(priority 1) ⇒ activity 被收进控件段
      dispatch({ type: 'file_changes', files: ['a.md'] });
      expect(controls().contains(actBar())).toBe(true);
      expect(detail().parentElement).toBe(panel()); // 时间线静态固定
      expect(panel().hidden).toBe(true); // 抽屉收起
      expect(actBar().hidden).toBe(true);
      // 拉开抽屉 ⇒ 被收纳条与时间线同时可见
      chip().click();
      expect(panel().hidden).toBe(false);
      expect(controls().hidden).toBe(false);
      expect(actBar().hidden).toBe(false);
      // 收起抽屉 ⇒ 一起隐藏
      chip().click();
      expect(panel().hidden).toBe(true);
      expect(actBar().hidden).toBe(true);
    });
  });
});

describe('chatView 过程事件单形态（round-block，v1.5 SSOT 渲染收敛）', () => {
  /** 构造一个 meta（开新轮，随后 round-block 挂载） */
  function beginRound(): void {
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: '',
        payload: { role: '文档设计师', llm: 'deepseek-chat' },
      },
    });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('process_event 增量渲染 round-block：summary 计数 + details 各小节（工具/已沉淀/执行指标）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '读取成功' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'memory_added',
        seq: 4,
        ts: '',
        payload: { id: 'm1', source: 'round-summary', name: '设计约束' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq: 5,
        ts: '',
        payload: {
          durationMs: 62000,
          tokenIn: 100,
          tokenOut: 200,
          toolFailureCount: 0,
          success: true,
        },
      },
    });
    dispatch({ type: 'done' });

    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // round-block 挂在本轮 assistant 块内（正文之后、操作行之前）
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    expect(assistant.contains(rb)).toBe(true);
    // summary：耗时（metrics）+ 叙述句（工具×1（读取文件 1））
    const summary = rb.querySelector('.round-block__summary') as HTMLElement;
    expect(summary.textContent).toContain('耗时 1m 2s');
    expect(summary.textContent).toContain('工具×1（读取文件 1）');
    // 工具行移入 round-block（任务过程折叠区）工具调用小节，不重复出现在其他档案小节
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    expect(tool).not.toBeNull();
    expect(tool.textContent).toContain('读取文件：a.md (成功)');
    expect(tool.textContent).toContain('读取成功');
    // round-block details 各小节（档案：已沉淀/执行指标）
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    expect(details.textContent).toContain('设计约束');
    // 口径标注：入/出为估算、输出只计正文不含思考
    expect(details.textContent).toContain('Tokens（估算）：入 100 / 正文 200（不含思考）');
    // meta 未带 maxTokens（beginRound）→ 生效上限显示服务端默认
    expect(details.textContent).toContain('输出上限（生效）：服务端默认');
    expect(details.textContent).toContain('完成：是');
  });

  it('后台任务收尾小节：background_report 事件 → finalize 渲染多行报告（后台任务跨轮存活方案·脱管定案）', () => {
    // 渲染单点 = renderRoundBlock（finalize 与重放共用）——单点有测试即双路有保障。
    // 无存活后台任务的轮无此事件 → 小节不出现（由上方用例的「无收尾内容」断言天然覆盖）。
    // ⚠️ 假数据必须是**脱管后的新文案**：沿用旧的「已全部终止」= 测试在固化一句对用户
    // 不再成立的假话（真机 2026-10-04 用户截图即此症状）。小节标题同理不得写「收割」。
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'background_report',
        seq: 2,
        ts: '',
        payload: {
          content:
            '[本轮结束 · 后台任务继续运行] 本轮结束时有 1 个后台命令在运行，已转为后台常驻（本轮不终止；正常退出 VS Code 时随扩展终止，崩溃/被强杀除外）。结果不会自动进入上下文：你可以在后续任意一轮用 kill_command 传入该 taskId 取回截至当时的输出。\n- bg_1（仍在运行）：node server.js',
        },
      },
    });
    dispatch({ type: 'done' });

    const details = document.querySelector('.round-block__details') as HTMLElement;
    expect(details).not.toBeNull();
    // 小节标题 + 多行报告逐行渲染（\n 拆行，textContent 防注入）
    expect(details.textContent).toContain('后台任务收尾');
    expect(details.textContent).toContain('[本轮结束 · 后台任务继续运行]');
    expect(details.textContent).toContain('- bg_1（仍在运行）：node server.js');
    // 反向守卫：旧「收割/已全部终止」措辞不得复活（脱管后进程并未被杀）
    expect(details.textContent).not.toContain('已全部终止');
    expect(details.textContent).not.toContain('后台任务收割');
  });

  it('执行指标 · meta.maxTokens 生效值亮明：被角色包收紧时看这行（非面板配置值）', () => {
    mountChatView();
    // 不用 beginRound：自行发带 maxTokens 的 meta（模拟面板 64K 被取小成 4096 的场景）
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: '',
        payload: { role: '共鸣小说家', llm: 'mimo', maxTokens: 4096 },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq: 2,
        ts: '',
        payload: {
          durationMs: 1000,
          tokenIn: 10,
          // 正文估算很小：推理模型下思考吃大头，正文数不能代表输出预算消耗
          tokenOut: 89,
          toolFailureCount: 0,
          success: true,
        },
      },
    });
    dispatch({ type: 'done' });

    const details = document.querySelector('.round-block__details') as HTMLElement;
    // 生效上限 = meta 里的裁决值（与面板配置无关，取证面不重算）
    expect(details.textContent).toContain('输出上限（生效）：4096');
    expect(details.textContent).toContain('正文 89（不含思考）');
  });

  it('执行指标 · 空响应兜底诚实信号：emptyResponseCount>0 → 显示计数且不算成功收尾（success 不动）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq: 2,
        ts: '',
        payload: {
          durationMs: 5000,
          tokenIn: 100,
          tokenOut: 33,
          toolFailureCount: 0,
          // 流程正常跑完（success 语义 =「流程跑完没有」），但末段正文是兜底文案而非模型产出
          success: true,
          emptyResponseCount: 1,
        },
      },
    });
    dispatch({ type: 'done' });

    const rb = document.querySelector('.round-block') as HTMLElement;
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    // 诚实信号可见：空响应兜底计数入指标行
    expect(details.textContent).toContain('空响应兜底：1 次');
    // 产出不合格 ≠ 成功收尾：展示层合成 finalSuccess=false（success 字段本身保持 true 不撒谎）
    expect(details.textContent).toContain('完成：否（中断/失败）');
    expect(details.textContent).not.toContain('完成：是');
  });

  it('执行指标 · 截断救回观测信号：truncationRecoveryCount>0 → 显示计数且不否决成功收尾（正文是真实产出）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq: 2,
        ts: '',
        payload: {
          durationMs: 5000,
          tokenIn: 100,
          tokenOut: 200,
          toolFailureCount: 0,
          // 曾截断但换策略重试救回：正文是真实模型产出——观测留痕，不参与成功否决
          success: true,
          truncationRecoveryCount: 1,
        },
      },
    });
    dispatch({ type: 'done' });

    const rb = document.querySelector('.round-block') as HTMLElement;
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    // 观测信号可见：截断救回计数入指标行
    expect(details.textContent).toContain('截断重试救回：1 次');
    // 不否决成功收尾（与 emptyResponseCount 语义相反：救回轮正文是真实产出）
    expect(details.textContent).toContain('完成：是');
  });

  it('执行指标 · 截断救回计数缺省（旧数据）不显示该行', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq: 2,
        ts: '',
        payload: {
          durationMs: 5000,
          tokenIn: 100,
          tokenOut: 200,
          toolFailureCount: 0,
          success: true,
        },
      },
    });
    dispatch({ type: 'done' });

    const rb = document.querySelector('.round-block') as HTMLElement;
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    expect(details.textContent).not.toContain('截断重试救回');
  });

  it('工具调用二级嵌套折叠：成功/进行中默认折叠，失败默认展开，body 含 args+result', () => {
    mountChatView();
    beginRound();
    // 成功工具：默认折叠（summary 常显名称(状态)，args/result 折叠在 body）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '读取成功' },
      },
    });
    // 失败工具：默认展开（错误可见优先）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't2', name: 'write_file', args: '{"path":"b.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 5,
        ts: '',
        payload: { toolCallId: 't2', name: 'write_file', ok: false, summary: '权限不足' },
      },
    });
    // 进行中工具（无 result）：默认折叠
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 6,
        ts: '',
        payload: { toolCallId: 't3', name: 'search', args: '{}' },
      },
    });
    dispatch({ type: 'done' });

    const tools = document.querySelectorAll('.round-block__tool') as NodeListOf<HTMLDetailsElement>;
    expect(tools).toHaveLength(3);
    // 成功：折叠（open=false），summary 含名称(状态)，body 含 args 与 result
    expect(tools[0].open).toBe(false);
    expect(tools[0].querySelector('summary')?.textContent).toBe('读取文件：a.md (成功)');
    expect(tools[0].textContent).toContain('{"path":"a.md"}');
    expect(tools[0].textContent).toContain('读取成功');
    // 失败：默认展开（open=true），错误摘要可见
    expect(tools[1].open).toBe(true);
    expect(tools[1].querySelector('summary')?.textContent).toBe('写入文件：b.md (失败)');
    expect(tools[1].textContent).toContain('权限不足');
    // 进行中：TS-11b 默认展开（让正在执行的工具可见）+ 进行中态 class（is-tool-running）
    expect(tools[2].open).toBe(true);
    expect(tools[2].classList.contains('is-tool-running')).toBe(true);
    expect(tools[2].querySelector('summary')?.textContent).toBe('search (进行中)');
  });

  it('meta 驱动本轮身份：该轮 assistant 消息挂对应角色/模型标签（与会话级 chat_role_pack 分离）', () => {
    mountChatView();
    // 会话级角色（顶栏）先推一个"当前角色"
    dispatch({ type: 'chat_role_pack', rolePack: '代码审查员' });
    beginRound(); // meta.role = 文档设计师
    const label = document.querySelector('.msg.assistant .msg-ai-label') as HTMLElement;
    expect(label.textContent).toContain('文档设计师');
    expect(label.textContent).toContain('deepseek-chat');
    // 会话级顶栏不被 meta 覆盖（仍是 chat_role_pack 推的角色）
    const badge = document.getElementById('currentRoleBadge') as HTMLElement;
    expect(badge.textContent).toBe('代码审查员');
  });

  it('重放整批渲染与 process_event 同路径（重放 = 运行时同一渲染函数）', () => {
    mountChatView();
    // 重放整批 processEvents 由单条 turn_update(replay:true) 承载（与运行时 process_event 同渲染函数）
    // 附 assistantMessage（复刻原 chunk『历史回答』语义）：round-block 需挂接 assistant 正文块才可见
    dispatchReplay(
      makeRound({
        id: 'r1',
        processEvents: [
          { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
          {
            type: 'memory_added',
            seq: 2,
            ts: '',
            payload: { id: 'm:1', name: '旧记忆', source: 'round-summary' },
          },
          {
            type: 'aborted',
            seq: 3,
            ts: '',
            payload: { reason: 'User cancelled the conversation' },
          },
        ],
        assistantMessage: { content: '历史回答', ts: '' },
        status: 'complete',
      }),
    );
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb?.textContent).toContain('旧记忆');
    expect(rb?.textContent).toContain('已停止');
  });

  it('中断轮重放：interrupted 标志 → 过程独立平铺可见、不进折叠块（2026-09-15 方案）', () => {
    mountChatView();
    const events = [
      { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
      { type: 'thought', seq: 2, ts: '', payload: { content: '先梳理上下文' } },
      {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{}' },
      },
      {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: false },
      },
      {
        type: 'aborted',
        seq: 5,
        ts: '',
        payload: { reason: 'User cancelled the conversation', stopReason: 'user' },
      },
      {
        type: 'metrics',
        seq: 6,
        ts: '',
        payload: {
          durationMs: 5000,
          tokenIn: 100,
          tokenOut: 0,
          toolFailureCount: 1,
          unparsedToolIntentCount: 0,
          success: false,
        },
      },
    ];
    // 中断轮：独立 round（status=interrupted，无 assistant 正文块），单条 turn_update 承载
    dispatchReplay(makeRound({ id: 'r2', status: 'interrupted', processEvents: events }));

    // 孤儿折叠宿主（形态定案：与 done 轮同构——过程折叠 + 停止行平铺，非孤儿平铺）
    const host = document.querySelector('.msg.is-interrupted-host') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.dataset.roundId).toBe('r2');
    // 身份标签恢复（角色·模型）
    expect(host.querySelector('.msg-ai-label__role')?.textContent).toBe('AI');
    // 过程收进折叠块（round-block），不再走 process-flow 平铺（呼吸相位行连带消失）
    const rb = host.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    expect(document.querySelector('.process-flow')).toBeNull();
    // 思考/工具行保留在折叠块 details 内（已完成 step 不丢）
    expect(rb.querySelector('.round-block__thought')?.textContent).toContain('思考');
    const toolRow = rb.querySelector('.round-block__details .round-block__tool') as HTMLElement;
    expect(toolRow?.textContent).toContain('读取文件');
    expect(toolRow?.textContent).toContain('失败');
    // 「用户停止了对话」平铺折叠块外（收起态常驻可见）
    expect(host.querySelector('.round-block__interrupted')?.textContent).toContain(
      '用户停止了对话',
    );
    // 收起态摘要含耗时（指标留折叠块，不重复平铺）
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('耗时');
  });

  it('中断轮重放：error 事件 → §已停止行显示失败原因（LEG-1 缺口②：失败原因重放可见）', () => {
    mountChatView();
    // 真机形态：SSE 停摆看门狗抛 TimeoutError → agent.ts catch → yield error(category:'timeout')
    // → orchestrator.act 收为 interrupted 轮；若该 chunk 不落 processEvents → 重放只剩 generic
    const events = [
      { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
      { type: 'thought', seq: 2, ts: '', payload: { content: '正在读取文件' } },
      {
        type: 'error',
        seq: 3,
        ts: '',
        payload: { message: 'LLM request timed out (no response)', category: 'timeout' },
      },
    ];
    dispatchReplay(makeRound({ id: 'r3', status: 'interrupted', processEvents: events }));

    const host = document.querySelector('.msg.is-interrupted-host') as HTMLElement;
    expect(host).not.toBeNull();
    // 停止行平铺在折叠块外（error → 友好文案，非 generic「对话已中断」）
    const row = host.querySelector('.round-block__interrupted') as HTMLElement;
    expect(row?.textContent).toContain('对话处理超时，请稍后重试');
    expect(row?.textContent).not.toContain('对话已中断');
  });

  it('中断轮重放：error 无 category → §已停止行回退原始 message（不吞技术细节）', () => {
    mountChatView();
    const events = [
      { type: 'error', seq: 1, ts: '', payload: { message: 'HTTP 400: invalid request' } },
    ];
    dispatchReplay(makeRound({ id: 'r4', status: 'interrupted', processEvents: events }));

    const host = document.querySelector('.msg.is-interrupted-host') as HTMLElement;
    expect(host.querySelector('.round-block__interrupted')?.textContent).toContain(
      'HTTP 400: invalid request',
    );
  });

  it('中断轮重放：error 与 aborted 并存时 error 优先（保守排序，正常路径二者互斥）', () => {
    mountChatView();
    const events = [
      {
        type: 'aborted',
        seq: 1,
        ts: '',
        payload: { reason: 'User cancelled', stopReason: 'user' },
      },
      {
        type: 'error',
        seq: 2,
        ts: '',
        payload: { message: 'socket hang up', category: 'connection' },
      },
    ];
    dispatchReplay(makeRound({ id: 'r5', status: 'interrupted', processEvents: events }));

    const host = document.querySelector('.msg.is-interrupted-host') as HTMLElement;
    expect(host.querySelector('.round-block__interrupted')?.textContent).toContain(
      '对话连接中断，已保留部分回答，请检查网络后重试',
    );
  });

  it('中断轮重放：收进 round-group 容器 + footer（复制/分叉/删除 + 时间戳，2026-09-22 修复被停止会话无操作条）', () => {
    // 契约：重启回放时中断轮走 renderInterruptedRound（孤儿宿主）也须与 done 轮同构容器化
    // （round-group 容器 + footer）——若不建容器，底部缺「复制/删除/时间」footer、用户无法
    // 删除被停止的会话（坑）。
    const { postMessage } = mountChatView();
    // 真实重放时序：user（带 ts + roundId）→ 中断轮（status=interrupted，processEvents 首条 meta 带真实起始 ts）
    dispatchReplay(
      makeRound({
        id: 'r6',
        user: { content: '帮我读文件', ts: '2026-09-22T03:00:00.000Z' },
        status: 'interrupted',
        processEvents: [
          {
            type: 'meta',
            seq: 1,
            ts: '2026-09-22T03:00:05.000Z',
            payload: { role: 'AI', llm: 'm' },
          },
          {
            type: 'narrate',
            seq: 2,
            ts: '2026-09-22T03:00:06.000Z',
            payload: { content: '开始读取文件' },
          },
          {
            type: 'tool_start',
            seq: 3,
            ts: '2026-09-22T03:00:07.000Z',
            payload: { toolCallId: 't1', name: 'read_file' },
          },
          {
            type: 'aborted',
            seq: 4,
            ts: '2026-09-22T03:00:08.000Z',
            payload: { reason: 'User cancelled', stopReason: 'user' },
          },
        ],
      }),
    );

    // 孤儿宿主收进 round-group 容器（与 done 轮同构），记录正确 roundId
    const g = document.querySelector('.round-group') as HTMLElement;
    expect(g).not.toBeNull();
    expect(g.dataset.roundId).toBe('r6');
    const host = g.querySelector('.msg.is-interrupted-host') as HTMLElement;
    expect(host).not.toBeNull();
    // 容器 footer 现身：复制 / 分叉 / 删除 + 时间戳（已定稿 → 非 is-pending 直接显示）
    const footer = g.querySelector('.round-group__footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.classList.contains('is-pending')).toBe(false);
    const copyBtn = footer.querySelector('.msg-copy-icon') as HTMLButtonElement;
    const forkBtn = footer.querySelector('.msg-fork-icon') as HTMLButtonElement;
    const deleteBtn = footer.querySelector('.msg-delete-icon') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    // 分叉（roundId 可用）与删除（真实起始 ts 锚）均可用；时间戳 = 闭环起点（meta ts）
    expect(forkBtn.disabled).toBe(false);
    expect(deleteBtn.disabled).toBe(false);
    expect(host.dataset.ts).toBe('2026-09-22T03:00:05.000Z');
    expect(footer.querySelector('.msg-time')?.textContent?.trim().length).toBeGreaterThan(0);
    // 删除点击 → delete_turn 携带真实 meta ts（truncateFrom 可锚定该轮，非 new Date 伪值）
    deleteBtn.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'delete_turn',
      ts: '2026-09-22T03:00:05.000Z',
    });
  });

  it('运行时中断（RT 形态定案 2026-09-19）：掐半截正文 + 过程折叠 + 「用户停止了对话」平铺折叠块外', () => {
    mountChatView();
    dispatch({ type: 'user', text: '读文件', ts: 't0', roundId: 'r1' });
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: 't1',
        payload: { role: '白话方案设计师', llm: 'mimo-v2.5-pro' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: 't1.1', payload: { phase: 'llm_calling' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: 't1.2',
        payload: { toolCallId: 't1', name: 'read_file', args: '{}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: 't1.3',
        payload: { toolCallId: 't1', name: 'read_file', ok: true },
      },
    });
    // 半截正文已流式上屏
    dispatch({ type: 'chunk', content: '正在读取…', roundId: 'r1' });
    // 中断：正文随之作废（丢弃运行中 step 的内容）
    dispatch({
      type: 'process_event',
      event: {
        type: 'aborted',
        seq: 5,
        ts: 't1.4',
        payload: { reason: 'User cancelled the conversation', stopReason: 'user' },
      },
    });
    dispatch({ type: 'interrupted', roundId: 'r1' });
    // 过程收进折叠块（保留已完成 tool step）
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    expect(rb.querySelector('.round-block__details .round-block__tool')?.textContent).toContain(
      '读取文件',
    );
    // 半截正文被掐断：assistant 块不再有正文容器
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    expect(assistant.querySelector('.msg-body')).toBeNull();
    // 「用户停止了对话」平铺折叠块外（收起态常驻可见）+ 身份标签保留
    expect(document.querySelector('.round-block__interrupted')?.textContent).toContain(
      '用户停止了对话',
    );
    expect(assistant.querySelector('.msg-ai-label__role')?.textContent).toBe('白话方案设计师');
    // 运行时平铺容器已收走（不残留 process-flow 呼吸相位行）
    expect(document.querySelector('.process-flow')).toBeNull();
  });

  it('阶段二任务项级折叠：重放 processEvents 含 plan_item_boundary 时 narrate/tool 按任务项归组（有任务表边切组、无边界退回扁平）', () => {
    mountChatView();
    // 整批 processEvents（含 plan_item_boundary）由单条 turn_update 承载
    // 附 assistantMessage（复刻原 chunk『任务开始』语义）：round-block 需挂接 assistant 正文块才可见
    dispatchReplay(
      makeRound({
        id: 'r1',
        processEvents: [
          { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
          {
            type: 'plan_item_boundary',
            seq: 2,
            ts: '',
            payload: { planItemId: 's1', title: '分析需求' },
          },
          { type: 'narrate', seq: 3, ts: '', payload: { content: '正在分析需求文档' } },
          { type: 'tool_start', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'read_file' } },
          {
            type: 'tool_result',
            seq: 5,
            ts: '',
            payload: { toolCallId: 't1', name: 'read_file', ok: true },
          },
          {
            type: 'plan_item_boundary',
            seq: 6,
            ts: '',
            payload: { planItemId: 's2', title: '编写代码' },
          },
          { type: 'narrate', seq: 7, ts: '', payload: { content: '开始编写实现代码' } },
          { type: 'tool_start', seq: 8, ts: '', payload: { toolCallId: 't2', name: 'write_file' } },
          {
            type: 'tool_result',
            seq: 9,
            ts: '',
            payload: { toolCallId: 't2', name: 'write_file', ok: true },
          },
        ],
        assistantMessage: { content: '任务开始', ts: '' },
        status: 'complete',
      }),
    );
    // 两个任务项级折叠块：summary 显示任务项名并可展开
    const planItems = document.querySelectorAll('.round-block__plan-item');
    expect(planItems.length).toBe(2);
    expect(planItems[0]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '任务项 1',
    );
    expect(planItems[0]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '分析需求',
    );
    expect(planItems[1]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '编写代码',
    );
    // 任务项1内：narrate 与 tool 归入第 1 个任务项容器（边界切组、项内平铺）
    const planItem1Host = planItems[0]!.querySelector('.round-block__narrate') as HTMLElement;
    expect(planItem1Host?.textContent).toContain('正在分析需求文档');
    expect(planItems[0]!.querySelector('.round-block__tool')?.textContent).toContain('读取文件');
    // 任务项2内：narrate 与 tool 归入第 2 个任务项容器，不越界混入任务项1
    const planItem2Host = planItems[1]!.querySelector('.round-block__narrate') as HTMLElement;
    expect(planItem2Host?.textContent).toContain('开始编写实现代码');
    expect(planItems[1]!.querySelector('.round-block__tool')?.textContent).toContain('写入文件');
    // 负向断言：任务项 1 不含任务项 2 的工具——标记物须同步为中文名，否则接入后恒真（因错误的原因通过）
    expect(planItems[0]!.querySelector('.round-block__tool')?.textContent).not.toContain(
      '写入文件',
    );
  });

  it('任务项组外条目不沉底：boundary 前置于本轮首个工具时（预置/续会/上一 turn 遗留计划），组外 thought 仍居首个任务项组之前', () => {
    // 场景来自真机 round（会议骨架预置计划）：边界排在**首迭代的建表工具之前**
    // → 该轮所有工具都被边界收进任务项组内，根层只剩组外 thought/输入。
    // 若任务项组不参与 insertPlanItemInOrder 的统一 (ts, seq) 排序，行只与行比、
    // 组只与组比，根层无同层行可锚 → appendChild 把组外 thought 甩到**全部任务项组之下**。
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r1',
        processEvents: [
          { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
          { type: 'thought', seq: 2, ts: '', payload: { content: '步骤1思考', stepIndex: 1 } },
          {
            type: 'plan_item_boundary',
            seq: 3,
            ts: '',
            payload: { planItemId: 's1', title: '任务甲' },
          },
          {
            type: 'tool_start',
            seq: 4,
            ts: '',
            payload: { toolCallId: 't1', name: 'task_table_write' },
          },
          {
            type: 'tool_result',
            seq: 5,
            ts: '',
            payload: { toolCallId: 't1', name: 'task_table_write', ok: true },
          },
          { type: 'thought', seq: 6, ts: '', payload: { content: '步骤2思考', stepIndex: 2 } },
          {
            type: 'plan_item_boundary',
            seq: 7,
            ts: '',
            payload: { planItemId: 's2', title: '任务乙' },
          },
          { type: 'tool_start', seq: 8, ts: '', payload: { toolCallId: 't2', name: 'read_file' } },
          {
            type: 'tool_result',
            seq: 9,
            ts: '',
            payload: { toolCallId: 't2', name: 'read_file', ok: true },
          },
        ],
        assistantMessage: { content: '答复', ts: '' },
        status: 'complete',
      }),
    );
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const kids = Array.from(details.children);
    const thoughtIdx = kids.findIndex((el) => el.classList.contains('round-block__thought'));
    const firstGroupIdx = kids.findIndex((el) => el.classList.contains('round-block__plan-item'));
    // 两个任务项组都建成（前置条件：本用例确实走到了「组外内容 + 组」共存的形态）
    expect(details.querySelectorAll(':scope > .round-block__plan-item').length).toBe(2);
    expect(thoughtIdx).toBeGreaterThanOrEqual(0);
    expect(firstGroupIdx).toBeGreaterThanOrEqual(0);
    // 组外的 thought 必须排在第一个任务项组**之前**（沉底即 thoughtIdx > firstGroupIdx → 红）
    expect(thoughtIdx).toBeLessThan(firstGroupIdx);
  });

  it('建表工具批不沉到任务项组之间（真机 round-1790411133316 形态：建表在前、边界在后）', () => {
    // 真机事件序（小说项目 round-1790411133316）：建表工具产在**首个边界之前** →
    // 它不在任何任务项组内（根层），却在收尾重建时被摆到了「任务项 2 与 任务项 3」之间——
    // 正是用户报的「工具夹在倒数第一和倒数第二个标题中间」。
    // 成因：narrate 归组循环先跑（建出组 1、组 2），批循环后来给根层批块找锚点时
    // **只与「行」比、不与「组」比** → 找不到更大的同层行 → appendChild 落尾 → 后续组（组 3）再追加到它之后。
    // 判据同源见 insertPlanItemInOrder（任务项组入候选）。
    mountChatView();
    const T = (n: number): string => `2026-09-27T00:00:${String(n).padStart(2, '0')}.000Z`;
    dispatchReplay(
      makeRound({
        id: 'r1',
        processEvents: [
          { type: 'meta', seq: 1, ts: T(0), payload: { role: 'AI', llm: 'm' } },
          { type: 'thought', seq: 2, ts: T(1), payload: { content: '先建任务表', stepIndex: 1 } },
          {
            type: 'tool_start',
            seq: 3,
            ts: T(2),
            payload: { toolCallId: 'ttw', name: 'task_table_write' },
          },
          {
            type: 'tool_result',
            seq: 4,
            ts: T(2),
            payload: { toolCallId: 'ttw', name: 'task_table_write', ok: true },
          },
          {
            type: 'plan_item_boundary',
            seq: 5,
            ts: T(3),
            payload: { planItemId: 'p1', title: '任务甲' },
          },
          { type: 'narrate', seq: 6, ts: T(4), payload: { content: '甲执行' } },
          {
            type: 'plan_item_boundary',
            seq: 7,
            ts: T(5),
            payload: { planItemId: 'p2', title: '任务乙' },
          },
          { type: 'narrate', seq: 8, ts: T(6), payload: { content: '乙执行' } },
          {
            type: 'plan_item_boundary',
            seq: 9,
            ts: T(7),
            payload: { planItemId: 'p3', title: '任务丙' },
          },
          {
            type: 'tool_start',
            seq: 10,
            ts: T(8),
            payload: { toolCallId: 'rf', name: 'read_file' },
          },
          {
            type: 'tool_result',
            seq: 11,
            ts: T(8),
            payload: { toolCallId: 'rf', name: 'read_file', ok: true },
          },
        ],
        assistantMessage: { content: '答复', ts: T(9) },
        status: 'complete',
      }),
    );
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const kids = Array.from(details.children);
    const firstGroupIdx = kids.findIndex((el) => el.classList.contains('round-block__plan-item'));
    const ttwRow = details.querySelector<HTMLElement>(
      '.round-block__tool[data-tool-call-id="ttw"]',
    )!;
    // 单工具批 = 行即批（无批块包裹）→ 落点根元素就是该行
    const ttwEl = (ttwRow.closest('.round-block__tool-batch') ?? ttwRow) as HTMLElement;
    const ttwIdx = kids.indexOf(ttwEl);
    // 三个任务项组都建成（前置条件：确为「组外条目 + 多组」形态）
    expect(details.querySelectorAll(':scope > .round-block__plan-item').length).toBe(3);
    expect(ttwIdx).toBeGreaterThanOrEqual(0);
    // 根层建表工具必须排在**所有**任务项组之前（沉到组间/组下即红）
    expect(ttwIdx).toBeLessThan(firstGroupIdx);
  });

  it('任务项组位置与「任务项 N」编号同源：边界 (ts, seq) 逆序样本下不出现编号序与视觉序分家', () => {
    // 病理样本（时钟回拨 / 历史补写）：两个边界的 ts 与 seq 逆序——后发生的边界（seq 小）
    // 时间戳反而更大。全仓排序键是 (ts, seq)：bounds 排序、任务项编号、行插入三处同源；
    // 组的位置也必须同源，否则「任务项 N」编号与屏幕上组的先后分家。
    mountChatView();
    const T = (n: number): string => `2026-09-27T00:00:${String(n).padStart(2, '0')}.000Z`;
    dispatchReplay(
      makeRound({
        id: 'r1',
        processEvents: [
          { type: 'meta', seq: 1, ts: T(0), payload: { role: 'AI', llm: 'm' } },
          { type: 'narrate', seq: 2, ts: T(1), payload: { content: '组外叙述' } },
          // 边界甲：seq 小、ts 大（逆序的一半）
          {
            type: 'plan_item_boundary',
            seq: 3,
            ts: T(5),
            payload: { planItemId: 'a1', title: '任务甲' },
          },
          { type: 'narrate', seq: 4, ts: T(3), payload: { content: '乙执行' } },
          // 边界乙：seq 大、ts 小（逆序的另一半）
          {
            type: 'plan_item_boundary',
            seq: 5,
            ts: T(2),
            payload: { planItemId: 'a2', title: '任务乙' },
          },
          { type: 'narrate', seq: 6, ts: T(7), payload: { content: '甲执行' } },
        ],
        assistantMessage: { content: '答复', ts: T(8) },
        status: 'complete',
      }),
    );
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const groups = Array.from(
      details.querySelectorAll<HTMLElement>(':scope > .round-block__plan-item'),
    );
    // 前置条件：两个任务项组都建成
    expect(groups.length).toBe(2);
    // 编号真源 = bounds 按 (ts, seq) 排出的名次：乙（ts 小）是「任务项 1」，甲（ts 大）是「任务项 2」；
    // 视觉序必须与编号序一致（若组按纯 seq 摆位 → 甲在前、编号却更大 → 红）
    expect(groups[0]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '任务项 1',
    );
    expect(groups[0]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '任务乙',
    );
    expect(groups[1]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '任务项 2',
    );
    expect(groups[1]!.querySelector('.round-block__plan-item-summary')?.textContent).toContain(
      '任务甲',
    );
  });

  /**
   * BATCH-SPLIT-1 夹具：ask 结构 —— 工具 A（step 1）→ ask_user 工具行（step 2）→ 问答卡 → 工具 B（step 3）。
   *
   * 内核侧事实（`src/agent/loop.ts`）：提问走 `ask_user` 内置工具（唯一通道）。正常路径
   * handleToolCalls 检出即整批挂起（handleAskUser）——**不发 tool_start/tool_result**，
   * 问答记录由交互行（QA 行）承载、宿主不为占位渲染工具行；仅 askLimit 超限的 ask_user
   * 走 executeToolCalls 照常执行（[ASK_LIMIT] 拒绝）⇒ 事件流里**才**可能出现 ask_user
   * 工具行，本夹具取该形态覆盖切段判据（勿据夹具反推「正常轮必有 ask 工具行」）。
   * 工具轮 narrate 为**条件产出**（`if (narration)`，模型未吐文本则无）⇒ 本夹具覆盖「无 narrate、无 thought」
   * 的边界：切段判据 `groupToolBatches` 视三者同批。
   *
   * 时间轴取两位数值（T10–T16），保证 ISO 串的字面序与时间序一致。
   */
  const batchSplitFixture = (): void => {
    mountChatView();
    const T = (n: number): string => `2026-09-27T00:00:${String(n).padStart(2, '0')}.000Z`;
    dispatchReplay(
      makeRound({
        id: 'r1',
        processEvents: [
          { type: 'meta', seq: 1, ts: T(9), payload: { role: 'AI', llm: 'm' } },
          {
            type: 'tool_start',
            seq: 2,
            ts: T(10),
            payload: { toolCallId: 'a', name: 'read_file', args: '{}', stepIndex: 1 },
          },
          {
            type: 'tool_result',
            seq: 3,
            ts: T(11),
            payload: { toolCallId: 'a', name: 'read_file', ok: true, summary: 'A' },
          },
          // 提问 = 一次普通工具调用（ask_user 唯一通道）
          {
            type: 'tool_start',
            seq: 4,
            ts: T(12),
            payload: {
              toolCallId: 'ask',
              name: 'ask_user',
              args: '{"question":"选方案A还是B?"}',
              stepIndex: 2,
            },
          },
          // 用户答案以该工具的 tool result 回填
          {
            type: 'tool_result',
            seq: 5,
            ts: T(13),
            payload: { toolCallId: 'ask', name: 'ask_user', ok: true, summary: '选方案A' },
          },
          {
            type: 'tool_start',
            seq: 6,
            ts: T(15),
            payload: { toolCallId: 'b', name: 'write_file', args: '{}', stepIndex: 3 },
          },
          {
            type: 'tool_result',
            seq: 7,
            ts: T(16),
            payload: { toolCallId: 'b', name: 'write_file', ok: true, summary: 'B' },
          },
        ],
        // 问答卡：可见记录，真实 ts 落在 ask_user(T12) 与 B(T15) 之间
        interactiveInputs: [{ content: '选方案A', ts: T(14), kind: 'question-answer' }],
        assistantMessage: { content: '答复', ts: T(17) },
        status: 'complete',
      }),
    );
  };

  it('BATCH-SPLIT-1 前置自检：问答卡与三段工具均已上屏（防夹具腐化）', () => {
    batchSplitFixture();
    const details = document.querySelector('.round-block__details') as HTMLElement;
    expect(details).not.toBeNull();
    expect(details.querySelector('.round-block__input')).not.toBeNull();
    expect(details.querySelector('.round-block__tool[data-tool-call-id="a"]')).not.toBeNull();
    expect(details.querySelector('.round-block__tool[data-tool-call-id="ask"]')).not.toBeNull();
    expect(details.querySelector('.round-block__tool[data-tool-call-id="b"]')).not.toBeNull();
    expect(details.textContent).toContain('选方案A');
  });

  /**
   * BATCH-SPLIT-1：同容器内的**外部可见条目**（问答卡等 `interactiveInputs` 行）须参与工具批切段
   * ——断言取**与修法无关的不变量**：问答卡必须排在「答完之后才跑的工具 B」之前
   * （truth：A → ask_user → 卡片 → B）。不写死 DOM 结构，不预设切段形态。
   *
   * 原始病理：切段判据 `groupToolBatches` 只吃 events，而问答卡无 seq、对它不可见；批块又锚在
   * 段内首个 `tool_start` 的 ts ⇒ 问答卡被排到整块之后，观感「问答卡之后的工具跑到卡片前面」。
   * 已由 `visibleInputTs` 注入断面 ts 修复（本用例曾以 `it.fails` 封存，实现满足即转红 → 本轮升格为 it）。
   */
  it('BATCH-SPLIT-1：外部可见条目（问答卡）应成为工具批断面', () => {
    batchSplitFixture();
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const qa = details.querySelector('.round-block__input') as HTMLElement;
    const rowB = details.querySelector('.round-block__tool[data-tool-call-id="b"]') as HTMLElement;
    // B 的 DOM 位置须在问答卡之后（FOLLOWING）——否则问答卡被推到了它「答完之后才跑的工具」后面
    expect(qa.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * BATCH-SPLIT-1 流式对照：同一病理在**运行时流式路径**（renderProcessFlow）也须成立。
   *
   * 上一条守卫走重放（`renderReplayRound`）；本用例按事件到达序逐条 dispatch，验证流式路径
   * 同样以问答卡切开前后两段工具——两条路径共用 `groupToolBatches`，此处对拍防「只修一路」。
   * 时点即真实复现点：问答卡上屏后、工具 B 到达时渲染，若断面未生效则 B 被并进批块排到卡片之前。
   */
  it('BATCH-SPLIT-1 流式：问答卡同样切开前后两段工具（对拍重放路径）', () => {
    mountChatView();
    const T = (n: number): string => `2026-09-27T00:00:${String(n).padStart(2, '0')}.000Z`;
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: T(9), payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: T(10),
        payload: { toolCallId: 'a', name: 'read_file', args: '{}', stepIndex: 1 },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: T(11),
        payload: { toolCallId: 'a', name: 'read_file', ok: true, summary: 'A' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 4,
        ts: T(12),
        payload: { toolCallId: 'ask', name: 'ask_user', args: '{}', stepIndex: 2 },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 5,
        ts: T(13),
        payload: { toolCallId: 'ask', name: 'ask_user', ok: true, summary: '选方案A' },
      },
    });
    // 用户回答上屏（流式 QA 行，无 seq）
    dispatch({ type: 'user', text: '选方案A', ts: T(14), kind: 'question-answer' });
    // 答完之后才跑的工具 B
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 6,
        ts: T(15),
        payload: { toolCallId: 'b', name: 'write_file', args: '{}', stepIndex: 3 },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 7,
        ts: T(16),
        payload: { toolCallId: 'b', name: 'write_file', ok: true, summary: 'B' },
      },
    });

    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    const qa = flow.querySelector('.round-block__input') as HTMLElement;
    const rowB = flow.querySelector('.round-block__tool[data-tool-call-id="b"]') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(rowB).not.toBeNull();
    // 与重放守卫同一不变量：问答卡须在工具 B 之前
    expect(qa.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('clear_ok 清空 round-block 状态（切换会话不残留）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'memory_added',
        seq: 2,
        ts: '',
        payload: { id: 'm:1', name: '旧', source: 'a' },
      },
    });
    expect(document.querySelector('.process-flow')).not.toBeNull(); // v1.8：运行时平铺容器
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时无大折叠壳
    dispatch({ type: 'clear_ok' });
    // DOM 与引用状态同步清空（下一轮 meta 重新挂载）
    expect(document.querySelector('.process-flow')).toBeNull();
    expect(document.querySelector('.round-block')).toBeNull();
  });

  it('meta 到达即建流式骨架：角色·模型标签 + 运行时过程容器立即可见（TTFT 前即时反馈）', () => {
    mountChatView();
    // 仅 meta（LLM 首 token 未到时）：应已有「谁在回答 + 正在做什么」
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: '代码专家', llm: 'deepseek-chat' } },
    });
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    expect(assistant).not.toBeNull();
    // 消息标签显示本轮身份
    const label = assistant.querySelector('.msg-ai-label') as HTMLElement;
    expect(label.textContent).toContain('代码专家');
    expect(label.textContent).toContain('deepseek-chat');
    // v1.8：运行时过程平铺容器已挂载（无 round-block 大折叠壳，无 summary 统计条）
    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull();
    // 容器挂在本轮 assistant 块内 label 之后
    expect(flow.closest('.msg.assistant')).toBe(assistant);
  });

  it('thinking 到达后运行时平铺相位行实时显示运行阶段（装配上下文中 → 调用模型中…）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'assembling' } },
    });
    let row = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('装配上下文中');
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 3, ts: '', payload: { phase: 'llm_calling' } },
    });
    row = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(row.textContent).toContain('调用模型中');
  });

  it('首个 chunk 复用餐架块：正文流入同一块，不新建第二条 assistant 消息', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 骨架已存在（meta 建立）
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1);
    dispatch({ type: 'chunk', content: '正文内容' });
    dispatch({ type: 'chunk', content: '继续' });
    dispatch({ type: 'done' });
    // 仍是一条消息，正文完整流入骨架
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('正文内容继续');
  });

  it('pause→resume 无输入续跑：原位续写暂停块，不新建第 2 个 assistant 块（2026-09-07 回归）', async () => {
    mountChatView();
    // meta 建骨架 → 首个 chunk 流入块 A（beginStreaming 记录同闭环 roundId）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '前半', roundId: 'r:1' });
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1);
    // 暂停：记录暂停块（resume 原位续接锚）+ 清流式态
    dispatch({ type: 'paused' });
    // 无输入 continue：同 roundId 首 chunk → 应原位续写暂停块（复用 pausedAssistantEl），
    // 而非 beginStreaming 新建第 2 个独立回答块（视觉「两个 LLM 回答」bug 根因）
    dispatch({ type: 'chunk', content: '后半', roundId: 'r:1' });
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks).toHaveLength(1); // 关键断言：不出现第 2 个块
    // 后续 chunk 走 150ms 节流重渲染（首个 chunk 已立即渲染）——等待节流周期后断言拼接完整
    await new Promise((r) => setTimeout(r, 160));
    expect(collectAllBodyText(blocks[0])).toContain('前半');
    expect(collectAllBodyText(blocks[0])).toContain('后半');
    dispatch({ type: 'done' });
  });

  it('重放路径：processEvents（含 meta）+ 最终回答只产生 1 个 assistant 块（重启不重复块）', () => {
    mountChatView();
    // 重放整批 processEvents + 最终回答由单条 turn_update 承载
    dispatchReplay(
      makeRound({
        id: 'r:100',
        user: { content: '介绍下自己', ts: '2026-08-28T20:15:00Z' },
        processEvents: [
          { type: 'meta', seq: 1, ts: '', payload: { role: '方案设计师', llm: 'mimo-v2.5-pro' } },
          {
            type: 'memory_added',
            seq: 2,
            ts: '',
            payload: { id: 'm:1', name: '设计哲学', source: 'round-summary' },
          },
          {
            type: 'metrics',
            seq: 3,
            ts: '',
            payload: { durationMs: 9600, inputTokens: 500, outputTokens: 120 },
          },
        ],
        assistantMessage: {
          content: '我是Memora Agent，专注于将模糊想法设计为可落地的项目方案。',
          ts: '2026-08-28T20:16:00Z',
        },
        status: 'complete',
      }),
    );
    // 核心断言：只有一条 assistant 消息块（不能出现"运行状态一条 + 正文一条"的双线 bug）
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    // 该块同时承载：身份标签 + 正文 + round-block（三合一，不分裂）
    const el = assistants[0] as HTMLElement;
    expect(el.querySelector('.msg-ai-label')?.textContent).toContain('方案设计师');
    expect(el.querySelector('.msg-ai-label')?.textContent).toContain('mimo-v2.5-pro');
    // 重放路径：单容器一次性渲染正文，这里仍按所有 .msg-body 拼接断言（结构无关）
    expect(collectAllBodyText(el)).toContain('Memora Agent');
    const rb = el.querySelector('.round-block') as HTMLElement | null;
    expect(rb).not.toBeNull();
    expect(rb?.querySelector('.round-block__summary')?.textContent).toContain('耗时 9.6s');
  });

  it('重放路径不会创建流式骨架引用（flowShellEl 保持 null，无残留副作用）', () => {
    mountChatView();
    // 重放态 processEvents（含 meta）+ 正文由单条 turn_update 承载（不建流式骨架）
    dispatchReplay(
      makeRound({
        id: 'r:200',
        processEvents: [{ type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } }],
        assistantMessage: { content: '回答', ts: 't' },
        status: 'complete',
      }),
    );
    // 现在模拟用户发送下一轮新消息（先 user）——user 消息处理会尝试清 flowShellEl，
    // 如果重放时错误地留下了 flowShellEl 残留，这里会把正文块当作骨架删掉，
    // 从而产生 bug。验证：发送 user 后上一条 assistant 正文块仍健在。
    const before = document.querySelectorAll('.msg.assistant').length;
    dispatch({ type: 'user', text: '下一个问题', ts: 't2' });
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(before);
    // 重放路径：单容器一次性渲染，按所有 .msg-body 拼接断言（结构无关）
    expect(collectAllBodyText(document.querySelectorAll('.msg.assistant')[0])).toContain('回答');
  });

  it('两轮带过程事件的重放：折叠区各归其轮（第二轮折叠不串到第一轮顶部，2026-09-07 回归）', () => {
    mountChatView();
    // 场景：用户只测 2 个问答后重启，历史重放两轮都带过程事件
    // 两轮整体由单条 turn_update(replay:true) 的 rounds 数组整批承载，各轮折叠各归其块
    dispatchReplayMany([
      makeRound({
        id: 'r:1',
        user: { content: '问题一', ts: 't1' },
        processEvents: [
          { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
          {
            type: 'memory_added',
            seq: 2,
            ts: '',
            payload: { id: 'm:1', name: '设计哲学', source: 'round-summary' },
          },
        ],
        assistantMessage: { content: '回答一', ts: 't2' },
        status: 'complete',
      }),
      makeRound({
        id: 'r:2',
        user: { content: '问题二', ts: 't3' },
        processEvents: [
          { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
          {
            type: 'memory_added',
            seq: 2,
            ts: '',
            payload: { id: 'm:2', name: '角色包', source: 'round-summary' },
          },
          {
            type: 'memory_added',
            seq: 3,
            ts: '',
            payload: { id: 'm:3', name: '任务表', source: 'round-summary' },
          },
        ],
        assistantMessage: { content: '回答二', ts: 't4' },
        status: 'complete',
      }),
    ]);
    // 两个 assistant 块，折叠区总数 = 2（不得在旧块上堆叠）
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect(document.querySelectorAll('.round-block')).toHaveLength(2);
    // 折叠区各挂各轮：第一轮块含「设计哲学」，第二轮块含「角色包/任务表」，互不串轮
    const rb1 = blocks[0].querySelectorAll('.round-block');
    const rb2 = blocks[1].querySelectorAll('.round-block');
    expect(rb1).toHaveLength(1);
    expect(rb2).toHaveLength(1);
    expect(rb1[0].textContent).toContain('设计哲学');
    expect(rb1[0].textContent).not.toContain('角色包');
    expect(rb2[0].textContent).toContain('角色包');
    expect(rb2[0].textContent).toContain('任务表');
  });

  it('定向复现：任务表现在（task_table 工具）无 narrate + 自审二次输出，done 后折叠块/光标/进度条收口（2026-09-16 round-1789565571934）', () => {
    mountChatView();
    // 真实 round 事件序：meta → chunk(正文全文) → plan_item_boundary → task_table_update 工具 → self_review → text_self_review → thinking(archiving) → metrics → done
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '【组长开场】\n\n## 第一步', roundId: 'r1' });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'processing' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 3,
        ts: '',
        payload: { planItemId: 's1', title: '文档收束' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 4,
        ts: '',
        payload: {
          toolCallId: 't1',
          name: 'task_table_update',
          args: '{"plan_item_id":"0","status":"done"}',
        },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 5,
        ts: '',
        payload: { toolCallId: 't1', name: 'task_table_update', ok: true, summary: '更新成功' },
      },
    });
    // 大事件量（逼近真实 round：1358 个事件中绝大多数是 thought 碎片）
    let seq = 6;
    for (let i = 0; i < 400; i++) {
      dispatch({
        type: 'process_event',
        event: {
          type: 'thought',
          seq,
          ts: '',
          payload: { content: `思考碎片含会议记录质量评估第${i}段` },
        },
      });
      seq += 1;
    }
    dispatch({ type: 'process_event', event: { type: 'self_review', seq, ts: '', payload: {} } });
    seq += 1;
    dispatch({
      type: 'process_event',
      event: {
        type: 'text_self_review',
        seq,
        ts: '',
        payload: { content: '本次会议结论：文档收束 → 项目骨架 → 第一个 API。' },
      },
    });
    seq += 1;
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq, ts: '', payload: { phase: 'archiving' } },
    });
    seq += 1;
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq,
        ts: '',
        payload: {
          durationMs: 120000,
          tokenIn: 100,
          tokenOut: 200,
          toolFailureCount: 0,
          success: true,
        },
      },
    });
    dispatch({ type: 'done', roundId: 'r1' });

    // 现象1/3：任务过程应收进折叠块（round-block 存在且含工具行）
    const rb = document.querySelector('.round-block') as HTMLElement | null;
    expect(rb).not.toBeNull();
    // 现象2：会话结束后光标收口 → 终态定格「已完成」（批次二：运行态消失 + 静默淡勾）
    const body = document.querySelector<HTMLElement>('.msg.assistant .msg-body');
    expect(body?.dataset.status).toBe('已完成');
    // 过程平铺容器（进度条）finalize 后被移除，不在消息流底部残留
    expect(document.querySelector('.process-flow')).toBeNull();
  });

  it('定向复现：任务表看板在流中刷新（plan_update 非空）→ 收尾 plan_update(空) + done，全局看板清 + 无残留进度条/光标', () => {
    mountChatView();
    // ① meta → 正文流开启（cursor 亮）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '【组长开场】', roundId: 'r1' });
    // ② 任务表现在：plan_item_boundary + task_table_update 工具 → 宿主 postPlanUpdate() 推非空计划
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 2,
        ts: '',
        payload: { planItemId: 's1', title: '文档收束' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: {
          toolCallId: 't1',
          name: 'task_table_update',
          args: '{"plan_item_id":"0","status":"done"}',
        },
      },
    });
    // ≥3 个任务项的计划才常驻（**webview 展示层自身门槛**，非内核 needsPlanning——后者是关键词/
    // 结构式布尔判定、无项数阈值）——3 个任务项触发常驻条
    dispatch({
      type: 'plan_update',
      items: [
        { order: 0, id: '0', description: '文档收束', status: 'active', planItemLog: [] },
        { order: 1, id: '1', description: '补充说明', status: 'pending', planItemLog: [] },
        { order: 2, id: '2', description: '整理结论', status: 'pending', planItemLog: [] },
      ],
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't1', name: 'task_table_update', ok: true, summary: '更新成功' },
      },
    });
    // 流中常驻条应出现（任务表模式 ≥3 个任务项 → 单轨 planBar；合并单轨 PLAN-UI-1）
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(false);
    // ③ 大事件量 thought 洪流 + 自审二次输出 + archiving + metrics
    let seq = 5;
    for (let i = 0; i < 400; i++) {
      dispatch({
        type: 'process_event',
        event: {
          type: 'thought',
          seq,
          ts: '',
          payload: { content: `思考碎片含会议记录质量评估第${i}段` },
        },
      });
      seq += 1;
    }
    dispatch({ type: 'process_event', event: { type: 'self_review', seq, ts: '', payload: {} } });
    seq += 1;
    dispatch({
      type: 'process_event',
      event: { type: 'text_self_review', seq, ts: '', payload: { content: '本次会议结论。' } },
    });
    seq += 1;
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq, ts: '', payload: { phase: 'archiving' } },
    });
    seq += 1;
    dispatch({
      type: 'process_event',
      event: {
        type: 'metrics',
        seq,
        ts: '',
        payload: {
          durationMs: 120000,
          tokenIn: 100,
          tokenOut: 200,
          toolFailureCount: 0,
          success: true,
        },
      },
    });
    // ④ 宿主流尾：postPlanUpdate() 空计划（清理看板）→ done
    dispatch({ type: 'plan_update', items: [] });
    dispatch({ type: 'done', roundId: 'r1' });

    // 折叠块存在（任务过程收起）
    expect(document.querySelector('.round-block')).not.toBeNull();
    // 常驻条已隐藏；内容区零卡片（过程全在折叠块）
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.plan-inline.plan-inline-done')).toBeNull();
    // 光标收口 → 终态「已完成」
    const body = document.querySelector<HTMLElement>('.msg.assistant .msg-body');
    expect(body?.dataset.status).toBe('已完成');
    // 过程平铺容器已收
    expect(document.querySelector('.process-flow')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 真实 round 回放回归护栏（用户实测三个 UI 现象）
//
// 数据来源：round-1789565571934 的真实 processEvents（1356 条 / seq 3..1358），
// 经 scripts 层压缩为 fixtures/realRound-1789565571934.ts，事件**类型相对顺序**、
// 7 对工具调用（task_table_write + 4×task_table_update + search_memories + list_dir）、
// 4 个 plan_item_boundary、1324 条 thought 的分布均保持真实。
//
// R1–R3 = 现象现状；R4 = 唯一变量「补发 done」的对照组，用于归因。
// ─────────────────────────────────────────────────────────────────────────────
describe('chatView 真实 round-1789565571934 三现象回归护栏（2026-09-16 用户实测）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 回放真实 round（含运行期流式 chunk；done 是否补发由入参控制——R4 的唯一变量）。
   *
   * @param withDone 是否在 metrics 之后补发 done（原落盘文件末尾没有 done）
   */
  function replayRealRound(withDone: boolean): void {
    mountChatView();
    const msgs = buildRealRoundTimeline({ withStreaming: true, withDone });
    for (const m of msgs) dispatch(m);
  }

  // 正向断言由下方「R1-期望断言」承担；不设 .plan-inline 现状快照断言——现状快照会把缺陷
  // 行为（锚点退化为 appendChild）锁进用例（坑）。

  it('R1-期望断言：plan 清空 → 常驻条隐藏、内容区零完成卡片（2026-09-17 删完成快照后转绿）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: '',
        payload: { role: '白话方案设计师', llm: 'mimo-v2.5-pro' },
      },
    });
    dispatch({
      type: 'chunk',
      content: '【组长开场】介绍会议主题和讨论框架',
      roundId: REAL_ROUND.id,
    });
    // ≥3 个任务项的计划 → 常驻条出现（运行时无 inline 轨）
    dispatch({ type: 'plan_update', items: PLAN_SNAPSHOTS[0]! });
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.plan-inline')).toBeNull();
    // plan 清空 → 常驻条隐藏，内容区不留完成快照（过程全由 round-block 折叠块承载）
    dispatch({ type: 'plan_update', items: [] });
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.plan-inline.plan-inline-done')).toBeNull();
  });

  // 超时放宽至 30s：R1-R4 是全量真实轮重放（fixture 数千事件），
  // 单跑 ~5.5s；pre-push full 档并发（fileParallelism=true）下被挤爆 15s → flake
  // （kernel:test/kernel:coverage 命中 R2/R3/R4 超时）。放宽不改断言，只消除并发挤占假红。
  it('R2 现象2：真实事件序走到 metrics（未发 done = 合法在途/暂停态）后光标保留 —— 语义快照（非缺陷）', () => {
    replayRealRound(false);
    // 语义快照（**非缺陷**）：done 是宿主 post-message、不落盘为 ProcessEvent，
    // 故 fixtures 末尾无 done 纯属持久化产物。真实 round 的 status=complete 证明宿主正常完成路径**必发 done**
    // （宿主发 done 的路径，见 chatPanel 的 finalizeStreaming）。因此「metrics 之后无 done」只会来自暂停
    // （pausedOnPurpose，见 chatPanel 的 pause 分支）
    // 或其他在途态 —— 此时 finalizeStreaming 不调用、.msg-body[data-status] 运行态保留，是正确语义（轮次未收口，可 resume）。
    // 用户实测的「光标不消失」根因是 finalizeRound 抛 NotFoundError 打断收口，与 done 是否发送无关。
    expect(document.querySelector('.msg-body[data-status]')).not.toBeNull();
  }, 30000);

  it('R3 现象3：真实事件序走到 metrics（未发 done = 合法在途/暂停态）后过程保持平铺 —— 语义快照（非缺陷）', () => {
    replayRealRound(false);
    // 语义快照（同 R2）：轮次未收口 → 不 finalize → 平铺容器 .process-flow 保留、尚未建立 round-block 折叠块。
    expect(document.querySelector('.process-flow')).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull();
  }, 30000);

  it('R4 对照：补发 done 后三现象全部收口（round-block 建立 / 过程折叠 / 光标消失）—— F2 修复态', () => {
    // 根因护栏（变异验证加固）：onMessage 的兜底 console.error 是本轮
    // 唯一异常出口。若 insertPlanItemInOrder 的「直接子节点」限定被回退，异常会在此被观测到。
    // ⚠️ 必要性：下面三条「收口」断言可被 finalizeRound 的 finally **单独**满足——
    // 实测回退 :scope > 限定后，flowEl/光标仍被 finally 收掉，三条断言全绿（假绿）。
    // 唯有「兜底未被触发」+「折叠内容完整性」两条能把「根治」与「兜底掩盖」区分开。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 与 R2/R3 事件序列完全一致（同一 fixture、同一 withStreaming），唯一变量是末尾补发 done
    replayRealRound(true);
    // 兜底路径未被触发 ⇒ 异常已根治，而非被 onMessage 的 try/catch 吞掉。
    // 判据**不依赖 catch 文案**：旧写法按 `[chatView]` 前缀 filter 后再断言
    // 长度 —— 一旦前缀被改或换到 logger 模块，filter 恒返回空数组 → 断言依然绿 → 又变回假绿，
    // 且无人察觉。故直接对全部 console.error 调用断言。
    // 实测该用例路径内 console.error 唯一来源 = chatView 的 onMessage 兜底分支；webview 侧
    // 其余异常出口是 chatView 的 console.warn 分支，不在本判据范围内。
    expect(errorSpy).not.toHaveBeenCalled();
    // done → finalizeRound 全量重建 round-block 折叠块（任务过程收进折叠区）
    expect(document.querySelector('.round-block')).not.toBeNull();
    // 修复态：finalizeRound 不被 insertPlanItemInOrder 的 NotFoundError 打断 →
    // 运行时平铺容器 .process-flow 被移除（若异常跳过 flowEl.remove() 会残留）
    expect(document.querySelector('.process-flow')).toBeNull();
    // 且 finalizeStreaming 被执行到 → 运行态清 + 终态「已完成」定格
    expect(document.querySelector('.msg-body[data-status]')?.getAttribute('data-status')).toBe(
      '已完成',
    );
    // 折叠内容完整性（兜底掩盖防线）：折叠块必须真的装进过程内容（思考折叠 + 小节）。
    // 若 renderRoundBlock 中途抛错，finally 虽收掉 flow/光标，折叠块却只剩 step 空骨架
    // ——实测回退后 thought/section 双双归零、折叠文本从 37282 字符塌成 1366 字符。
    expect(document.querySelectorAll('.round-block__thought').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.round-block__section').length).toBeGreaterThan(0);
    // ⇒ 归因闭环：根治（insertPlanItemInOrder 候选限定直接子节点）+ 兜底（收口进 finally）
    //   让「补发 done」这一唯一变量真正完成收口，现象2/3 消失。
  }, 30000);
});

describe('chatView toolbar 剪枝（会话管理收敛到标题条，2026-08-17 重构）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toolbar 剪枝后 webview 无溢出菜单元素（历史/清空已由标题条按钮 + 历史浮层取代）', () => {
    mountChatView();
    // toolbar 不渲染 overflow-menu / role-pack-badge 等顶部栏元素
    expect(document.querySelector('.overflow-menu')).toBeNull();
    expect(document.querySelector('#toolbar')).toBeNull();
    // chat_history_dates / chat_history_view 消息不触发任何渲染（被静默忽略）
    expect(() => {
      dispatch({ type: 'chat_history_dates', dates: ['2026-08-15'] });
      dispatch({ type: 'chat_history_view', date: '2026-08-15' });
    }).not.toThrow();
  });
});

describe('chatView 会话管理（2026-08-17 重构 v2：标题条按钮 + treedd 历史下拉）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('标题条按钮：改名/新建 发送对应消息；历史按钮请求列表', () => {
    const { postMessage } = mountChatView();
    (document.getElementById('renameSessionBtn') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'rename_request' });
    (document.getElementById('newSessionBtn') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'new_session' });
    (document.getElementById('historyBtn') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'session_list' });
  });

  it('历史按钮：点击请求列表并展开菜单（treedd 开合）', () => {
    const { postMessage } = mountChatView();
    const dd = document.getElementById('historyDd') as HTMLElement;
    const btn = document.getElementById('historyBtn') as HTMLElement;
    expect(dd.classList.contains('is-open')).toBe(false);
    btn.click();
    // treedd 开合 + 本层请求列表（SSOT 单一职责协作）
    expect(postMessage).toHaveBeenCalledWith({ type: 'session_list' });
    expect(dd.classList.contains('is-open')).toBe(true);
  });

  it('session_list_data 渲染历史条目（treedd__item 富内容）；点击条目走委托发送 switch_session', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [
        { sessionId: '2026-08-15-s1', title: '会话A', updatedAt: new Date().toISOString() },
      ],
      archivedIds: [],
    });
    const items = document.querySelectorAll('#historyMenu .treedd__item');
    expect(items.length).toBe(1);
    expect(items[0]?.querySelector('.session-history__item-title')?.textContent).toBe('会话A');
    // 点击条目 → treedd 选择委托 → __historyOnSelect → switch_session
    (items[0] as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'switch_session',
      sessionId: '2026-08-15-s1',
    });
  });

  it('历史条目渲染 messageCount 并槽「N 条」；缺省时只显示时间不显示 0', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [
        {
          sessionId: '2026-08-15-s1',
          title: '会话A',
          updatedAt: new Date().toISOString(),
          messageCount: 12,
        },
        { sessionId: '2026-08-15-s2', title: '会话B', updatedAt: new Date().toISOString() },
      ],
      archivedIds: [],
    });
    const items = document.querySelectorAll('#historyMenu .treedd__item');
    // 带计数：时间并槽追加「 · 12 条」
    expect(items[0]?.querySelector('.session-history__item-time')?.textContent).toContain('12 条');
    // 缺省（旧会话未生成）：只显示时间，不出现「0 条」
    expect(items[1]?.querySelector('.session-history__item-time')?.textContent).not.toContain('条');
    void postMessage;
  });

  it('历史条目悬停 title 载摘要：keyTopics + summary（超 100 字截断以…收尾）', () => {
    mountChatView();
    const longSummary = '长'.repeat(120);
    dispatch({
      type: 'session_list_data',
      sessions: [
        {
          sessionId: '2026-08-15-s1',
          title: '会话A',
          updatedAt: new Date().toISOString(),
          keyTopics: ['术语锚点', 'SSOT'],
          summary: longSummary,
        },
        { sessionId: '2026-08-15-s2', title: '会话B', updatedAt: new Date().toISOString() },
      ],
      archivedIds: [],
    });
    const items = document.querySelectorAll('#historyMenu .treedd__item');
    const tip = (items[0] as HTMLElement).title;
    expect(tip).toContain('术语锚点 · SSOT');
    expect(tip).toContain('长'.repeat(100) + '…');
    // 无摘要条目不挂空 title
    expect((items[1] as HTMLElement).hasAttribute('title')).toBe(false);
  });

  it('骨架 title 防泄漏：标题条容器无 title（容器级 title 会被无 title 后代继承，历史条目悬停误显示「当前会话」）', () => {
    mountChatView();
    // 容器不得携带 title：历史下拉挂在它内部，无摘要条目会回退显示祖先 title
    expect(document.getElementById('sessionTitleBar')?.hasAttribute('title')).toBe(false);
    // 提示语义保留在内层标题文本上
    expect(document.getElementById('sessionTitleText')?.getAttribute('title')).toBe('当前会话');
  });

  it('历史条目垃圾桶：点击发送 delete_session 且不触发条目加载', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [
        { sessionId: '2026-08-15-s1', title: '会话A', updatedAt: new Date().toISOString() },
      ],
      archivedIds: [],
    });
    const delBtn = document.querySelector('.session-history__item-del') as HTMLElement;
    delBtn.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'delete_session',
      sessionId: '2026-08-15-s1',
    });
    // stopPropagation：不触发条目加载（选择委托）
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'switch_session' }),
    );
  });

  it('session_list_data 空数组 → 显示空态（非 item 文本）', () => {
    mountChatView();
    dispatch({ type: 'session_list_data', sessions: [], archivedIds: [] });
    expect(document.querySelector('.session-history__empty')?.textContent).toContain(
      '暂无历史会话',
    );
    expect(document.querySelectorAll('#historyMenu .treedd__item').length).toBe(0);
  });

  it('点击外部区域收起历史菜单（treedd 外部关闭机制）', () => {
    mountChatView();
    const dd = document.getElementById('historyDd') as HTMLElement;
    (document.getElementById('historyBtn') as HTMLElement).click();
    expect(dd.classList.contains('is-open')).toBe(true);
    // 点击外部（非下拉区域）→ treedd root 委托关闭
    document.body.click();
    expect(dd.classList.contains('is-open')).toBe(false);
  });
});

describe('留存区分组标签（SESS-KEEP-1）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const mkSession = (id: string, title: string) => ({
    sessionId: id,
    title,
    updatedAt: new Date().toISOString(),
  });

  it('分组过滤：会话记录只显示未归档条目，切留存区只显示已归档条目', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A'), mkSession('s2', '会话B')],
      archivedIds: ['s2'],
    });
    let titles = [...document.querySelectorAll('#historyMenu .session-history__item-title')];
    expect(titles.map((el) => el.textContent)).toEqual(['会话A']);
    (document.getElementById('historyTabArchived') as HTMLElement).click();
    titles = [...document.querySelectorAll('#historyMenu .session-history__item-title')];
    expect(titles.map((el) => el.textContent)).toEqual(['会话B']);
    expect(
      (document.getElementById('historyTabArchived') as HTMLElement).classList.contains(
        'is-active',
      ),
    ).toBe(true);
  });

  it('留存区计数徽标：有归档显示数量，切视图后计数由同一数据源驱动不变', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A')],
      archivedIds: ['s1'],
    });
    const count = document.getElementById('historyArchivedCount') as HTMLElement;
    expect(count.textContent).toContain('1');
    (document.getElementById('historyTabRecent') as HTMLElement).click();
    expect(count.textContent).toContain('1');
  });

  it('留存区空态显示专属文案（与「暂无历史会话」区分）', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A')],
      archivedIds: [],
    });
    (document.getElementById('historyTabArchived') as HTMLElement).click();
    expect(document.querySelector('#historyMenu .session-history__empty')?.textContent).toContain(
      '留存区',
    );
  });

  it('会话记录视图 keepBtn：发送 archive_session，不触发条目加载、不触发删除', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A')],
      archivedIds: [],
    });
    (document.querySelector('.session-history__item-keep') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'archive_session', sessionId: 's1' });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'switch_session' }),
    );
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'delete_session' }),
    );
  });

  it('留存区视图 keepBtn：发送 restore_session（同一按钮按视图分型）', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A')],
      archivedIds: ['s1'],
    });
    (document.getElementById('historyTabArchived') as HTMLElement).click();
    (document.querySelector('.session-history__item-keep') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'restore_session', sessionId: 's1' });
  });

  it('数据下发不重置视图：留存区操作后的列表刷新仍停在留存区', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A'), mkSession('s2', '会话B')],
      archivedIds: ['s2'],
    });
    (document.getElementById('historyTabArchived') as HTMLElement).click();
    // 模拟「移回一条」后宿主刷新下发（archivedIds 已空）
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A'), mkSession('s2', '会话B')],
      archivedIds: [],
    });
    expect(
      (document.getElementById('historyTabArchived') as HTMLElement).classList.contains(
        'is-active',
      ),
    ).toBe(true);
    expect(document.querySelector('#historyMenu .session-history__empty')?.textContent).toContain(
      '留存区',
    );
  });

  it('点历史按钮重置视图：新一轮浏览回到会话记录默认分组', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '会话A')],
      archivedIds: [],
    });
    (document.getElementById('historyTabArchived') as HTMLElement).click();
    (document.getElementById('historyBtn') as HTMLElement).click();
    expect(
      (document.getElementById('historyTabRecent') as HTMLElement).classList.contains('is-active'),
    ).toBe(true);
  });

  it('硬约束：tab 按钮不得携带 .treedd__item（点击委托命中即收起浮层）', () => {
    mountChatView();
    const tabs = [...document.querySelectorAll('#historyTabs button')] as HTMLElement[];
    expect(tabs.length).toBe(2);
    for (const tab of tabs) {
      expect(tab.classList.contains('treedd__item')).toBe(false);
    }
  });
});

describe('会话元数据搜索（FD-3-A）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const mkSession = (
    id: string,
    title: string,
    extra?: { keyTopics?: string[]; summary?: string },
  ) => ({
    sessionId: id,
    title,
    updatedAt: new Date().toISOString(),
    ...extra,
  });

  /** 模拟输入搜索词（input 事件驱动过滤） */
  const type = (q: string): void => {
    const box = document.getElementById('historySearch') as HTMLInputElement;
    box.value = q;
    box.dispatchEvent(new Event('input'));
  };

  const visibleTitles = (): (string | null)[] =>
    [...document.querySelectorAll('#historyMenu .session-history__item-title')].map(
      (el) => el.textContent,
    );

  it('按标题过滤：命中者可见，未命中者隐藏', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '排序算法实现'), mkSession('s2', '翻译助手调试')],
      archivedIds: [],
    });
    type('排序');
    expect(visibleTitles()).toEqual(['排序算法实现']);
  });

  it('按摘要过滤：summary 命中即可见（标题不含该词）', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [
        mkSession('s1', '随便聊聊', { summary: '讨论了动态规划的边界条件' }),
        mkSession('s2', '翻译助手调试'),
      ],
      archivedIds: [],
    });
    type('动态规划');
    expect(visibleTitles()).toEqual(['随便聊聊']);
  });

  it('按主题过滤：keyTopics 任一命中即可见', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [
        mkSession('s1', '随便聊聊', { keyTopics: ['算法', '记忆子系统'] }),
        mkSession('s2', '翻译助手调试', { keyTopics: ['i18n'] }),
      ],
      archivedIds: [],
    });
    type('记忆');
    expect(visibleTitles()).toEqual(['随便聊聊']);
  });

  it('无匹配空态：区分「没有匹配」与「暂无历史会话」，且回显搜索词', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '排序算法实现')],
      archivedIds: [],
    });
    type('不存在的词');
    const empty = document.querySelector('#historyMenu .session-history__empty');
    expect(empty?.textContent).toContain('没有匹配');
    expect(empty?.textContent).toContain('不存在的词');
  });

  it('搜索作用于当前分组：留存区视图下搜索不显示会话记录侧的匹配项', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [
        mkSession('s1', '排序算法实现'),
        mkSession('s2', '留存的历史', { summary: '排序话题' }),
      ],
      archivedIds: ['s2'],
    });
    (document.getElementById('historyTabArchived') as HTMLElement).click();
    type('排序');
    expect(visibleTitles()).toEqual(['留存的历史']);
    (document.getElementById('historyTabRecent') as HTMLElement).click();
    expect(visibleTitles()).toEqual(['排序算法实现']);
  });

  it('硬约束：搜索框不得携带 .treedd__item（点击委托命中即收起浮层）', () => {
    mountChatView();
    const box = document.getElementById('historySearch') as HTMLElement;
    expect(box.classList.contains('treedd__item')).toBe(false);
  });

  it('打开浮层清空搜索词（新一轮浏览语义，与视图重置同批）', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '排序算法实现')],
      archivedIds: [],
    });
    type('排序');
    (document.getElementById('historyBtn') as HTMLElement).click();
    expect((document.getElementById('historySearch') as HTMLInputElement).value).toBe('');
  });

  it('数据下发不清搜索词：归档/移回后的刷新仍保持过滤（连续操作场景）', () => {
    mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '排序算法实现'), mkSession('s2', '翻译助手调试')],
      archivedIds: [],
    });
    type('排序');
    dispatch({
      type: 'session_list_data',
      sessions: [mkSession('s1', '排序算法实现'), mkSession('s2', '翻译助手调试')],
      archivedIds: [],
    });
    expect((document.getElementById('historySearch') as HTMLInputElement).value).toBe('排序');
    expect(visibleTitles()).toEqual(['排序算法实现']);
  });
});

describe('任务项状态图标（真机反馈 2026-10-01：运行中无 active 图标 / 重放丢完成图标）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const T0 = '2026-10-01T08:00:00.000Z';
  const planEvents = (): ProcessEvent[] => [
    {
      type: 'meta',
      seq: 3,
      ts: T0,
      payload: {
        role: '共鸣小说家',
        llm: 'mimo-v2.6-pro',
        contextWindow: 600000,
        maxTokens: 64000,
      },
    },
    {
      type: 'plan_item_boundary',
      seq: 55,
      ts: '2026-10-01T08:00:09.206Z',
      payload: { planItemId: 'p1', title: '任务一：读取素材' },
    },
    { type: 'narrate', seq: 60, ts: '2026-10-01T08:00:10.000Z', payload: { content: '开工' } },
    {
      type: 'plan_item_boundary',
      seq: 70,
      ts: '2026-10-01T08:01:00.000Z',
      payload: { planItemId: 'p2', title: '任务二：成文' },
    },
  ];

  it('问题2复现：重放含 plan_snapshot（全 done）的轮 → 任务项组显示完成绿勾', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-plan',
        user: { content: '建任务表干活', ts: T0 },
        assistantMessage: { content: '第 1 章正文成稿。', ts: '2026-10-01T08:09:00.500Z' },
        processEvents: [
          ...planEvents(),
          {
            type: 'plan_snapshot',
            seq: 90,
            ts: '2026-10-01T08:09:00.000Z',
            payload: {
              items: [
                { planItemId: 'p1', status: 'done' },
                { planItemId: 'p2', status: 'done' },
              ],
            },
          },
        ],
      }),
    );
    const grp = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p1"]');
    expect(grp).toBeTruthy();
    expect(grp?.classList.contains('is-plan-done')).toBe(true);
    expect(grp?.querySelector('.round-block__plan-item-status')).toBeTruthy();
  });

  it('问题1复现：流式 plan_item_boundary 到达 → 该任务项组立即亮 active 靶心', () => {
    const {} = mountChatView();
    // 开轮（meta）→ 任务项边界（无任何 plan_snapshot / plan_update）
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 3,
        ts: T0,
        payload: {
          role: '共鸣小说家',
          llm: 'mimo-v2.6-pro',
          contextWindow: 600000,
          maxTokens: 64000,
        },
      } as ProcessEvent,
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 55,
        ts: '2026-10-01T08:00:09.206Z',
        payload: { planItemId: 'p1', title: '任务一：读取素材' },
      } as ProcessEvent,
    });
    // 任务项组已渲染（运行时平铺形态），状态图标应同步亮起（active 靶心）
    const grp = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p1"]');
    expect(grp).toBeTruthy();
    expect(grp?.classList.contains('is-plan-active')).toBe(true);
    expect(grp?.querySelector('.round-block__plan-item-status')).toBeTruthy();
  });

  it('调和回归：plan_update 宣告 done 后，后续内容事件到达不把绿勾抹回 active', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 3,
        ts: T0,
        payload: {
          role: '共鸣小说家',
          llm: 'mimo-v2.6-pro',
          contextWindow: 600000,
          maxTokens: 64000,
        },
      } as ProcessEvent,
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 55,
        ts: '2026-10-01T08:00:09.206Z',
        payload: { planItemId: 'p1', title: '任务一：读取素材' },
      } as ProcessEvent,
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 70,
        ts: '2026-10-01T08:01:00.000Z',
        payload: { planItemId: 'p2', title: '任务二：成文' },
      } as ProcessEvent,
    });
    // LLM 显式更新任务表：p1 done（权威表态，全量重建 livePlanStates）
    dispatch({
      type: 'plan_update',
      items: [
        { order: 0, id: 'p1', description: '任务一：读取素材', status: 'done', planItemLog: [] },
        { order: 1, id: 'p2', description: '任务二：成文', status: 'active', planItemLog: [] },
      ],
    });
    // 后续内容事件（narrate）到达 → renderProcessFlow 增量刷新：
    // 若尾部投影「从事件序推导 active」而非读 livePlanStates，p1 的绿勾会被抹掉
    dispatch({
      type: 'process_event',
      event: {
        type: 'narrate',
        seq: 80,
        ts: '2026-10-01T08:02:00.000Z',
        payload: { content: '继续' },
      } as ProcessEvent,
    });
    const p1 = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p1"]');
    const p2 = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p2"]');
    expect(p1?.classList.contains('is-plan-done')).toBe(true);
    expect(p2?.classList.contains('is-plan-active')).toBe(true);
  });

  it('中断轮（无 plan_snapshot）finalize → 最后 boundary 项保留 active 靶心，其余项诚实无图标', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 3,
        ts: T0,
        payload: { role: 'AI', llm: 'm' },
      } as ProcessEvent,
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 55,
        ts: '2026-10-01T08:00:09.206Z',
        payload: { planItemId: 'p1', title: '任务一' },
      } as ProcessEvent,
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'narrate',
        seq: 60,
        ts: '2026-10-01T08:00:10.000Z',
        payload: { content: '开工' },
      } as ProcessEvent,
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 70,
        ts: '2026-10-01T08:01:00.000Z',
        payload: { planItemId: 'p2', title: '任务二' },
      } as ProcessEvent,
    });
    dispatch({ type: 'chunk', content: '半截正文' });
    dispatch({
      type: 'process_event',
      event: {
        type: 'aborted',
        seq: 80,
        ts: '',
        payload: { reason: '用户停止', stopReason: 'user' },
      } as ProcessEvent,
    });
    dispatch({ type: 'interrupted', roundId: 'r-int' });
    // finalize 全量重渲（planItemStatesFromEvents 无快照分支）：最后 boundary = p2 active
    const p1 = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p1"]');
    const p2 = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p2"]');
    expect(p2?.classList.contains('is-plan-active')).toBe(true);
    // p1 未见完成宣告：无图标（不伪造 done、不误亮 active）
    expect(p1?.classList.contains('is-plan-done')).toBe(false);
    expect(p1?.classList.contains('is-plan-active')).toBe(false);
  });

  it('重放双保险：最后快照之后发生的 boundary → 该项覆盖为 active（快照终态不覆盖新开始项）', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-plan-late',
        user: { content: '建任务表干活', ts: T0 },
        assistantMessage: { content: '正文成稿。', ts: '2026-10-01T08:10:00.500Z' },
        processEvents: [
          ...planEvents(),
          {
            type: 'plan_snapshot',
            seq: 90,
            ts: '2026-10-01T08:09:00.000Z',
            payload: {
              items: [
                { planItemId: 'p1', status: 'done' },
                { planItemId: 'p2', status: 'done' },
              ],
            },
          },
          {
            type: 'plan_item_boundary',
            seq: 95,
            ts: '2026-10-01T08:09:30.000Z',
            payload: { planItemId: 'p3', title: '任务三：收尾' },
          },
        ],
      }),
    );
    const p1 = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p1"]');
    const p3 = document.querySelector<HTMLElement>('.round-block__plan-item[data-plan-item="p3"]');
    expect(p1?.classList.contains('is-plan-done')).toBe(true);
    expect(p3?.classList.contains('is-plan-active')).toBe(true);
  });
});

describe('chatView UI 自然生长三优化点（2026-08-15）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('interrupted（aborted 事件）→ round-block §已停止 + 「用户停止了对话」平铺折叠块外，半截正文掐断（2026-09-19 形态定案）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '半截回答' });
    dispatch({
      type: 'process_event',
      event: {
        type: 'aborted',
        seq: 2,
        ts: '',
        payload: { reason: 'User cancelled the conversation', stopReason: 'user' },
      },
    });
    dispatch({ type: 'interrupted', roundId: 'r1' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 折叠块内 §已停止（详情完整，stopReasonLabel 映射友好文案）
    expect(rb.textContent).toContain('已停止');
    expect(rb.textContent).toContain('用户停止了对话');
    // 收尾即停止呼吸（is-running 收敛）
    expect(rb.classList.contains('is-running')).toBe(false);
    // 停止行平铺折叠块外（收起态常驻可见，语义映射为「用户停止了对话」）
    expect(document.querySelector('.round-block__interrupted')?.textContent).toContain(
      '用户停止了对话',
    );
    // 半截正文掐断（丢弃运行中 step 的内容，与重放中断轮不显示正文同构）
    expect(document.querySelector('.msg.assistant .msg-body')).toBeNull();
  });

  it('P3：空状态标题/提示随激活角色包动态生成（切换角色不错位）', () => {
    mountChatView();
    const title = document.getElementById('emptyTitle') as HTMLElement;
    const hint = document.getElementById('emptyHint') as HTMLElement;
    // 未加载角色包：回退「AI」+ 默认引导
    expect(title.textContent).toBe('开始与 AI 对话');
    // 角色包列表 + 激活角色 → 空状态随角色生长（标题用角色名、提示用定位描述）
    dispatch({
      type: 'chat_role_packs',
      packs: [
        { name: 'doc-review', displayName: '文档打磨', description: '打磨文档结构、表达与一致性' },
        { name: 'translator', displayName: '翻译助手', description: '中英互译与润色' },
      ],
      activeName: 'doc-review',
    });
    dispatch({ type: 'chat_role_pack', rolePack: '文档打磨' });
    expect(title.textContent).toBe('开始与 文档打磨 对话');
    expect(hint.textContent).toBe('打磨文档结构、表达与一致性');
    // 切换角色 → 文案同步更新
    dispatch({ type: 'chat_role_pack', rolePack: '翻译助手' });
    expect(title.textContent).toBe('开始与 翻译助手 对话');
    expect(hint.textContent).toBe('中英互译与润色');
  });

  it('MVP：空状态示例提问随 showcase 角色特化（白话方案设计师种子收敛引导，其余回退通用）', () => {
    mountChatView();
    const chipLabels = () =>
      Array.from(document.querySelectorAll('.suggestion-chip')).map((c) => c.textContent);
    // 未加载角色：回退通用打磨引导
    expect(chipLabels()).toEqual(['审阅架构', '精简表达', '对齐实现']);
    // 非 showcase 角色（文档打磨）：仍回退通用引导
    dispatch({ type: 'chat_role_pack', rolePack: '文档打磨' });
    expect(chipLabels()).toEqual(['审阅架构', '精简表达', '对齐实现']);
    // showcase 角色（白话方案设计师）：渲染专属"种子收敛"引导，一键体验 memora 设计魅力
    dispatch({ type: 'chat_role_pack', rolePack: '白话方案设计师' });
    expect(chipLabels()).toEqual(['设计知识库', '设计记忆系统', '找最小单元']);
  });
});

describe('chatView 流式光标 + Markdown 渲染（吸收养分，2026-08-16）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('流式期间 body 带回答态光标 + 增量渲染 Markdown，done 后落终态', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '**加粗** 与 `code`' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    // 流式进行中：默认回答态 data-status（CSS ::after 呼吸光标）+ 首个 chunk 立即渲染 markdown
    // （对齐 TraeWork 实时格式化，不显示 ** ` 原始记号）
    expect(body.dataset.status).toBe('正在回答中');
    expect(body.textContent?.trim()).toBe('加粗 与 code');
    expect(body.querySelector('strong')).not.toBeNull();

    // done → 终态定格「已完成」，Markdown 保持渲染（加粗/行内代码成元素）
    dispatch({ type: 'done' });
    expect(body.dataset.status).toBe('已完成');
    expect(body.querySelector('strong')).not.toBeNull();
    expect(body.querySelector('code')).not.toBeNull();
  });

  it('代码块增强：语言标签 + 复制按钮（吸收养分：对齐 TraeWork 一键复制）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '```ts\nconst x = 1;\n```' });
    dispatch({ type: 'done' });
    // 流式收敛后代码块被包装为 .code-block（语言标签 + 复制按钮）
    const block = document.querySelector('.msg.assistant .code-block') as HTMLElement;
    expect(block).not.toBeNull();
    const lang = block.querySelector('.code-block__lang') as HTMLElement;
    expect(lang.textContent).toBe('ts');
    const copyBtn = block.querySelector('.code-block__copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.textContent).toBe('复制');
    // 复制按钮承载的是代码文本（供点击复制）
    expect(block.querySelector('code')?.textContent).toContain('const x = 1');
  });

  it('一键到底按钮：上滚离开底部显示，点击回到底部后隐藏（吸底优化）', () => {
    mountChatView();
    const btn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
    const messages = document.getElementById('messages') as HTMLElement;
    // 默认吸底：按钮隐藏
    expect(btn.hidden).toBe(true);
    // 模拟上滚（scrollHeight > clientHeight + scrollTop + 阈值）→ 离开底部 → 按钮浮现
    Object.defineProperty(messages, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(messages, 'clientHeight', { value: 100, configurable: true });
    messages.scrollTop = 100;
    messages.dispatchEvent(new Event('scroll'));
    expect(btn.hidden).toBe(false);
    // 点击一键到底 → 回到最新位置 + 按钮隐藏
    btn.click();
    expect(messages.scrollTop).toBe(1000);
    expect(btn.hidden).toBe(true);
  });

  it('一键到底按钮锚点守卫：按钮必须锚 #inputBar（滚动容器内 absolute 必随内容滚走，真机反馈 2026-10-01）', () => {
    mountChatView();
    const btn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    const messages = document.getElementById('messages') as HTMLElement;
    // 必须挂在 #inputBar（position:relative，非滚动容器）内：bottom: calc(100% + sp-4)
    // 锚其顶边 = 恒钉消息区可视框右下角，不随消息滚动
    expect(inputBar.contains(btn)).toBe(true);
    // 🔴 严禁挪回 #messages：#messages 是 overflow-y:auto 滚动容器，absolute 子元素
    // 参与滚动（「和会话记录一起滚走」根因；同 #planBar 注释警告过的错）
    expect(messages.contains(btn)).toBe(false);
  });

  // ─── 运行时吸底（RAF-1：定稿收尾补吸底 + 视图复位即吸底复位）───
  /** 放行一帧 rAF：scrollToBottom / forceScrollToBottom 均经 requestAnimationFrame 落地 */
  function flushRaf(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  /** 把消息区撑成可滚动且已吸底的形态（jsdom 无布局，三项几何值须显式喂入） */
  function makeScrollableAtBottom(scrollHeight: number, clientHeight = 200): HTMLElement {
    const messages = document.getElementById('messages') as HTMLElement;
    Object.defineProperty(messages, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(messages, 'clientHeight', { value: clientHeight, configurable: true });
    return messages;
  }

  it('定稿收尾补吸底：代码块增强增高后视野对齐最新内容', async () => {
    mountChatView();
    const messages = makeScrollableAtBottom(800);
    messages.scrollTop = 600; // 800 - 200 = 600 ⇒ 吸底
    dispatch({ type: 'chunk', content: '```ts\nconst x = 1;\n```' });
    await flushRaf(); // 先让 chunk 自身那次吸底落地（否则它会掩盖定稿收尾的补滚动）
    expect(messages.scrollTop).toBe(800);
    // 终渲染 + 代码块增强（每个 <pre> 补一行 header）使内容增高——增高只发生在定稿时
    Object.defineProperty(messages, 'scrollHeight', { value: 900, configurable: true });
    dispatch({ type: 'done' });
    await flushRaf();
    expect(messages.scrollTop).toBe(900);
  });

  it('定稿收尾不拽走：用户上滚阅读历史时不强制吸底', async () => {
    mountChatView();
    const messages = makeScrollableAtBottom(1000);
    messages.scrollTop = 100; // 距底 700 > 阈值 ⇒ 非吸底
    messages.dispatchEvent(new Event('scroll'));
    dispatch({ type: 'chunk', content: '```ts\nconst x = 1;\n```' });
    Object.defineProperty(messages, 'scrollHeight', { value: 1100, configurable: true });
    dispatch({ type: 'done' });
    await flushRaf();
    expect(messages.scrollTop).toBe(100);
  });

  it('一键到底即恢复吸底：点击后新内容继续自动跟随', async () => {
    mountChatView();
    const messages = makeScrollableAtBottom(1000);
    messages.scrollTop = 100;
    messages.dispatchEvent(new Event('scroll')); // 上滚阅读 → 标记非吸底
    const btn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(messages.scrollTop).toBe(1000);
    expect(btn.hidden).toBe(true);
    // 恢复吸底：此后新内容继续自动跟随。标记由点击处理器显式重算，不依赖浏览器
    // 因 scrollTop 变化而派发 scroll 事件（jsdom 不派发，守卫须锁住显式调用点）
    Object.defineProperty(messages, 'scrollHeight', { value: 1100, configurable: true });
    dispatch({ type: 'chunk', content: 'hello' });
    await flushRaf();
    expect(messages.scrollTop).toBe(1100);
  });

  it('视图复位即吸底复位：上滚后清空，新会话首条消息仍自动吸底', async () => {
    mountChatView();
    const messages = makeScrollableAtBottom(1000);
    messages.scrollTop = 0; // 停在顶部：清空时高度塌缩不改变 scrollTop ⇒ 无 scroll 事件纠正
    messages.dispatchEvent(new Event('scroll'));
    dispatch({ type: 'clear_ok' });
    await flushRaf();
    // 复位后新会话重新开始：内容增高即跟随到底部
    Object.defineProperty(messages, 'scrollHeight', { value: 900, configurable: true });
    dispatch({ type: 'chunk', content: 'hello' });
    await flushRaf();
    expect(messages.scrollTop).toBe(900);
  });

  // ─── 长输入气泡折叠（USER-CLAMP-1）───
  it('短输入气泡不动：未溢出时不截断也不留按钮', () => {
    mountChatView();
    dispatch({ type: 'user', text: '短问题', ts: '2026-10-02T10:00:00.000Z' });
    const body = document.querySelector('.msg.user .msg-body') as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.classList.contains('is-clamped')).toBe(false);
    expect(document.querySelector('.msg-user-more')).toBeNull();
  });

  it('长输入气泡折叠：溢出才截断并插「展开全文」，点击可展开与收起', () => {
    mountChatView();
    // jsdom 无布局：给 .msg-body 打桩几何值（内容 400 > 可视 160 = 溢出），用完立即还原
    const proto = HTMLElement.prototype;
    const geo = (v: number): PropertyDescriptor => ({
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('msg-body') ? v : 0;
      },
    });
    const origSH = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const origCH = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    Object.defineProperty(proto, 'scrollHeight', geo(400));
    Object.defineProperty(proto, 'clientHeight', geo(160));
    try {
      dispatch({ type: 'user', text: 'x'.repeat(2000), ts: '2026-10-02T10:00:00.000Z' });
    } finally {
      if (origSH) Object.defineProperty(proto, 'scrollHeight', origSH);
      else Reflect.deleteProperty(proto, 'scrollHeight');
      if (origCH) Object.defineProperty(proto, 'clientHeight', origCH);
      else Reflect.deleteProperty(proto, 'clientHeight');
    }
    const body = document.querySelector('.msg.user .msg-body') as HTMLElement;
    expect(body.classList.contains('is-clamped')).toBe(true);
    const more = document.querySelector('.msg-user-more') as HTMLButtonElement;
    expect(more).toBeTruthy();
    expect(more.textContent).toBe('展开全文');
    // 点击 → 展开（撤掉截断），文案切「收起」
    more.click();
    expect(body.classList.contains('is-clamped')).toBe(false);
    expect(more.textContent).toBe('收起');
    // 再点 → 收回折叠态
    more.click();
    expect(body.classList.contains('is-clamped')).toBe(true);
    expect(more.textContent).toBe('展开全文');
  });

  // ─── StatusDock：底部状态条收纳器（优先级裁决 / error 豁免 / 收纳形态行为锁）───
  describe('StatusDock 底部状态条收纳（真机反馈 2026-10-01：形态太多）', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    const fcBar = (): HTMLElement => document.querySelector('.file-changes-bar') as HTMLElement;
    const pqBar = (): HTMLElement => document.querySelector('.pending-queue-bar') as HTMLElement;
    const actBar = (): HTMLElement => document.getElementById('activityBar') as HTMLElement;
    const chip = (): HTMLButtonElement =>
      document.querySelector('.status-dock__chip') as HTMLButtonElement;
    const panel = (): HTMLElement => document.querySelector('.status-dock__panel') as HTMLElement;
    const controls = (): HTMLElement => document.getElementById('dockControls') as HTMLElement;

    it('优先级裁决：文件改动 + 待发送同活 → 文件改动主位，待发送收进控件段（变异：去掉 priority 排序必红）', () => {
      mountChatView();
      dispatch({ type: 'file_changes', files: ['a.md'] });
      dispatch({ type: 'turn_update', state: { phase: 'running' }, pendingQueue: ['补充一'] });
      // 主位 = fileChanges（priority 3 > 2）：可见、在抽屉体外
      expect(fcBar().hidden).toBe(false);
      expect(panel()?.contains(fcBar())).toBe(false);
      // 次位 = pendingQueue：单实例移入抽屉体控件段（直接父 = #dockControls）
      expect(controls().contains(pqBar())).toBe(true);
      expect(pqBar().parentElement).toBe(controls());
      expect(pqBar().hidden).toBe(true); // 抽屉收起态内容隐藏
      // chip = +1
      expect(chip()?.textContent).toBe('+1');
      expect(chip().getAttribute('aria-expanded')).toBe('false');
    });

    it('error 豁免：错误 + 文件改动同活 → activityBar 恒主位（抽屉体外），文件改动降入控件段（变异：去掉 fixed 豁免必红）', () => {
      mountChatView();
      dispatch({ type: 'file_changes', files: ['a.md'] });
      dispatch({ type: 'notice', level: 'error', message: '出错了' });
      // error 恒主位：不在抽屉体内、可见
      expect(panel()?.contains(actBar())).toBe(false);
      expect(actBar().hidden).toBe(false);
      expect(actBar().textContent).toContain('出错了');
      // fileChanges 降为被收纳（进控件段；panel.contains 经 #dockControls 成立）
      expect(controls().contains(fcBar())).toBe(true);
      expect(chip()?.textContent).toBe('+1');
    });

    it('抽屉交互：点击 +N 展开（被收纳条可见、动作按钮可达），再点收起', () => {
      mountChatView();
      dispatch({ type: 'file_changes', files: ['a.md'] });
      dispatch({ type: 'turn_update', state: { phase: 'running' }, pendingQueue: ['补充一'] });
      chip().click();
      expect(chip().getAttribute('aria-expanded')).toBe('true');
      expect(panel().hidden).toBe(false);
      expect(pqBar().hidden).toBe(false);
      // 控件段内动作按钮直达：待发送清空按钮存在且可点击
      const clearBtn = pqBar().querySelector('.pending-queue-bar__clear') as HTMLButtonElement;
      expect(clearBtn).toBeTruthy();
      expect(clearBtn.disabled).toBe(false);
      // 再点收起
      chip().click();
      expect(panel().hidden).toBe(true);
      expect(chip().getAttribute('aria-expanded')).toBe('false');
    });

    it('单条空态：单条活跃入口隐藏；条撤销后主位顺延、全部清空时入口/抽屉体隐藏（C1：节点静态常驻，只切 hidden）', () => {
      mountChatView();
      // 单条：无收纳、无历史 ⇒ 入口不可达（节点仍在骨架中，仅 hidden）
      dispatch({ type: 'file_changes', files: ['a.md'] });
      expect(chip().hidden).toBe(true);
      expect(panel().hidden).toBe(true);
      // fileChanges 撤销 → pendingQueue 顺延为主位
      dispatch({ type: 'turn_update', state: { phase: 'running' }, pendingQueue: ['补充一'] });
      dispatch({ type: 'file_changes', files: [] });
      expect(fcBar().hidden).toBe(true);
      expect(pqBar().hidden).toBe(false);
      expect(chip().hidden).toBe(true); // 只剩一条 → 入口不可达
      // 全部清空 → 入口/抽屉体隐藏（无活动历史，本用例不触发 notice）
      dispatch({ type: 'turn_update', state: { phase: 'running' }, pendingQueue: [] });
      expect(chip().hidden).toBe(true);
      expect(panel().hidden).toBe(true);
      expect(pqBar().hidden).toBe(true);
    });
  });

  // ─── 后台任务条（CMD-1 阶段 2 · 方案-后台任务可见性与kill入口-20261004.md §2.3/§4）───
  // 缺口原状：后台命令「运行态零可见 + 用户无 kill 入口」（只有模型能砍）。
  // 本组钉死三件事：① 无任务零占用；② 运行态可见且带终止按钮；③ 终止只回宿主、webview 不自杀进程。
  describe('后台任务条（运行态可见 + 用户侧 kill 入口）', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    const bgBar = (): HTMLElement => document.querySelector('.background-tasks-bar') as HTMLElement;
    const rows = (): HTMLElement[] =>
      [...document.querySelectorAll('.background-tasks-bar__item')] as HTMLElement[];

    /** statusLabel 由宿主下发（真源 = 内核 BACKGROUND_TASK_STATUS_LABELS），webview 不自建词表 */
    function bgTask(over: Partial<BackgroundTaskView> = {}): BackgroundTaskView {
      return {
        taskId: 'bg-1',
        command: 'npm run build',
        status: 'running',
        statusLabel: '运行中',
        ...over,
      };
    }

    it('无任务时零占用（空快照 → 条不创建，不制造常驻噪音）', () => {
      mountChatView();
      dispatch({ type: 'background_tasks', items: [] });
      expect(bgBar()).toBeNull();
    });

    it('running 任务 → 条可见，行 = 命令原文 + 状态标签 + 终止按钮', () => {
      mountChatView();
      dispatch({ type: 'background_tasks', items: [bgTask()] });
      expect(bgBar()).toBeTruthy();
      expect(bgBar().hidden).toBe(false);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.querySelector('.background-tasks-bar__text')?.textContent).toBe(
        'npm run build',
      );
      // 状态文案直接消费下发的 statusLabel（改内核词表即改 UI，无第二套）
      expect(rows()[0]?.querySelector('.background-tasks-bar__status')?.textContent).toBe('运行中');
      expect(rows()[0]?.querySelector('.background-tasks-bar__kill')).toBeTruthy();
    });

    it('终态行无「终止」按钮（已结束再点即无反应 —— 僵尸交互不留），改为 `×` 收起', () => {
      mountChatView();
      dispatch({
        type: 'background_tasks',
        items: [bgTask({ status: 'completed', statusLabel: '已完成' })],
      });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.querySelector('.background-tasks-bar__kill')).toBeNull();
      // 终态行给 `×`：关掉的是「眼睛」不是「东西」（reason:'dismiss'，宿主只收起视图）
      expect(rows()[0]?.querySelector('.background-tasks-bar__dismiss')).toBeTruthy();
    });

    it('`×` 只收视图不终止进程（载荷带 reason=dismiss，与「终止」区分）', () => {
      const { postMessage } = mountChatView();
      dispatch({
        type: 'background_tasks',
        items: [bgTask({ taskId: 'bg-3', status: 'completed', statusLabel: '已完成' })],
      });
      const dismiss = rows()[0]?.querySelector(
        '.background-tasks-bar__dismiss',
      ) as HTMLButtonElement;
      postMessage.mockClear();
      dismiss.click();
      expect(postMessage).toHaveBeenCalledWith({
        type: 'background_kill',
        taskId: 'bg-3',
        reason: 'dismiss',
      });
      // 反向守卫：running 行的「终止」**不带** reason（缺省即 terminate，兼容旧 webview）
      dispatch({
        type: 'background_tasks',
        items: [bgTask({ taskId: 'bg-4', status: 'running', statusLabel: '运行中' })],
      });
      const kill = document.querySelector('.background-tasks-bar__kill') as HTMLButtonElement;
      postMessage.mockClear();
      kill.click();
      expect(postMessage).toHaveBeenCalledWith({ type: 'background_kill', taskId: 'bg-4' });
    });

    it('running 行刻意不给 `×`（进程在跑必须始终可见 —— 本缺口最初的样子）', () => {
      mountChatView();
      dispatch({ type: 'background_tasks', items: [bgTask()] });
      expect(rows()[0]?.querySelector('.background-tasks-bar__dismiss')).toBeNull();
      expect(rows()[0]?.querySelector('.background-tasks-bar__kill')).toBeTruthy();
    });

    it('点「终止」只回宿主（执行只能落 host），载荷带 taskId', () => {
      const { postMessage } = mountChatView();
      dispatch({ type: 'background_tasks', items: [bgTask({ taskId: 'bg-9' })] });
      const killBtn = rows()[0]?.querySelector('.background-tasks-bar__kill') as HTMLButtonElement;
      postMessage.mockClear();
      killBtn.click();
      expect(postMessage).toHaveBeenCalledWith({ type: 'background_kill', taskId: 'bg-9' });
    });

    it('命令原文过长截断，title 保留全文（不解析、不改写命令）', () => {
      mountChatView();
      const long = 'x'.repeat(200);
      dispatch({ type: 'background_tasks', items: [bgTask({ command: long })] });
      const text = rows()[0]?.querySelector('.background-tasks-bar__text') as HTMLElement;
      expect(text.textContent).toBe(`${'x'.repeat(100)}…`);
      expect(text.title).toBe(long);
    });

    it('优先级垫底：不顶掉 activity 主状态条，后台条收进抽屉控件段（chip = +1）', () => {
      mountChatView();
      dispatch({ type: 'notice', level: 'info', message: '正在思考' });
      dispatch({ type: 'background_tasks', items: [bgTask()] });
      const actBar = document.getElementById('activityBar') as HTMLElement;
      const chip = document.querySelector('.status-dock__chip') as HTMLButtonElement;
      const panel = document.querySelector('.status-dock__panel') as HTMLElement;
      const controls = document.getElementById('dockControls') as HTMLElement;
      expect(actBar.hidden).toBe(false);
      expect(panel.contains(actBar)).toBe(false); // activity 恒主位
      expect(controls.contains(bgBar())).toBe(true); // 后台条被收进控件段
      expect(bgBar().parentElement).toBe(controls);
      expect(chip.textContent).toBe('+1');
    });
  });

  it('流式结束后复制按钮使用完整原始文本（dataset.rawText 修复复制只复制首 chunk）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '第一段 ' });
    dispatch({ type: 'chunk', content: '第二段' });
    dispatch({ type: 'done' });
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    // 完整原始文本存在消息 dataset（复制按钮据此复制完整 Markdown 源）
    expect(assistant.dataset.rawText).toBe('第一段 第二段');
    // 复制按钮存在（主动可见）
    expect(assistant.querySelector('.msg-copy-icon')).not.toBeNull();
  });

  it('interrupted 同样 finalize：渲染 Markdown + 清光标态 + 代码块增强', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '- 列表项一' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.dataset.status).toBe('正在回答中');
    // 打断 → 渲染已累积的半截内容为 Markdown（列表成 <li>），正文块移除（中断态由停止行承担）
    dispatch({ type: 'interrupted' });
    expect(body.isConnected).toBe(false);
  });

  it('Markdown 渲染不注入 LLM 恶意脚本（DOMPurify 消毒）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '<img src=x onerror=alert(1)> 安全文本' });
    dispatch({ type: 'done' });
    // 消毒后 onerror 脚本被剥离（marked 透传原始 HTML，DOMPurify 负责剥离恶意属性），
    // 仅保留无害文本/元素
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.querySelector('img[onerror]')).toBeNull();
    expect(body.textContent).toContain('安全文本');
  });

  it('历史回放的一次性 assistant 消息直接渲染 Markdown（无流式光标态，complete 轮落终态）', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'round-md',
        assistantMessage: { content: '## 标题\n\n正文', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    // 历史重放非流式：直接渲染 Markdown（标题成 <h2>），complete 轮终态定格「已完成」
    expect(body.querySelector('h2')).not.toBeNull();
    expect(body.dataset.status).toBe('已完成');
  });
});

describe('chatView 对话闭环操作（复制/删除，2026-08-16）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('用户消息底部有复制按钮（复制用户原始输入）', () => {
    mountChatView();
    dispatch({ type: 'user', text: '你好，帮我打磨文档', ts: '2026-08-14T09:00:00.000Z' });
    const copyBtn = document.querySelector('.msg-user-actions .msg-copy-icon') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.getAttribute('aria-label')).toBe('复制消息');
  });

  it('AI 消息底部有复制 + 删除按钮（删除问答闭环入口）', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'round-del',
        assistantMessage: { content: '回答', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    expect(msg.querySelector('.msg-copy-icon')).not.toBeNull();
    const del = msg.querySelector('.msg-delete-icon') as HTMLButtonElement;
    expect(del).not.toBeNull();
    // 有 timestamp 锚点时删除按钮可用
    expect(del.disabled).toBe(false);
  });

  it('流式回答 done 携带 roundId → 分叉按钮启用（任意 LLM 回答可分叉）', () => {
    const { postMessage } = mountChatView();
    // 流式期间：roundId 未知 → 分叉按钮初始禁用（灰色）
    dispatch({ type: 'chunk', content: '第一段' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const forkBtn = msg.querySelector('.msg-fork-icon') as HTMLButtonElement;
    expect(forkBtn).not.toBeNull();
    expect(forkBtn.disabled).toBe(true);
    // 本轮闭环结束：host done 携带 roundId → 回填 dataset 并启用按钮
    dispatch({ type: 'done', roundId: 'round-42' });
    // done 消息后宿主紧跟 status:done 释放 sessionControlsLocked，
    // forkBtn.disabled 判定 = locked || !roundId，锁未释放时恒为 true
    dispatch({ type: 'status', state: 'done' });
    expect(msg.dataset.roundId).toBe('round-42');
    expect(forkBtn.disabled).toBe(false);
    // 点击 → 携带该 roundId 发 fork_session（从本轮位置分叉新会话）
    forkBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'fork_session', roundId: 'round-42' });
  });

  it('interrupted 携带 roundId → 打断产生的部分回答也可分叉', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '半截回答' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const forkBtn = msg.querySelector('.msg-fork-icon') as HTMLButtonElement;
    expect(forkBtn.disabled).toBe(true);
    dispatch({ type: 'interrupted', roundId: 'round-7' });
    // interrupted 后宿主同样发 status:done 释放锁
    dispatch({ type: 'status', state: 'done' });
    expect(msg.dataset.roundId).toBe('round-7');
    expect(forkBtn.disabled).toBe(false);
  });

  it('AI 消息删除按钮：携带该消息 ts 发送 delete_turn（host 确认后截断）', () => {
    const { postMessage } = mountChatView();
    dispatchReplay(
      makeRound({
        id: 'round-del-ts',
        assistantMessage: { content: '回答', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    del.click();
    // 点删除 → 发 delete_turn（携带渲染时存的 dataset.ts 锚点）
    expect(postMessage).toHaveBeenCalledWith({
      type: 'delete_turn',
      ts: '2026-08-14T09:00:30.000Z',
    });
  });

  it('AI 消息无 timestamp 时删除按钮禁用（避免锚点失效）', () => {
    mountChatView();
    // 流式未完成即被清空：assistant 无 ts
    dispatch({ type: 'chunk', content: '半截' });
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('流式回答期间底部操作行隐藏，done 后才展示（按钮 + 时间戳）', () => {
    mountChatView();
    // 首个 chunk：footer 处于 pending（隐藏）态
    dispatch({ type: 'chunk', content: '第一段' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const footer = msg.querySelector('.msg-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 流式持续：仍隐藏
    dispatch({ type: 'chunk', content: '第二段' });
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 回答完毕：展示 footer
    dispatch({ type: 'done', roundId: 'r1' });
    expect(footer.classList.contains('is-pending')).toBe(false);
  });

  it('meta 骨架（prepareFlowShell）期间 footer 隐藏，interrupted 打断后展示', () => {
    mountChatView();
    // meta 到达 → 骨架建立（footer pending）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const footer = msg.querySelector('.msg-footer') as HTMLElement;
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 正文流入骨架
    dispatch({ type: 'chunk', content: '回答' });
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 打断（interrupted 同样 finalize）：展示 footer
    dispatch({ type: 'interrupted', roundId: 'r2' });
    expect(footer.classList.contains('is-pending')).toBe(false);
  });

  it('历史回放的一次性 assistant 消息 footer 直接展示（已完成消息）', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'round-footer',
        assistantMessage: { content: '回答', ts: '2026-08-14T09:00:30.000Z' },
        status: 'complete',
      }),
    );
    const footer = document.querySelector('.msg.assistant .msg-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.classList.contains('is-pending')).toBe(false);
  });
});

describe('chatView Follow-up 建议（T2，2026-08-17 回复后关联推荐）', () => {
  it('suggestions 渲染「接下来可以探索」chips 块（textContent 防注入）', () => {
    mountChatView();
    dispatch({
      type: 'suggestions',
      items: [
        { prompt: '继续深入：甲', label: '甲' },
        { prompt: '继续深入：乙', label: '乙' },
      ],
    });
    const block = document.querySelector('.followup');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.followup__caption')?.textContent).toBe('接下来可以探索');
    const chips = block?.querySelectorAll('.suggestion-chip');
    expect(chips).toHaveLength(2);
    // 标签与 prompt 均为 textContent 赋值，恶意 HTML 不被注入
    expect(chips?.[0]?.textContent).toBe('甲');
    expect((chips?.[0] as HTMLButtonElement).dataset.prompt).toBe('继续深入：甲');
  });

  it('点击 follow-up chip 填入输入框并聚焦（复用 .suggestion-chip 点击委托）', () => {
    mountChatView();
    dispatch({
      type: 'suggestions',
      items: [{ prompt: '继续深入：记忆甲', label: '记忆甲' }],
    });
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const chip = document.querySelector('.followup .suggestion-chip') as HTMLButtonElement;
    chip.click();
    expect(input.value).toBe('继续深入：记忆甲');
    expect(document.activeElement).toBe(input);
  });

  it('多轮建议幂等：新 suggestions 覆盖旧块（不堆叠残影）', () => {
    mountChatView();
    dispatch({ type: 'suggestions', items: [{ prompt: '继续深入：旧', label: '旧' }] });
    dispatch({ type: 'suggestions', items: [{ prompt: '继续深入：新', label: '新' }] });
    const blocks = document.querySelectorAll('.followup');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toContain('新');
    expect(blocks[0].textContent).not.toContain('旧');
  });

  it('clear_ok 清除 follow-up 建议块（不残留污染重放视图）', () => {
    mountChatView();
    dispatch({ type: 'suggestions', items: [{ prompt: '继续深入：甲', label: '甲' }] });
    expect(document.querySelector('.followup')).not.toBeNull();
    dispatch({ type: 'clear_ok' });
    expect(document.querySelector('.followup')).toBeNull();
  });

  it('空 items 不渲染建议块（记忆库为空/未装配时零残留）', () => {
    mountChatView();
    dispatch({ type: 'suggestions', items: [] });
    expect(document.querySelector('.followup')).toBeNull();
  });

  it('prefill_input 写入输入框并聚焦（角色 handoff 上下文传递，不自动发送）', () => {
    mountChatView();
    dispatch({ type: 'prefill_input', text: '继续以「技术文档工程师」的视角处理以上任务' });
    const input = document.getElementById('input') as HTMLTextAreaElement;
    expect(input.value).toBe('继续以「技术文档工程师」的视角处理以上任务');
    expect(document.activeElement).toBe(input);
  });

  it('prefill_input 在生成中（thinking+有输入）同步按钮语义 → 标题=发送补充（方案 §3.2b-1）', () => {
    mountChatView();
    dispatchTurn({ phase: 'running' });
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    // running+空输入：发送键默认「停止生成」
    expect(send.title).toBe('停止生成');
    // 生成中预填文本 → 必须同步语义（标题随相位+输入重算），否则窗口期文案过期（血训同型）
    dispatch({ type: 'prefill_input', text: '补充：先核对术语表' });
    expect(input.value).toBe('补充：先核对术语表');
    expect(send.title).toBe('发送补充（排队等 step 边界注入）');
  });
});

describe('chatView 安全审计指标（G6，2026-08-23）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('metrics 带 securityAudit → 可观测区渲染安全审计行（basename 路径）', () => {
    mountChatView();
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: { llmCallCount: 3, toolFailureCount: 1, truncationCount: 0 },
      securityAudit: {
        total: 4,
        denied: 1,
        recent: [
          { type: 'path-allow', path: 'foo.ts' },
          { type: 'path-deny', path: 'out.js', reason: '路径越界，不在白名单内' },
        ],
      },
    });
    const metricsEl = document.getElementById('activityMetrics') as HTMLElement;
    expect(metricsEl.textContent).toContain('安全审计 4 次 · 拒绝 1');
    expect(metricsEl.textContent).toContain('path-allow foo.ts');
    // 拒绝原因须透出（仅显示 type+path 会丢弃 reason）
    expect(metricsEl.textContent).toContain('path-deny out.js (路径越界，不在白名单内)');
  });

  it('metrics 无 securityAudit → 不显示安全审计行', () => {
    mountChatView();
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: { llmCallCount: 1, toolFailureCount: 0, truncationCount: 0 },
    });
    const metricsEl = document.getElementById('activityMetrics') as HTMLElement;
    expect(metricsEl.textContent).not.toContain('安全审计');
  });
});

describe('chatView 任务看板（H4 任务驱动多步闭环，2026-08-23 → 2026-09-17 合并单轨 PLAN-UI-1）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plan_update ≥3 个任务项 → 常驻条渲染（N/M + 当前任务项 + 浮层全量任务项列表）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '收集需求', status: 'done', order: 0, planItemLog: [] },
        { id: 's2', description: '设计方案', status: 'active', order: 1, planItemLog: [] },
        { id: 's3', description: '编写文档', status: 'pending', order: 2, planItemLog: [] },
      ],
    });
    const bar = document.querySelector('#planBar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(false);
    // 头行：N/M（完成的 N/total）+ 当前 active step 摘要
    expect(bar.querySelector('#planBarCount')?.textContent).toBe('1/3');
    expect(bar.querySelector('#planBarCurrent')?.textContent).toBe('设计方案');
    // 浮层懒构建：收起态面板隐藏且不建 DOM（省运行期开销）
    const panel = bar.querySelector('#planBarPanel') as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(panel.childElementCount).toBe(0);
    // 点击展开 → 从当前快照补建全量任务项列表（按 order 序号 + 描述；状态 class 按 status 映射）
    (bar.querySelector('#planBarHead') as HTMLElement).click();
    expect(panel.hidden).toBe(false);
    const planItems = panel.querySelectorAll('.plan-item');
    expect(planItems).toHaveLength(3);
    expect(planItems[0].querySelector('.plan-item-title')?.textContent).toBe('1. 收集需求');
    expect(planItems[0].classList.contains('plan-item-done')).toBe(true);
    expect(planItems[0].querySelector('.plan-item-badge')?.textContent).toBe('已完成');
    expect(planItems[1].querySelector('.plan-item-title')?.textContent).toBe('2. 设计方案');
    expect(planItems[1].classList.contains('plan-item-active')).toBe(true);
    expect(planItems[1].querySelector('.plan-item-badge')?.textContent).toBe('进行中');
    expect(planItems[2].querySelector('.plan-item-title')?.textContent).toBe('3. 编写文档');
    expect(planItems[2].classList.contains('plan-item-pending')).toBe(true);
    expect(planItems[2].querySelector('.plan-item-badge')?.textContent).toBe('待执行');
  });

  it('任务看板浮层展开态按 Esc 收起（对齐 dropdown 族键盘契约）；收起态 Esc 无副作用', () => {
    mountChatView();
    // 条数 ≥3 常驻条才显示（setPlanBarVisible 门槛）；planItemLog 为协议必填字段
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '收集需求', status: 'done', order: 0, planItemLog: [] },
        { id: 's2', description: '设计方案', status: 'active', order: 1, planItemLog: [] },
        { id: 's3', description: '编写文档', status: 'pending', order: 2, planItemLog: [] },
      ],
    });
    const head = document.querySelector('#planBarHead') as HTMLElement;
    const panel = document.querySelector('#planBarPanel') as HTMLElement;
    head.click();
    expect(panel.hidden).toBe(false);
    // 展开态 Esc → 收起（aria 复位 + 面板清空，与点击外部收起同路径）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(panel.childElementCount).toBe(0);
    // 收起态再按 Esc：幂等无副作用（aria 保持 false）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  it('plan_update 携带 planItemLog → 浮层任务项节点展开显示该任务项的推进记录', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      items: [
        {
          id: 's1',
          description: '收集需求',
          status: 'done',
          order: 0,
          planItemLog: [{ planItemId: 's1', summary: '梳理用户痛点并产出需求清单' }],
        },
        { id: 's2', description: '设计方案', status: 'active', order: 1, planItemLog: [] },
        { id: 's3', description: '编写文档', status: 'pending', order: 2, planItemLog: [] },
      ],
    });
    const panel = document.querySelector('#planBarPanel') as HTMLElement;
    // 展开浮层（懒构建）后检查任务项节点
    (document.querySelector('#planBarHead') as HTMLElement).click();
    const planItems = panel.querySelectorAll('.plan-item');
    // 有关联推进记录的任务项：details 携带摘要 body（折叠态，仅标题常显）
    const withRounds = planItems[0] as HTMLDetailsElement;
    expect(withRounds.open).toBe(false);
    expect(withRounds.querySelector('.plan-item-round')?.textContent).toBe(
      '梳理用户痛点并产出需求清单',
    );
    // 无关联推进记录的任务项：不渲染空摘要体
    const noRounds = planItems[1] as HTMLDetailsElement;
    expect(noRounds.querySelector('.plan-item-round')).toBeNull();
  });

  it('plan_update 覆盖旧看板（幂等更新，不堆叠）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '第一步', status: 'active', order: 0, planItemLog: [] },
        { id: 's2', description: '第二步', status: 'pending', order: 1, planItemLog: [] },
        { id: 's3', description: '第三步', status: 'pending', order: 2, planItemLog: [] },
      ],
    });
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '第一步', status: 'done', order: 0, planItemLog: [] },
        { id: 's2', description: '第二步', status: 'active', order: 1, planItemLog: [] },
        { id: 's3', description: '第三步', status: 'pending', order: 2, planItemLog: [] },
      ],
    });
    const bar = document.querySelector('#planBar') as HTMLElement;
    expect(bar).not.toBeNull();
    // 仅一个常驻条容器
    expect(document.querySelectorAll('#planBar')).toHaveLength(1);
    // 展开浮层 → 任务项被新快照覆盖，N/M 同步
    (bar.querySelector('#planBarHead') as HTMLElement).click();
    expect(bar.querySelectorAll('.plan-item')).toHaveLength(3);
    expect(bar.querySelector('#planBarCount')?.textContent).toBe('1/3');
  });

  it('plan_update <3 个任务项 → 常驻条不出现（webview 展示层 ≥3 个任务项门槛；与内核 needsPlanning 无关）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '第一步', status: 'active', order: 0, planItemLog: [] },
        { id: 's2', description: '第二步', status: 'pending', order: 1, planItemLog: [] },
      ],
    });
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(true);
    // 运行时无 inline 轨（合并单轨）
    expect(document.querySelector('.plan-inline')).toBeNull();
  });

  it('plan_update 空 items → 常驻条隐藏、内容区不留完成卡片', () => {
    mountChatView();
    // 建块（正文块存在）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正文', roundId: 'r1' });
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '第一步', status: 'done', order: 0, planItemLog: [] },
        { id: 's2', description: '第二步', status: 'done', order: 1, planItemLog: [] },
        { id: 's3', description: '第三步', status: 'done', order: 2, planItemLog: [] },
      ],
    });
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(false);
    dispatch({ type: 'plan_update', items: [] });
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(true);
    // 内容区零卡片：不再留完成快照（过程全由 round-block 折叠块承载）
    expect(document.querySelector('.plan-inline.plan-inline-done')).toBeNull();
  });

  it('点击常驻条头部 → 展开/收起锚定浮层（aria-expanded 同步）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '第一步', status: 'active', order: 0, planItemLog: [] },
        { id: 's2', description: '第二步', status: 'pending', order: 1, planItemLog: [] },
        { id: 's3', description: '第三步', status: 'pending', order: 2, planItemLog: [] },
      ],
    });
    const head = document.querySelector('#planBarHead') as HTMLElement;
    const panel = document.querySelector('#planBarPanel') as HTMLElement;
    const chevron = document.querySelector('#planBarChevron') as HTMLElement;
    // 折叠指示为 icons.ts 的 SVG（▸/▾ 字符形态禁用）。
    // 图标守卫的 FORBIDDEN 字符集不含 U+25BE/U+25B8，故此处显式锁住「不得回退为字符」。
    expect(chevron.textContent, '折叠指示不得回退为字符图标').toBe('');
    expect(chevron.querySelector('svg'), '折叠指示必须是 SVG').not.toBeNull();
    expect(panel.hidden).toBe(true);
    head.click();
    expect(panel.hidden).toBe(false);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(chevron.dataset.icon).toBe('chevron-down');
    head.click();
    expect(panel.hidden).toBe(true);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(chevron.dataset.icon).toBe('chevron-right');
  });

  it('clear_ok → 移除常驻条（切换会话不残留）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正文', roundId: 'r1' });
    dispatch({
      type: 'plan_update',
      items: [
        { id: 's1', description: '第一步', status: 'done', order: 0, planItemLog: [] },
        { id: 's2', description: '第二步', status: 'done', order: 1, planItemLog: [] },
        { id: 's3', description: '第三步', status: 'done', order: 2, planItemLog: [] },
      ],
    });
    dispatch({ type: 'plan_update', items: [] });
    // 内容区零完成卡片（清空前已无；断言锁死后门残留）
    expect(document.querySelector('.plan-inline-done')).toBeNull();
    dispatch({ type: 'clear_ok' });
    expect(document.querySelector('#planBar')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.plan-inline-done')).toBeNull();
  });
});

describe('chatView 回答等待指示器（③ 等待反馈，2026-08-29）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('meta 前 thinking 事件 → 显示相位 + 等待秒数；meta 到达骨架接管后移除', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // prepare 阶段：assembling（meta 未到、无骨架）
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'assembling' } },
    });
    let wait = messages.querySelector('.pending-wait') as HTMLElement | null;
    expect(wait).not.toBeNull();
    expect(wait!.textContent).toContain('装配上下文中');
    expect(wait!.textContent).toMatch(/已等待 \d+s/);

    // 相位推进 → 文案随 thinking 更新
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'llm_calling' } },
    });
    expect(messages.querySelector('.pending-wait')!.textContent).toContain('调用模型中');

    // meta 到达（建流式骨架 + 平铺容器）→ 等待条移除，过程平铺容器接管
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    expect(messages.querySelector('.pending-wait')).toBeNull();
    expect(messages.querySelector('.process-flow')).not.toBeNull(); // v1.8：平铺容器接管，无大折叠壳
    expect(messages.querySelector('.round-block')).toBeNull();
  });

  it('正文开启（chunk 首段）后等待指示器退场', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'processing' } },
    });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    // chunk 首段（无骨架路径 beginStreaming）→ 等待条移除
    dispatch({ type: 'chunk', content: '回答' });
    expect(messages.querySelector('.pending-wait')).toBeNull();
  });

  it('done / error 收尾后等待指示器移除（不留残留定时器渲染）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'assembling' } },
    });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    dispatch({ type: 'done' });
    expect(messages.querySelector('.pending-wait')).toBeNull();

    // error 分支同样清理
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'processing' } },
    });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    dispatch({ type: 'error', message: 'boom' });
    expect(messages.querySelector('.pending-wait')).toBeNull();
  });

  it('error 消息带 category（结构化分类）时按 message 渲染、不崩溃', () => {
    // TS-10b：内核 error chunk 携带 category（connection/timeout/unknown），
    // webview 只消费 message（已是宿主映射后的友好文案），category 是透传诊断字段不影响渲染
    mountChatView();
    dispatch({
      type: 'error',
      message: '对话连接中断，已保留部分回答，请检查网络后重试',
      category: 'connection',
    });
    const body = document.querySelector('.msg.error .msg-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent).toBe('对话连接中断，已保留部分回答，请检查网络后重试');
  });

  it('纯 user 消息（历史回放路径）不触发等待指示器，防止误报', () => {
    // 纯 user 消息（历史回放 path）不建等待条——等待条只由运行时 thinking 事件驱动
    mountChatView();
    dispatch({ type: 'user', text: '旧消息', ts: 't' });
    expect(document.querySelector('.pending-wait')).toBeNull();
  });

  it('interrupted 后等待指示器退场（③ 排雷补漏：done/error 均清，中断也不能漏）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'llm_calling' } },
    });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    // 用户点停止 → interrupted（无 meta/chunk/done/error 的收尾通道）→ 等待条必须移除
    dispatch({ type: 'interrupted' });
    expect(messages.querySelector('.pending-wait')).toBeNull();
  });
});

describe('chatView 上下文占用条：按选中 LLM 实时显示上限（④ 预算可视化，2026-08-31）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chat_providers 到达（含选中模型）→ 圆环显示该模型容量且未隐藏（首轮对话前即有真实容量）', () => {
    mountChatView();
    const bar = document.getElementById('contextOccupancy') as HTMLElement;
    const tipEl = document.getElementById('occTip') as HTMLElement;
    // 无 Provider 前：默认隐藏，避免展示误导性的 0/0
    expect(bar.hidden).toBe(true);

    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
        { name: 'local', displayName: '本地', contextWindow: 8192, limitTokens: 8192 },
      ],
      activeName: 'deepseek',
    });

    // 展示所选模型上限（fmtTokens 缩写 128K），已用 0
    expect(bar.hidden).toBe(false);
    expect(tipEl.textContent).toContain('总容量 128K');
    expect((document.getElementById('occPercent') as HTMLElement).textContent).toBe('0%');
    // 空环：dashoffset = 周长（无可见充能弧）
    const fill = document.getElementById('occFill') as unknown as SVGCircleElement;
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(2 * Math.PI * 16, 1);
  });

  it('无选中 Provider 时圆环保持隐藏（无「当前模型」可依赖，不展示缺省值）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [{ name: 'a', displayName: 'A', limitTokens: 64000 }],
      activeName: undefined,
    });
    const bar = document.getElementById('contextOccupancy') as HTMLElement;
    expect(bar.hidden).toBe(true);
  });

  it('同一上限的 chat_providers 重复推送不重置已用数字（保留 context_occupancy 真实占用）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
      ],
      activeName: 'deepseek',
    });
    // 首轮流式结束 → 真实占用到达（占用 24,000）
    dispatch({
      type: 'context_occupancy',
      occupancy: {
        totalTokens: 128000,
        rolePackBaseTokens: 20000,
        dialogueTokens: 2000,
        dialogueCount: 3,
        inputAnchorTokens: 0,
        outputReserveTokens: 19200,
        freeTokens: 86800,
      },
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain(
      '完整对话：3 条',
    );
    // 同款 chat_providers 再推送（如面板刷新）→ 上限未变 → 不把已用清回 0
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
      ],
      activeName: 'deepseek',
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain(
      '完整对话：3 条',
    );
  });

  it('切换到其他模型（上限不同）→ 容量与已用同步更新为新模型（实时跟随选中 LLM）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
        { name: 'local', displayName: '本地', contextWindow: 8192, limitTokens: 8192 },
      ],
      activeName: 'deepseek',
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('总容量 128K');

    // 用户切换模型（底部模型下拉）→ host 重推 chat_providers（activeName 变化）
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
        { name: 'local', displayName: '本地', contextWindow: 8192, limitTokens: 8192 },
      ],
      activeName: 'local',
    });
    // 容量切换为本地模型 8K，占用清零（旧模型占用数据对新模型无意义）
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain(
      '总容量 8,192',
    );
    expect((document.getElementById('occPercent') as HTMLElement).textContent).toBe('0%');
  });

  it('context_occupancy 真实占用覆盖首屏容量（内核为总容量唯一真理源）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 64000, limitTokens: 64000 },
      ],
      activeName: 'deepseek',
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('总容量 64K');

    // 内核 prepare 后回推真实占用
    dispatch({
      type: 'context_occupancy',
      occupancy: {
        totalTokens: 64000,
        rolePackBaseTokens: 15000,
        dialogueTokens: 1000,
        dialogueCount: 2,
        inputAnchorTokens: 50,
        outputReserveTokens: 9600,
        freeTokens: 38350,
      },
    });
    // 更新：百分比取整显示 40%（40.08% → toFixed(0)）
    expect((document.getElementById('occPercent') as HTMLElement).textContent).toBe('40%');
    // 圆环充能：dashoffset 用精确比例 (64000−38350)/64000 = 0.4008（弧线精确、显示取整）
    const fill = document.getElementById('occFill') as unknown as SVGCircleElement;
    const expectedOffset = 2 * Math.PI * 16 * (38350 / 64000);
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(expectedOffset, 1);
    // 明细弹窗：含角色包比例 + 条数 + token（fmtTokens 整千缩写 15K/1K）
    const tip = (document.getElementById('occTip') as HTMLElement).textContent ?? '';
    expect(tip).toContain('总容量 64K');
    expect(tip).toContain('完整对话：2 条 · 1K');
    expect(tip).toContain('角色包/系统设定：15K（占窗口 23.4%）');
  });
});

describe('chatView 澄清候选选项（ask_user options，2026-09-02）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turn_update(waiting/ask) 携带 options → 消息流内联选择题渲染可点选项按钮（提问下方，非底部弹层）', () => {
    const { postMessage } = mountChatView();
    // 先建提问骨架作为内联锚点（提问块；纯视觉锚点，不含完整内核流）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [
        {
          slot: 'task',
          question: '请描述当前任务目标',
          options: ['延续当前会话目标', '开启新任务'],
        },
      ],
    });
    // 内联选择题在消息流内（提问块下方），而非底部 clarifyBar 替换输入栏
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.querySelector('.ask-inline__q')?.textContent).toBe('请描述当前任务目标');
    const btns = box.querySelectorAll('.ask-inline__opt');
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toBe('延续当前会话目标');
    expect(btns[1].textContent).toBe('开启新任务');
    // 补充输入通道随内联块出现（统一形态：每题输入框 + 底部提交按钮）
    expect(box.querySelector('.ask-inline__input')).not.toBeNull();
    expect(box.querySelector('.ask-inline__submit')).not.toBeNull();
    // 底部 clarifyBar 不激活（主路径已内联）
    expect(
      (document.getElementById('clarifyBar') as HTMLElement).classList.contains('visible'),
    ).toBe(false);
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'input', kind: 'answer' });
  });

  it('replay 与 waiting(ask) 同一条消息 → 提问 UI 不得被重放重建抹掉（渲染须后于重放）', () => {
    mountChatView();
    // 提问骨架作为内联锚点（提问挂起时消息流里已有 assistant 段，正常形态）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 宿主在有未答提问时重放：视图重建后的 ready 握手重放（切走再切回）、流尾「流期间视图
    // 重建过」补重放，都走 `postTurnUpdate(undefined, true)`——**同一条消息**既带 replay:true
    // 又带 state(waiting/ask + questions)。
    dispatch({
      type: 'turn_update',
      rounds: [],
      replay: true,
      state: {
        phase: 'waiting',
        reason: 'ask',
        questions: [{ slot: 'task', question: '确认执行？', options: ['是', '否'] }],
      },
    });
    // 不变量：提问未答 ⇒ 必然存在**可见**的提问 UI（内联卡 或 底部兜底条），不得两者皆无
    // ——顺序契约（重放先、提问渲染后）的事故背景见 chatView.ts turn_update 分支注释。
    const inline = document.querySelector('.ask-inline');
    const bar = document.getElementById('clarifyBar') as HTMLElement;
    expect(inline !== null || bar.classList.contains('visible')).toBe(true);
    // 提问原文必须在场（两种形态任一承载）
    const shown = inline?.querySelector('.ask-inline__q')?.textContent ?? bar.textContent ?? '';
    expect(shown).toContain('确认执行？');
  });

  it('点击内联选项 → 标记该题已答 is-selected，再点「提交回答」提交 input(kind=answer) 单元素', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [
        {
          slot: 'task',
          question: '请描述当前任务目标',
          options: ['延续当前会话目标', '开启新任务'],
        },
      ],
    });
    const btns = document.querySelectorAll<HTMLButtonElement>('.ask-inline__opt');
    const submit = document.querySelector('.ask-inline__submit') as HTMLButtonElement;
    // 统一形态：单问 = 一个问题的多问——点选项先标记（高亮），全部答完才可点「提交回答」
    expect(submit.disabled).toBe(true);
    (btns[1] as HTMLButtonElement).click();
    // 点选项不立即提交（无二次回车/即答自提交；按钮此时已答→可提交）
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input', kind: 'answer' }),
    );
    expect((btns[1] as HTMLElement).classList.contains('is-selected')).toBe(true);
    expect(submit.disabled).toBe(false);
    submit.click();
    // 一次性提交单元素数组（与提问按序一对一）
    expect(postMessage).toHaveBeenCalledWith({
      type: 'input',
      kind: 'answer',
      answers: ['开启新任务'],
    });
    // 内联块已移除（答案就位）
    expect(document.querySelector('.ask-inline')).toBeNull();
  });

  it('多 ask 聚合（P2）：逐题点选高亮 is-selected，全部答完才可提交 input(kind=answer) 数组', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [
        { slot: 'q1', question: '写作风格？', options: ['中文', '英文'] },
        { slot: 'q2', question: '篇幅长度？', options: ['短篇', '长篇'] },
      ],
    });
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    // 多问：每题渲染一个 item（两题各自选项组 + 每题输入框），统一形态（单/多问同构）
    expect(box.querySelectorAll('.ask-inline__item')).toHaveLength(2);
    // 提交按钮初始 disabled（全部答完才可提交）
    const submit = box.querySelector('.ask-inline__submit') as HTMLButtonElement;
    expect(submit).not.toBeNull();
    expect(submit.disabled).toBe(true);
    // 只答第 1 题：不提交任何回答、按钮仍 disabled（坑：点一个即提交会跳过其余问题）
    const btns = box.querySelectorAll<HTMLButtonElement>('.ask-inline__opt');
    expect(btns).toHaveLength(4);
    (btns[0] as HTMLButtonElement).click(); // 第一题「中文」
    // 未全部答完：不提交任何回答（postMessage 在此仅 mount ready 调用）
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input', kind: 'answer' }),
    );
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input', kind: 'answer' }),
    );
    expect(submit.disabled).toBe(true);
    // 已答题按钮高亮 is-selected（可再点改选）
    expect((btns[0] as HTMLElement).classList.contains('is-selected')).toBe(true);
    expect((btns[1] as HTMLElement).classList.contains('is-selected')).toBe(false);
    // 答完第 2 题 → 提交按钮 enabled → 一次性提交 answers 数组（与提问按序一对一）
    (btns[3] as HTMLButtonElement).click(); // 第二题「长篇」
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'input',
      kind: 'answer',
      answers: ['中文', '长篇'],
    });
    // 提交后内联块移除（聚合卡片任务完成）
    expect(document.querySelector('.ask-inline')).toBeNull();
  });

  it('ask 点选项自动 continue → resume 原位续写单块（问题回归：防建块 B 致双复制条/错位）', () => {
    const { postMessage } = mountChatView();
    // ① 建块 A：meta + 正文（同 roundId r1）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '提问前的正文', roundId: 'r1' });
    // ② ask 弹窗（内联选择题）
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question: '选哪个？', options: ['方案 A', '方案 B'] }],
    });
    // ③ 点选项标记 + 提交（应把块 A 记为 pausedAssistantEl 续写锚；统一形态下须再点「提交回答」）
    const btns = document.querySelectorAll<HTMLButtonElement>('.ask-inline__opt');
    (btns[0] as HTMLButtonElement).click();
    const submit = document.querySelector('.ask-inline__submit') as HTMLButtonElement;
    submit.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'input',
      kind: 'answer',
      answers: ['方案 A'],
    });
    // ④ resume 重发 meta（宿主收到 input(kind=answer) 后自动继续 runFlow）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // ⑤ 续写正文（同 roundId）→ done 收敛
    dispatch({ type: 'chunk', content: '已按方案 A 继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // 回归断言：不得出现第二个 assistant 块（若 prepareFlowShell 建块 B → 双复制条/角色名分裂（坑））
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('提问前的正文已按方案 A 继续');
  });

  it('骨架期 ask：LLM 未输出正文即提问——点选项后回发 user(kind) 不删骨架，resume 原位续写单块（2026-09-21 回归）', () => {
    const { postMessage } = mountChatView();
    // ① meta 建骨架（此后无任何正文 chunk —— 骨架未转正，LLM 首动作即 ask_user 的真实链路）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } },
    });
    // ② ask 弹窗（内联选择题）
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question: '选哪个？', options: ['方案 A', '方案 B'] }],
    });
    // ③ 点选项标记（pausedAssistantEl = 骨架），统一形态再点「提交回答」→ commitAskAnswers
    const btns = document.querySelectorAll<HTMLButtonElement>('.ask-inline__opt');
    (btns[0] as HTMLButtonElement).click();
    const submit = document.querySelector('.ask-inline__submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'input',
      kind: 'answer',
      answers: ['方案 A'],
    });
    // ④ 宿主 handleResume 回发 user(kind='question-answer') —— 真实链路关键：骨架在此不得被删
    dispatch({ type: 'user', text: '方案 A', ts: 't2', kind: 'question-answer' });
    // ⑤ resume 重发 meta → pausedResume 原位续写判定（骨架必须仍在 DOM，isConnected 恒真）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 3, ts: 't2', payload: { role: 'AI', llm: 'm' } },
    });
    // ⑥ 续写正文（同轮）→ done 收敛
    dispatch({ type: 'chunk', content: '已按方案 A 继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // 回归断言：单块续写（骨架复用开启正文流，不新建块 B）——骨架须在 user(kind) 回发时不被删，
    // 否则 pausedResume 判定失效（isConnected=false）→ 误走 resumePending → prepareFlowShell 挂
    // resolveInteractionAnchor 兜底位（消息流最后 assistant 块 = 上一轮）→ 回答错位；flowEl 随
    // 骨架消散 → 「你答」条目孤儿底部（坑）。
    const assistants = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('已按方案 A 继续');
    // done 后：运行时平铺容器已收敛（过程收进折叠块，设计行为），QA 折入折叠块、无孤儿残留
    expect(document.querySelector('.process-flow')).toBeNull();
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    expect(assistants[0].contains(rb)).toBe(true);
    expect(rb.querySelector('.round-block__details .round-block__input')?.textContent).toContain(
      '方案 A',
    );
  });

  it('骨架期 ask 修复核心：普通（非 ask）交互回发 user(kind) 时骨架仍保留——过程流与骨架同源不孤儿', () => {
    mountChatView();
    // 骨架期（无正文 chunk）+ 交互回答提交（点选项后宿主回发 user(kind)）——骨架不得被删
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'user', text: '方案 A', ts: 't2', kind: 'question-answer' });
    // 骨架仍在 DOM（含过程流），「你答」条目进骨架过程流、不孤儿挂消息流尾
    const assistants = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(assistants).toHaveLength(1);
    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    expect(assistants[0].contains(flow)).toBe(true);
    const qaRow = document.querySelector('.round-block__input') as HTMLElement;
    expect(qaRow).not.toBeNull();
    expect(flow.contains(qaRow)).toBe(true);
  });

  it('无 options 的 waiting(ask) 不渲染选项按钮（仅补充输入通道）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question: '请描述当前任务目标' }],
    });
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.querySelectorAll('.ask-inline__opt')).toHaveLength(0);
    // 无选项时引导补充输入（纯文本输入退化仍可用）
    expect(box.querySelector('.ask-inline__input')).not.toBeNull();
  });

  it('内联补充输入：键入后回车 → 提交 input(kind=answer) 并移除内联块', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question: '请描述当前任务目标', options: ['方案A', '方案B'] }],
    });
    const input = document.querySelector('.ask-inline__input') as HTMLInputElement;
    input.value = '我补充一点要求';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // 回车等价点「提交回答」（统一形态下 Enter 触发 submitBtn.click；已答才 enabled）
    expect(postMessage).toHaveBeenCalledWith({
      type: 'input',
      kind: 'answer',
      answers: ['我补充一点要求'],
    });
    expect(document.querySelector('.ask-inline')).toBeNull();
  });

  it('无 assistant 锚点时 waiting(ask) 降级底部 clarifyBar（异常兜底）', () => {
    mountChatView();
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question: '请描述当前任务目标', options: ['A', 'B'] }],
    });
    // 无可用提问块 → 无内联块，底部 clarifyBar 兜底显示（含选项按钮）
    expect(document.querySelector('.ask-inline')).toBeNull();
    const bar = document.getElementById('clarifyBar') as HTMLElement;
    expect(bar.classList.contains('visible')).toBe(true);
    expect(document.querySelectorAll('#clarifyOptions .opt-btn')).toHaveLength(2);
  });

  it('allowCustom=false 且带 options → 强制单选：隐藏自由输入框（仅点选）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [
        {
          slot: 'task',
          question: '采用哪种方案？',
          options: ['方案A', '方案B'],
          allowCustom: false,
        },
      ],
    });
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    // 选项仍在
    expect(box.querySelectorAll('.ask-inline__opt')).toHaveLength(2);
    // 自由输入框被隐藏（强制只点选）
    const input = box.querySelector('.ask-inline__input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.hidden).toBe(true);
  });

  it('allowCustom 缺省/true 且带 options → 保持每题自由输入（可见）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // allowCustom=true 显式允许自由输入
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [
        {
          slot: 'task',
          question: '采用哪种方案？',
          options: ['方案A', '方案B'],
          allowCustom: true,
        },
      ],
    });
    const input = document.querySelector('.ask-inline__input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.hidden).toBe(false);
  });
});

describe('chatView 任务过程文字化（TS-8，2026-09-02 以 Trae 执行过程为参照）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 开一轮（meta + 首 chunk），等价于 beginRound（本 describe 外的局部 helper 不共享） */
  function beginRound(): void {
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: '',
        payload: { role: '文档设计师', llm: 'deepseek-chat' },
      },
    });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('read_file 工具行显示行动叙述「读取文件：path (状态)」，原始 args 保留在折叠 body', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"docs/a.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '内容概要' },
      },
    });
    dispatch({ type: 'done' });
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    expect(tool.querySelector('summary')?.textContent).toBe('读取文件：docs/a.md (成功)');
    // 原始 args JSON 仍在折叠 body（细节不丢）
    expect(tool.textContent).toContain('{"path":"docs/a.md"}');
  });

  it('未收录工具（自定义/未知）回退原生工具名，不编造叙述', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't99', name: 'my_custom_tool', args: '{"foo":"bar"}' },
      },
    });
    dispatch({ type: 'done' });
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    // 无 result → 进行中；TOOL_META 亦未收录（角色包自定义工具）→ 原生英文名
    // （这是**唯一**落到英文名的路径——内置 24 工具均已中文）
    expect(tool.querySelector('summary')?.textContent).toBe('my_custom_tool (进行中)');
  });

  it('args 非合法 JSON 时走兜底中文显示名（解析兜底，不抛错）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: 'not-json{{{[' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true },
      },
    });
    dispatch({ type: 'done' });
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    // 解析失败 → 参数为空 → 叙述生成器返回 undefined → 兜底 toolNameMap 中文名
    expect(tool.querySelector('summary')?.textContent).toBe('读取文件 (成功)');
  });

  it('多工具 → 收尾叙述句「工具×N（读取文件 x · 项目搜索 y …）」：按工具名计数，与工具行同词表', () => {
    mountChatView();
    beginRound();
    // read_file + read_skill + search_project + write_file（四个**不同工具名**各一段）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't2', name: 'read_skill', args: '{"name":"doc-writer"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 5,
        ts: '',
        payload: { toolCallId: 't2', name: 'read_skill', ok: true },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 6,
        ts: '',
        payload: { toolCallId: 't3', name: 'search_project', args: '{"query":"createSession"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 7,
        ts: '',
        payload: { toolCallId: 't3', name: 'search_project', ok: true },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 8,
        ts: '',
        payload: { toolCallId: 't4', name: 'write_file', args: '{"path":"out.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 9,
        ts: '',
        payload: { toolCallId: 't4', name: 'write_file', ok: true },
      },
    });
    dispatch({ type: 'done' });
    const summary = document.querySelector('.round-block__summary') as HTMLElement;
    expect(summary.textContent).toContain(
      '工具×4（读取文件 1 · 读取技能 1 · 项目搜索 1 · 写入文件 1）',
    );
  });

  it('插话打断旧流时清旧块光标态（运行态不残留撒谎）', () => {
    mountChatView();
    // 流式正文进行中（回答态光标亮）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正在回答第一段' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.dataset.status).toBe('正在回答中');
    // 插话（supplement）到达 → 旧流被打断：新块由后续 chunk 开启，旧块必须无运行态（既非运行也非终态）
    dispatch({
      type: 'user',
      text: '补充：换个方向',
      ts: '2026-09-02T04:15:05Z',
      kind: 'supplement',
    });
    const oldBody = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(oldBody.dataset.status).toBeUndefined();
  });

  it('中断补充渲染为内联子行「你补充」进过程容器；后续 chunk 原位续写同一正文块（方案 A 单块统一，2026-09-30）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 单轨：运行时 chunk 携带 turn roundId（宿主透传），续接判定与重放共用「roundId 相等」
    dispatch({ type: 'chunk', content: '正在回答第一段', roundId: 'round-1' });
    const blockBefore = document.querySelector('.msg.assistant') as HTMLElement;
    expect(blockBefore).not.toBeNull();
    // 被打断补充（streaming 中 supplement）→ 过程条目「你补充」：与 question-answer 共用 round-block__input 形态
    dispatch({
      type: 'user',
      text: '补充：不要联网搜索',
      ts: '2026-09-03T04:15:05Z',
      kind: 'supplement',
    });
    const supRow = document.querySelector('.round-block__input') as HTMLElement;
    expect(supRow).not.toBeNull();
    expect(supRow.querySelector('.round-block__input-tag')?.textContent).toBe('你补充');
    expect(supRow.textContent).toContain('不要联网搜索');
    // 形态甲：补充条目进过程容器（process-flow），按 ts 归位——不再与 assistant 块消息流平级
    const flow = document.querySelector('.process-flow') as HTMLElement | null;
    expect(flow).not.toBeNull();
    expect(flow?.contains(supRow)).toBe(true);
    // 后续 chunk（同 roundId）→ 原位续写同一正文块（方案 A：打断分段退役，
    // 正文单块连续；补充行在过程区不丢信息）。roundId 护栏：不等则新建，防跨轮串位
    dispatch({ type: 'chunk', content: '好的，按你的要求继续', roundId: 'round-1' });
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(1); // 单块：不再拆续接块
    expect(blocks[0]).toBe(blockBefore); // 同一 DOM 节点（原位续写，非重建）
    expect(collectAllBodyText(document.body)).toContain('正在回答第一段');
    expect(collectAllBodyText(document.body)).toContain('按你的要求继续');
  });

  it('跨轮 chunk 护栏：补充后新轮 chunk（roundId 不等）新建正文块，不误挂旧轮活动块', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '第一轮回答', roundId: 'round-1' });
    dispatch({
      type: 'user',
      text: '补充：换个话题',
      ts: '2026-09-03T04:15:05Z',
      kind: 'supplement',
    });
    // 新一轮（roundId 不同，正常经 resetForNewClosedLoop 清活动块后 beginStreaming；
    // 此用例直接以异 roundId chunk 验证护栏本体：不得续写进 round-1 的块）
    dispatch({ type: 'chunk', content: '新轮回答', roundId: 'round-2' });
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2); // 护栏生效：新建而非误挂
    expect(collectAllBodyText(blocks[0] as HTMLElement)).not.toContain('新轮回答');
    expect(collectAllBodyText(blocks[1] as HTMLElement)).toContain('新轮回答');
  });

  it('打断后无续写直接 done：streamingRaw 残留旧文进 finalize，正文完整不丢（2026-09-30 盲区补测）', () => {
    mountChatView();
    // 场景：正文流入 → 补充打断（streamingRaw 保留、流式态结清）→ 内核吸收后直接收尾
    // （补充即为最后输入，无续写 chunk）→ finalize 若清空 streamingRaw 则正文蒸发
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正在回答第一段', roundId: 'round-1' });
    dispatch({
      type: 'user',
      text: '补充：就此收尾',
      ts: '2026-09-03T04:15:05Z',
      kind: 'supplement',
    });
    // done 前（打断态）：补充行必须在过程容器（flowEl 转正后仍连接）
    const flowBefore = document.querySelector('.process-flow') as HTMLElement | null;
    expect(flowBefore?.textContent).toContain('就此收尾');
    dispatch({ type: 'done', roundId: 'round-1' });
    // 打断前正文必须存活（streamingRaw 保留语义的直接消费场景）
    expect(collectAllBodyText(document.body)).toContain('正在回答第一段');
    // finalize 完成：流式态结清（终态「已完成」）、单块形态；补充行随过程折入折叠块（G31 收敛，rb 文本断言——
    // collectAllBodyText 是正文收集器，折叠块内容不在其范围）
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.dataset.status).toBe('已完成');
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1);
    const rbText = document.querySelector('details.round-block')?.textContent ?? '';
    expect(rbText).toContain('你补充');
    expect(rbText).toContain('就此收尾');
  });

  it('骨架期补充输入（插话/挂起态补充统一）不删骨架：过程容器存活、补充行归位进过程容器（2026-09-30 真机修复）', () => {
    mountChatView();
    // 骨架期（meta 后无 chunk 转正）：过程容器挂在骨架壳内，这是删除/保留语义
    // 真正作用于 DOM 的窗口——旧实现无条件删骨架（真机实证：过程蒸发 + 条目散落
    // 消息流尾 + 内核吸收后投影与本地兜底双份），修复后 user 消息一律不删骨架
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 骨架内过程容器 + 已升级工具折叠行（挂起前已完成的工具步骤）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '读取成功' },
      },
    });
    const flowBefore = document.querySelector('.process-flow') as HTMLElement;
    expect(flowBefore).not.toBeNull();

    // 补充输入到达（宿主 interject 入队 / resumeExecution 续跑，webview 渲染语义统一）
    dispatch({
      type: 'user',
      text: '补充：先看配置再改',
      ts: '2026-09-30T12:00:00.000Z',
      kind: 'supplement',
    });
    // 过程容器同一节点（未拆除重建）= 修复断言；旧代码此处骨架被删必挂
    expect(document.querySelector('.process-flow')).toBe(flowBefore);
    // 补充行归位进过程容器（flowEl 保持连接 → 正常路径，无兜底散落到消息流）
    expect(flowBefore.querySelector('.round-block__input')?.textContent).toContain('先看配置再改');
    expect(
      Array.from(document.querySelectorAll('.round-block__input')).filter(
        (el) => !flowBefore.contains(el),
      ),
    ).toHaveLength(0); // 无散落在过程容器外的兜底条目（双份修复断言）
  });

  it('骨架期补充后首个 chunk 复用骨架块续写正文（不新建块、过程容器保持）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' },
      },
    });
    const flowBefore = document.querySelector('.process-flow') as HTMLElement;
    dispatch({
      type: 'user',
      text: '补充：换个方向',
      ts: '2026-09-30T12:01:00.000Z',
      kind: 'supplement',
    });
    // 骨架未删（引用保持）→ chunk 走复用分支：正文续进骨架块，过程容器不动
    dispatch({ type: 'chunk', content: '好的，按新方向继续', roundId: 'round-1' });
    expect(document.querySelector('.process-flow')).toBe(flowBefore);
    expect(flowBefore.contains(flowBefore.querySelector('.round-block__input')!)).toBe(true);
    // 单块续写：骨架块即正文块，无第二个 assistant 块
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1);
    expect(collectAllBodyText(document.body)).toContain('按新方向继续');
  });

  it('连续补充各自独立成块：每颗钉子独立折叠块、无「补充 N 条」合并（2026-09-09 剪枝定案）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正在回答', roundId: 'round-1' });
    // 同轮连续两条补充（运行时：roundId 均未回填，历史上会误合并成「你补充 N 条」）
    dispatch({ type: 'user', text: '补充：先看配置', ts: 't1', kind: 'supplement', roundId: '' });
    dispatch({ type: 'user', text: '补充：再看日志', ts: 't2', kind: 'supplement', roundId: '' });
    const supRows = Array.from(
      document.querySelectorAll<HTMLElement>('.round-block__input'),
    ).filter((el) =>
      el.querySelector('.round-block__input-tag')?.textContent?.startsWith('你补充'),
    );
    // 两颗钉子独立成块：不合并、无「你补充了 N 条」标签、各自含完整内容
    expect(supRows).toHaveLength(2);
    expect(supRows[0]!.textContent).toContain('先看配置');
    expect(supRows[1]!.textContent).toContain('再看日志');
    expect(supRows[0]!.querySelector('.round-block__input-tag')?.textContent).toBe('你补充');
    expect(supRows[1]!.querySelector('.round-block__input-tag')?.textContent).toBe('你补充');
  });

  it('骨架期补充（正文未开即 supplement）→ 后续同轮 chunk 必须开启正文块渲染（2026-09-22 实证回归）', () => {
    mountChatView();
    // 发送第一问：骨架期（meta 先到建骨架，正文流未开始，streamingActive=false）
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 马上补充输入（host handleSend interject 分支：post user(supplement) 先行上屏）
    dispatch({
      type: 'user',
      text: '补充：先做第一步',
      ts: '2026-09-03T04:16:00Z',
      kind: 'supplement',
    });
    // 内核同轮续接（_handleInterrupt 注入同 roundId），正文 chunk 续至
    dispatch({ type: 'chunk', content: '好的，已按补充继续：第一步完成', roundId: 'round-1' });
    dispatch({ type: 'done' });
    const bodyTexts = Array.from(
      document.querySelectorAll<HTMLElement>('.msg.assistant .msg-body'),
    ).map((b) => b.textContent ?? '');
    // 补充后的正文必须渲染（退化时无任何 assistant 正文块，UI 视觉卡在「吸收补充」）
    expect(bodyTexts.join('')).toContain('第一步完成');
  });

  it('真实 IO 时序：骨架期补充后过程事件交错再正文续接（round-1790065416420 实证，2026-09-22）', () => {
    mountChatView();
    // ① 发送第一问：meta（骨架建立）
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 3,
        ts: '',
        payload: { role: '共鸣小说家', llm: 'mimo-v2.6-pro' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 4, ts: '', payload: { phase: 'llm_calling' } },
    });
    // ② 马上补充（supplement 上屏，删除骨架）
    dispatch({
      type: 'user',
      text: '其实就是上一轮的结论',
      ts: '2026-09-22T08:23:48.977Z',
      kind: 'supplement',
    });
    // ③ 补充后过程事件交错（narrate/tool/thought 先到，同轮）
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 65, ts: '', payload: { content: '我先查一下，请稍候' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 66,
        ts: '',
        payload: { toolCallId: 'c1', name: 'search_project', args: '{}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 69,
        ts: '',
        payload: { toolCallId: 'c1', name: 'search_project', ok: true, summary: '未命中' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 70, ts: '', payload: { phase: 'llm_calling' } },
    });
    // ④ 正文 chunk 同轮续接（长回答，多段）
    dispatch({
      type: 'chunk',
      content: '好，那就直说——**有道理，但只对了一半**。',
      roundId: 'round-1790065416420',
    });
    dispatch({
      type: 'chunk',
      content: '先定内核，种子才找得对。',
      roundId: 'round-1790065416420',
    });
    dispatch({ type: 'done' });
    // 补充后的正文必须实时渲染（30 秒空洞期间用户看到的是"卡住"的根因即此处断链）
    const bodyTexts = Array.from(
      document.querySelectorAll<HTMLElement>('.msg.assistant .msg-body'),
    ).map((b) => b.textContent ?? '');
    expect(bodyTexts.join('')).toContain('只对了一半');
  });

  it('D3 单轨：运行时 qa 回答后 resume，骨架为普通第 2 段块（无续接视觉，2026-09-21 剪枝：补充卡片已分隔）', () => {
    mountChatView();
    // 第一段回答（提问，roundId=round-1）：骨架复用分支记 lastAssistantRoundId
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '需要先确认哪个方案？', roundId: 'round-1' });
    // 用户回答（question-answer，带提问原文——运行时同构：host 透出 question，渲染「问」回顾行）
    dispatch({
      type: 'user',
      text: '选A',
      ts: 't2',
      kind: 'question-answer',
      roundId: 'round-1',
      question: '需要先确认哪个方案？',
    });
    const qaRows = document.querySelectorAll('.round-block__input');
    expect(qaRows.length).toBeGreaterThanOrEqual(1);
    // 提问明文在条目内（.round-block__input-q 回顾行 + 内容行）：trae work 形态，问答对可回看
    const askRow = document.querySelector('.round-block__input-q') as HTMLElement;
    expect(askRow).not.toBeNull();
    expect(askRow.textContent).toContain('需要先确认哪个方案？');
    expect(askRow.textContent).toContain('问');
    // resumeExecution → 新 runFlow 的 meta → resumePending 分支建续接骨架：
    // 续接视觉整体退役——骨架是普通第 2 段块（无 is-continued / 无 chip），
    // 补充/问答内容已由独立交互条目行（.round-block__input）上屏分隔
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    const skeleton = blocks[1] as HTMLElement;
    expect(skeleton.classList.contains('is-continued')).toBe(false);
    expect(skeleton.querySelector('.msg-ai-label__cont')).toBeNull();
    // 骨架挂在消息流 assistant 链尾（[块A] → [块B]；交互条目在过程容器内，不参与消息流兄弟链）
    expect((blocks[0] as HTMLElement).nextElementSibling).toBe(skeleton);
    // 首个 chunk（同 roundId）→ flowShellEl 复用骨架，正文流入第 2 段块
    dispatch({ type: 'chunk', content: '好，开始执行方案A', roundId: 'round-1' });
    const continued = document.querySelectorAll('.msg.assistant')[1] as HTMLElement;
    expect(continued).toBe(skeleton);
    expect(collectAllBodyText(continued)).toContain('开始执行方案A');
  });

  it('运行时暂停（paused）光标切挂起态「已暂停」：提问后暂停块不再呼吸运行态', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '需要先确认哪个方案？', roundId: 'round-1' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.dataset.status).toBe('正在回答中'); // 暂停前运行态亮
    dispatch({ type: 'paused' });
    expect(body.dataset.status).toBe('已暂停'); // 暂停即静态挂起态（半截正文保留，不撒谎运行态）
  });

  it('运行时 resume meta：续跑保留平铺容器锚点，不复制第二个运行时容器', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '需要先确认哪个方案？', roundId: 'round-1' });
    const flow0 = document.querySelector('.process-flow') as HTMLElement;
    expect(flow0).not.toBeNull();
    expect(flow0.closest('.msg.assistant')).toBe(document.querySelectorAll('.msg.assistant')[0]);
    // 用户回答 → resumePending 置位
    dispatch({ type: 'user', text: '选A', ts: 't2', kind: 'question-answer', roundId: 'round-1' });
    // resume 新 runFlow 的 meta（同闭环续跑）→ 不重置锚点：平铺容器仍只有一个、留在首块
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    const flow1s = document.querySelectorAll('.process-flow');
    expect(flow1s).toHaveLength(1);
    expect(flow1s[0].closest('.msg.assistant')).toBe(
      document.querySelectorAll('.msg.assistant')[0],
    );
    // 续接骨架不挂第二个容器
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].querySelector('.process-flow')).toBeNull();
  });

  it('UX-9 B：重放同 roundId 两段 AI（assistantLog + final）同容器连续，无续接视觉（2026-09-21 剪枝）', () => {
    mountChatView();
    // 普通新闭环用户输入（重置上轮同环判定）
    // 两轮整批由单条 turn_update(replay:true) 承载——前序段 + 交互行 + final 均收进各自的 RoundView
    dispatchReplayMany([
      makeRound({
        id: 'round-1',
        user: { content: '任务A', ts: 't1' },
        assistantLog: [{ content: '需要先确认哪个方案？', ts: 't2' }],
        interactiveInputs: [{ content: '选方案A', ts: 't3', kind: 'question-answer' }],
        // 最终回答（同 roundId）→ 第 2 段（同容器连续，无续接视觉标记）
        assistantMessage: { content: '好，开始执行方案A', ts: 't4' },
        status: 'complete',
      }),
      makeRound({
        // 下一轮（新 roundId）→ 同样无续接视觉
        id: 'round-2',
        user: { content: '任务B', ts: 't5' },
        assistantMessage: { content: '回答B', ts: 't6' },
        status: 'complete',
      }),
    ]);
    const blocks = document.querySelectorAll('.msg.assistant');
    // 两轮整批渲染——round-1 前序段 + final、round-2 final 共 3 块（分开 dispatch 中间态才是 2 块）
    expect(blocks).toHaveLength(3);
    expect((blocks[0] as HTMLElement).classList.contains('is-continued')).toBe(false);
    expect((blocks[1] as HTMLElement).classList.contains('is-continued')).toBe(false);
    expect((blocks[1] as HTMLElement).querySelector('.msg-ai-label__cont')).toBeNull();
    // 下一轮（新 roundId）→ 同样无续接视觉（已在同一条 turn_update 的 rounds[1] 渲染）
    const blocks2 = document.querySelectorAll('.msg.assistant');
    expect((blocks2[2] as HTMLElement).classList.contains('is-continued')).toBe(false);
  });

  it('UX-9 C：question-answer 渲染为过程条目行（运行时进 process-flow，即时可见，2026-09-17 形态甲）', () => {
    mountChatView();
    beginRound(); // meta + chunk：骨架建块并挂载过程平铺容器（process-flow）
    // 用户对提问的回答 → 过程条目「你答：xxx」按 ts 插入 process-flow（对应 step 分组）
    dispatch({
      type: 'user',
      text: '选方案A',
      ts: '2026-09-03T03:15:05Z',
      kind: 'question-answer',
      roundId: 'round-1',
    });
    const qa = document.querySelector('.round-block__input') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.querySelector('.round-block__input-row .round-block__input-tag')?.textContent).toBe(
      '你答',
    );
    expect(
      qa.querySelector('.round-block__input-row .round-block__input-text')?.textContent,
    ).toContain('选方案A');
    // 形态甲：QA 条目进过程容器（process-flow），按 ts 归位——运行时即时可见（硬约束）
    const flow = document.querySelector('.process-flow') as HTMLElement | null;
    expect(flow).not.toBeNull();
    expect(flow?.contains(qa)).toBe(true);
    // 运行时无大折叠壳（QA 在平铺容器内，非 round-block 折叠内部）
    expect(document.querySelector('.round-block')).toBeNull();
  });

  it('G26：重放 question-answer 携带 question/options → 先渲染只读「问」回顾行再「你答」', () => {
    mountChatView();
    dispatch({ type: 'user', text: '任务A', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '需要先确认哪个文件？', ts: 't2', roundId: 'round-1' });
    dispatch({
      type: 'user',
      text: '读 probe.txt',
      ts: 't3',
      roundId: 'round-1',
      kind: 'question-answer',
      question: '你想读哪个文件？',
      options: ['probe.txt', 'config.json'],
    });
    // 形态甲：问行+答行合并为单条目（.round-block__input），重放进 round-block details
    const qRows = Array.from(document.querySelectorAll<HTMLElement>('.round-block__input'));
    expect(qRows).toHaveLength(1); // 单条目 = 问回顾行 + 你答行
    const entry = qRows[0]!;
    const askRow = entry.querySelector('.round-block__input-q') as HTMLElement;
    expect(askRow).not.toBeNull();
    expect(askRow.querySelector('.round-block__input-tag')?.textContent).toBe('问');
    expect(askRow.querySelector('.round-block__input-text')?.textContent).toContain(
      '你想读哪个文件？',
    );
    expect(askRow.querySelector('.round-block__input-opts')?.textContent).toContain('probe.txt');
    // 阅读序：条目内问回顾行在前、内容行紧随其后
    expect(
      entry.querySelector('.round-block__input-row .round-block__input-tag')?.textContent,
    ).toBe('你答');
    expect(
      entry.querySelector('.round-block__input-row .round-block__input-text')?.textContent,
    ).toContain('读 probe.txt');
  });

  it('G26：无 question 的 question-answer（运行时/旧数据）不渲染回顾行，退化为现状', () => {
    mountChatView();
    dispatch({ type: 'user', text: '问题', ts: 't1' });
    dispatch({ type: 'assistant', text: '回答', ts: 't2' });
    dispatch({ type: 'user', text: '选A', ts: 't3', kind: 'question-answer', roundId: 'round-1' });
    const qRows = document.querySelectorAll('.round-block__input');
    expect(qRows).toHaveLength(1); // 仅「你答」行
    expect(document.querySelector('.round-block__input-q')).toBeNull();
    expect(document.querySelector('.round-block__input-opts')).toBeNull();
  });

  it('UX-9 C 兜底：无 assistant 锚点时 qa 内联子行落消息流，不丢失', () => {
    mountChatView();
    dispatch({ type: 'user', text: '问题', ts: 't1' });
    dispatch({ type: 'assistant', text: '回答', ts: 't2' }); // 无过程事件 → 无 round-block
    dispatch({ type: 'user', text: '补充说明', ts: 't3', kind: 'question-answer' });
    const qa = document.querySelector('.round-block__input') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.textContent).toContain('补充说明');
  });

  it('UX-9 重放路径：重放轮 + 前序段 + qa 内联子行、final 为同容器第 2 段（2026-09-21 剪枝，无续接视觉）', () => {
    mountChatView();
    // 主输入 → 整批过程事件（含 meta）→ 提问前序段
    // 整批 processEvents + 前序段 + 交互行 + final 由单条 turn_update 承载
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '帮我做方案', ts: 't1' },
        processEvents: [
          { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
          {
            type: 'metrics',
            seq: 2,
            ts: 't2',
            payload: {
              durationMs: 3000,
              tokenIn: 10,
              tokenOut: 20,
              toolFailureCount: 0,
              success: true,
            },
          },
        ],
        assistantLog: [{ content: '你倾向哪个方案？', ts: 't2' }],
        // 用户回答 → 内联子行（插在前序段之后、final 之前）
        interactiveInputs: [{ content: '选方案A', ts: 't3', kind: 'question-answer' }],
        // 最终回答 → 同环续接
        assistantMessage: { content: '好的，按方案A继续', ts: 't4' },
        status: 'complete',
      }),
    );
    const qa = document.querySelector('.round-block__input') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.textContent).toContain('选方案A');
    // A/B：前序段与 final 同 roundId → 同容器第 2 段（无续接视觉）；无打断轮不出现「补充」子行
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as HTMLElement).classList.contains('is-continued')).toBe(false);
    expect((blocks[1] as HTMLElement).querySelector('.msg-ai-label__cont')).toBeNull();
    // 仅「补充」tag 不存在（本轮是 qa 回答，不渲染 supplement 子行）；「你答」子行仍应在
    const supplementRows = Array.from(
      document.querySelectorAll<HTMLElement>('.round-block__input'),
    ).filter((el) => el.querySelector('.round-block__input-tag')?.textContent === '你补充');
    expect(supplementRows).toHaveLength(0);
    // 有 round-block 时 QA 最终折入任务折叠块
    // （平铺会污染两段式）——qa 行收进 .round-block__details 内
    const roundBlock = document.querySelector('.round-block') as HTMLElement;
    expect(roundBlock).not.toBeNull();
    const qaInsideBlock = roundBlock.querySelector('.round-block__input');
    expect(qaInsideBlock).not.toBeNull();
    expect(qaInsideBlock!.textContent).toContain('选方案A');
    // 消息流层面干净：assistant 前序段与续接 final 直接相邻（两段式：折叠块 + 纯文字报告）
    expect((blocks[0] as HTMLElement).nextElementSibling).toBe(blocks[1]);
    // 折叠块收起态摘要含「你答×1」
    expect(document.querySelector('.round-block__stats')?.textContent).toContain('你答×1');
  });

  it('形态甲回归：纯 QA 轮重放（有过程事件 + 无前序段）问答条目收进折叠块、不散落消息流（round-1789642310661 复现）', () => {
    mountChatView();
    // 主输入 → 整批过程事件 → 提问回答×3（无 assistantLog）→ 最终回答，全部收进单条 turn_update
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '把上述问题使用ask工具提问我', ts: 't1' },
        processEvents: [
          {
            type: 'meta',
            seq: 1,
            ts: 't1',
            payload: { role: '白话方案设计师', llm: 'mimo-v2.5-pro' },
          },
          { type: 'thinking', seq: 2, ts: 't1.1', payload: { phase: 'llm_calling' } },
          { type: 'narrate', seq: 3, ts: 't1.2', payload: { content: '提问中…' } },
          {
            type: 'metrics',
            seq: 4,
            ts: 't2',
            payload: {
              durationMs: 3000,
              tokenIn: 10,
              tokenOut: 20,
              toolFailureCount: 0,
              success: true,
            },
          },
        ],
        interactiveInputs: [
          {
            content: '互动性——用户能参与影响故事走向',
            ts: 't2.1',
            kind: 'question-answer',
            question: 'Q1：核心价值是什么？',
          },
          {
            content: '内容平台——让读者来读',
            ts: 't2.2',
            kind: 'question-answer',
            question: 'Q2：创作工具还是内容平台？',
          },
          { content: '专业作者/签约作者', ts: 't2.3', kind: 'question-answer' },
        ],
        assistantMessage: { content: '基于已回答的三个问题，最终回答…', ts: 't3' },
        status: 'complete',
      }),
    );
    // 问答条目全部收进折叠块 details 内（与运行时 finalize 合并流重建一致）
    const roundBlock = document.querySelector('.round-block') as HTMLElement;
    expect(roundBlock).not.toBeNull();
    const inputsInBlock = roundBlock.querySelectorAll('.round-block__details .round-block__input');
    expect(inputsInBlock).toHaveLength(3);
    expect(inputsInBlock[0]!.textContent).toContain('互动性');
    expect(inputsInBlock[1]!.textContent).toContain('内容平台');
    expect(inputsInBlock[2]!.textContent).toContain('专业作者');
    // 消息流层无残留：折叠块 details 在 #messages 子树内，故用直接子元素 `:scope >` 判定
    // （fallback 条目若作 #messages 直子，会散落在用户提问与最终回答之间（坑））
    const messages = document.getElementById('messages') as HTMLElement;
    expect(messages.querySelectorAll(':scope > .round-block__input')).toHaveLength(0);
    // 收起态摘要含「你答×3」
    expect(roundBlock.querySelector('.round-block__stats')?.textContent).toContain('你答×3');
  });

  it('重放跨轮 supplement 不合并：各 roundId 补充独立成行（2026-09-07 跨轮合并 bug 修复）', () => {
    mountChatView();
    // 两轮问答，各带一条 supplement（重放时序：user → 中间段supp → 最终回答）
    // 第一轮
    dispatch({ type: 'user', text: '第一轮问题', ts: 't1', roundId: 'r1' });
    dispatch({ type: 'user', text: '第一轮补充', ts: 't2', roundId: 'r1', kind: 'supplement' });
    dispatch({ type: 'assistant', text: '第一轮回答', ts: 't3', roundId: 'r1' });
    // 第二轮（无 setStatus 变化，模拟重放路径——_lastInterruptDivider 若残留会误并入第一轮行（坑））
    dispatch({ type: 'user', text: '第二轮问题', ts: 't4', roundId: 'r2' });
    dispatch({ type: 'user', text: '第二轮补充', ts: 't5', roundId: 'r2', kind: 'supplement' });
    dispatch({ type: 'assistant', text: '第二轮回答', ts: 't6', roundId: 'r2' });

    // 两轮补充各自独立成行（tag=你补充），不跨轮合并成「你补充了 2 条」
    const supplementRows = Array.from(
      document.querySelectorAll<HTMLElement>('.round-block__input'),
    ).filter((el) =>
      el.querySelector('.round-block__input-tag')?.textContent?.startsWith('你补充'),
    );
    expect(supplementRows).toHaveLength(2);
    // 各含自己的补充内容（第二轮没并进第一轮）
    expect(supplementRows[0]!.textContent).toContain('第一轮补充');
    expect(supplementRows[1]!.textContent).toContain('第二轮补充');
    expect(supplementRows[1]!.querySelector('.round-block__input-tag')?.textContent).toBe('你补充'); // 非「你补充了 2 条」
  });

  it('A 容器化：同 roundId 的 assistant 段收进同一 .round-group（平铺归组 + 容器级 footer）', () => {
    mountChatView();
    // 同 roundId 的前序段 + final 收进单条 turn_update.rounds[0]（同容器归组由同一 id 保证）
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '帮我做方案', ts: 't1' },
        assistantLog: [{ content: '你倾向哪个方案？', ts: 't2' }],
        assistantMessage: { content: '好的，按方案A继续', ts: 't4' },
        status: 'complete',
      }),
    );
    // 同 roundId → 单个 .round-group 容器，两段平铺归组 + 容器级 footer
    const groups = document.querySelectorAll('.round-group');
    expect(groups).toHaveLength(1);
    const g = groups[0] as HTMLElement;
    expect(g.querySelectorAll('.msg.assistant')).toHaveLength(2);
    expect(g.querySelector('.round-group__footer')).not.toBeNull();
    // 结构：段全部位于容器内，footer 恒居容器底部（段不会压到 footer 之后）
    const kids = Array.from(g.children);
    const footIdx = kids.findIndex((c) => c.classList.contains('round-group__footer'));
    expect(footIdx).toBe(kids.length - 1);
    const segIdx = kids.findIndex((c) => c.classList.contains('msg'));
    expect(segIdx).toBeGreaterThanOrEqual(0);
    expect(segIdx).toBeLessThan(footIdx);
    // 用户主提问在容器外（消息流气泡），与 AI 作答链上下衔接
    const userWrap = g.previousElementSibling as HTMLElement;
    expect(userWrap.classList.contains('msg-wrapper')).toBe(true);
  });

  it('A 容器化：容器级 footer 复制 = 用户提问 + 各段报告正文（rawText 原文直取）', () => {
    mountChatView();
    // jsdom 无 navigator.clipboard，注入 writeText mock 捕获复制内容
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // 同 roundId 的前序段 + final 收进单条 turn_update.rounds[0]
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '帮我做方案', ts: 't1' },
        assistantLog: [{ content: '你倾向哪个方案？', ts: 't2' }],
        assistantMessage: { content: '好的，按方案A继续', ts: 't4' },
        status: 'complete',
      }),
    );
    const copyBtn = document.querySelector(
      '.round-group__footer .msg-copy-icon',
    ) as HTMLButtonElement;
    copyBtn.click();
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    // 整链 = 用户提问 + 各段原文（提问在先、段按序拼接，rawText 直取不剥离）
    expect(copied).toContain('帮我做方案');
    expect(copied).toContain('你倾向哪个方案？');
    expect(copied).toContain('好的，按方案A继续');
    // 拼接顺序：提问在前、回答段在后
    expect(copied.indexOf('帮我做方案')).toBeLessThan(copied.indexOf('好的，按方案A继续'));
  });

  it('A 容器化：整链复制直取各段 rawText 原文（不剥离、不改写，溯源完整）', () => {
    mountChatView();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // M5b-3：同 roundId 的前序段 + final 收进单条 turn_update.rounds[0]
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '帮我做方案', ts: 't1' },
        assistantLog: [{ content: '先确认倾向。\n采用方案A', ts: 't2' }],
        assistantMessage: { content: '好的，按方案A继续', ts: 't4' },
        status: 'complete',
      }),
    );
    const copyBtn = document.querySelector(
      '.round-group__footer .msg-copy-icon',
    ) as HTMLButtonElement;
    copyBtn.click();
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('先确认倾向。');
    expect(copied).toContain('采用方案A');
    expect(copied).toContain('好的，按方案A继续');
  });

  it('narrate 过程事件渲染为独立父块（建议 A），每段叙述一个可折叠父块', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'narrate',
        seq: 2,
        ts: '',
        payload: { content: '让我先查看项目结构和所有文档' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 3, ts: '', payload: { content: '现在逐一读取它们的内容' } },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 每段叙述 = 一个独立 .round-block__narrate 父块（建议 A：无「过程叙述」独立小节标题）
    const rows = rb.querySelectorAll('.round-block__narrate') as NodeListOf<HTMLDetailsElement>;
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('让我先查看项目结构和所有文档');
    expect(rows[1].textContent).toContain('现在逐一读取它们的内容');
  });

  it('扁平化：narrate 纯文本行与 tool 折叠行按 seq 平铺 details 顶层（2026-09-04；narrate 直显形态 2026-10-05）', () => {
    mountChatView();
    beginRound();
    // 第一段叙述 → 一个搜索工具
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 2, ts: '', payload: { content: '我先搜索相关资料' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', ok: true, summary: '结果A' },
      },
    });
    // 第二段叙述 → 一个读取工具
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 5, ts: '', payload: { content: '再读取文档' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 6,
        ts: '',
        payload: { toolCallId: 't2', name: 'read_file', args: '{"path":"x.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 7,
        ts: '',
        payload: { toolCallId: 't2', name: 'read_file', ok: true, summary: '内容' },
      },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const narrates = rb.querySelectorAll('.round-block__narrate') as NodeListOf<HTMLElement>;
    const tools = rb.querySelectorAll('.round-block__tool') as NodeListOf<HTMLDetailsElement>;
    expect(narrates).toHaveLength(2);
    expect(tools).toHaveLength(2);
    // 扁平化：工具行不再嵌套进 narrate（narrate 内部无 .round-block__tool）
    const nested = rb.querySelectorAll('.round-block__narrate .round-block__tool');
    expect(nested).toHaveLength(0);
    // 严格时序：details 顶层子元素按 seq 交错平铺 narrate(2) → tool t1(3) → narrate(5) → tool t2(6)
    const childSeq = Array.from(rb.querySelector('.round-block__details')!.children)
      .filter(
        (el) =>
          el.classList.contains('round-block__narrate') ||
          el.classList.contains('round-block__tool'),
      )
      .map((el) => (el as HTMLElement).dataset.seq);
    expect(childSeq).toEqual(['2', '3', '5', '6']);
    // narrate 与 tool 各自保留原展现（叙述文本 / 工具名与状态）
    expect(narrates[0].textContent).toContain('我先搜索相关资料');
    expect(narrates[1].textContent).toContain('再读取文档');
    expect(tools[0].dataset.toolCallId).toBe('t1');
    expect(tools[1].dataset.toolCallId).toBe('t2');
    expect(tools[0].textContent).toContain('联网搜索：A (成功)');
    expect(tools[1].textContent).toContain('读取文件：x.md (成功)');
  });

  it('运行中与收尾 narrate 同构纯文本冒号行（2026-10-05 形态统一：details+双份消费已废）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 2, ts: '', payload: { content: '我先搜索相关资料' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' },
      },
    });
    // 运行中（v1.8 平铺）：narrate = 平铺文本行（非折叠），以「：」结尾，后接工具折叠行
    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时无大折叠壳
    const narrate = flow.querySelector('.process-flow__narrate') as HTMLElement;
    expect(narrate).not.toBeNull();
    expect(narrate.textContent).toBe('我先搜索相关资料：'); // 叙述冒号形态
    const toolRow = flow.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(toolRow).not.toBeNull();
    expect(toolRow.dataset.toolCallId).toBe('t1');
    // 阅读序：narrate 平铺行在工具折叠行之前（叙述冒号 → 工具块的序；phase 若存在居首）
    const phaseFirst = flow.children[0]?.classList.contains('process-flow__phase') ?? false;
    if (phaseFirst) expect(flow.children[1]).toBe(narrate);
    else expect(flow.children[0]).toBe(narrate);
    expect(narrate.nextElementSibling).toBe(toolRow);
    dispatch({
      type: 'tool_result',
      seq: 4,
      ts: '',
      payload: { toolCallId: 't1', name: 'web_search', ok: true, summary: '结果A' },
    });
    dispatch({ type: 'done' });
    // 收尾（finalize 全量重建 + flow 移除）：narrate 保持纯文本直显（流式/收尾同构，
    // 不再折叠收起——轮结束瞬间形态突变 + summary/body 双份消费已废）
    const rb = document.querySelector('.round-block') as HTMLDetailsElement;
    expect(rb).not.toBeNull();
    expect(document.querySelector('.process-flow')).toBeNull(); // 平铺容器已移除
    const narrateRow = rb.querySelector('.round-block__narrate') as HTMLElement;
    expect(narrateRow).not.toBeNull();
    expect(narrateRow.tagName).toBe('DIV'); // 非折叠 details
    expect(narrateRow.textContent).toBe('我先搜索相关资料：'); // 冒号形态与运行时一致
  });

  it('策略拦截（blocked）工具行显示「已拦截」并默认展开，不冒充成功/失败（2026-09-02 第三态）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: {
          toolCallId: 't1',
          name: 'web_search',
          ok: false,
          blocked: true,
          summary: '[SEARCH_LIMIT_REACHED] 已达上限',
        },
      },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const row = rb.querySelector<HTMLDetailsElement>('.round-block__tool[data-tool-call-id="t1"]');
    expect(row).not.toBeNull();
    // 状态标签为「已拦截」而非「成功/失败」；拦截即展开（拒绝文案应直接可见，与失败同纪律）
    expect(row!.textContent).toContain('已拦截');
    expect(row!.open).toBe(true);
  });

  it('TS-11 已拦截工具行不带 is-tool-running（拦截即终态，非进行中）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', ok: false, blocked: true, summary: 'x' },
      },
    });
    dispatch({ type: 'done' });
    const row = document.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(row.classList.contains('is-tool-running')).toBe(false);
  });
});

describe('TS-11 工具执行实时态（2026-09-02 用户实测消缺落地）', () => {
  function beginRound(): void {
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: '',
        payload: { role: '文档设计师', llm: 'deepseek-chat' },
      },
    });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('TS-11a 相位行联动：tool_start → 「正在执行：写入文件」叙述，tool_result → 回落 thinking 相位', () => {
    mountChatView();
    beginRound();
    // 先有 thinking（LLM 调用相位）
    dispatch({
      type: 'process_event',
      event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'llm_calling' } },
    });
    // 工具开始执行：相位行切「正在执行」行动叙述（toolActionLabel 复用），is-tool 态
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'write_file', args: '{"path":"b.md"}' },
      },
    });
    let phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow).not.toBeNull();
    expect(phaseRow.textContent).toBe('正在执行：写入文件：b.md');
    expect(phaseRow.classList.contains('is-tool')).toBe(true);
    // 工具完成：相位行回落最新 thinking（调用模型中…），移除 is-tool 态
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't1', name: 'write_file', ok: true, summary: 'ok' },
      },
    });
    phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow.textContent).toContain('调用模型中');
    expect(phaseRow.classList.contains('is-tool')).toBe(false);
  });

  it('TS-11a 多工具并行：最新未完成工具为相位主体，逐完成回落（无 thinking 时安全移除）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't2', name: 'write_file', args: '{"path":"b.md"}' },
      },
    });
    // 最新未完成者（t2）为相位主体
    let phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow.textContent).toBe('正在执行：写入文件：b.md');
    // t2 完成 → t1 成为剩余未完成者 → 相位切回 t1
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't2', name: 'write_file', ok: true, summary: 'ok' },
      },
    });
    phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow.textContent).toBe('正在执行：读取文件：a.md');
    // t1 完成 → 无进行中工具且无 thinking → 相位行移除（不残留过期「正在执行」）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 5,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok' },
      },
    });
    expect(document.querySelector('.process-flow__phase')).toBeNull();
  });

  it('TS-11b 进行中工具行实时可见：默认展开 + is-tool-running，result 到达移除', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 't1', name: 'write_file', args: '{"path":"b.md"}' },
      },
    });
    const row = document.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(row).not.toBeNull();
    expect(row.open).toBe(true);
    expect(row.classList.contains('is-tool-running')).toBe(true);
    // result 到达 → 成功折叠 + 移除进行中态
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'write_file', ok: true, summary: '已写入' },
      },
    });
    expect(row.classList.contains('is-tool-running')).toBe(false);
    expect(row.open).toBe(false);
    expect(row.textContent).toContain('(成功)');
  });

  it('TS-11d 工具意图预告：tool_pending「准备中」→ tool_start 升级执行态 → tool_result 收敛（不重建）', () => {
    // 写文件等大参数工具的参数生成段可能数十秒——name 成形即提前渲染
    // 「准备中」行（is-tool-pending、静态浅环、不转 spinner），消除生成段 UI 真空。
    mountChatView();
    beginRound();
    // ① 参数生成段：tool_pending（瞬态顶层消息，不走 process_event/不落盘）
    dispatch({ type: 'tool_pending', toolCallId: 'call_w', name: 'write_file' });
    let row = document.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(row).not.toBeNull();
    expect(row.classList.contains('is-tool-pending')).toBe(true);
    expect(row.classList.contains('is-tool-running')).toBe(false); // 准备 ≠ 执行
    expect(row.textContent).toContain('准备中');
    expect(row.open).toBe(true);
    // ② 参数成形 tool_start 到达 → 同一行升级执行态（不重建：DOM 引用不换）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: {
          toolCallId: 'call_w',
          name: 'write_file',
          args: '{"path":"b.md","content":"x"}',
        },
      },
    });
    row = document.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(row.classList.contains('is-tool-pending')).toBe(false);
    expect(row.classList.contains('is-tool-running')).toBe(true);
    expect(row.textContent).toContain('进行中');
    // 叙述复原（参数完整，写环工具行动叙述生成器同路）
    expect(row.textContent).toContain('写入文件：b.md');
    // ③ tool_result 收敛终态（成功收起，非运行态）
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 3,
        ts: '',
        payload: { toolCallId: 'call_w', name: 'write_file', ok: true, summary: '已写入' },
      },
    });
    expect(row.classList.contains('is-tool-running')).toBe(false);
    expect(row.open).toBe(false);
    expect(row.textContent).toContain('(成功)');
  });

  it('run_command 工具行叙述命令原文（2026-10-03 宿主侧自然生长）', () => {
    // 背景：run_command 的命令原文是唯一可叙述面。不收录 → 只显「执行命令」，
    // 用户完全看不到 AI 到底跑了什么命令（命令执行是最高风险的可观测面）。
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: {
          toolCallId: 'call_cmd',
          name: 'run_command',
          args: JSON.stringify({ command: 'npm test' }),
        },
      },
    });
    const row = document.querySelector('.round-block__tool') as HTMLElement;
    expect(row.textContent).toContain('执行命令：npm test');
  });

  it('run_command 后台模式在叙述里标出（否则用户以为界面卡住）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: {
          toolCallId: 'call_bg',
          name: 'run_command',
          args: JSON.stringify({ command: 'npm run build', background: true }),
        },
      },
    });
    const row = document.querySelector('.round-block__tool') as HTMLElement;
    expect(row.textContent).toContain('执行命令（后台）：npm run build');
  });

  it('kill_command 叙述任务 id（否则只见「终止后台命令」，不知停的是哪个）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: {
          toolCallId: 'call_kill',
          name: 'kill_command',
          args: JSON.stringify({ taskId: 'bg-1' }),
        },
      },
    });
    const row = document.querySelector('.round-block__tool') as HTMLElement;
    expect(row.textContent).toContain('终止后台命令');
  });

  it('工具中文名接入（2026-09-19）：无参数可叙述的未收录工具与参数缺失场景均显中文名，不裸露英文名', () => {
    // 背景：toolActionLabel 兜底若为 `?? name`（英文原名）——两类场景在 UI 裸露英文工具名：
    // ①未收录工具（ask_user / remember_intel / run_project_script / run_team_meeting，均无可叙述
    //   参数，故不入 TOOL_ACTION_LABELS）；②已收录但本次 args 缺参（如 read_file 无 path）。
    // toolNameMap.getToolDisplayName 统一回退中文名，本条锁死该回退契约。
    mountChatView();
    beginRound();
    // ① 准备中态（renderPendingToolRow）：直显中文名
    dispatch({ type: 'tool_pending', toolCallId: 'call_m', name: 'run_team_meeting' });
    const pendingRow = document.querySelector('.round-block__tool') as HTMLElement;
    expect(pendingRow.textContent).toContain('团队会议');
    expect(pendingRow.textContent).not.toContain('run_team_meeting');
    // ② 升级为执行态（upgradePendingToolRow → toolActionLabel 兜底）：仍为中文名
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 'call_m', name: 'run_team_meeting', args: '{}' },
      },
    });
    expect(pendingRow.textContent).toContain('团队会议');
    expect(pendingRow.textContent).not.toContain('run_team_meeting');
  });

  it('TS-11d 并行工具独立预告：多个 tool_pending 各自成行、各自升级互不干扰', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'tool_pending', toolCallId: 'call_a', name: 'read_file' });
    dispatch({ type: 'tool_pending', toolCallId: 'call_b', name: 'write_file' });
    const rows = document.querySelectorAll('.round-block__tool');
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect((r as HTMLElement).classList.contains('is-tool-pending')).toBe(true);
    });
    // 只升级 a（按 toolCallId 精确配对），b 保持准备中
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 2,
        ts: '',
        payload: { toolCallId: 'call_a', name: 'read_file', args: '{"path":"a.ts"}' },
      },
    });
    const rowA = document.querySelector<HTMLDetailsElement>(
      '.round-block__tool[data-tool-call-id="call_a"]',
    );
    const rowB = document.querySelector<HTMLDetailsElement>(
      '.round-block__tool[data-tool-call-id="call_b"]',
    );
    expect(rowA!.classList.contains('is-tool-running')).toBe(true);
    expect(rowA!.classList.contains('is-tool-pending')).toBe(false);
    expect(rowB!.classList.contains('is-tool-running')).toBe(false);
    expect(rowB!.classList.contains('is-tool-pending')).toBe(true);
  });

  describe('TS-11c 工具等待时长（瞬态，不落库）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('tool_start → 秒数实时刷新；结果完成 + 流结束 → elapsed 移除', () => {
      mountChatView();
      beginRound();
      dispatch({
        type: 'process_event',
        event: {
          type: 'tool_start',
          seq: 2,
          ts: '',
          payload: { toolCallId: 't1', name: 'write_file', args: '{"path":"b.md"}' },
        },
      });
      // tick 前无 elapsed span；advance 2s 后出现「Ns」标签（Date 被 fake timers 一并 mock）
      expect(document.querySelector('.round-block__elapsed')).toBeNull();
      vi.advanceTimersByTime(2000);
      const row = document.querySelector('.round-block__tool') as HTMLElement;
      expect(row.textContent).toContain('2s');
      // 结果完成 + 流结束 → elapsed 清空（瞬态退场）
      dispatch({
        type: 'process_event',
        event: {
          type: 'tool_result',
          seq: 3,
          ts: '',
          payload: { toolCallId: 't1', name: 'write_file', ok: true, summary: 'ok' },
        },
      });
      dispatch({ type: 'done' });
      expect(document.querySelector('.round-block__elapsed')).toBeNull();
    });
  });
});

describe('TS-12b aborted 语义渲染（2026-09-02 结束语义收敛）', () => {
  function beginRound(): void {
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('stopReason=user → § 已停止 显示「用户停止了对话」（不写死「用户取消了对话」）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'aborted',
        seq: 2,
        ts: '',
        payload: { reason: 'User cancelled the conversation', stopReason: 'user' },
      },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const detail = rb.querySelector('.round-block__details') as HTMLElement;
    expect(detail.textContent).toContain('已停止');
    expect(detail.textContent).toContain('用户停止了对话');
    expect(detail.textContent).not.toContain('用户取消了对话');
  });

  it('无 stopReason（旧数据）→ 回退 reason 原文（兼容不丢细节）', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: { type: 'aborted', seq: 2, ts: '', payload: { reason: 'legacy 原因' } },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb.textContent).toContain('legacy 原因');
  });

  it('stopReason=timeout（chat 锁超时/LLM 无响应）→ 显示「对话处理超时」，不显示「用户停止」', () => {
    mountChatView();
    beginRound();
    dispatch({
      type: 'process_event',
      event: {
        type: 'aborted',
        seq: 2,
        ts: '',
        payload: { reason: 'LLM request timed out (no response)', stopReason: 'timeout' },
      },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb.textContent).toContain('对话处理超时，请稍后重试');
    expect(rb.textContent).not.toContain('用户停止');
  });

  it('运行时流式轮 done 后回填 ts 锚：容器级删除按钮可用（修复「回答结束删除恒禁用」）', () => {
    mountChatView();
    // 用户输入（带 ts）→ 流式正文（建 round-group 容器 + footer）→ done（回填 roundId + ts 锚）
    dispatch({ type: 'user', text: '请总结', ts: '2026-09-08T10:00:00.000Z' });
    dispatch({ type: 'chunk', content: '第一段', roundId: 'r1' });
    dispatch({ type: 'chunk', content: '第二段' });
    // done 前：容器 footer 的删除按钮 anchor ts 未回填 → 禁用
    const delBefore = document.querySelector(
      '.round-group__footer .msg-delete-icon',
    ) as HTMLButtonElement | null;
    expect(delBefore?.disabled).toBe(true);
    dispatch({ type: 'done', roundId: 'r1' });
    // done 后：commitTurnTs 用本轮用户输入 ts 回填 → 删除按钮可用（锁定已解除）
    const delAfter = document.querySelector(
      '.round-group__footer .msg-delete-icon',
    ) as HTMLButtonElement;
    expect(delAfter.disabled).toBe(false);
    // 分叉按钮：roundId 回填 → 同样可用
    const forkAfter = document.querySelector(
      '.round-group__footer .msg-fork-icon',
    ) as HTMLButtonElement;
    expect(forkAfter.disabled).toBe(false);
  });

  it('G31 方案1：运行时 done 收敛 QA 进折叠块——消息流干净、摘要含你答×N（2026-09-08 落地）', () => {
    mountChatView();
    // 有过程事件（narrate/tool）→ round-block 存在；过程中用户问答平铺消息流
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 2, ts: '', payload: { content: '开始分析' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't1', name: 'read_file', ok: true },
      },
    });
    dispatch({ type: 'chunk', content: '正在执行，需要确认方案', roundId: 'r1' });
    // 用户回答（运行时 qa，roundId 未知）
    dispatch({ type: 'user', text: '选方案A', ts: 't', kind: 'question-answer' });
    const qaRow = document.querySelector('.round-block__input') as HTMLElement;
    expect(qaRow).not.toBeNull();
    // 运行中（v1.8）：无 round-block 壳，过程平铺 .process-flow；QA 平铺消息流（折入未触发）
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时绝无大折叠壳
    expect(document.querySelector('.process-flow')).not.toBeNull(); // 过程平铺容器在
    expect(qaRow.parentElement?.classList.contains('round-block__details')).toBe(false);
    // 续跑 + done → 收敛：QA 折入折叠块、平铺内容收进折叠、摘要更新、消息流干净
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 5, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '好，按方案A继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // QA 已折入 .round-block__details
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 运行时平铺容器已移除（过程收进折叠块，无残留平铺）
    expect(document.querySelector('.process-flow')).toBeNull();
    const rbQa = rb?.querySelector('.round-block__details .round-block__input');
    expect(rbQa).not.toBeNull();
    expect(rbQa!.textContent).toContain('选方案A');
    // narrate/tool 已由 finalize 全量承载进折叠块（收尾后过程在折叠内）
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('开始分析');
    // 消息流层面：assistant 正文（含折叠块）→ 续接块，无孤立 QA 行（两段式干净）
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('你答×1');
    // done 后 round-block 收起（finalize）
    expect(rb?.hasAttribute('open')).toBe(false);
  });

  it('G31 方案1 修复（2026-09-08）：重放带 question 的 qa 成对完整折入——折叠内含「问回顾行 + 你答块」、assistant 相邻、摘要你答×1', () => {
    mountChatView();
    // 重放由单条 turn_update(replay:true) 承载——前序段 + 带 question 的 qa + 末段全量折入同一轮
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '帮我做方案', ts: 't1' },
        processEvents: [
          { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
          {
            type: 'metrics',
            seq: 2,
            ts: 't2',
            payload: {
              durationMs: 3000,
              tokenIn: 10,
              tokenOut: 20,
              toolFailureCount: 0,
              success: true,
            },
          },
        ],
        assistantLog: [{ content: '你想读哪个文件？', ts: 't2' }],
        // 带 question 的 qa（提问回顾行 + 回答折叠块）——问行与答块须成对折入，否则答块残留消息流（坑）
        interactiveInputs: [
          {
            content: '读 probe.txt',
            ts: 't3',
            kind: 'question-answer',
            question: '你想读哪个文件？',
            options: ['probe.txt', 'config.json'],
          },
        ],
        assistantMessage: { content: '好的', ts: 't4' },
        status: 'complete',
      }),
    );
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 形态甲：折叠块内单条目 = 问回顾行 + 你答行（合并形态，非两元素成对）
    const inBlock = rb.querySelectorAll<HTMLElement>('.round-block__details .round-block__input');
    expect(inBlock.length).toBe(1);
    expect(inBlock[0]!.querySelector('.round-block__input-q')?.textContent).toContain(
      '你想读哪个文件？',
    );
    expect(
      inBlock[0]!.querySelector('.round-block__input-row .round-block__input-tag')?.textContent,
    ).toBe('你答');
    // 消息流层面干净：assistant 前序段与 final 直接相邻（无残留 QA 块污染两段式）
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks[0]!.nextElementSibling).toBe(blocks[1]);
    // 折叠摘要含你答×1
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('你答×1');
  });

  it('ask 超时未答（2026-09-08 保底）：运行时提问框销毁、渲染「问 + 未回答」行、done 后折入折叠块 + 摘要未回答×1', () => {
    mountChatView();
    // 运行时轮：assistant 块（ask 暂停点）→ turn_update(waiting/ask) 渲染提问框
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '在读取前需要确认：', roundId: 'round-1' });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [
        { slot: 'task', question: '你想读哪个文件？', options: ['probe.txt', 'config.json'] },
      ],
    });
    const askInline = document.querySelector('.ask-inline') as HTMLElement;
    expect(askInline).not.toBeNull();
    // 宿主超时自动续跑：先投递「未回答」交互行（timeout 消息到达即销毁提问框）
    dispatch({
      type: 'user',
      text: '用户未在时限内回答，已自动继续——请从上面的选项里选一项你推荐的方案继续推进，并在答复中说明这是你代选的及理由；不可逆操作仍需向我确认',
      ts: 't2',
      roundId: 'round-1',
      kind: 'timeout',
      question: '你想读哪个文件？',
      options: ['probe.txt', 'config.json'],
    });
    expect(document.querySelector('.ask-inline')).toBeNull(); // 提问框已销毁
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.round-block__input'));
    // 形态甲：单条目 = 问回顾行 + 未回答行（合并形态，非两元素）
    expect(rows.length).toBe(1);
    expect(rows[0]!.querySelector('.round-block__input-q')?.textContent).toContain(
      '你想读哪个文件？',
    );
    expect(
      rows[0]!.querySelector('.round-block__input-row .round-block__input-tag')?.textContent,
    ).toBe('未回答');
    expect(rows[0]!.textContent).toContain('已自动继续');
    // done → 收敛折入折叠块 + 摘要未回答×1
    dispatch({ type: 'chunk', content: '好的，按默认继续。', roundId: 'round-1' });
    dispatch({ type: 'done', roundId: 'round-1' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const rbQa = rb.querySelectorAll<HTMLElement>('.round-block__details .round-block__input');
    expect(rbQa.length).toBe(1); // 单条目（问回顾行 + 未回答行）
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('未回答×1');
  });

  it('ask 超时重放：timeout 交互记录经 middle 透传渲染「问 + 未回答」并折入收起态折叠块（运行时 = 重放同构）', () => {
    mountChatView();
    // 重放由单条 turn_update(replay:true) 承载——前序段 + timeout 交互行 + 末段折入同一轮
    dispatchReplay(
      makeRound({
        id: 'round-1',
        user: { content: '帮我做方案', ts: 't1' },
        processEvents: [
          { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
          {
            type: 'metrics',
            seq: 2,
            ts: 't2',
            payload: {
              durationMs: 3000,
              tokenIn: 10,
              tokenOut: 20,
              toolFailureCount: 0,
              success: true,
            },
          },
        ],
        assistantLog: [{ content: '在读取前需要确认：', ts: 't2' }],
        // 重放 middle 段 timeout 行（宿主 replayHistory → postTurnUpdate 按 kind 透传；带 question/options）
        interactiveInputs: [
          {
            content:
              '用户未在时限内回答，已自动继续——请从上面的选项里选一项你推荐的方案继续推进，并在答复中说明这是你代选的及理由；不可逆操作仍需向我确认',
            ts: 't3',
            kind: 'timeout',
            question: '你想读哪个文件？',
            options: ['probe.txt', 'config.json'],
          },
        ],
        assistantMessage: { content: '好的，按默认继续。', ts: 't4' },
        status: 'complete',
      }),
    );
    const rb = document.querySelector('.round-block') as HTMLElement;
    const rbQa = rb.querySelectorAll<HTMLElement>('.round-block__details .round-block__input');
    // 形态甲：单条目 = 问回顾行 + 未回答行（合并形态）
    expect(rbQa.length).toBe(1);
    expect(rbQa[0]!.querySelector('.round-block__input-q')?.textContent).toContain(
      '你想读哪个文件？',
    );
    expect(
      rbQa[0]!.querySelector('.round-block__input-row .round-block__input-tag')?.textContent,
    ).toBe('未回答');
    expect(rbQa[0]!.textContent).toContain('已自动继续');
    // 消息流干净 + 摘要
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks[0]!.nextElementSibling).toBe(blocks[1]);
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('未回答×1');
  });

  it('形态甲：QA 条目按 ts 归位对应 step 分组（补充挂刚结束的 step 间隙，2026-09-17 位置确定性防回归）', () => {
    mountChatView();
    // 重放由单条 turn_update(replay:true) 承载——两条任务项边界过程事件 + 前序段 + supplement 折入同一轮
    dispatchReplay(
      makeRound({
        id: 'r1',
        user: { content: '任务', ts: 't0' },
        processEvents: [
          { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } },
          {
            type: 'plan_item_boundary',
            seq: 2,
            ts: 't2',
            payload: { planItemId: 's1', title: '第一步' },
          },
          { type: 'narrate', seq: 3, ts: 't3', payload: { content: '步骤一执行' } },
          {
            type: 'plan_item_boundary',
            seq: 4,
            ts: 't4',
            payload: { planItemId: 's2', title: '第二步' },
          },
          { type: 'narrate', seq: 5, ts: 't5', payload: { content: '步骤二执行' } },
          {
            type: 'metrics',
            seq: 6,
            ts: 't6',
            payload: {
              durationMs: 100,
              tokenIn: 1,
              tokenOut: 1,
              toolFailureCount: 0,
              success: true,
            },
          },
        ],
        assistantLog: [{ content: '前序段', ts: 't2.5' }],
        // 用户补充：ts 在 step1 边界之后、step2 边界之前 → 归 step1 分组（刚结束的 step 间隙）
        interactiveInputs: [{ content: '补充：改一下', ts: 't3.5', kind: 'supplement' }],
        assistantMessage: { content: '已按补充调整', ts: 't7' },
        status: 'complete',
      }),
    );
    const planItems = document.querySelectorAll('.round-block__plan-item');
    expect(planItems.length).toBe(2);
    // 条目归 step1（ts 定位），不飘忽：不在 details 顶层、不在 step2
    expect(planItems[0]!.querySelector('.round-block__input')?.textContent).toContain(
      '补充：改一下',
    );
    const detailsInputs = Array.from(
      document.querySelectorAll<HTMLElement>('.round-block__details > .round-block__input'),
    );
    expect(detailsInputs).toHaveLength(0);
    expect(planItems[1]!.querySelector('.round-block__input')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 回抽 · 首轮工具叙述从正文撤回，改由过程叙述承载
// ═══════════════════════════════════════════════════════════════

describe('chatView narrate_withdraw 回抽', () => {
  /** 本轮 assistant 正文容器（正文 = 该轮唯一 .msg-body） */
  const assistantBody = (): HTMLElement =>
    document.querySelector('.msg.assistant .msg-body') as HTMLElement;

  it('撤回已流式进正文的叙述段：正文去该段、叙述进过程区，收尾后仅余结论', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 首轮无工具史：叙述已逐字流式进正文（消息级分类前无法预判工具轮）
    dispatch({ type: 'chunk', content: '我先全面探索项目结构' });
    expect(assistantBody().textContent).toContain('我先全面探索项目结构');

    // 内核确认工具轮 → 回抽该段（正文全量重渲染自 streamingRaw，去后缀即生效）
    dispatch({ type: 'narrate_withdraw', text: '我先全面探索项目结构' });
    expect(assistantBody().textContent).not.toContain('我先全面探索项目结构');

    // 该段改由 narrate 过程事件承载（运行时过程平铺容器）
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 2, ts: '', payload: { content: '我先全面探索项目结构' } },
    });
    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    expect(flow.querySelector('.process-flow__narrate')?.textContent).toContain(
      '我先全面探索项目结构',
    );
    expect(assistantBody().textContent).not.toContain('我先全面探索项目结构');

    // 后续最终结论照常进正文（流式节流 150ms，终态在 done 收敛渲染后断言）
    dispatch({ type: 'chunk', content: '这是最终结论。' });

    // 收尾：过程（叙述）折入 round-block 并收起，正文仅余结论——「外面只有结论」
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLDetailsElement;
    expect(rb.open).toBe(false);
    expect(rb.textContent).toContain('我先全面探索项目结构');
    expect(assistantBody().textContent).not.toContain('我先全面探索项目结构');
    expect(assistantBody().textContent).toContain('这是最终结论。');
  });

  it('防御分支：撤回段非正文后缀（正文另含其它文本）时按最后出现位置删除，不误伤其余正文', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '叙述段' });
    dispatch({ type: 'chunk', content: '结论段' });
    dispatch({ type: 'narrate_withdraw', text: '叙述段' });
    expect(assistantBody().textContent).toContain('结论段');
    expect(assistantBody().textContent).not.toContain('叙述段');
  });

  it('撤回文本不在正文中：无副作用（幂等守卫，不误删正文）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({ type: 'chunk', content: '正文' });
    dispatch({ type: 'narrate_withdraw', text: '不相干的文本' });
    expect(assistantBody().textContent).toContain('正文');
  });

  it('thought 思考折叠块：运行时平铺 + finalize 后 round-block 折叠组（2026-09-13）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 运行时：思考增量汇入 process-flow 平铺
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 2, ts: '', payload: { content: '用户问 A/B，先查资料' } },
    });
    const flow = document.querySelector('.process-flow') as HTMLElement;
    const runningRow = flow.querySelector('.process-flow__thought') as HTMLDetailsElement;
    expect(runningRow).not.toBeNull();
    expect(runningRow.textContent).toContain('思考');
    expect(runningRow.textContent).toContain('用户问 A/B，先查资料');
    // 思考不污染正文
    expect(assistantBody().textContent).not.toContain('用户问 A/B');
    // finalize：round-block 出现折叠组
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const doneRow = rb.querySelector('.round-block__thought') as HTMLDetailsElement;
    expect(doneRow).not.toBeNull();
    expect(doneRow.textContent).toContain('思考');
    expect(doneRow.textContent).toContain('用户问 A/B，先查资料');
  });

  it('thought 与 narrate/tool 按 seq 平铺（时序忠实，思考是过程轨迹一部分）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 2, ts: '', payload: { content: '思考：先搜索' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_start',
        seq: 3,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' },
      },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'tool_result',
        seq: 4,
        ts: '',
        payload: { toolCallId: 't1', name: 'web_search', ok: true, summary: '结果A' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 5, ts: '', payload: { content: '再看文档' } },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const nodes = Array.from(
      rb.querySelectorAll('.round-block__thought, .round-block__tool, .round-block__narrate'),
    );
    // 按 seq 平铺：thought(2) → tool(3) → narrate(5)
    expect(nodes[0].className).toContain('round-block__thought');
    expect(nodes[1].className).toContain('round-block__tool');
    expect(nodes[2].className).toContain('round-block__narrate');
  });

  it('P3：同一轮多个 thought 碎片聚合成一个折叠块且连续（修复满屏小折叠与断断续续）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 2, ts: '', payload: { content: '用户想要理解' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 3, ts: '', payload: { content: '项目并生成' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 4, ts: '', payload: { content: '白' } },
    });
    // 运行时：仍是**单个** process-flow__thought，增量**原样连续**累积（data-merged-seq 防重复拼接）
    const flow = document.querySelector('.process-flow') as HTMLElement;
    const runningRows = flow.querySelectorAll('.process-flow__thought');
    expect(runningRows.length).toBe(1);
    // 连贯：碎片拼接无换行 → 一次性连续文本（不逐段一行）
    expect(runningRows[0]!.textContent).toBe('思考用户想要理解项目并生成白');
    // finalize：round-block 亦为**单个**折叠块，连续拼接
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const doneRows = rb.querySelectorAll('.round-block__thought');
    expect(doneRows.length).toBe(1);
    expect(doneRows[0]!.textContent).toContain('用户想要理解项目并生成白');
  });

  it('P3：连续性——英文增量粒度的天然空格保留（逐 delta 不回退、不 trim 空格）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    // 模拟增量片段：真实流式里每个 delta 可能是词/短语，天然携带间隔
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 2, ts: '', payload: { content: 'Now let me also read ' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 3, ts: '', payload: { content: 'the project report' } },
    });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const done = rb.querySelector('.round-block__thought') as HTMLDetailsElement;
    // 连续拼接 → 一句完整文本（中间有空格，非分行的碎片）
    expect(done.textContent).toContain('Now let me also read the project report');
  });

  it('per-step 分桶——不同 step 的思考各自独立折叠（标注第几步），同 step 内碎片连续', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 2, ts: '', payload: { content: '第一', stepIndex: 1 } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 3, ts: '', payload: { content: '步', stepIndex: 1 } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 4, ts: '', payload: { content: '第二', stepIndex: 2 } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 5, ts: '', payload: { content: '步', stepIndex: 2 } },
    });
    // 流式：step1、step2 各 1 个折叠块（同 step 内连续），标题标注第几步
    const flow = document.querySelector('.process-flow') as HTMLElement;
    const runningRows = flow.querySelectorAll('.process-flow__thought');
    expect(runningRows.length).toBe(2);
    expect(runningRows[0]!.textContent).toContain('第 1 步');
    expect(runningRows[0]!.textContent).toContain('第一步');
    expect(runningRows[1]!.textContent).toContain('第 2 步');
    expect(runningRows[1]!.textContent).toContain('第二步');
    // finalize：round-block 内同样每 step 一个折叠块
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const doneRows = rb.querySelectorAll('.round-block__thought');
    expect(doneRows.length).toBe(2);
    expect(doneRows[0]!.textContent).toContain('第一步');
    expect(doneRows[1]!.textContent).toContain('第二步');
  });

  it('per-step 分桶 × 任务项收纳：step 折叠块仍归入所属任务项分组（边界切组语义不变）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 2,
        ts: '',
        payload: { planItemId: 's1', title: '分析需求' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 3, ts: '', payload: { content: '第一', stepIndex: 1 } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 4, ts: '', payload: { content: '步', stepIndex: 1 } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 5,
        ts: '',
        payload: { planItemId: 's2', title: '编写代码' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 6, ts: '', payload: { content: '第二', stepIndex: 2 } },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 7, ts: '', payload: { content: '步', stepIndex: 2 } },
    });
    // 流式：s1、s2 各收纳 1 个 step 折叠块（同 step 内连续），各自独立
    const flow = document.querySelector('.process-flow') as HTMLElement;
    const flowPlanItems = flow.querySelectorAll('.round-block__plan-item');
    expect(flowPlanItems.length).toBe(2);
    const s1f = flowPlanItems[0]!.querySelectorAll('.process-flow__thought');
    const s2f = flowPlanItems[1]!.querySelectorAll('.process-flow__thought');
    expect(s1f.length).toBe(1);
    expect(s1f[0]!.textContent).toContain('第一步');
    expect(s2f.length).toBe(1);
    expect(s2f[0]!.textContent).toContain('第二步');
    // finalize：round-block 内任务项分组同样各收纳对应 step 折叠块
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const rbPlanItems = rb.querySelectorAll('.round-block__plan-item');
    expect(rbPlanItems.length).toBe(2);
    expect(rbPlanItems[0]!.querySelectorAll('.round-block__thought').length).toBe(1);
    expect(rbPlanItems[0]!.querySelectorAll('.round-block__thought')[0]!.textContent).toContain(
      '第一步',
    );
    expect(rbPlanItems[1]!.querySelectorAll('.round-block__thought').length).toBe(1);
    expect(rbPlanItems[1]!.querySelectorAll('.round-block__thought')[0]!.textContent).toContain(
      '第二步',
    );
  });

  it('旧数据回落：无 stepIndex 的 thought 归整轮单桶（不猜测推断归属）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 2,
        ts: '',
        payload: { planItemId: 's1', title: '分析需求' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 3, ts: '', payload: { content: '旧数据甲' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 4,
        ts: '',
        payload: { planItemId: 's2', title: '编写代码' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'thought', seq: 5, ts: '', payload: { content: '旧数据乙' } },
    });
    // 流式：跨任务项边界仍为单桶（无 stepIndex 不拆分）
    const flow = document.querySelector('.process-flow') as HTMLElement;
    const runningRows = flow.querySelectorAll('.process-flow__thought');
    expect(runningRows.length).toBe(1);
    expect(runningRows[0]!.textContent).toContain('旧数据甲');
    expect(runningRows[0]!.textContent).toContain('旧数据乙');
    expect(runningRows[0]!.textContent).not.toContain('第');
    // finalize：同样单桶
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const doneRows = rb.querySelectorAll('.round-block__thought');
    expect(doneRows.length).toBe(1);
    expect(doneRows[0]!.textContent).toContain('旧数据甲');
    expect(doneRows[0]!.textContent).toContain('旧数据乙');
  });
});

// ─── 写入审批卡（webview 侧）────────────────────
// 背景：write_confirm_request 若仅 host 发送、webview 无消费 → 开启「写入二次确认」后
// 审批卡永不弹出、超时 fail-closed 自动拒绝导致写入功能不可用。本组护栏验证：
// 1) 收到 request渲染审批卡（工具/路径/描述/diff 全部字段 textContent 填充，防注入）；
// 2) 确认按钮回传 write_confirm_answer(approved=true) 并隐藏卡片；
// 3) 拒绝按钮回传 write_confirm_answer(approved=false) 并隐藏卡片；
// 4) 覆盖渲染：webview 收到新 request 时替换当前卡（旧 requestId 清空，不泄漏陈旧按钮态）。
// ⚠️ 语义变更（2026-10-05 串行化，修 S2）：真实链路已由宿主 FIFO 串行送审，**同一时刻
// 只有一条在途**，故「旧 requestId 由 host 超时独立兜底」不再成立——旧请求根本没被推出去，
// 是宿主队列在等，不是 webview 覆盖后被 host 兜底。保留本用例是因webview 仍须对
// 「同时收到两条」保持健壮（协议层不假设host 行为，是webview 的自保义务）。
describe('chatView 写入审批卡（H0，2026-09-19 补全）', () => {
  it('write_confirm_request 渲染审批卡：工具/路径/描述/diff 填充且卡片可见', () => {
    mountChatView();
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    // 初始隐藏
    expect(card.hasAttribute('hidden')).toBe(true);
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_test1',
      targetPath: '/workspace/src/foo.ts',
      tool: 'write_file',
      description: '写文件：foo.ts',
      permission: '',
      beforeContent: 'old',
      afterContent: 'new',
      hasDiff: true, // 写入场景：判据归内核单点，宿主按此渲染 diff 域
    });
    expect(card.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('writeConfirmTool')!.textContent).toBe('写入文件');
    expect(document.getElementById('writeConfirmPath')!.textContent).toBe('/workspace/src/foo.ts');
    expect(document.getElementById('writeConfirmDesc')!.textContent).toBe('写文件：foo.ts');
    // diff 预览：before → after（textContent 防注入，与消息区同纪律；纯内容对比，不含描述）
    expect(document.getElementById('writeConfirmDiff')!.textContent).toContain('--- 写入前 ---');
    expect(document.getElementById('writeConfirmDiff')!.textContent).toContain('old');
    expect(document.getElementById('writeConfirmDiff')!.textContent).toContain('+++ 写入后 +++');
    expect(document.getElementById('writeConfirmDiff')!.textContent).toContain('new');
    // S3 断言升级：原只断言 hidden（真机 hidden=false 却不可见 ⇒ 假绿）。此处补结构断言——
    // 卡片必须不在滚动容器 #messages 内，否则「渲染成功」与「用户看得见」不等价。
    expect(
      (document.getElementById('messages') as HTMLElement).contains(
        document.getElementById('writeConfirmCard') as HTMLElement,
      ),
    ).toBe(false);
  });

  it('非写入场景（命令确认，内核下发 hasDiff=false）不得渲染假 diff 表', () => {
    // 回归锁：diff 域判据已归内核单点（`WriteConfirmationInfo.hasDiff`，2026-10-03 实锤
    // 宿主 truthy 自猜属措辞折叠型带伤）。命令/代码/脚本/删除确认内核恒下发 hasDiff=false，
    // 宿主无论载荷带不带内容字段都不渲染「--- 写入前 --- / +++ 写入后 +++」假对比。
    mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_cmd',
      targetPath: '在工作区执行命令：git push origin main',
      tool: 'run_command',
      description: '在工作区执行命令：git push origin main',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false, // 命令场景：内核恒 false
    });
    const diff = document.getElementById('writeConfirmDiff')!.textContent ?? '';
    expect(diff).toContain('--- 目标 ---');
    expect(diff).toContain('git push origin main');
    expect(diff).not.toContain('--- 写入前 ---');
    expect(diff).not.toContain('+++ 写入后 +++');
    // 按钮动词中性（不写死「确认写入」）
    expect(document.getElementById('writeConfirmOk')!.textContent).toBe('确认');
  });

  it('删除文件场景（同样无 diff 域）也不得渲染假 diff 表', () => {
    // delete_file 走 requestWriteConfirmation 时不传 diff（builtinToolHandlers 只给 3 个参数）
    mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_del',
      targetPath: '/workspace/src/gone.ts',
      tool: 'delete_file',
      description: '删除文件：gone.ts',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false, // 删除场景：内核恒 false（同命令确认）
    });
    const diff = document.getElementById('writeConfirmDiff')!.textContent ?? '';
    expect(diff).toContain('--- 目标 ---');
    expect(diff).not.toContain('--- 写入前 ---');
  });

  it('confirmWrites 审批卡：确认按钮回传 answer(approved=true) 并进入等待态（**不收卡**）', () => {
    // 2026-10-05 P5 落地 A 语义变更：点击**不再**收卡。显隐真源在宿主（_settleConfirm 推下一条
    // 覆盖渲染 / 队列空时推 closed 收卡）；webview 同步关卡会造成「同步关 / 异步开」两帧空档
    // = 用户真机实测的闪烁，且队列无下一条时卡片滞留 → 重复提交窗口。
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_ok',
      targetPath: '/workspace/a.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: 'hello',
    });
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'write_confirm_answer',
      requestId: 'wc_ok',
      approved: true,
    });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    // 🔴 卡**不得**收：等宿主推下一条
    expect(card.hasAttribute('hidden')).toBe(false);
    // 等待态三件套：按钮 disabled（防重复提交）+ 卡片降透明度 + 明示文案
    expect((document.getElementById('writeConfirmOk') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('writeConfirmReject') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(card.getAttribute('data-pending')).toBe('true');
    expect(document.getElementById('writeConfirmHint')!.textContent).toContain('已确认');
    // 倒计时停表（F3）：已裁决的卡不再倒数
    expect((document.getElementById('writeConfirmCountdown') as HTMLElement).hidden).toBe(true);
  });

  it('confirmWrites 审批卡：拒绝按钮回传 answer(approved=false) 并进入等待态', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_no',
      targetPath: '/workspace/b.ts',
      tool: 'edit_file',
      description: '',
      permission: '',
      beforeContent: 'a',
      afterContent: 'b',
    });
    (document.getElementById('writeConfirmReject') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'write_confirm_answer',
      requestId: 'wc_no',
      approved: false,
    });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    expect(card.hasAttribute('hidden')).toBe(false);
    expect((document.getElementById('writeConfirmReject') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(card.getAttribute('data-pending')).toBe('true');
    expect(document.getElementById('writeConfirmHint')!.textContent).toContain('已拒绝');
  });

  it('等待态期间重复点击不再回传 answer（消解 F1：宿主 pending 已 delete，重复提交会被静默丢弃）', () => {
    // 无disabled 时：点第2 下 ⇒ postMessage 再发一条同 requestId 的 answer ⇒ 宿主 pending
    // 已 delete ⇒ 静默丢弃 ⇒ 用户视角「点了没反应」。disabled 是第一道防线，
    // writeConfirmAwaitingNext 的显式 early-return 是第二道（双保险）。
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_dup',
      targetPath: '/workspace/c.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    const ok = document.getElementById('writeConfirmOk') as HTMLButtonElement;
    ok.click();
    ok.click();
    ok.click();
    const answers = postMessage.mock.calls.filter(
      (args) => (args[0] as { type?: string }).type === 'write_confirm_answer',
    );
    expect(answers.length).toBe(1);
  });

  it('宿主推下一条 request ⇒ 等待态复位、按钮恢复可用（串行送审接力）', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_r1',
      targetPath: '/workspace/1.ts',
      tool: 'run_command',
      description: 'git push',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    });
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    expect(card.getAttribute('data-pending')).toBe('true');
    // 宿主推下一条（队列还有）⇒ 覆盖渲染 + 等待态复位
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_r2',
      targetPath: '/workspace/2.ts',
      tool: 'run_command',
      description: 'git reset --hard',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(card.getAttribute('data-pending')).toBe(null);
    expect((document.getElementById('writeConfirmOk') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('writeConfirmReject') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(document.getElementById('writeConfirmHint')!.hidden).toBe(true);
    // 内容已切到第 2 条，且卡**始终可见**（同DOM 覆盖 ⇒ 天然无闪烁）
    expect(card.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('writeConfirmPath')!.textContent).toBe('/workspace/2.ts');
    // 第二条可独立裁决
    (document.getElementById('writeConfirmReject') as HTMLButtonElement).click();
    const answers = postMessage.mock.calls.filter(
      (args) => (args[0] as { type?: string }).type === 'write_confirm_answer',
    );
    expect(answers.length).toBe(2);
    expect(answers[1]![0]).toEqual({
      type: 'write_confirm_answer',
      requestId: 'wc_r2',
      approved: false,
    });
  });

  it('队列已空：宿主推 write_confirm_closed ⇒ 收卡且等待态一并清干净（无残留）', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_last',
      targetPath: '/workspace/z.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    // 宿主推 closed（队列空）⇒ 收卡
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_last' });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    expect(card.hasAttribute('hidden')).toBe(true);
    // 等待态痕迹必须全清（否则下次请求进来按钮是灰的 = 僵尸交互）
    expect(card.getAttribute('data-pending')).toBe(null);
    expect((document.getElementById('writeConfirmOk') as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('writeConfirmHint')!.hidden).toBe(true);
    // composer 已回归（A 类不再阻断）
    expect((document.getElementById('inputWrap') as HTMLElement).hidden).toBe(false);
    // 收卡后重新来一条必须完全可用（回归锁：等待态跨请求泄漏）
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_fresh',
      targetPath: '/workspace/fresh.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    const ok = document.getElementById('writeConfirmOk') as HTMLButtonElement;
    expect(ok.disabled).toBe(false);
    ok.click();
    const answers = postMessage.mock.calls.filter(
      (args) => (args[0] as { type?: string }).type === 'write_confirm_answer',
    );
    expect(answers.length).toBe(2);
    expect(answers[1]![0]).toMatchObject({ requestId: 'wc_fresh', approved: true });
  });

  it('🔴 主位条位置恒定：B 类条进出不得挤开审批卡（真机「先消失再出现」守卫）', () => {
    // 真机实锤（2026-10-05 第二轮，P7 落地后仍闪）：审批卡每切一张必闪一次。
    // 探针实测根因：resolveDock 把 +N chip /浮层 panel 插到 **anchor(inputBar) 前**，
    // 即插进「confirm 卡 ↔ inputBar」之间；而 rest 是否非空随 B 类条进出而变
    // （activity 条 2500ms 自动消失 = 高频触发点，恰好落在用户审下一条的等待窗口内）
    // ⇒ chip/panel 反复插拔 ⇒ 卡在「紧邻 inputBar」与「被挤开」之间来回跳。
    //
    // 🔴 判据用anchor.previousElementSibling（**不是** head.previousElementSibling：
    // 后者恒为假—— 非活跃条循环会把隐藏条夹在 head 与 anchor 之间，两者可同时成立）。
    const isAdjacent = (): boolean => {
      const card = document.getElementById('writeConfirmCard') as HTMLElement;
      const bar = document.getElementById('inputBar') as HTMLElement;
      return bar.previousElementSibling === card;
    };
    mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_pos1',
      targetPath: '/workspace/p1.ts',
      tool: 'run_command',
      description: 'git push',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(isAdjacent()).toBe(true);
    // B 类条进入 ⇒ rest 非空 ⇒ 生成 chip + panel（这是「挤开」的发生条件）
    dispatch({ type: 'notice', level: 'info', message: '正在执行' });
    expect(isAdjacent()).toBe(true);
    // B 类条退出 ⇒ rest 变空 ⇒ chip/panel 撤除
    dispatch({ type: 'file_changes', files: [] });
    expect(isAdjacent()).toBe(true);
    // 多条 B 类同活（rest 更多）仍不得挤开
    dispatch({ type: 'file_changes', files: ['/workspace/a.ts'] });
    dispatch({ type: 'notice', level: 'info', message: '正在执行' });
    expect(isAdjacent()).toBe(true);
    // 裁决 → 下一条覆盖渲染，全程位置恒定
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_pos2',
      targetPath: '/workspace/p2.ts',
      tool: 'run_command',
      description: 'git reset --hard',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(isAdjacent()).toBe(true);
    // 收卡后 A 类退位，inputBar 前一位交还给常规条
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_pos2' });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    expect(card.hasAttribute('hidden')).toBe(true);
  });

  it('审批卡覆盖渲染：收到新 request 即替换为最新（旧 requestId 清空，卡片无状态泄漏）', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_first',
      targetPath: '/workspace/1.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: '1',
    });
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_second',
      targetPath: '/workspace/2.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: '2',
    });
    // 点击确认（只回传最新 requestId；过滤初始化 ready 消息，仅统计 write_confirm_answer）
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    const confirmAnswers = postMessage.mock.calls.filter(
      (args) => (args[0] as { type?: string }).type === 'write_confirm_answer',
    );
    expect(confirmAnswers.length).toBe(1);
    expect(confirmAnswers[0]![0]).toEqual({
      type: 'write_confirm_answer',
      requestId: 'wc_second',
      approved: true,
    });
  });

  it('审批卡锚点守卫：卡须与 #messages 同级并位其之后，严禁挪回滚动容器内', () => {
    // 真机背景（2026-10-05 实锤）：卡原是 #messages 的**第 2 个子节点**（紧跟 #emptyState），
    // 而 chatView 全部 12 处消息追加都是 messages.appendChild() ⇒ 卡恒停在消息流最顶端；
    // #messages 是 overflow-y:auto 滚动容器（chatStyles.ts 内 #messages 规则），流式全程吸底
    // （helpers/scrollToBottom.ts）把视口钉在底部 ⇒ 卡恒在视口之上不可见 ⇒ 表现为
    // 「确认 UI 根本没弹」，超时后 fail-closed 自动拒绝（命令确认首跑即翻车）。
    mountChatView();
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    const messages = document.getElementById('messages') as HTMLElement;
    const inputBar = document.getElementById('inputBar') as HTMLElement;
    // 🔴 严禁挪回 #messages 内部
    expect(messages.contains(card)).toBe(false);
    // 必须与 #messages 同级（同父）且排在其后 —— 不参与消息流滚动，恒定可见
    expect(card.parentElement).toBe(messages.parentElement);
    expect(messages.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 位于输入区紧上方（对齐 Cline / Roo「输入区上方动作区」形态）
    expect(card.compareDocumentPosition(inputBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('载荷缺 timeoutMs 必显式报错（禁静默失效：倒计时无声消失且无痕可查）', () => {
    // 反向守卫：startConfirmCountdown 曾对非法 timeoutMs 静默 return——宿主一旦漏填
    // （真源漂移），倒计时无声消失，用户只见一张永不提示的卡，直到 30 分钟后突然被拒，
    // 现场无任何痕迹（与E2 同款病）。此处锁死「必须抛」，不锁抛的文案。
    mountChatView();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 走 onMessage：异常由其兜底 catch 转 console.error，不炸测试。
    // 载荷用as never 绕过 TS——本用例正是要模拟「宿主违约、字段根本不存在」。
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_no_timeout',
      targetPath: '/workspace/z.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      hasDiff: true,
    } as never);
    // onMessage 的 catch 必须被触发（＝确实抛了，不是静默 return）
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => String(c[0]) + ' ' + String(c[1] ?? '')).join('\n');
    expect(logged).toContain('timeoutMs');
    spy.mockRestore();
  });

  it('末段倒计时：剩余不足 60 秒才显示，文本由宿主透传的 timeoutMs 投影', () => {
    // 时长真源在宿主（CONFIRM_TIMEOUT_MS → 协议 timeoutMs），webview 只投影不自算——
    // 自算即真源双写，末段提示会与宿主实际拒绝时刻漂移。
    mountChatView();
    const countdown = document.getElementById('writeConfirmCountdown') as HTMLElement;
    // 远超末段窗口 ⇒ 静默（不打扰）
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_cd_far',
      targetPath: '/workspace/x.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: 'x',
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(countdown.hidden).toBe(true);
    // 落在末段窗口内 ⇒ 显示倒计时
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_cd_near',
      targetPath: '/workspace/y.ts',
      tool: 'run_command',
      description: 'rm -rf /tmp/x',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30_000,
    });
    expect(countdown.hidden).toBe(false);
    expect(countdown.textContent).toContain('还有');
    expect(countdown.textContent).toContain('秒将自动拒绝');
  });

  it('末段倒计时：收卡即停表（不在关闭后残留倒计时）', () => {
    mountChatView();
    const countdown = document.getElementById('writeConfirmCountdown') as HTMLElement;
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_cd_stop',
      targetPath: '/workspace/z.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: 'z',
      hasDiff: true,
      timeoutMs: 30_000,
    });
    expect(countdown.hidden).toBe(false);
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_cd_stop' });
    expect(countdown.hidden).toBe(true);
    expect(countdown.textContent).toBe('');
  });

  it('A 类阻断即替换 composer：审批卡挂起时输入框让位，宿主终结后才恢复', () => {
    // 方案 P1b：输入框在阻断期间整体让位（**替换**而非遮罩 —— 零新 z-index 层、零焦点陷阱），
    // 用户此刻只能做「确认/拒绝」这一个决定。🔴 恢复路径必须覆盖：漏了就永久卡死输入。
    // ⚠️ 2026-10-05 P5 落地 A 后恢复判据变了：点击**不再**立即恢复，须待宿主推
    // write_confirm_closed（=宿主已确认「请求终结且队列已空」）。这正是把 composer 让位的
    // 生命周期锚定在宿主事实上的意义——用户拒绝的那一刻起，输入框仍被占用（阻断未结束）。
    mountChatView();
    const inputWrap = document.getElementById('inputWrap') as HTMLElement;
    expect(inputWrap.hidden).toBe(false);
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_lock',
      targetPath: '/workspace/d.ts',
      tool: 'run_command',
      description: 'echo test',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    });
    // 挂起中：输入框让位
    expect(inputWrap.hidden).toBe(true);
    // 焦点落到「拒绝」（安全默认，与 fail-closed 同向；composer 已隐藏，焦点不能丢到 body）
    expect(document.activeElement).toBe(document.getElementById('writeConfirmReject'));
    // 用户拒绝 ⇒ 进入等待态，**输入框仍让位**（阻断未结束，卡还要接下一条）
    (document.getElementById('writeConfirmReject') as HTMLButtonElement).click();
    expect(inputWrap.hidden).toBe(true);
    // 宿主推 closed（队列已空，请求真终结）⇒ composer 恢复
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_lock' });
    expect(inputWrap.hidden).toBe(false);
  });

  it('A 类串行送审：连续两条确认期间 composer 全程让位（中途不闪回）', () => {
    // 回归锁：若某条路径在「点确认 → 宿主推下一条」之间让 composer 提前恢复，用户会在
    // 阻断未结束时拿到输入入口（A4 定的阻断语义被破坏），且视觉上表现为输入框一闪。
    mountChatView();
    const inputWrap = document.getElementById('inputWrap') as HTMLElement;
    const first: ExtensionToWebviewMessage = {
      type: 'write_confirm_request',
      requestId: 'wc_s1',
      targetPath: '/workspace/s1.ts',
      tool: 'run_command',
      description: 'git push',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    };
    dispatch(first);
    expect(inputWrap.hidden).toBe(true);
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    // 关键断言：点完确认，composer 依然隐藏
    expect(inputWrap.hidden).toBe(true);
    // 宿主推下一条（队列还有）⇒ 覆盖渲染，composer 继续让位
    dispatch({ ...first, requestId: 'wc_s2', targetPath: '/workspace/s2.ts' });
    expect(inputWrap.hidden).toBe(true);
    (document.getElementById('writeConfirmReject') as HTMLButtonElement).click();
    expect(inputWrap.hidden).toBe(true);
    // 最后一条终结 ⇒ 恢复
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_s2' });
    expect(inputWrap.hidden).toBe(false);
  });

  it('B 类信息条不抢输入框：多条状态条同活也不替换 composer', () => {
    // 反向守卫：只有 A 类（阻断）才让位。若 B 类也让位，用户发消息会被无故剥夺入口。
    mountChatView();
    const inputWrap = document.getElementById('inputWrap') as HTMLElement;
    dispatch({ type: 'notice', level: 'error', message: '出错了' });
    dispatch({ type: 'file_changes', files: ['/workspace/a.ts', '/workspace/b.ts'] });
    expect(inputWrap.hidden).toBe(false);
  });

  it('🔴 源码级守卫：凡声明 display 的可见元素，一律须有[hidden] 兜底或被全局规则覆盖', () => {
    // 真机实锤（2026-10-05）：A 类阻断面板激活时确认卡显示在 composer「上方」而非替换之。
    // 根因＝ #inputWrap { display: flex } 覆盖了 HTML hidden 属性的 UA display:none，
    // 而 setComposerReplaced 写的inputWrap.hidden=true **确实为 true** ⇒ 上方那两条
    // 「hidden === true/false」断言全绿，而真机视觉纹丝不动 = 结构性假绿。
    // 为什么测试抓不到：①jsdom 不加载 <style> ②夹具HTML 不含样式表 ③hidden 是属性非计算样式。
    //
    // 本守卫读**生产样式表源码**（chatStyles.ts），对每个声明 display 且
    //「初始 hidden / 会被 JS 切 hidden」的容器类名，要求存在 [hidden] 兜底。
    // 新增此类元素若忘补兜底 ⇒ 此用例变红。
    const src = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf-8') as string;
    // 治本防线：全局兜底规则必须在（它覆盖全部，逐条补 [hidden] 是打补丁不是治本）
    expect(src).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    // 本次真机翻车的那一条：显式兜底 + 注释登记（注释是给未来人的，不参与断言）
    expect(src).toMatch(/#inputWrap\[hidden\]\s*\{\s*display:\s*none/);
  });

  it('审批卡终结通知：write_confirm_closed 收卡，收卡后按钮不再回传（僵尸交互不留）', () => {
    // 缺口背景：宿主超时自动拒绝时，webview 不知道请求已死 ⇒ 卡残留、按钮点了没反应
    // （对照后台任务行「终态无终止按钮」的既有纪律）。终结通知补上这一唯一真源。
    const { postMessage } = mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_close',
      targetPath: '/workspace/a.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: 'a',
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    expect(card.hasAttribute('hidden')).toBe(false);
    // 宿主侧终结（用户裁决 / 超时自动拒绝同源）
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_close' });
    expect(card.hasAttribute('hidden')).toBe(true);
    // 收卡后点确认不得再回传（requestId 已清空）
    (document.getElementById('writeConfirmOk') as HTMLButtonElement).click();
    const answers = postMessage.mock.calls.filter(
      (args) => (args[0] as { type?: string }).type === 'write_confirm_answer',
    );
    expect(answers.length).toBe(0);
  });

  it('审批卡终结通知：requestId 不匹配不关当前卡（旧终结通知不得关掉新卡）', () => {
    mountChatView();
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_new',
      targetPath: '/workspace/b.ts',
      tool: 'run_command',
      description: 'ls',
      permission: 'owner',
      beforeContent: null,
      hasDiff: false,
      timeoutMs: 30 * 60 * 1000,
    });
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_stale' });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    expect(card.hasAttribute('hidden')).toBe(false);
  });

  it('A 类恒主位：确认卡与 error 通知同活时确认卡仍占主位（被收纳 = 不可见 = 超时拒绝）', () => {
    // 方案 §九 A2：确认卡一旦被 StatusDock 收进浮层就不可见，30 分钟后 fail-closed 自动拒绝
    // —— 正是「命令确认不弹 UI」的同款病灶。error 被收纳仍可从图标条点开，代价不对称。
    mountChatView();
    // error 走 fixed 豁免（activity 恒主位的既有语义）
    dispatch({ type: 'notice', level: 'error', message: '出错了' });
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_head',
      targetPath: '/workspace/c.ts',
      tool: 'write_file',
      description: '',
      permission: '',
      beforeContent: null,
      afterContent: 'c',
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    const card = document.getElementById('writeConfirmCard') as HTMLElement;
    const activity = document.getElementById('activityBar') as HTMLElement;
    // 确认卡在主位（可见、不在收纳浮层内）
    expect(card.hasAttribute('hidden')).toBe(false);
    expect(card.closest('.status-dock__panel')).toBeNull();
    // error 条让位被收纳（A 类恒主位优先于 error 豁免）
    expect(activity.closest('.status-dock__panel')).not.toBeNull();
  });

  it('审批卡位置源码守卫：生产 buildHtml 模板中卡为骨架层（缩进 2 空格，非 #messages 内 4 空格）', () => {
    // S9 防线：测试夹具 chatViewTestEnv.ts 的 HTML 是生产 buildHtml 的**手工镜像**，
    // 仅靠 DOM 层守卫会在夹具漂移时失效。此处直接锁生产模板（沿用 iconLanguage /
    // tokensClosure 的 readFileSync 范式），夹具漂了生产也跑不掉。
    const src = readFileSync(join(__dirname, '..', 'panels', 'chatPanel.ts'), 'utf8');
    // 缩进 2 空格 = 面板骨架层（与 #messages / #inputBar 同级）；4 空格 = 嵌在 #messages 内
    expect(/^ {2}<div id="writeConfirmCard"/m.test(src)).toBe(true);
    expect(/^ {4,}<div id="writeConfirmCard"/m.test(src)).toBe(false);
    // 且必须排在 #inputBar 之前（输入区紧上方）
    expect(src.indexOf('<div id="writeConfirmCard"')).toBeLessThan(
      src.indexOf('<div id="inputBar">'),
    );
  });

  it('审批卡按钮基类守卫：生产与夹具两键静态带 write-confirm-card__btn，等待态周期 JS 不增删类', () => {
    // 等待态样式真源 = CSS `.write-confirm-card__btn[disabled]`（chatStyles.ts）。基类必须
    // 静态在骨架上、由原生 disabled 触发——若改回「进等待态时 JS 补类」，漏补的键会
    // disabled=true 却无等待态样式（悬停仍手型、无降透明），且 jsdom 证不了计算样式。
    const prod = readFileSync(join(__dirname, '..', 'panels', 'chatPanel.ts'), 'utf8');
    const fixture = readFileSync(join(__dirname, 'helpers', 'chatViewTestEnv.ts'), 'utf8');
    for (const [label, src] of [
      ['生产', prod],
      ['夹具', fixture],
    ] as const) {
      expect(src, `${label}骨架缺拒绝键基类`).toContain(
        'id="writeConfirmReject" class="write-confirm-card__btn write-confirm-card__btn--reject"',
      );
      expect(src, `${label}骨架缺确认键基类`).toContain(
        'id="writeConfirmOk" class="write-confirm-card__btn write-confirm-card__btn--ok"',
      );
    }
    // DOM 层：等待态进出全程两键基类在场（JS 只翻 disabled，不碰 classList）
    mountChatView();
    const ok = document.getElementById('writeConfirmOk') as HTMLButtonElement;
    const reject = document.getElementById('writeConfirmReject') as HTMLButtonElement;
    dispatch({
      type: 'write_confirm_request',
      requestId: 'wc_basecls',
      targetPath: '/workspace/src/base.ts',
      tool: 'write_file',
      description: '写文件：base.ts',
      permission: '',
      beforeContent: 'a',
      afterContent: 'b',
      hasDiff: true,
      timeoutMs: 30 * 60 * 1000,
    });
    ok.click(); // 进等待态
    expect(ok.disabled).toBe(true);
    expect(ok.classList.contains('write-confirm-card__btn')).toBe(true);
    expect(reject.classList.contains('write-confirm-card__btn')).toBe(true);
    dispatch({ type: 'write_confirm_closed', requestId: 'wc_basecls' }); // 收卡退等待态
    expect(ok.classList.contains('write-confirm-card__btn')).toBe(true);
    expect(reject.classList.contains('write-confirm-card__btn')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 技能启停 · 对话区（用户通道）显式标注
// ═══════════════════════════════════════════════════════════
// 缺陷：`skills_loaded` 的 `disabled` 字段被 `map` 丢弃 ⇒ 用户通道看不出技能已禁用，
// 选中即**静默落空**（技能不注入、界面零提示，对照主流 `off` 态按名调用明确报错）。
// 本区块锁住两处**显示**标记（下拉项 + chip）；**拦截**刻意不落在 webview ——
// 一次配置重载不同步（`pushSkillList` 不随配置变更重推）即会造成「配置已允许、UI 却拒绝」
// 的假拒绝，故拒绝只在 host 侧以 `isSkillDisabled` 真源判定后发 notice。
describe('技能启停：对话区（用户通道）显式标注（SKILL-S2）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** 分发 skills_loaded：一条启用 + 一条禁用（同一清单，差异只在 disabled 标记） */
  function dispatchSkills(): void {
    dispatch({
      type: 'skills_loaded',
      skills: [
        { name: '正常技能', description: 'd', layer: 'builtin' },
        { name: '已禁用技能', description: 'd', layer: 'builtin', disabled: true },
      ],
    });
  }

  it('skills_loaded 带 disabled → 下拉项标 is-disabled + 「已禁用」后缀，且条目保留不隐藏', () => {
    mountChatView();
    dispatchSkills();
    const menu = document.querySelector('.skill-picker .treedd__menu') as HTMLElement;
    const off = menu.querySelector('[data-treedd-id="已禁用技能"]') as HTMLElement;
    const on = menu.querySelector('[data-treedd-id="正常技能"]') as HTMLElement;
    // 标记在：弱化 + 后缀（复用设置页同一词汇，不新增术语）
    expect(off.classList.contains('is-disabled')).toBe(true);
    expect(off.querySelector('.treedd__item-note')?.textContent).toBe('已禁用');
    // 标记不在：启用中的技能不得被误标（反向守卫，防「一刀切标禁用」）
    expect(on.classList.contains('is-disabled')).toBe(false);
    expect(on.querySelector('.treedd__item-note')).toBeNull();
    // 条目保留：静默隐藏会让用户误判「技能消失了」（禁用的是生效性，不是存在性）
    expect(menu.querySelector('[data-treedd-id="已禁用技能"]')).not.toBeNull();
  });

  it('选中已禁用技能 → chip 标 is-disabled + 「已禁用」（不拦截：选择本身仍是合法操作）', () => {
    mountChatView();
    dispatchSkills();
    (document.querySelector('.skill-picker [data-treedd-id="已禁用技能"]') as HTMLElement).click();
    const chip = document.querySelector('#skillChips .skill-chip') as HTMLElement;
    expect(chip.querySelector('.skill-chip__name')?.textContent).toBe('已禁用技能');
    expect(chip.classList.contains('is-disabled')).toBe(true);
    expect(chip.querySelector('.skill-chip__note')?.textContent).toBe('已禁用');
    // 「不拦截」的判据 = chip 仍被创建（技能仍挂在 composer 上，发送时才由 host 判定）。
    // 若改成「禁止选择」（currentSkill 置 null），chip 直接不存在 → 上一行断言即红。
  });

  it('选中启用技能 → chip 无禁用标记（反向守卫，防「一律标记」）', () => {
    mountChatView();
    dispatchSkills();
    (document.querySelector('.skill-picker [data-treedd-id="正常技能"]') as HTMLElement).click();
    const chip = document.querySelector('#skillChips .skill-chip') as HTMLElement;
    expect(chip.classList.contains('is-disabled')).toBe(false);
    expect(chip.querySelector('.skill-chip__note')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 工具批折叠合并（toolBatch · groupToolBatches 三渲染上下文同源）
// ═══════════════════════════════════════════════════════════
// 判据（唯一声明 = chatView.ts `BATCH_SPLITTER_TYPES` + thought 步切换；此处只指路、不重述集合）：
// 打断物 = narrate / text_self_review（自审查**输出**，非正文）/ plan_item_boundary；
// thought 同 step 不断段（换 step 才断）；段 id = 段内首个 tool_start 的 seq。
// 批结构对拍从 DOM 提取（[data-tool-batch] 容器 = 一批；单工具批行即批，容器即行自身）。
describe('工具批折叠合并（toolBatch · groupToolBatches 三渲染上下文同源）', () => {
  /** 开一轮（meta 建骨架 + 首 chunk 开正文）：与既有 describe 的 beginRound 同构（各 describe 自持） */
  function beginRound(): void {
    dispatch({
      type: 'process_event',
      event: {
        type: 'meta',
        seq: 1,
        ts: '',
        payload: { role: '文档设计师', llm: 'deepseek-chat' },
      },
    });
    dispatch({ type: 'chunk', content: '正文' });
  }

  /** 构造 tool_start 过程事件（段内容主体；stepIndex = 所属 step，供步切换断段判据） */
  function toolStart(
    seq: number,
    id: string,
    name: string,
    args = '{}',
    stepIndex?: number,
  ): ProcessEvent {
    return { type: 'tool_start', seq, ts: '', payload: { toolCallId: id, name, args, stepIndex } };
  }

  /**
   * 逐条分发过程事件（流式追加语义：与运行时 process_event 单条推送同序）
   *
   * 参数上下文类型化为 ProcessEvent[]：事件字面量在编译期即校验形状（不用 as 断言）。
   */
  function dispatchEvents(events: ProcessEvent[]): void {
    for (const ev of events) dispatch({ type: 'process_event', event: ev });
  }

  /** 构造 tool_result 过程事件（ok=false 可配 blocked=true 模拟被拒，口径②同样留段内） */
  function toolResult(
    seq: number,
    id: string,
    name: string,
    ok: boolean,
    blocked = false,
  ): ProcessEvent {
    return {
      type: 'tool_result',
      seq,
      ts: '',
      payload: { toolCallId: id, name, ok, blocked, summary: ok ? '成功' : '失败' },
    };
  }

  /**
   * 从 DOM 提取批结构（三上下文一致性对拍的单一提取器）
   *
   * `[data-tool-batch]` 容器 = 一批（多工具批 = 批块，单工具批 = 行即批、容器即行自身）；
   * 返回值按文档序 = 批序，segId 为段 id、toolCallIds 为段内工具行（按序）。
   */
  function batchStructure(root: HTMLElement): { segId: string; toolCallIds: string[] }[] {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-tool-batch]')).map((el) => ({
      segId: el.dataset.toolBatch ?? '',
      toolCallIds: (el.classList.contains('round-block__tool')
        ? [el]
        : Array.from(el.querySelectorAll<HTMLElement>('.round-block__tool'))
      ).map((row) => row.dataset.toolCallId ?? ''),
    }));
  }

  it('切段矩阵 · narrate 打断：叙述两侧的相邻工具序列各成一批', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'read_file'),
      toolResult(5, 't2', 'read_file', true),
      { type: 'narrate', seq: 6, ts: '', payload: { content: '现在搜索一下' } },
      toolStart(7, 't3', 'web_search'),
      toolResult(8, 't3', 'web_search', true),
      toolStart(9, 't4', 'web_search'),
      toolResult(10, 't4', 'web_search', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    // 叙述（打断物）切段：两批各 2 个工具，段 id = 各段首个 tool_start 的 seq
    expect(batchStructure(rb)).toEqual([
      { segId: '2', toolCallIds: ['t1', 't2'] },
      { segId: '7', toolCallIds: ['t3', 't4'] },
    ]);
  });

  it('切段矩阵 · 自审查输出打断：text_self_review 条目两侧的工具序列切段', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'read_file'),
      toolResult(5, 't2', 'read_file', true),
      { type: 'text_self_review', seq: 6, ts: '', payload: { content: '审查分段正文' } },
      toolStart(7, 't3', 'write_file'),
      toolResult(8, 't3', 'write_file', true),
      toolStart(9, 't4', 'write_file'),
      toolResult(10, 't4', 'write_file', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(batchStructure(rb)).toEqual([
      { segId: '2', toolCallIds: ['t1', 't2'] },
      { segId: '7', toolCallIds: ['t3', 't4'] },
    ]);
  });

  it('切段矩阵 · plan_item_boundary 打断：任务项边界两侧的工具序列切段', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'read_file'),
      toolResult(5, 't2', 'read_file', true),
      { type: 'plan_item_boundary', seq: 6, ts: '', payload: { planItemId: 'p1', title: '分析' } },
      toolStart(7, 't3', 'write_file'),
      toolResult(8, 't3', 'write_file', true),
      toolStart(9, 't4', 'write_file'),
      toolResult(10, 't4', 'write_file', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(batchStructure(rb)).toEqual([
      { segId: '2', toolCallIds: ['t1', 't2'] },
      { segId: '7', toolCallIds: ['t3', 't4'] },
    ]);
  });

  it('切段矩阵 · 无 step 归属的 thought 不断段：旧数据（无 stepIndex）回落相邻性', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      { type: 'thought', seq: 4, ts: '', payload: { content: '再看第二个文件' } },
      toolStart(5, 't2', 'read_file'),
      toolResult(6, 't2', 'read_file', true),
      { type: 'thought', seq: 7, ts: '', payload: { content: '再搜索一下' } },
      toolStart(8, 't3', 'web_search'),
      toolResult(9, 't3', 'web_search', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    // 两侧 stepIndex 缺省（旧数据）→ 步切换判据不成立、回落相邻性 → 三工具并为一批（段 id 仍是首个 seq）
    expect(batchStructure(rb)).toEqual([{ segId: '2', toolCallIds: ['t1', 't2', 't3'] }]);
  });

  it('切段矩阵 · 步切换断段：不同 step 的思考两侧工具序列各成一批（真机修复项）', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      { type: 'thought', seq: 2, ts: '', payload: { content: '第1步：先看目录', stepIndex: 1 } },
      toolStart(3, 't1', 'read_file', '{}', 1),
      toolResult(4, 't1', 'read_file', true),
      toolStart(5, 't2', 'read_file', '{}', 1),
      toolResult(6, 't2', 'read_file', true),
      { type: 'thought', seq: 7, ts: '', payload: { content: '第2步：换个方向', stepIndex: 2 } },
      toolStart(8, 't3', 'web_search', '{}', 2),
      toolResult(9, 't3', 'web_search', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    // 新 step 的思考 = 可见分隔物 → 两批各归其 step（修复「不同步工具糊成一块」）
    expect(batchStructure(rb)).toEqual([
      { segId: '3', toolCallIds: ['t1', 't2'] },
      { segId: '8', toolCallIds: ['t3'] },
    ]);
  });

  it('切段矩阵 · 同 step 思考不断段：stepIndex 相同的思考碎片夹在工具之间仍并为一批', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file', '{}', 1),
      toolResult(3, 't1', 'read_file', true),
      { type: 'thought', seq: 4, ts: '', payload: { content: '同一步内的思考碎片', stepIndex: 1 } },
      toolStart(5, 't2', 'read_file', '{}', 1),
      toolResult(6, 't2', 'read_file', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    // 同 step 思考（stepIndex 相同）= step 内伴随物 → 不断段，仍并为一批
    expect(batchStructure(rb)).toEqual([{ segId: '2', toolCallIds: ['t1', 't2'] }]);
  });

  it('切段矩阵 · 无思考分隔的跨 step 工具合并：模型不产 reasoning 时维持相邻合并', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file', '{}', 1),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'read_file', '{}', 2),
      toolResult(5, 't2', 'read_file', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    // 无可见分隔物（无思考/narrate）→ 不切段，跨 step 工具仍并为一批（用户裁定：无分隔可合并）
    expect(batchStructure(rb)).toEqual([{ segId: '2', toolCallIds: ['t1', 't2'] }]);
  });

  it('跨任务项边界切段：两批各归自己的任务项分组容器（不越界混批）', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      {
        type: 'plan_item_boundary',
        seq: 2,
        ts: '',
        payload: { planItemId: 'p1', title: '分析需求' },
      },
      toolStart(3, 't1', 'read_file'),
      toolResult(4, 't1', 'read_file', true),
      toolStart(5, 't2', 'read_file'),
      toolResult(6, 't2', 'read_file', true),
      {
        type: 'plan_item_boundary',
        seq: 7,
        ts: '',
        payload: { planItemId: 'p2', title: '编写代码' },
      },
      toolStart(8, 't3', 'write_file'),
      toolResult(9, 't3', 'write_file', true),
      toolStart(10, 't4', 'write_file'),
      toolResult(11, 't4', 'write_file', true),
    ]);
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    // 跨任务项边界 = 跨段（plan_item_boundary 是打断物）：两批段 id 各自为界
    expect(batchStructure(rb)).toEqual([
      { segId: '3', toolCallIds: ['t1', 't2'] },
      { segId: '8', toolCallIds: ['t3', 't4'] },
    ]);
    // 归组落位：批块分别位于自己的任务项分组容器内，不越界混入对方
    const groups = rb.querySelectorAll('.round-block__plan-item');
    expect(groups).toHaveLength(2);
    expect(
      groups[0]!.querySelector('.round-block__tool-batch')?.getAttribute('data-tool-batch'),
    ).toBe('3');
    expect(
      groups[1]!.querySelector('.round-block__tool-batch')?.getAttribute('data-tool-batch'),
    ).toBe('8');
  });

  it('三上下文一致：同一事件流在流式追加与 finalize 全量重建下产出相同批结构（防内联分组三份的守卫）', () => {
    mountChatView();
    beginRound();
    // 同一事件流（含 thought 穿插 + narrate 打断 + 单/多工具批混排）
    const events: ProcessEvent[] = [
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      { type: 'thought', seq: 4, ts: '', payload: { content: '继续' } },
      toolStart(5, 't2', 'read_file'),
      toolResult(6, 't2', 'read_file', true),
      { type: 'narrate', seq: 7, ts: '', payload: { content: '换个方向' } },
      toolStart(8, 't3', 'web_search'),
      toolResult(9, 't3', 'web_search', true),
      toolStart(10, 't4', 'write_file'),
      toolResult(11, 't4', 'write_file', true),
    ];
    dispatchEvents(events);
    // ① 运行时流式追加：process-flow 平铺容器内观测批结构
    const flow = document.querySelector('.process-flow') as HTMLElement;
    const streamed = batchStructure(flow);
    expect(streamed).toEqual([
      { segId: '2', toolCallIds: ['t1', 't2'] },
      { segId: '8', toolCallIds: ['t3', 't4'] },
    ]);
    // ② finalize 全量重建：round-block 内观测批结构——与流式一致（同一 groupToolBatches 投影）
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(batchStructure(rb)).toEqual(streamed);
  });

  it('批标题 = 工具叙述句（toolActionType 单点口径）+ 不带序号（第二类编号，STEP-ID-1）', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'read_file'),
      toolResult(5, 't2', 'read_file', true),
      toolStart(6, 't3', 'web_search'),
      toolResult(7, 't3', 'web_search', true),
    ]);
    dispatch({ type: 'done' });
    const block = document.querySelector('.round-block__tool-batch') as HTMLElement;
    const summary = block.querySelector('.round-block__tool-batch-summary') as HTMLElement;
    // 分型计数走 toolActionType（与轮收尾摘要同源），不再按工具名另起一份计数口径
    expect(block.querySelector('.round-block__tool-batch-title')?.textContent).toBe(
      '工具×3（读取文件 2 · 网络搜索 1）',
    );
    // 工具类折叠块不带序号：批号与 step 号互不对齐，属另一套编号（STEP-ID-1 防复发精神）
    expect(summary.textContent).not.toMatch(/第\s*\d+\s*[批步]/);
  });

  it('同源守卫：批标题与轮收尾摘要的工具叙述句逐字一致（防两套口径漂移）', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'read_file'),
      toolResult(5, 't2', 'read_file', true),
      toolStart(6, 't3', 'web_search'),
      toolResult(7, 't3', 'web_search', true),
      toolStart(8, 't4', 'write_file'),
      toolResult(9, 't4', 'write_file', true),
    ]);
    dispatch({ type: 'done' });
    const blockTitle = (document.querySelector('.round-block__tool-batch-title') as HTMLElement)
      .textContent;
    const roundSummary = (document.querySelector('.round-block__stats') as HTMLElement).textContent;
    // 唯一的形成点：两份工具叙述同一口径；一旦批改用工具名计数，此断言立即红
    expect(blockTitle).toBe('工具×4（读取文件 2 · 网络搜索 1 · 写入文件 1）');
    expect(roundSummary).toBe(blockTitle);
  });

  it('失败/被拒工具留段内：块级标红提示（含失败/拦截），不单独成块（口径②）', () => {
    mountChatView();
    beginRound();
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      toolStart(4, 't2', 'write_file'),
      toolResult(5, 't2', 'write_file', false),
      toolStart(6, 't3', 'web_search'),
      toolResult(7, 't3', 'web_search', false, true),
    ]);
    dispatch({ type: 'done' });
    // 三工具仍为一批（失败/被拒不拆块），块级标红提示错误密度
    const blocks = document.querySelectorAll('.round-block__tool-batch');
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as HTMLElement;
    expect(block.dataset.toolBatch).toBe('2');
    expect(block.classList.contains('is-tool-batch-failed')).toBe(true);
    const warn = block.querySelector('.round-block__tool-batch-warn') as HTMLElement;
    expect(warn.textContent).toContain('含失败 1');
    expect(warn.textContent).toContain('含拦截 1');
    // 失败/被拒行留段内（各自原位可见），无游离行逃出批块
    const rows = block.querySelectorAll('.round-block__tool');
    expect(rows).toHaveLength(3);
    expect(
      (document.querySelector('.round-block__details') as HTMLElement).querySelectorAll(
        ':scope > .round-block__tool',
      ),
    ).toHaveLength(0);
  });

  it('pending 行升级后并入所在批（批容器 key = 段 id），旧 toolCallId 批 key 零残留消费（口径③）', () => {
    mountChatView();
    beginRound();
    // 参数生成段：两条工具意图预告（瞬态行，暂居流尾、无批归属）
    dispatch({ type: 'tool_pending', toolCallId: 'call_a', name: 'read_file' });
    dispatch({ type: 'tool_pending', toolCallId: 'call_b', name: 'read_file' });
    // tool_start 到达 → 预告行升级执行态并并入所在批（两工具相邻 = 同批）
    dispatch({
      type: 'process_event',
      event: toolStart(2, 'call_a', 'read_file', '{"path":"a.md"}'),
    });
    dispatch({
      type: 'process_event',
      event: toolStart(3, 'call_b', 'read_file', '{"path":"b.md"}'),
    });
    const block = document.querySelector('.round-block__tool-batch') as HTMLElement;
    expect(block).not.toBeNull();
    // 批容器 DOM key = 段 id（段内首个 tool_start 的 seq），非 toolCallId
    expect(block.dataset.toolBatch).toBe('2');
    expect(document.querySelector('[data-tool-batch="call_a"]')).toBeNull();
    // 升级后的两行并入所在批（批块内、无游离），且均已脱离「准备中」态
    const rows = Array.from(block.querySelectorAll<HTMLElement>('.round-block__tool'));
    expect(rows.map((r) => r.dataset.toolCallId)).toEqual(['call_a', 'call_b']);
    rows.forEach((r) => expect(r.classList.contains('is-tool-pending')).toBe(false));
    expect(document.querySelectorAll('.round-block__tool')).toHaveLength(2);
    // 旧 key 无残留消费：全部批 key 均为段 id（数字），无 toolCallId 值、无一键双主
    const keys = Array.from(document.querySelectorAll<HTMLElement>('[data-tool-batch]')).map(
      (el) => el.dataset.toolBatch,
    );
    expect(keys).toEqual(['2']);
  });

  it('单工具批视觉等价现状（零回归）：无批块包裹、行即批（data-tool-batch = 段 id 挂行）', () => {
    mountChatView();
    beginRound();
    // 两条单工具批（叙述打断）——旧数据（无批概念）即此形态：回落逐条渲染
    dispatchEvents([
      toolStart(2, 't1', 'read_file'),
      toolResult(3, 't1', 'read_file', true),
      { type: 'narrate', seq: 4, ts: '', payload: { content: '再写一个文件' } },
      toolStart(5, 't2', 'write_file'),
      toolResult(6, 't2', 'write_file', true),
    ]);
    dispatch({ type: 'done' });
    // 无批块包裹（现状形态：平铺工具行直接子级，逐条渲染）
    expect(document.querySelectorAll('.round-block__tool-batch')).toHaveLength(0);
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const rows = Array.from(details.querySelectorAll<HTMLElement>(':scope > .round-block__tool'));
    expect(rows.map((r) => r.dataset.toolCallId)).toEqual(['t1', 't2']);
    // 行即批：批 key（段 id）挂行自身——单批也可按段 id 寻址（口径③键位统一）
    expect(rows.map((r) => r.dataset.toolBatch)).toEqual(['2', '5']);
  });
});

// ═══════════════════════════════════════════════════════════
// 任务项完成态（plan_snapshot 快照 → 状态图标，UI-BLOCK-ICON 批次一）
// ═══════════════════════════════════════════════════════════
// 数据真源 = 内核 plan_snapshot（turn 收尾清空 plan 前产出，方案-过程块视觉辨识-20261001.md §四）。
// 写入点单一 = applyPlanItemStates；消费点恰两个（plan_update 实时 / renderRoundBlock 重放）。
// 存量历史轮无快照 = 组无状态图标（诚实降级，不伪造绿勾）。变异锁：删 chatPanel
// plan_snapshot 桥接 / 删 renderRoundBlock 快照消费 → 重放用例转红。
describe('任务项完成态（plan_snapshot 快照 → 状态图标）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 构造含任务项边界 + 叙述行 + 可选快照的过程事件序列（ts 递增保证归组判定成立） */
  function planEvents(
    withSnapshot: boolean,
    finalStatus: 'pending' | 'active' | 'done' | 'blocked' = 'done',
  ): ProcessEvent[] {
    return [
      { type: 'meta', seq: 0, ts: 'T0', payload: { role: 'AI', llm: 'm' } },
      {
        type: 'plan_item_boundary',
        seq: 1,
        ts: 'T1',
        payload: { planItemId: 'p1', title: '第一步' },
      },
      { type: 'narrate', seq: 2, ts: 'T2', payload: { content: '干活中' } },
      ...(withSnapshot
        ? [
            {
              type: 'plan_snapshot' as const,
              seq: 3,
              ts: 'T3',
              payload: { items: [{ planItemId: 'p1', status: finalStatus }] },
            },
          ]
        : []),
      {
        type: 'metrics',
        seq: 4,
        ts: 'T4',
        payload: { durationMs: 100, tokenIn: 1, tokenOut: 1, toolFailureCount: 0, success: true },
      },
    ];
  }

  it('重放：有 plan_snapshot 快照轮 → 任务项组点亮完成图标（is-plan-done + circle-check）', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-snap',
        processEvents: planEvents(true, 'done'),
        assistantMessage: { content: '完成回答' },
        status: 'complete',
      }),
    );
    const grp = document.querySelector(
      '.round-block__plan-item[data-plan-item="p1"]',
    ) as HTMLElement;
    expect(grp).not.toBeNull();
    expect(grp.classList.contains('is-plan-done')).toBe(true);
    const icon = grp.querySelector('.round-block__plan-item-status') as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.dataset.statusIcon).toBe('circle-check');
  });

  it('重放：active 状态 → 靶心图标（is-plan-active），与完成勾形态互斥', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-active',
        processEvents: planEvents(true, 'active'),
        assistantMessage: { content: '完成回答' },
        status: 'complete',
      }),
    );
    const grp = document.querySelector(
      '.round-block__plan-item[data-plan-item="p1"]',
    ) as HTMLElement;
    expect(grp.classList.contains('is-plan-active')).toBe(true);
    expect(grp.classList.contains('is-plan-done')).toBe(false);
    const icon = grp.querySelector('.round-block__plan-item-status') as HTMLElement;
    expect(icon.dataset.statusIcon).toBe('target');
  });

  it('重放：存量轮无快照 → 最后 boundary 项亮 active 靶心（不再全程裸奔；中断轮定格现场）', () => {
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-legacy',
        processEvents: planEvents(false),
        assistantMessage: { content: '完成回答' },
        status: 'complete',
      }),
    );
    const grp = document.querySelector(
      '.round-block__plan-item[data-plan-item="p1"]',
    ) as HTMLElement;
    // 组照常渲染（分组结构不受影响）。口径升级（真机反馈 2026-10-01）：
    // boundary = 内核结构化「开始执行」宣告，最后宣告且未见完成宣告的项亮「进行中」
    // 是数据支持的诚实表达（中断轮定格现场），非伪造状态；不伪造的是 done 绿勾。
    expect(grp).not.toBeNull();
    expect(grp.classList.contains('is-plan-done')).toBe(false);
    expect(grp.classList.contains('is-plan-active')).toBe(true);
    const icon = grp.querySelector('.round-block__plan-item-status') as HTMLElement;
    expect(icon.dataset.statusIcon).toBe('target');
  });

  it('重放：多条快照取最后一条（挂起→续跑推进后以收尾终态为准）', () => {
    mountChatView();
    const events = [
      ...planEvents(false),
      // 两条快照：挂起时中途态（active）+ 收尾终态（done）——重放必须以终态为准
      {
        type: 'plan_snapshot' as const,
        seq: 3,
        ts: 'T3',
        payload: { items: [{ planItemId: 'p1', status: 'active' }] },
      },
      {
        type: 'plan_snapshot' as const,
        seq: 5,
        ts: 'T5',
        payload: { items: [{ planItemId: 'p1', status: 'done' }] },
      },
    ];
    dispatchReplay(
      makeRound({
        id: 'r-multi',
        processEvents: events,
        assistantMessage: { content: '完成回答' },
        status: 'complete',
      }),
    );
    const grp = document.querySelector(
      '.round-block__plan-item[data-plan-item="p1"]',
    ) as HTMLElement;
    expect(grp.classList.contains('is-plan-done')).toBe(true);
    expect(
      grp.querySelector('.round-block__plan-item-status')?.getAttribute('data-status-icon'),
    ).toBe('circle-check');
  });

  it('实时：plan_update 到达 → 过程区任务项组同步状态图标（done/active 切换幂等）', () => {
    mountChatView();
    // 运行时链路：meta 建骨架 → boundary 声明分组 → narrate 触发懒建组 → plan_update 同步状态
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: 'T0', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'process_event',
      event: {
        type: 'plan_item_boundary',
        seq: 2,
        ts: 'T1',
        payload: { planItemId: 'p1', title: '第一步' },
      },
    });
    dispatch({
      type: 'process_event',
      event: { type: 'narrate', seq: 3, ts: 'T2', payload: { content: '干活中' } },
    });
    const grpOf = () =>
      document.querySelector('.round-block__plan-item[data-plan-item="p1"]') as HTMLElement;
    expect(grpOf()).not.toBeNull();

    // done → 绿勾
    dispatch({
      type: 'plan_update',
      items: [{ id: 'p1', description: '第一步', status: 'done', order: 0, planItemLog: [] }],
    });
    expect(grpOf().classList.contains('is-plan-done')).toBe(true);
    expect(
      grpOf().querySelector('.round-block__plan-item-status')?.getAttribute('data-status-icon'),
    ).toBe('circle-check');

    // 状态回变 active（LLM 复改）→ 图标切换为靶心（不残留双图标，写入点幂等替换）
    dispatch({
      type: 'plan_update',
      items: [{ id: 'p1', description: '第一步', status: 'active', order: 0, planItemLog: [] }],
    });
    expect(grpOf().classList.contains('is-plan-done')).toBe(false);
    expect(grpOf().classList.contains('is-plan-active')).toBe(true);
    expect(grpOf().querySelectorAll('.round-block__plan-item-status')).toHaveLength(1);
    expect(
      grpOf().querySelector('.round-block__plan-item-status')?.getAttribute('data-status-icon'),
    ).toBe('target');
  });
});

// ═══════════════════════════════════════════════════════════
// 光标八态状态机（data-status，UI-BLOCK-ICON 批次二）
// ═══════════════════════════════════════════════════════════
// 状态真源 = setCursorStatus 单一写入点（data-status 值即中文文案，CSS 按值分档渲染）；
// 运行态唯一合成点 = syncRunningCursor（优先级 = 工具在途 > 思考相位 > 默认回答）。
// 变异锁：删 chunk 尾覆盖 / 删 done 落「已完成」/ 删 error detail 透传 → 对应用例转红。
describe('光标八态状态机（data-status）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 正文块定位（运行时流式转正后即该形态，与既有断言同源） */
  function bodyOf(): HTMLElement {
    const body = document.querySelector<HTMLElement>('.msg.assistant .msg-body');
    expect(body).not.toBeNull();
    return body as HTMLElement;
  }

  /** 分发一条运行时过程事件 */
  function dispatchEv(event: Record<string, unknown>): void {
    dispatch({ type: 'process_event', event });
  }

  it('运行三态迁移：chunk（正在回答中）→ 工具在途（运行工具中）→ 结果回收（回正在回答中）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '开始回答' });
    expect(bodyOf().dataset.status).toBe('正在回答中');
    // 工具开始：相位行转 --tool 形态 → 合成点判「运行工具中」
    dispatchEv({
      type: 'tool_start',
      seq: 2,
      ts: 'T1',
      payload: { toolCallId: 't1', name: 'read_file', args: '{"p":"a"}', stepIndex: 1 },
    });
    expect(bodyOf().dataset.status).toBe('运行工具中');
    // 工具结果：is-tool-running 摘除、相位行回落 → 回默认回答态
    dispatchEv({
      type: 'tool_result',
      seq: 3,
      ts: 'T2',
      payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'done' },
    });
    expect(bodyOf().dataset.status).toBe('正在回答中');
  });

  it('思考相位：thinking 建相位行 → 「思考中」；后续 chunk 覆盖回「正在回答中」', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '先说结论' });
    // thinking 相位行随事件常驻（events 累积，renderProcessFlow 重渲染不丢）
    dispatchEv({ type: 'thinking', seq: 2, ts: 'T1', payload: { phase: 'llm_calling' } });
    expect(bodyOf().dataset.status).toBe('思考中');
    // 正文流式 = 最强「正在回答」信号：chunk 尾覆盖思考相位态（相位行不消失也不误标）
    dispatch({ type: 'chunk', content: '，展开说' });
    expect(bodyOf().dataset.status).toBe('正在回答中');
  });

  it('优先级：思考相位下工具在途 → 「运行工具中」压过「思考中」（工具在途 > 思考相位）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '开工' });
    dispatchEv({ type: 'thinking', seq: 2, ts: 'T1', payload: { phase: 'processing' } });
    expect(bodyOf().dataset.status).toBe('思考中');
    // 工具开始（无结果）：同一相位行转 --tool 形态，合成点按优先级判「运行工具中」
    dispatchEv({
      type: 'tool_start',
      seq: 3,
      ts: 'T2',
      payload: { toolCallId: 't2', name: 'write_file', args: '{}', stepIndex: 1 },
    });
    expect(bodyOf().dataset.status).toBe('运行工具中');
    // 结果回收：相位行回落普通形态 → 仍处思考相位（下一步推理前不误标回答态）
    dispatchEv({
      type: 'tool_result',
      seq: 4,
      ts: 'T3',
      payload: { toolCallId: 't2', name: 'write_file', ok: true, summary: 'ok' },
    });
    expect(bodyOf().dataset.status).toBe('思考中');
  });

  it('挂起态不撒谎：ask 提问挂起 → 「等待输入」（非运行三态）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '回答一半' });
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: {
        phase: 'waiting',
        reason: 'ask',
        questions: [{ slot: 'task', question: '确认执行？', options: ['是', '否'] }],
      },
    });
    expect(bodyOf().dataset.status).toBe('等待输入');
  });

  it('error 终态：异常中断 + detail 透传（JS 截断 80 字符）；随后 done 收尾覆盖为「已完成」', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '流式中' });
    dispatch({ type: 'error', message: 'HTTP 500: internal error' });
    const body = bodyOf();
    expect(body.dataset.status).toBe('异常中断');
    // detail 落独立属性（CSS 取 attr(data-status-detail) 红字展示），不污染状态值本身
    expect(body.dataset.statusDetail).toBe('HTTP 500: internal error');
    // done 兜底收尾：finalize 清态后落「已完成」（诚实收尾，不留异常态定格撒谎）
    dispatch({ type: 'done' });
    expect(body.dataset.status).toBe('已完成');
    expect(body.dataset.statusDetail).toBeUndefined();
  });

  it('重放 live 轮接手运行态（无工具/相位 → 默认「正在回答中」）；重放 interrupted 轮无正文块、无状态撒谎', () => {
    // live 轮：切界面重建重放时的本流进行中轮——重放正文后由 syncRunningCursor 接手推导
    mountChatView();
    dispatchReplay({
      ...makeRound({
        id: 'r-live',
        user: { content: '问题' },
        assistantMessage: { content: '半截回答' },
        status: 'pending',
      }),
      live: true,
    });
    const liveBody = document.querySelector<HTMLElement>('.msg.assistant .msg-body');
    expect(liveBody?.dataset.status).toBe('正在回答中');

    // interrupted 轮：正文块整体不派生（诚实降级）——不得伪造任何 data-status
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-stop',
        user: { content: '问题' },
        processEvents: [
          {
            type: 'error',
            seq: 1,
            ts: '',
            payload: { message: 'socket hang up', category: 'connection' },
          },
        ],
        status: 'interrupted',
      }),
    );
    // 中断轮：容器（is-interrupted-host）保留，但正文块不派生——无载体即无状态，不得伪造
    expect(document.querySelector('.msg.assistant .msg-body')).toBeNull();
    expect(document.querySelector('[data-status]')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 块类型标与折叠箭头（UI-BLOCK-ICON 批次三）
// ═══════════════════════════════════════════════════════════
// 类型标收敛 2 个：thought（思考块 summary 前置）/ tool（工具行 + 工具批共用）；
// 叙述块明确不加（防泛滥定案：裸文本即类别信号）。icon = 独立稳定 span（getIconSvg 注入），
// 文本节点刷新不触碰——变异锁：改 icon 随文本重写 / 漏注入某构建点 → 对应用例转红。
// 折叠箭头统一为 CSS 层（chevron ::after 行内随文），DOM 断言不覆盖，真机对照验收。
describe('块类型标与折叠箭头（批次三）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 分发一条运行时过程事件 */
  function dispatchEv(event: Record<string, unknown>): void {
    dispatch({ type: 'process_event', event });
  }

  it('思考块 summary 前置 thought 类型标（finalize 重建与运行时增量两路同构）', () => {
    // 路一：finalize/重放重建（createAggregatedThought）
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-thought',
        user: { content: '问题' },
        processEvents: [
          { type: 'meta', seq: 0, ts: 'T0', payload: { role: 'AI', llm: 'm' } },
          { type: 'thought', seq: 1, ts: 'T1', payload: { content: '先分析结构', stepIndex: 1 } },
          { type: 'thought', seq: 2, ts: 'T2', payload: { content: '再定方案', stepIndex: 1 } },
        ],
        assistantMessage: { content: '完成回答' },
        status: 'complete',
      }),
    );
    const iconOf = (root: Element) => root.querySelector('.round-block__type-icon svg');
    const thought = document.querySelector('.round-block__thought');
    expect(thought).not.toBeNull();
    expect(iconOf(thought!)).not.toBeNull();
    // 文本走独立 span：icon 存在且 summary 文本完整（拼接逻辑迁移不丢内容）
    expect(thought!.querySelector('summary')?.textContent).toContain('思考 · 第 1 步');

    // 路二：运行时增量（renderProcessFlow 懒建折叠块）
    mountChatView();
    dispatch({ type: 'chunk', content: '正文' });
    dispatchEv({
      type: 'thought',
      seq: 2,
      ts: 'T1',
      payload: { content: '增量思考', stepIndex: 1 },
    });
    const flowThought = document.querySelector('.process-flow__thought');
    expect(flowThought).not.toBeNull();
    expect(iconOf(flowThought!)).not.toBeNull();
    expect(flowThought!.querySelector('summary')?.textContent).toContain('思考 · 第 1 步');
  });

  it('工具行 summary 前置 tool 类型标；tool_result 状态重写后 icon 不丢', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '开工' });
    dispatchEv({
      type: 'tool_start',
      seq: 2,
      ts: 'T1',
      payload: { toolCallId: 't1', name: 'read_file', args: '{"p":"a"}', stepIndex: 1 },
    });
    const row = () => document.querySelector('.round-block__tool[data-tool-call-id="t1"]')!;
    expect(row().querySelector('.round-block__type-icon svg')).not.toBeNull();
    // 结果回收：updateToolRowState 重写状态 span 文本——icon（独立节点）必须仍在
    dispatchEv({
      type: 'tool_result',
      seq: 3,
      ts: 'T2',
      payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'done' },
    });
    expect(row().querySelector('.round-block__type-icon svg')).not.toBeNull();
    expect(row().querySelector('.round-block__tool-status')?.textContent).toBe(' (成功)');
  });

  it('工具批 summary 前置 tool 类型标（行批共用）；finalize 重刷后 icon 不丢', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '连做两件事' });
    dispatchEv({
      type: 'tool_start',
      seq: 2,
      ts: 'T1',
      payload: { toolCallId: 't1', name: 'read_file', args: '{}', stepIndex: 1 },
    });
    dispatchEv({
      type: 'tool_start',
      seq: 3,
      ts: 'T2',
      payload: { toolCallId: 't2', name: 'write_file', args: '{}', stepIndex: 1 },
    });
    dispatchEv({
      type: 'tool_result',
      seq: 4,
      ts: 'T3',
      payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'a' },
    });
    dispatchEv({
      type: 'tool_result',
      seq: 5,
      ts: 'T4',
      payload: { toolCallId: 't2', name: 'write_file', ok: false, summary: 'b' },
    });
    // 运行时批块（多工具 = 批容器）已带类型标
    const batch = () => document.querySelector('.round-block__tool-batch')!;
    expect(batch()).not.toBeNull();
    expect(
      batch().querySelector('.round-block__tool-batch-summary .round-block__type-icon svg'),
    ).not.toBeNull();
    // done 收尾全量重建（refreshToolBatchSummary 重刷路径）→ icon 仍在
    dispatch({ type: 'done' });
    expect(
      batch().querySelector('.round-block__tool-batch-summary .round-block__type-icon svg'),
    ).not.toBeNull();
  });

  it('叙述块不加类型标（防泛滥定案：裸文本即类别信号；运行时与重建两路同锁）', () => {
    // 路一：运行时增量（process-flow__narrate 平铺行）
    mountChatView();
    dispatch({ type: 'chunk', content: '正文' });
    dispatchEv({ type: 'narrate', seq: 2, ts: 'T1', payload: { content: '开始读取文件' } });
    const flowNarrate = document.querySelector('.process-flow__narrate');
    expect(flowNarrate).not.toBeNull();
    expect(flowNarrate!.querySelector('.round-block__type-icon')).toBeNull();

    // 路二：finalize/重放重建（round-block__narrate 折叠行）
    mountChatView();
    dispatchReplay(
      makeRound({
        id: 'r-narrate',
        user: { content: '问题' },
        processEvents: [
          { type: 'meta', seq: 0, ts: 'T0', payload: { role: 'AI', llm: 'm' } },
          { type: 'narrate', seq: 1, ts: 'T1', payload: { content: '开始读取文件' } },
        ],
        assistantMessage: { content: '完成回答' },
        status: 'complete',
      }),
    );
    const narrate = document.querySelector('.round-block__narrate');
    expect(narrate).not.toBeNull();
    expect(narrate!.querySelector('.round-block__type-icon')).toBeNull();
  });
});

describe('INPUT-LIMIT-1 输入长度上限（输入框阶段原生截断，2026-10-02）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('主输入框与 clarify 兜底输入框挂上限（长档 / 短档，值真源 shared/constants）', () => {
    mountChatView();
    expect((document.getElementById('input') as HTMLTextAreaElement).maxLength).toBe(
      MAX_INPUT_CHARS,
    );
    expect((document.getElementById('clarifyInput') as HTMLInputElement).maxLength).toBe(
      MAX_ASK_ANSWER_CHARS,
    );
  });

  it('ask-inline 每题输入框挂短档上限（创建时设 maxLength）', () => {
    mountChatView();
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatchTurn({
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question: '请描述当前任务目标' }],
    });
    const askInput = document.querySelector<HTMLInputElement>('.ask-inline__input');
    expect(askInput).not.toBeNull();
    expect(askInput!.maxLength).toBe(MAX_ASK_ANSWER_CHARS);
  });

  it('运行中插话满员：Enter 拒发——不 post、文本保留在输入框（审查补漏：宿主拒收不丢用户内容）', () => {
    const { postMessage } = mountChatView();
    // 队列投影满员（宿主即将拒收第 6 条的镜像场景）
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'running' },
      pendingQueue: Array.from({ length: MAX_PENDING_INTERJECTIONS }, (_, i) => `插话${i}`),
    });
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '第 6 条插话';
    // 运行中插话走 Enter（发送按钮 loading 态 click = 停止，不经 sendMessage）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // 不发送 + 不清框：拒收发生在文本离开输入框之前，警告不再伴随内容丢失
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input', kind: 'send' }),
    );
    expect(input.value).toBe('第 6 条插话');
  });

  it('运行中插话未满员：Enter 正常发送并清框（防误伤边界）', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'running' },
      pendingQueue: Array.from({ length: MAX_PENDING_INTERJECTIONS - 1 }, (_, i) => `插话${i}`),
    });
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '第 5 条插话';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'input', kind: 'send', text: '第 5 条插话' }),
    );
    expect(input.value).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
//骨架 id 三方一致性（UI-CONFIRM-P6 轻量版）
// ═══════════════════════════════════════════════════════════
// 缺陷：测试夹具 chatViewTestEnv.ts 的 HTML 是生产 buildHtml 的**手工镜像**（双源）。
// 夹具漏一个 id 时，若消费侧写的是 `getElementById(x) as T | null` + `if (x)` 守卫
// （polishBtn / currentCapabilityBadge 即此形态），则**测试全绿而该链路恒不执行** ——
// 与E4 同构的静默失测：断言没红，行为根本没被测。
// 本守卫以「消费面 = chatView.ts 全部字面量 getElementById」为轴，一次锁三方：
//①消费 ⊆ 生产骨架 ②消费 ⊆ 夹具骨架 ③夹具 ⊆ 生产（夹具不得凭空多出 id）。
// 代价O(1)、零新模块；不足是纯静态（不校验嵌套结构），嵌套/类名另由各用例守。
describe('骨架 id 三方一致性（UI-CONFIRM-P6 轻量版）', () => {
  /** 抽出一份源码里全部 `id="xxx"` 字面量（仅字母数字，与 getElementById 的 id 风格一致） */
  function idsOf(src: string): Set<string> {
    return new Set(
      Array.from(src.matchAll(/\bid="([A-Za-z][A-Za-z0-9]*)"/g), (m) => m[1] as string),
    );
  }

  /** 抽出 chatView.ts 全部 `getElementById('xxx')` 字面量 —— 消费面的唯一可静态判据 */
  function consumedIds(src: string): Set<string> {
    return new Set(
      Array.from(
        src.matchAll(/getElementById\('([A-Za-z][A-Za-z0-9]*)'\)/g),
        (m) => m[1] as string,
      ),
    );
  }

  /** 集合差：a 中有而 b 中无的项（排序后便于断言失败时直读） */
  function diff(a: Set<string>, b: Set<string>): string[] {
    return Array.from(a)
      .filter((x) => !b.has(x))
      .sort();
  }

  const consumed = consumedIds(
    readFileSync(join(__dirname, '..', 'scripts', 'chatView.ts'), 'utf8'),
  );
  const prod = idsOf(readFileSync(join(__dirname, '..', 'panels', 'chatPanel.ts'), 'utf8'));
  const fixture = idsOf(
    readFileSync(join(__dirname, '..', '__tests__', 'helpers', 'chatViewTestEnv.ts'), 'utf8'),
  );

  it('消费面（chatView getElementById）非空，且逐项落在生产骨架上', () => {
    // 前置：轴心本身不能为空，否则守卫空跑＝假绿
    expect(consumed.size).toBeGreaterThan(20);
    expect(diff(consumed, prod)).toEqual([]);
  });

  it('消费面逐项落在测试夹具骨架上（夹具漏 id ⇒ 该链路静默失测）', () => {
    expect(diff(consumed, fixture)).toEqual([]);
  });

  it('夹具不得凭空多出生产没有的 id（防止两处各写各的、互不校准）', () => {
    expect(diff(fixture, prod)).toEqual([]);
  });
});
