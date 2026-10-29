/**
 * processEventText 纯函数单测（纯逻辑自 chatView.ts 迁出后的覆盖）
 *
 * 行为级主路径已由 `__tests__/chatView.test.ts`（DOM 驱动）覆盖；本文件锁**纯函数边界**：
 * 非法输入回退、时长格式化阈值、后台命令标记、run_code 双模式、other 分型不成句等。
 * toDateKey 为内核 formatDateKey 的必要镜像（webview 沙箱无运行时依赖），口径漂移在此报警。
 */
import { describe, it, expect } from 'vitest';
import {
  argStr,
  fmtDuration,
  parseToolArgs,
  toDateKey,
  toolActionLabel,
  toolActionType,
  toolSummaryText,
} from '../processEventText.js';

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

describe('toolActionLabel（兜底链：映射 → 中文显示名）', () => {
  it('run_code 双模式：script_path 优先，code 次之，均缺走显示名', () => {
    expect(toolActionLabel('run_code', '{"script_path":"t.mjs"}')).toBe('运行脚本：t.mjs');
    expect(toolActionLabel('run_code', '{"code":"1+1"}')).toBe('运行代码片段');
    expect(toolActionLabel('run_code', '{}')).toBe('运行代码');
  });
  it('run_command 后台标记：background=true/1 加「（后台）」', () => {
    expect(toolActionLabel('run_command', '{"command":"npm test","background":true}')).toBe(
      '执行命令（后台）：npm test',
    );
    expect(toolActionLabel('run_command', '{"command":"npm test","background":1}')).toBe(
      '执行命令（后台）：npm test',
    );
    expect(toolActionLabel('run_command', '{"command":"npm test"}')).toBe('执行命令：npm test');
  });
  it('未收录工具 / 缺参 → 中文显示名，不裸露英文', () => {
    expect(toolActionLabel('ask_user', '{}')).toBe('询问用户');
    expect(toolActionLabel('read_file', '{}')).toBe('读取文件');
  });
});

describe('toolActionType / toolSummaryText', () => {
  it('未收录工具归 other；other 不参与成句只计入总数', () => {
    expect(toolActionType('mystery_tool')).toBe('other');
    expect(toolSummaryText(['mystery_tool', 'mystery_tool2'])).toBe('工具×2');
  });
  it('空数组返回空串（调用方据此省略整段）', () => {
    expect(toolSummaryText([])).toBe('');
  });
  it('已知工具按显示名聚合计次，段序 = 首次出场序', () => {
    const s = toolSummaryText(['web_search', 'read_file', 'web_search']);
    expect(s).toBe('工具×3（网络搜索 2 · 读取文件 1）');
  });
});

describe('fmtDuration', () => {
  it('阈值边界：59.9s 与 60s 分属两种形态', () => {
    expect(fmtDuration(59_900)).toBe('59.9s');
    expect(fmtDuration(60_000)).toBe('1m 0s');
  });
});
