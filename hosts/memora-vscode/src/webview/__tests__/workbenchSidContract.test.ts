/**
 * create_session 结果格式互锁测试（WORKBENCH-SID-1）
 *
 * 为什么要有这条：工作台重启后从 `tool_result.summary`（内核截到 100 字符）里解析 sid，
 * 而这段文本是**给人看的摘要**，不是接口。摘要改一个字，解析就断；最坏的断法是静默变成
 * 空清单——界面看起来像「一条活都没有」，实际是「读不到」。
 *
 * 本测试把「产生点」与「解析点」钉在一起：
 *   - 产生点 = `serializeCreateSessionResult`（`extension/host/workSessionTools.ts`）；
 *   - 解析点 = `parseCreateSessionSid`（`webview/helpers/workbenchHistory.ts`）。
 * 任何一边改了缩进 / 键序 / 字段名 / 把 sid 挤出一百字符窗口，这里先红。
 *
 * 注：本项目选择互锁而不是结构化通道，原因是内核持久化的 `tool_result` 只有通用
 * `summary` 与 delegate 专用回执，没有自定义工具的通用结构化载荷；新增字段等于新增
 * 持久化字段，超出本切片边界。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent, Round } from '@zooique/memora';
import { serializeCreateSessionResult } from '../../extension/host/workSessionTools.js';
import { parseCreateSessionSid, rebuildWorkbenchChildren } from '../helpers/workbenchHistory.js';

/** 固定的会话标识（真实形态：日期前缀 + session 名） */
const SID = '2026-11-14-session-weekly-report';
/** 固定的标题（只用于断言文本形态，不参与 sid 解析） */
const TITLE = '整理周报';
/** 内核 `tool_result.summary` 的截断长度（唯一真源在 `src/agent/loop.ts`，此处是消费侧常量） */
const SUMMARY_LIMIT = 100;

describe('create_session 结果格式互锁', () => {
  it('成功结果的文本形态固定：前缀与键序就是解析的输入契约', () => {
    const text = serializeCreateSessionResult({ ok: true, sid: SID, title: TITLE });
    // 前缀精确匹配：改缩进、改键序、改字段名都会红（而不是让解析静默失败）
    expect(text.startsWith('{\n  "ok": true,\n  "sid": "')).toBe(true);
    expect(text).toBe(`{\n  "ok": true,\n  "sid": "${SID}",\n  "title": "${TITLE}"\n}`);
  });

  it('内核截到 100 字符后，真实 sid 仍能被解析出来', () => {
    const summary = serializeCreateSessionResult({ ok: true, sid: SID, title: TITLE }).slice(
      0,
      SUMMARY_LIMIT,
    );
    // sid 必须完整落在截断窗口内（落在窗口外 = 解析断 = 清单静默变空）
    expect(summary).toContain(SID);
    expect(parseCreateSessionSid(summary)).toBe(SID);
  });

  it('摘要被截到 sid 中间时解析为 undefined（调用方会计入「读不到」）', () => {
    const text = serializeCreateSessionResult({ ok: true, sid: SID, title: TITLE });
    // 只留到 sid 的一半：模拟「sid 被挤出窗口」的退化情形
    const cut = text.indexOf(SID) + Math.floor(SID.length / 2);
    expect(parseCreateSessionSid(text.slice(0, cut))).toBeUndefined();
  });

  it('失败结果不含 sid 键，不会被误认成一次创建', () => {
    const text = serializeCreateSessionResult({
      ok: false,
      code: 'E_ROLE_PACK',
      message: '角色包不可用',
    });
    expect(parseCreateSessionSid(text)).toBeUndefined();
  });
});

describe('send_to_session 派发记录的配对面', () => {
  /** 派发事件时间（断言时间取自事件，不取轮创建时间） */
  const DISPATCH_TS = '2026-11-14T09:30:00.000Z';

  it('目标 sid 只能来自 tool_start.args（成功回执里没有 sid）', () => {
    // 真实成功回执 = 派发层结果直接序列化后过内核 100 字截断：只有 ok / accepted
    const receipt = JSON.stringify({ ok: true, accepted: true }, null, 2).slice(0, SUMMARY_LIMIT);
    expect(receipt.toLowerCase()).not.toContain('sid');

    /** 一次真实形状的派发调用对（入参完整，结果只有 ok / accepted） */
    const events = [
      {
        type: 'tool_start',
        seq: 1,
        ts: DISPATCH_TS,
        payload: {
          toolCallId: 'send-1',
          name: 'send_to_session',
          args: JSON.stringify({ sid: SID, text: '把周报整理成三段' }),
        },
      },
      {
        type: 'tool_result',
        seq: 2,
        ts: DISPATCH_TS,
        payload: { toolCallId: 'send-1', name: 'send_to_session', ok: true, summary: receipt },
      },
    ] as unknown as ProcessEvent[];
    const rebuilt = rebuildWorkbenchChildren('session-agent', {
      readRoundIds: () => ['r1'],
      // 本用例只钉摘要格式：不涉及反查面
      listSessionIds: () => [],
      readRoundDispatch: () => undefined,
      readRound: () =>
        ({
          id: 'r1',
          status: 'complete',
          createdAt: '2026-11-14T09:29:00.000Z',
          processEvents: events,
        }) as Round,
    });
    // 改工具名 / 改入参键名 / 改配对方式，这里先红（而不是让「派过什么」静默消失）
    expect(rebuilt.dispatches).toEqual([
      { sessionId: SID, excerpt: '把周报整理成三段', at: DISPATCH_TS },
    ]);
  });
});
