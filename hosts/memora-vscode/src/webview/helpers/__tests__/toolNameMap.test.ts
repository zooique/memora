/**
 * getToolDisplayName 纯函数单测（纯逻辑抽为可测模块后的覆盖）
 *
 * 键集合对齐约束见 toolNameMap.ts 文件头：本测试顺带守卫「未知工具回退」语义，
 * 已知键逐一断言中文标签，防幽灵键死灰复燃。另含键集合与内核清单双向闭合守卫。
 * 图标不在本模块职责内——emoji 断言已随 getToolIcon 剪除。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getToolDisplayName } from '../toolNameMap.js';

describe('getToolDisplayName', () => {
  it('映射已知工具为中文标签', () => {
    // 内置工具清单代表性抽查（read/write/记忆/追溯/会议/压缩），映射缺失会回退英文 → 此断言即漂移哨兵
    expect(getToolDisplayName('read_file')).toBe('读取文件');
    expect(getToolDisplayName('write_file')).toBe('写入文件');
    expect(getToolDisplayName('web_search')).toBe('网络搜索');
    expect(getToolDisplayName('search_memories')).toBe('搜索记忆');
    expect(getToolDisplayName('trace_summary')).toBe('追溯摘要');
    expect(getToolDisplayName('run_team_meeting')).toBe('团队会议');
    expect(getToolDisplayName('compress_context')).toBe('压缩上下文');
    expect(getToolDisplayName('ask_user')).toBe('询问用户');
    expect(getToolDisplayName('list_sessions')).toBe('列出会话');
    expect(getToolDisplayName('read_skill')).toBe('读取技能');
  });

  it('未知工具回退原值', () => {
    expect(getToolDisplayName('some_new_tool')).toBe('some_new_tool');
  });

  it('幽灵键不再返回旧映射（防死灰复燃）', () => {
    // 内核零存在的工具名应回退原值而非「看起来存在」的中文标签
    expect(getToolDisplayName('memory_search')).toBe('memory_search');
    expect(getToolDisplayName('create_skill')).toBe('create_skill');
    expect(getToolDisplayName('create_rule')).toBe('create_rule');
  });
});

/**
 * 键集合对齐守卫
 *
 * 两个失败模式都是**静默**的：①内核新增工具而映射表未补键 → 该工具在 UI 回退英文名（无报错）；
 * ②内核删工具而映射表留键 → 幽灵键（表腐化）。本条将判据机械化。读内核源码 + 文本提取沿用 shared/__tests__/protocolGuard.test.ts 先例
 * （webview 沙箱不可 import 内核，且内核 index.ts 未导出完整工具清单，故只能文本级取源）。
 */
