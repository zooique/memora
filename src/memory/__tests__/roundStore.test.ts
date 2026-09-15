/**
 * 单元测试：问答闭环存储（RoundStore）
 * 验证 InMemoryRoundStore 的核心功能
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import {
  createPendingRound,
  completeRound,
  generateRoundId,
  generateMessageId,
  type ProcessEvent,
  type Round,
} from '@/memory/roundStore.js';

describe('问答闭环存储', () => {
  let store: InMemoryRoundStore;

  beforeEach(() => {
    store = new InMemoryRoundStore();
  });

  describe('InMemoryRoundStore', () => {
    it('应该保存和获取问答闭环', () => {
      // 创建 pending Round
      const round = createPendingRound('你好');

      // 保存
      store.save(round);

      // 获取
      const retrieved = store.getById(round.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(round.id);
      expect(retrieved?.status).toBe('pending');
      expect(retrieved?.userMessage.content).toBe('你好');
      expect(retrieved?.refCount).toBe(1);
    });

    it('listInterruptedRecent：列出指定日期崩溃残留轮（pending/error + refCount=0 + 倒序）', () => {
      // 构造崩溃残留轮：覆盖工厂默认（refCount=1）为 refCount=0（崩溃发生在 appendAssistant 前的形态）
      const mk = (date: string, min: string, status: Round['status']): void => {
        const base = createPendingRound(`q-${min}`);
        // status 覆盖为 complete（此处仅验证过滤，不做模型完整性校验）
        const round: Round = {
          ...base,
          status,
          refCount: 0,
          createdAt: `${date}T${min}:00.00.000Z`,
        };
        store.save(round);
      };
      // 目标日期：pending 两条 + error 一条（最新在前，分钟序 2 > 0 > 1）
      mk('2026-09-09', '00', 'pending');
      mk('2026-09-09', '01', 'pending');
      mk('2026-09-09', '02', 'error');
      // 排除项：他日 pending、同日 complete（归零轮非未完成残留）
      mk('2026-09-08', '03', 'pending');
      mk('2026-09-09', '04', 'complete');
      // 排除项：被引用（refCount>0）的 pending——进行中轮不属崩溃残留
      const refed = createPendingRound('refed');
      refed.refCount = 1;
      store.save(refed);

      // 全量：仅 3 条目标，按 createdAt 倒序（最新在前，分钟序 02 > 01 > 00）
      const all = store.listInterruptedRecent('2026-09-09');
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.userMessage.content)).toEqual(['q-02', 'q-01', 'q-00']);

      // limit 截断：取最新 2 条
      const limited = store.listInterruptedRecent('2026-09-09', 2);
      expect(limited).toHaveLength(2);
      expect(limited[0]?.userMessage.content).toBe('q-02');
      expect(limited[1]?.userMessage.content).toBe('q-01');
    });

    it('应该完成问答闭环', () => {
      // 创建并完成 Round
      const round = createPendingRound('你好');
      store.save(round);

      const completed = completeRound(round, '你好！有什么可以帮你的？');
      store.save(completed);

      // 获取并验证
      const retrieved = store.getById(round.id);
      expect(retrieved?.status).toBe('complete');
      expect(retrieved?.assistantMessage?.content).toBe('你好！有什么可以帮你的？');
      expect(retrieved?.completedAt).toBeDefined();
      // 摘要关联不落 Round：ID 由 roundSummaryGenerator 按 roundId 独立构造，Round 侧无反向指针
      expect(retrieved && 'summaryId' in retrieved).toBe(false);
    });

    it('应该批量获取问答闭环', () => {
      // 创建多个 Round
      const round1 = createPendingRound('第一个问题');
      const round2 = createPendingRound('第二个问题');
      const round3 = createPendingRound('第三个问题');

      store.save(round1);
      store.save(round2);
      store.save(round3);

      // 批量获取
      const results = store.getByIds([round1.id, round3.id]);
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe(round1.id);
      expect(results[1]!.id).toBe(round3.id);
    });

    it('应该跳过批量获取中不存在的 ID', () => {
      const round1 = createPendingRound('存在的');
      store.save(round1);

      // 包含不存在的 ID
      const results = store.getByIds([round1.id, '不存在的-id']);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(round1.id);
    });

    it('应该列出所有问答闭环', () => {
      const round1 = createPendingRound('问题1');
      const round2 = createPendingRound('问题2');

      store.save(round1);
      store.save(round2);

      const all = store.listAll();
      expect(all).toHaveLength(2);
      expect(store.size()).toBe(2);
    });

    it('应该按状态筛选问答闭环', () => {
      // 创建不同状态的 Round
      const pendingRound = createPendingRound('待处理');
      store.save(pendingRound);

      const completedRound = createPendingRound('已完成');
      const completed = completeRound(completedRound, '完成');
      store.save(completed);

      // 按状态筛选
      const pendingList = store.listByStatus('pending');
      const completedList = store.listByStatus('complete');

      expect(pendingList.length).toBeGreaterThanOrEqual(1);
      expect(completedList.length).toBeGreaterThanOrEqual(1);
    });

    it('应该管理引用计数', () => {
      const round = createPendingRound('测试引用');
      store.save(round);

      // 初始 refCount = 1
      const initial = store.getById(round.id);
      expect(initial?.refCount).toBe(1);

      // 增加引用
      store.incrementRef(round.id);
      const afterIncrement = store.getById(round.id);
      expect(afterIncrement?.refCount).toBe(2);

      // 减少引用
      store.decrementRef(round.id);
      const afterDecrement = store.getById(round.id);
      expect(afterDecrement?.refCount).toBe(1);

      // 减少到 0 以下不允许
      store.decrementRef(round.id);
      store.decrementRef(round.id); // 尝试继续减少
      const afterOverflow = store.getById(round.id);
      expect(afterOverflow?.refCount).toBe(0); // 不会降到 0 以下
    });

    it('应该删除孤立的问答闭环', () => {
      // 创建 refCount=0 的 Round
      const round = createPendingRound('待删除');
      // 手动设置 refCount=0
      round.refCount = 0;
      store.save(round);

      // 应该能删除
      const deleted = store.delete(round.id);
      expect(deleted).toBe(true);
      expect(store.getById(round.id)).toBeNull();
      expect(store.size()).toBe(0);
    });

    it('不应该删除仍被引用的问答闭环', () => {
      const round = createPendingRound('被引用');
      store.save(round);

      // refCount=1 > 0，不允许删除
      const deleted = store.delete(round.id);
      expect(deleted).toBe(false);
      expect(store.getById(round.id)).not.toBeNull();
    });

    it('应该列出孤立的问答闭环', () => {
      // 创建孤立的 Round（refCount=0 且 complete）
      const round1 = createPendingRound('孤立1');
      const completed1 = completeRound(round1, '完成1');
      completed1.refCount = 0;
      store.save(completed1);

      // 创建非孤立的 Round（refCount=2）
      const round2 = createPendingRound('非孤立');
      const completed2 = completeRound(round2, '完成2');
      completed2.refCount = 2;
      store.save(completed2);

      // 列出孤立的
      const orphaned = store.listOrphaned(0); // minAgeMs=0 忽略存活时间
      expect(orphaned.length).toBe(1);
      expect(orphaned[0]!.id).toBe(round1.id);
    });

    it('应该尊重最小存活时间', () => {
      // 创建刚完成的 Round
      const round = createPendingRound('新的');
      const completed = completeRound(round, '新完成');
      completed.refCount = 0;
      store.save(completed);

      // 存活时间设置为 1 小时，应该过滤掉
      const orphaned = store.listOrphaned(60 * 60 * 1000);
      expect(orphaned.length).toBe(0); // 不会被列出
    });

    it('应该忽略不存在的 Round 操作', () => {
      // 获取不存在的 ID
      expect(store.getById('不存在的-id')).toBeNull();

      // 增加不存在的 ID 的引用（不报错）
      expect(() => store.incrementRef('不存在的-id')).not.toThrow();

      // 减少不存在的 ID 的引用（不报错）
      expect(() => store.decrementRef('不存在的-id')).not.toThrow();
    });

    it('应该支持清空操作', () => {
      const round = createPendingRound('测试');
      store.save(round);
      expect(store.size()).toBe(1);

      store.clear();
      expect(store.size()).toBe(0);
    });
  });

  describe('processEvents 过程事件透传', () => {
    it('应该完整透传保存的 processEvents（含 seq 顺序与各类型 payload）', () => {
      // 构造一轮完整的过程事件（meta 首条 → thinking → tool_start → metrics 末条）
      const round = createPendingRound('你好');
      const completed = completeRound(round, '你好！');
      const events: ProcessEvent[] = [
        { type: 'meta', seq: 1, ts: '2026-08-28T00:00:00.000Z', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
        { type: 'thinking', seq: 2, ts: '2026-08-28T00:00:01.000Z', payload: { phase: 'processing' } },
        { type: 'tool_start', seq: 3, ts: '2026-08-28T00:00:02.000Z', payload: { toolCallId: 'tc1', name: 'read_file', args: '{"path":"a.md"}' } },
        { type: 'tool_result', seq: 4, ts: '2026-08-28T00:00:03.000Z', payload: { toolCallId: 'tc1', name: 'read_file', ok: true, summary: '读取成功' } },
        { type: 'metrics', seq: 5, ts: '2026-08-28T00:00:04.000Z', payload: { durationMs: 4000, tokenIn: 100, tokenOut: 200, toolFailureCount: 0, success: true } },
      ];
      completed.processEvents = events;
      store.save(completed);

      // 找回后事件完整且顺序一致
      const retrieved = store.getById(completed.id);
      expect(retrieved?.processEvents).toHaveLength(5);
      expect(retrieved?.processEvents?.map((e) => e.type)).toEqual(['meta', 'thinking', 'tool_start', 'tool_result', 'metrics']);
      expect(retrieved?.processEvents?.[0]).toEqual(events[0]);
      expect(retrieved?.processEvents?.[4]).toEqual(events[4]);
    });

    it('缺省 processEvents（pending/error 轮无过程数据），不渲染 round-block', () => {
      const round = createPendingRound('用户问题');
      store.save(round);

      const retrieved = store.getById(round.id);
      expect(retrieved?.processEvents).toBeUndefined();
    });

    it('增量变更 processEvents（Write-once 前宿主追加）后重新保存可覆盖', () => {
      // 模拟宿主流结束后的「读 Round → 附加 processEvents → save」写入路径
      const round = createPendingRound('问题');
      const completed = completeRound(round, '回答');
      store.save(completed);

      const current = store.getById(completed.id)!;
      current.processEvents = [
        { type: 'meta', seq: 1, ts: '2026-08-28T00:00:00.000Z', payload: { role: 'AI', llm: 'deepseek-chat' } },
        { type: 'aborted', seq: 2, ts: '2026-08-28T00:00:01.000Z', payload: { reason: 'User cancelled the conversation' } },
      ];
      store.save(current);

      const retrieved = store.getById(completed.id);
      expect(retrieved?.processEvents?.map((e) => e.type)).toEqual(['meta', 'aborted']);
    });
  });

  describe('辅助函数', () => {
    it('应该生成唯一的 Round ID', () => {
      const id1 = generateRoundId();
      const id2 = generateRoundId();

      expect(id1.startsWith('round-')).toBe(true);
      expect(id2.startsWith('round-')).toBe(true);
      expect(id1).not.toBe(id2); // 唯一
    });

    it('应该生成唯一的消息 ID', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();

      expect(id1.startsWith('msg-')).toBe(true);
      expect(id1).not.toBe(id2);
    });

    it('应该创建 pending Round', () => {
      const round = createPendingRound('测试消息');

      expect(round.id).toBeDefined();
      expect(round.status).toBe('pending');
      expect(round.userMessage.content).toBe('测试消息');
      expect(round.userMessage.role).toBe('user');
      expect(round.refCount).toBe(1);
      expect(round.createdAt).toBeDefined();
    });

    it('应该完成 Round', () => {
      const round = createPendingRound('用户问题');
      const completed = completeRound(round, 'AI 回答', { input: 10, output: 20 });

      expect(completed.status).toBe('complete');
      expect(completed.assistantMessage?.content).toBe('AI 回答');
      expect(completed.assistantMessage?.tokenUsage?.input).toBe(10);
      expect(completed.assistantMessage?.tokenUsage?.output).toBe(20);
      expect(completed.completedAt).toBeDefined();
      // Round 不持有摘要反向指针（summaryId 字段已删除）
      expect('summaryId' in completed).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 判据单源守卫：「轮是否已收场」只许走 isRoundSettled（2026-09-15）
// ══════════════════════════════════════════════════════════════
//
// 背景：v3.0.0 把中断/失败轮从「伪 complete」改为 'interrupted' 后，各处**自写**的
// `status === 'complete'` 会静默改行为——中断轮的 assistantMessage 被排除出会话视图与
// LLM 历史（`ISessionStore.loadMessages` 是 `restoreHistory` 的唯一上游），违背定案
// `docs/architecture/step-atomic-persistence.md §一·五`「中断轮可作后续上下文」。
// 修复方式不是逐处补 `|| 'interrupted'`（并列 = 腐化），而是收敛到单一判据；本守卫防其再散开。

/**
 * 剥离行尾注释，返回该行的**代码部分**（保守处理单/双/反引号字符串，识别引号外的首个 `//`）。
 *
 * 为什么必须剥：判据行可能被「行尾注释」形态注释掉，如 `assistant: undefined, // <旧判据>`——
 * 此时该行**不再消费**判据，但豁免片段文本仍在行内，`includes` 会通过 → 静默放行。
 * 变异验证实测到该假阴性（改注释后守卫仍全绿），故所有判定一律用代码部分。
 */
function stripTrailingLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++; // 转义字符跳过（防误判引号闭合）
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

describe('isRoundSettled 判据单源守卫', () => {
  /**
   * 豁免清单（每条必须给出「为何不是收场判据」的理由，不得为省事豁免）
   *
   * **按行内容精确匹配**豁免，而非整文件 / 行号：
   * - 整文件豁免 = 该文件其余位置再自写判据可蒙混过关（chatPanel 是宿主最大文件，口子最宽）；
   * - 行号豁免 = 无关改动导致漂移时误红。
   * 并有「僵尸豁免」闭环：豁免片段必须在目标文件中真实存在，判据删改后仍在 = 敞开的后门。
   *
   * - `chatPanel.loadRoundBasedHistory`：**渲染分流**判据「是否挂 assistant 正文块」，
   *   回答的是「怎么画」而非「是否已收场」。中断轮**可能确有** assistantMessage
   *   （`appendInterrupted` 有恢复文本即写，来源 = narrate 拼接 / 运行期 streamResult.content），
   *   不挂正文的真正理由 = **同源去双份**（该文本与 processEvents 平铺区内容相同）。
   *   语义与收场判据不同，故保留 `'complete'`。
   */
  const ALLOWED_LINES: Record<string, string[]> = {
    'hosts/memora-vscode/src/webview/panels/chatPanel.ts': [
      "round.assistantMessage?.content && round.status === 'complete'",
    ],
  };

  // 守卫自身的「测量工具」先自证（纪律：先验证测量工具本身，再信它的结论）
  it('stripTrailingLineComment：剥行尾注释，但保留引号内的 //', () => {
    expect(stripTrailingLineComment('const x = 1; // status === \'complete\'')).toBe('const x = 1; ');
    expect(stripTrailingLineComment("const u = 'https://a'; y")).toBe("const u = 'https://a'; y");
    expect(stripTrailingLineComment('const u = "a\\"//b"; y')).toBe('const u = "a\\"//b"; y');
    expect(stripTrailingLineComment('const s = `a//b`; y')).toBe('const s = `a//b`; y');
    expect(stripTrailingLineComment('const x = 1;')).toBe('const x = 1;');
  });

  it('生产代码中不得自写 status ==/!= /=== /!== \'complete\' 收场判据（豁免须登记理由）', () => {
    const roots = ['src', 'hosts/memora-vscode/src'];
    // 只认比较运算，不匹配写点（`status: 'complete'` 是 appendAssistant / completeRound 的合法落盘）
    const forbidden = /status\s*(?:===|!==|==|!=)\s*'complete'/;
    const hits: string[] = [];
    /** isRoundSettled 定义体出现次数：判据必须**恰好定义一处**（与上方豁免互为闭环，防豁免被滥用） */
    let settledDefCount = 0;
    /** 实际用到的豁免条目（用于末尾「僵尸豁免」闭环：登记了却没命中 = 判据已变质而豁免仍在） */
    const usedAllowed = new Set<string>();

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // 测试自身与依赖不参与（守卫只约束生产代码）
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = full.split(sep).join('/');
        const allowedHere = ALLOWED_LINES[rel] ?? [];
        // 定义体豁免按「行区间」而非「整文件」给出——否则该文件内其余位置再自写判据就能蒙混过关
        let insideSettledDef = false;
        readFileSync(full, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (line.startsWith('export function isRoundSettled')) {
              settledDefCount += 1;
              insideSettledDef = true;
              return;
            }
            if (insideSettledDef) {
              if (line === '}') insideSettledDef = false;
              return;
            }
            const code = line.trim();
            // 判定一律用「剥掉行尾注释后的代码部分」——否则 `x, // <被判据>` 形态会被静默放行
            const codePart = stripTrailingLineComment(line);
            // 跳过整行注释（SSOT 文档本身会引用该反模式作为反面说明）
            if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
            if (!forbidden.test(codePart)) return;
            // 行内容精确豁免：仅当该行**正是**登记过的渲染分流判据才放行——同文件新增另一处
            // 自写判据仍会命中（这是把豁免从「整文件」收窄到「行」的全部意义）
            const allowedHit = allowedHere.find((allowed) => codePart.includes(allowed));
            if (allowedHit !== undefined) {
              usedAllowed.add(`${rel}::${allowedHit}`);
              return;
            }
            hits.push(`${rel}:${i + 1} → ${code}`);
          });
      }
    };
    for (const root of roots) walk(root);

    // 失败时 hits 直接指出「哪个文件哪一行」——断言口径 = 不变量本身（判据单源），非装饰
    expect(hits).toEqual([]);
    // 闭环一：判据定义必须唯一（0 = 判据被删/改名，>1 = 又长出并列判据）
    expect(settledDefCount).toBe(1);
    // 闭环二：豁免表不得留僵尸——登记片段必须在目标文件中真实存在。判据被改写/删除而豁免仍在，
    // 等于敞开的后门：该位置下次自写同类判据会被静默放行，而豁免理由已与事实脱节。
    const zombieAllowed: string[] = [];
    for (const [relPath, allowedList] of Object.entries(ALLOWED_LINES)) {
      const text = readFileSync(relPath, 'utf8');
      for (const allowed of allowedList) {
        if (!text.includes(allowed)) zombieAllowed.push(`${relPath} :: ${allowed}`);
      }
    }
    expect(zombieAllowed).toEqual([]);
    // 闭环三：登记了却零命中 = 该片段存在但已不被判据行消费（如判据被注释掉）——豁免须与
    // 活跃判据一一对应，否则「豁免」变成了对该文件的一张空白通行证
    const unusedAllowed: string[] = [];
    for (const [relPath, allowedList] of Object.entries(ALLOWED_LINES)) {
      for (const allowed of allowedList) {
        if (!usedAllowed.has(`${relPath}::${allowed}`)) {
          unusedAllowed.push(`${relPath}::${allowed}`);
        }
      }
    }
    expect(unusedAllowed).toEqual([]);
  });
});
