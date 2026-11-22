/**
 * processEventText 纯函数单测（纯逻辑自 chatView.ts 迁出后的覆盖）
 *
 * 行为级主路径已由 `__tests__/chatView.test.ts`（DOM 驱动）覆盖；本文件锁**纯函数边界**：
 * 非法输入回退、时长格式化阈值、后台命令标记、run_code 双模式、other 分型不成句等。
 * toDateKey 为内核 formatDateKey 的必要镜像（webview 沙箱无运行时依赖），口径漂移在此报警。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  argStr,
  dispatchedSidTextsFromEvents,
  dispatchedSidsFromEvents,
  fmtDuration,
  isAcceptedDispatchResult,
  parseToolArgs,
  toDateKey,
  toolActionLabel,
  toolActionType,
  toolSummaryText,
} from '../processEventText.js';
import type { ProcessEvent } from '@zooique/memora';

describe('toDateKey（内核 formatDateKey 镜像）', () => {
  it('本地时区格式化 YYYY-MM-DD（非 UTC 切日）', () => {
    // 固定本地时间构造：本地 2026-01-02 00:30，UTC 可能仍是 01-01 —— 断言按本地字段
    const d = new Date(2026, 0, 2, 0, 30, 0);
    expect(toDateKey(d)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`,
    );
  });
});

describe('parseToolArgs / argStr', () => {
  it('非 JSON / 数组 / 标量 → 空对象（叙述按缺参回退显示名）', () => {
    expect(parseToolArgs('not-json{')).toEqual({});
    expect(parseToolArgs('[1,2]')).toEqual({});
    expect(parseToolArgs('"str"')).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
  });
  it('合法 JSON 对象透传；argStr 拒绝非字符串与空串', () => {
    expect(parseToolArgs('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
    expect(argStr({ path: 'a.ts' }, 'path')).toBe('a.ts');
    expect(argStr({ path: '' }, 'path')).toBeUndefined();
    expect(argStr({ path: 3 }, 'path')).toBeUndefined();
  });
});

describe('toolActionLabel（兜底链：映射 → 展示名）', () => {
  it('run_code 双模式：script_path 优先，code 次之，均缺走显示名', () => {
    // 无译文包 ⇒ l10n.t 返回英文源键（键面 = 英文源文案，见 verify-nls 判据⑨）
    expect(toolActionLabel('run_code', '{"script_path":"t.mjs"}')).toBe('Run script: t.mjs');
    expect(toolActionLabel('run_code', '{"code":"1+1"}')).toBe('Run code snippet');
    expect(toolActionLabel('run_code', '{}')).toBe('Run code');
  });
  it('run_command 后台标记：background=true/1 加「(background)」', () => {
    expect(toolActionLabel('run_command', '{"command":"npm test","background":true}')).toBe(
      'Run command (background): npm test',
    );
    expect(toolActionLabel('run_command', '{"command":"npm test","background":1}')).toBe(
      'Run command (background): npm test',
    );
    expect(toolActionLabel('run_command', '{"command":"npm test"}')).toBe('Run command: npm test');
  });
  it('未收录工具 / 缺参 → 展示名（英文源键），不裸露工具原名', () => {
    expect(toolActionLabel('ask_user', '{}')).toBe('Ask user');
    expect(toolActionLabel('read_file', '{}')).toBe('Read file');
  });
  it('read_image 显示图片路径；delegate_task 显示子任务描述；缺参均回退展示名', () => {
    expect(toolActionLabel('read_image', '{"path":"assets/logo.png"}')).toBe(
      'Read image: assets/logo.png',
    );
    expect(toolActionLabel('read_image', '{}')).toBe('Read image');
    expect(toolActionLabel('delegate_task', '{"task":"调查登录链路"}')).toBe(
      'Delegate task: 调查登录链路',
    );
    expect(toolActionLabel('delegate_task', '{}')).toBe('Delegate task');
  });
});

describe('toolActionType / toolSummaryText', () => {
  it('未收录工具归 other；other 不参与成句只计入总数', () => {
    expect(toolActionType('mystery_tool')).toBe('other');
    expect(toolSummaryText(['mystery_tool', 'mystery_tool2'])).toBe('Tools ×2');
  });
  it('read_image 归读取类、delegate_task 归执行类（不再落 other 被摘要跳过）', () => {
    expect(toolActionType('read_image')).toBe('read');
    expect(toolActionType('delegate_task')).toBe('run');
    expect(toolSummaryText(['read_image', 'delegate_task'])).toBe(
      'Tools ×2 (Read image 1 · Delegate task 1)',
    );
  });
  it('空数组返回空串（调用方据此省略整段）', () => {
    expect(toolSummaryText([])).toBe('');
  });
  it('已知工具按显示名聚合计次，段序 = 首次出场序', () => {
    const s = toolSummaryText(['web_search', 'read_file', 'web_search']);
    expect(s).toBe('Tools ×3 (Web search 2 · Read file 1)');
  });
});

describe('fmtDuration', () => {
  it('阈值边界：59.9s 与 60s 分属两种形态', () => {
    expect(fmtDuration(59_900)).toBe('59.9s');
    expect(fmtDuration(60_000)).toBe('1m 0s');
  });
});

describe('dispatchedSidsFromEvents（DISPATCH-CARD-INLINE-1 触发轮解析）', () => {
  const ev = (e: unknown): ProcessEvent => e as ProcessEvent;

  it('create_session 成功 → 结果 summary 里的 sid 入集合', () => {
    const sids = dispatchedSidsFromEvents([
      ev({
        type: 'tool_result',
        seq: 1,
        ts: '2026-11-19T09:00:01.000Z',
        payload: {
          toolCallId: 'c1',
          name: 'create_session',
          ok: true,
          summary: '{"ok":true,"sid":"worker-a","title":"统计目录文件数"}',
        },
      }),
    ]);
    expect([...sids]).toEqual(['worker-a']);
  });

  it('send_to_session 成功 → 入参 sid 入集合（回执无 sid）', () => {
    const sids = dispatchedSidsFromEvents([
      ev({
        type: 'tool_start',
        seq: 0,
        ts: '2026-11-19T09:00:00.000Z',
        payload: {
          toolCallId: 'c2',
          name: 'send_to_session',
          args: JSON.stringify({ sid: 'worker-b', text: '继续' }),
        },
      }),
      ev({
        type: 'tool_result',
        seq: 1,
        ts: '2026-11-19T09:00:01.000Z',
        payload: {
          toolCallId: 'c2',
          name: 'send_to_session',
          ok: true,
          summary: '{\n  "ok": true,\n  "accepted": true\n}',
        },
      }),
    ]);
    expect([...sids]).toEqual(['worker-b']);
  });

  it('失败（ok:false）不盖章；无 sid 不编造', () => {
    const sids = dispatchedSidsFromEvents([
      ev({
        type: 'tool_result',
        seq: 1,
        ts: '2026-11-19T09:00:01.000Z',
        payload: {
          toolCallId: 'c3',
          name: 'create_session',
          ok: false,
          summary: '{"ok":false,"sid":"nope"}',
        },
      }),
      ev({
        type: 'tool_start',
        seq: 0,
        ts: '2026-11-19T09:00:00.000Z',
        payload: { toolCallId: 'c4', name: 'send_to_session', args: '{"text":"无sid"}' },
      }),
    ]);
    expect(sids.size).toBe(0);
  });

  it('空事件 / 无关事件 → 空集合', () => {
    expect(dispatchedSidsFromEvents([]).size).toBe(0);
    expect(
      dispatchedSidsFromEvents([
        ev({
          type: 'tool_start',
          seq: 0,
          ts: '2026-11-19T09:00:00.000Z',
          payload: { toolCallId: 'c5', name: 'read_file', args: '{}' },
        }),
      ]).size,
    ).toBe(0);
  });
});

describe('isAcceptedDispatchResult（业务受理单点判据 DISPATCH-RECEIPT-1）', () => {
  it('内核 ok=false 一律不受理（执行层失败）', () => {
    expect(
      isAcceptedDispatchResult({ name: 'send_to_session', ok: false, summary: '{"ok":true}' }),
    ).toBe(false);
  });

  it('内核 ok=true 但业务 ok=false ⇒ 不受理（E_BUSY 真实形态）', () => {
    expect(
      isAcceptedDispatchResult({
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": false,\n  "code": "E_BUSY",\n  "message": "目标会话在跑"\n}',
      }),
    ).toBe(false);
  });

  it('内核 ok=true 且摘要首键 ok=true ⇒ 受理（send / create 两类）', () => {
    expect(
      isAcceptedDispatchResult({
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "accepted": true\n}',
      }),
    ).toBe(true);
    expect(
      isAcceptedDispatchResult({
        name: 'create_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "sid": "worker-a",\n  "title": "统计"\n}',
      }),
    ).toBe(true);
  });

  it('fail-closed：摘要缺失 / 读不到显式 true ⇒ 不算受理（旧数据不编卡）', () => {
    expect(isAcceptedDispatchResult({ name: 'send_to_session', ok: true })).toBe(false);
    expect(isAcceptedDispatchResult({ name: 'create_session', ok: true, summary: '{}' })).toBe(
      false,
    );
  });

  it('作用域只到派发工具：非派发工具一律 false（不是通用成功判据）', () => {
    expect(isAcceptedDispatchResult({ name: 'read_file', ok: true, summary: '{}' })).toBe(false);
    expect(isAcceptedDispatchResult({ name: 'read_file', ok: false })).toBe(false);
  });

  it('工作台清单与卡片锚点共用同一判据（源码守卫：禁止第二份裸 payload.ok）', () => {
    const src = readFileSync(new URL('../workbenchHistory.ts', import.meta.url), 'utf8');
    expect(src).toContain('isAcceptedDispatchResult');
    expect(src).not.toMatch(/event\.payload\.ok/);
  });
});

describe('dispatchedSidTextsFromEvents（跨会话定位锚 DISPATCH-CARD-LOCATE-1）', () => {
  const ev = (e: unknown): ProcessEvent => e as ProcessEvent;

  it('send_to_session 成功 → (sid, text) 都从 args 取，按 toolCallId 配回执', () => {
    expect(
      dispatchedSidTextsFromEvents([
        ev({
          type: 'tool_start',
          seq: 0,
          ts: '2026-11-19T09:00:00.000Z',
          payload: {
            toolCallId: 'c1',
            name: 'send_to_session',
            args: '{"sid":"2026-11-19-target","text":"请把加法算完"}',
          },
        }),
        ev({
          type: 'tool_result',
          seq: 1,
          ts: '2026-11-19T09:00:01.000Z',
          payload: {
            toolCallId: 'c1',
            name: 'send_to_session',
            ok: true,
            summary: '{\n  "ok": true,\n  "accepted": true\n}',
          },
        }),
      ]),
    ).toEqual([{ sid: '2026-11-19-target', text: '请把加法算完', via: 'delegate' }]);
  });

  it('create_session 成功 → text 从 args、sid 从 summary；缺 text 时 text 为空串', () => {
    expect(
      dispatchedSidTextsFromEvents([
        ev({
          type: 'tool_start',
          seq: 0,
          ts: '2026-11-19T09:00:00.000Z',
          payload: {
            toolCallId: 'c2',
            name: 'create_session',
            args: '{"text":"新建后做减法"}',
          },
        }),
        ev({
          type: 'tool_result',
          seq: 1,
          ts: '2026-11-19T09:00:01.000Z',
          payload: {
            toolCallId: 'c2',
            name: 'create_session',
            ok: true,
            summary: '{\n  "ok": true,\n  "sid": "2026-11-19-created",\n  "title": "减法"\n}',
          },
        }),
      ]),
    ).toEqual([{ sid: '2026-11-19-created', text: '新建后做减法', via: 'create' }]);
    // 缺 text：仍出卡（sid 有效），但定位锚为空串，点击退化看最新轮
    const noText = dispatchedSidTextsFromEvents([
      ev({
        type: 'tool_start',
        seq: 0,
        ts: '2026-11-19T09:00:00.000Z',
        payload: { toolCallId: 'c3', name: 'create_session', args: '{}' },
      }),
      ev({
        type: 'tool_result',
        seq: 1,
        ts: '2026-11-19T09:00:01.000Z',
        payload: {
          toolCallId: 'c3',
          name: 'create_session',
          ok: true,
          summary: '{\n  "ok": true,\n  "sid": "2026-11-19-x"\n}',
        },
      }),
    ]);
    expect(noText).toEqual([{ sid: '2026-11-19-x', text: '', via: 'create' }]);
  });

  it('受理失败 / 无 sid → 不产生锚；dispatchedSidsFromEvents 与之一致（单一真源）', () => {
    const events = [
      ev({
        type: 'tool_start',
        seq: 0,
        ts: '2026-11-19T09:00:00.000Z',
        payload: {
          toolCallId: 'c4',
          name: 'send_to_session',
          args: '{"sid":"2026-11-19-fail","text":"失败的任务"}',
        },
      }),
      ev({
        type: 'tool_result',
        seq: 1,
        ts: '2026-11-19T09:00:01.000Z',
        payload: { toolCallId: 'c4', name: 'send_to_session', ok: false },
      }),
    ];
    expect(dispatchedSidTextsFromEvents(events)).toEqual([]);
    expect([...dispatchedSidsFromEvents(events)]).toEqual([]);
  });
});