describe('键集合与内核内置工具清单对齐', () => {
  // __dirname = hosts/memora-vscode/src/webview/helpers/__tests__ → 6 次上跳抵仓库根
  const KERNEL_TOOLS_PATH = join(__dirname, '../../../../../../src/agent/builtinTools.ts');
  const SELF_PATH = join(__dirname, '../toolNameMap.ts');

  /**
   * 提取内核**完整内置工具定义**的工具名。
   *
   * 判据同源：内核 SSOT = `ToolExecutor.builtinDefinitions`（toolExecutor.ts）=
   * `[...BUILTIN_TOOLS, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, RUN_CODE_TOOL, SEARCH_PROJECT_TOOL]`。
   * ⚠️ 注意 `BUILTIN_TOOLS`（builtinTools.ts 数组）只是**常驻**那批（22），另有 4 个能力门控
   * 工具（web_search/web_fetch/run_code/search_project）定义在数组外、按宿主注入的 provider
   * 条件暴露——两者合计 26 才是完整面。因此本函数取「全部 `XXX_TOOL` 常量定义 + 数组内联定义」，
   * 而非仅数组段。
   */
  function kernelToolNames(): Set<string> {
    const src = readFileSync(KERNEL_TOOLS_PATH, 'utf8');
    const names = new Set<string>();
    // ①-a 独立的工具常量定义·字面量形态（export const XXX_TOOL: ToolDefinition = { name: '...' }）
    for (const m of src.matchAll(
      /export const [A-Z][A-Z0-9_]*_TOOL: ToolDefinition = \{[\s\S]*?\bname: '([a-z_]+)'/g,
    )) {
      names.add(m[1]!);
    }
    // ①-b 独立的工具常量定义·工厂形态（2026-10-03 buildRunCodeTool 引入，命令执行能力方案 §10.4-①(b)）：
    // export const XXX_TOOL: ToolDefinition = buildYYY(...) —— name 在工厂函数体内的
    // return { name: '...' }，从对应函数体提取（提取失效立即红，不静默通过）
    for (const m of src.matchAll(
      /export const [A-Z][A-Z0-9_]*_TOOL: ToolDefinition = (build[A-Za-z0-9_]*)\(/g,
    )) {
      const fnStart = src.indexOf(`function ${m[1]}(`);
      expect(fnStart, `未找到工厂函数 ${m[1]}——内核结构已变更，守卫需同步`).toBeGreaterThan(-1);
      const nameMatch = src.slice(fnStart).match(/\bname: '([a-z_]+)'/);
      expect(nameMatch, `工厂函数 ${m[1]} 内未提取到 name——守卫正则需同步`).toBeTruthy();
      names.add(nameMatch![1]!);
    }
    // ② BUILTIN_TOOLS 数组内联定义（未抽为常量的那批）
    const start = src.indexOf('export const BUILTIN_TOOLS');
    const end = start < 0 ? -1 : src.indexOf('\n];', start);
    // 非空反向守卫：提取失效（内核结构变更）立即红，不静默通过（防「空集假绿」）
    expect(start, '未找到 BUILTIN_TOOLS 定义——内核结构已变更，守卫需同步').toBeGreaterThan(-1);
    expect(end, '未找到 BUILTIN_TOOLS 数组结尾').toBeGreaterThan(-1);
    for (const m of src.slice(start, end).matchAll(/\bname:\s*'([a-z_]+)'/g)) names.add(m[1]!);
    expect(names.size, '内核工具名提取为空——正则已失效').toBeGreaterThan(0);
    return names;
  }

  /** 提取映射表自身声明的键集合（源文本级：TOOL_LABELS 为模块内常量，未导出） */
  function mapKeys(): Set<string> {
    const src = readFileSync(SELF_PATH, 'utf8');
    const start = src.indexOf('const TOOL_LABELS');
    const end = start < 0 ? -1 : src.indexOf('\n};', start);
    expect(start, '未找到 TOOL_LABELS 定义——本守卫需同步').toBeGreaterThan(-1);
    expect(end, '未找到 TOOL_LABELS 结尾').toBeGreaterThan(-1);
    const keys = new Set<string>();
    for (const m of src.slice(start, end).matchAll(/^ {2}([a-z_]+):\s*'/gm)) keys.add(m[1]!);
    expect(keys.size, '映射表键提取为空——正则已失效').toBeGreaterThan(0);
    return keys;
  }

  it('内核每个内置工具都有中文名（新增工具未补键 → 红，防 UI 静默回退英文名）', () => {
    const missing = [...kernelToolNames()].filter((n) => getToolDisplayName(n) === n);
    expect(missing, `以下内核工具缺中文名（UI 将回退英文名）：${missing.join(', ')}`).toEqual([]);
  });

  it('映射无幽灵键（内核零存在的键 → 红，防映射表腐化）', () => {
    const kernel = kernelToolNames();
    const ghosts = [...mapKeys()].filter((k) => !kernel.has(k));
    expect(ghosts, `以下映射键在内核零存在（幽灵键）：${ghosts.join(', ')}`).toEqual([]);
  });
});
