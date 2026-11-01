/**
 * 会话导航写点守卫 —— `SESSION-RESUME-1` 的机器判据（不是行为测试的替代）
 *
 * 背景：`SESSION-RESUME-1` 的伤是「切了会话只改内存字段、没落『上次停留』指针」——
 * 切过去看历史、重启却跳回别处，且**症状静默**（无报错、无红测试）。修法是把两件事
 * 收口到 `setCurrentSessionId()` 一处成对写。
 *
 * 为什么光有 spy 测试不够：`spyOn(sessionStore, 'setLastActiveSession')` 只保护**被测的那条
 * 路径**。新增第 N 条导航路径时，只要它自己直接 `this._currentSessionId = ...` 而不落盘，
 * 既有的 spy 用例照绿（它压根没走那条新路径），bug 重新落地而无人报警。
 *
 * 判据（源码扫描，三条同时成立）：
 *   ① `chatPanel.ts` 中 `this._currentSessionId = <右值>;` 恰好 **2 处**；
 *   ② 一处右值为 `sessionId`，且位于 `setCurrentSessionId()` 内、紧跟 `setLastActiveSession(sessionId)`；
 *   ③ 另一处右值为 `this.sessionStore.getInitialSessionId()`（构造期**只读**指针灌入，不改状态）。
 * 任何第三处赋值 ⇒ 红（新增导航路径必须回到收口方法）。
 *
 * 反向守卫：先断言赋值总数 > 0 —— 防提取正则失效后空集恒过（与 `narrowWidthGuard` 同纪律）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 本文件位于 src/webview/__tests__/ ⇒ 面板源码在 ../panels/ 下 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 被守卫的宿主文件（会话导航的唯一所在） */
const CHAT_PANEL_PATH = join(HERE, '..', 'panels', 'chatPanel.ts');

/** 匹配「this._currentSessionId = <右值>;」，捕获右值用于区分「成对写」与「只读灌入」 */
const ASSIGN_RE = /this\._currentSessionId\s*=\s*(.+?);/g;

/** 收口方法名（两件事必须在此成对） */
const SETTER_NAME = 'private setCurrentSessionId(';

/** 落盘调用（收口方法内必须紧跟出现） */
const PERSIST_CALL = 'this.sessionStore.setLastActiveSession(sessionId);';

/** 构造期灌入的**唯一**合法右值（只读导航指针，不改状态） */
const INIT_VALUE = 'this.sessionStore.getInitialSessionId()';

/**
 * 提取源码中全部「当前会话赋值」的右值。
 *
 * @param source chatPanel.ts 全文
 * @returns 右值清单（按出现顺序）
 */
function collectAssignValues(source: string): string[] {
  const values: string[] = [];
  for (const m of source.matchAll(ASSIGN_RE)) values.push((m[1] as string).trim());
  return values;
}

/**
 * 截取收口方法体：从方法签名到**第一个同级缩进 `}`**（该方法体内无嵌套块，按缩进闭合足够）。
 *
 * @param source chatPanel.ts 全文
 * @returns 方法体文本；方法不存在时返回空串（由用例把「不存在」判红）
 */
function extractSetterBody(source: string): string {
  const start = source.indexOf(SETTER_NAME);
  if (start < 0) return '';
  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) return '';
  const end = source.indexOf('\n  }', bodyStart);
  return end < 0 ? '' : source.slice(bodyStart, end);
}

describe('SESSION-RESUME-1 · 会话导航写点守卫', () => {
  const source = readFileSync(CHAT_PANEL_PATH, 'utf8');
  const assignValues = collectAssignValues(source);

  it('反向守卫：确实扫到了赋值（防正则失效导致空集恒过）', () => {
    expect(assignValues.length).toBeGreaterThan(0);
  });

  it('赋值点恰好 2 处（收口写 + 构造期灌入）', () => {
    expect(assignValues.length).toBe(2);
  });

  it('收口方法存在，且内部成对写「内存字段 + 上次停留指针」', () => {
    const body = extractSetterBody(source);
    expect(body).not.toBe('');
    expect(body).toContain('this._currentSessionId = sessionId;');
    expect(body).toContain(PERSIST_CALL);
  });

  it('另一处赋值只能是构造期 getInitialSessionId（只读灌入）', () => {
    // 排除收口方法内的那处，剩下的必须全部是初始化灌入
    const nonSetter = assignValues.filter((v) => v !== 'sessionId');
    expect(nonSetter).toEqual([INIT_VALUE]);
  });
});
