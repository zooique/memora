/**
 * 上下文占用契约跨包对账守卫（N2）
 *
 * 治理背景：占用快照 shape 在**三处手写**——内核 `ContextOccupancy`（src/agent/budget.ts，
 * 唯一真理源）、宿主 `protocol.ts` 的 `context_occupancy.occupancy`（IPC 契约）、webview
 * 渲染（chatView）。此前无任何守卫保证前后两者的字段集双向相等（对比：确认入口有
 * `confirmEntry.test.ts` 做键集双向守卫，这里长期缺对等物）——内核加/删分段字段，宿主
 * 不报错、静默漏渲染（同族伤先例：toolFailurePrefixGuard.PRODUCER_FILES 漏配即失明）。
 *
 * 守卫语义（沿本仓源码对账范式，读取真理源源码而非复制品，防守卫自身漂移）：
 *   内核接口字段集 与 宿主协议 occupancy 字段集 双向求差，任一方向非空即失败。
 *
 * 失效防护（防「因错误的原因通过」）：两集均须非空且含已知字段 `freeTokens`——若切片/正则
 * 失配导致双空，差集也会空而假绿；这两条断言把该失效形态钉死（同 protocolGuard V-3 口径）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 内核占用真理源（__dirname → shared → src → memora-vscode → hosts → 项目根 → src/agent） */
const KERNEL_BUDGET_PATH = join(__dirname, '../../../../../src/agent/budget.ts');
/** 宿主协议契约（__dirname → shared） */
const PROTOCOL_PATH = join(__dirname, '../protocol.ts');

/** 剥块注释 + 行注释（注释里的字段名说明不得计入） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * 从 `anchor` 处起始的 `{` 起做大括号配对，返回配对块内部文本。
 * 结构漂移（找不到锚点 / 括号不配对）→ **抛错**而非静默返回空串（空集是本守卫最危险的失效形态）。
 */
function extractBraceBlock(source: string, anchor: string, braceToken: string): string {
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx < 0) throw new Error(`无法定位锚点：${anchor}`);
  const tokenIdx = source.indexOf(braceToken, anchorIdx);
  if (tokenIdx < 0) throw new Error(`锚点后未找到 ${braceToken}：${anchor}`);
  // 开括号 = 令牌内的 '{'（braceToken 可含前缀，如 'occupancy: {'；直接 indexOf 命中的是首字符）
  const braceIdx = tokenIdx + braceToken.indexOf('{');
  let depth = 0;
  for (let i = braceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceIdx + 1, i);
    }
  }
  throw new Error(`大括号未配对：${anchor}`);
}

/** 内核 `export interface ContextOccupancy { … }` 字段集（`readonly name:` 形式） */
function extractKernelOccupancyFields(source: string): Set<string> {
  const block = stripComments(extractBraceBlock(source, 'export interface ContextOccupancy', '{'));
  const fields = new Set<string>();
  const re = /readonly\s+(\w+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) fields.add(m[1]);
  return fields;
}

/** 宿主 `context_occupancy` 联合成员的 `occupancy: { … }` 字段集 */
function extractHostOccupancyFields(source: string): Set<string> {
  const block = stripComments(
    extractBraceBlock(source, "type: 'context_occupancy'", 'occupancy: {'),
  );
  const fields = new Set<string>();
  const re = /(\w+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) fields.add(m[1]);
  return fields;
}

/** 差集：a 有 b 无 */
function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((k) => !b.has(k));
}

describe('上下文占用契约跨包对账守卫（N2）', () => {
  it('测量工具自证：大括号配对切片有效（锚点缺失或括号不配对须抛错，不得静默空集）', () => {
    expect(() => extractBraceBlock('no anchor here', 'missing', '{')).toThrow();
    expect(extractBraceBlock('a { x: 1; } b', 'a', '{').trim()).toBe('x: 1;');
  });

  it('内核 ContextOccupancy 字段集 与 宿主 protocol occupancy 字段集 双向相等', () => {
    const kernelFields = extractKernelOccupancyFields(readFileSync(KERNEL_BUDGET_PATH, 'utf-8'));
    const hostFields = extractHostOccupancyFields(readFileSync(PROTOCOL_PATH, 'utf-8'));

    // 前置事实（防「因错误的原因通过」）：两集均须非空且含已知字段——
    // 若切片/正则失配导致双空，差集也会空而假绿。
    expect(kernelFields.size, '内核占用字段解析为空（切片/正则失配）').toBeGreaterThan(0);
    expect(hostFields.size, '宿主占用字段解析为空（切片/正则失配）').toBeGreaterThan(0);
    expect(kernelFields.has('freeTokens')).toBe(true);
    expect(hostFields.has('freeTokens')).toBe(true);

    const kernelOnly = diff(kernelFields, hostFields);
    const hostOnly = diff(hostFields, kernelFields);

    expect(
      kernelOnly,
      `内核 ContextOccupancy 新增/改名了宿主 protocol 未跟进的字段：[${kernelOnly.join(', ')}]。` +
        `宿主将静默漏渲染（无编译错误）。须同步 shared/protocol.ts 的 occupancy shape。`,
    ).toEqual([]);
    expect(
      hostOnly,
      `宿主 protocol occupancy 含内核 ContextOccupancy 已无的字段：[${hostOnly.join(', ')}]。` +
        `是已删字段的残留，须同步清理。`,
    ).toEqual([]);
  });
});
