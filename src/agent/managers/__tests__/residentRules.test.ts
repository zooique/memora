/**
 * 项目规则层测试（读盘判据 + 两道上限 + 段渲染 + 两道 fail-safe）
 *
 * 重点锁死三类「没有测试会红」的语义：
 * ① 判据只认严格 `true`（`"false"` 字符串不得变项目规则）；
 * ② 计量按**渲染块**（单条 = 标题行 + 正文；合计 = 整段渲染长度）；
 * ③ 读失败 ⇒ **该条本轮不进段**并写明「本次未注入（读取失败，下轮重试）」（不缓存、不沿用）；
 * ④ 合计超限 ⇒ **按清单顺序从末尾逐条丢弃**（靠前者优先），不再整段降级。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_RESIDENT_SINGLE_CHARS,
  MAX_RESIDENT_TOTAL_CHARS,
  ResidentRulesManager,
  evaluateResidentSegment,
  isNonBooleanResident,
  isResidentEntry,
  isResidentLayerEnabled,
  readResidentSource,
  renderResidentSegment,
} from '../residentRules.js';
import type { WorkProjectionEntry } from '../workProjection.js';

/**
 * 构造一条最小作品投影条目（测试只关心 source / resident，其余字段给占位值）
 *
 * @param source 清单相对路径
 * @param resident 项目规则标记（缺省 = 字段缺失）
 * @returns 完整条目（满足 WorkProjectionEntry 形状）
 */
function entryOf(source: string, resident?: boolean): WorkProjectionEntry {
  return { name: source, description: '', source, resident };
}

/**
 * 上限常量的政策线不变量：**合计恒等于单条 × 2**
 *
 * 两个常量是**彼此独立的字面量**（政策线由用户拍板），而「合计 = 单条 × 2」是可解释预算关系
 * （最坏容得下两篇顶格规则）。只改其一时，`residentRules.ts` 的常量注释与设计文档 §6.1 立刻
 * 变成假话，且此前**没有任何测试会红**——此处用一行断言把关系钉死。
 *
 * 为什么用断言而不是把合计直接写成 `MAX_RESIDENT_SINGLE_CHARS * 2`：
 * 派生写法虽能「结构上不可能漂移」，但既有测试全部引用该常量（没有绝对数值锚），
 * 把 `* 2` 变异成 `* 3` 会**静默保持全绿**——那正是本仓禁止的「绿 ≠ 做对了」。
 * 断言写法能通过变异验证（关系被改即红），故取断言。
 */
describe('上限常量（政策线不变量）', () => {
  it('合计恒等于单条 × 2（改其一会红）', () => {
    expect(MAX_RESIDENT_TOTAL_CHARS).toBe(MAX_RESIDENT_SINGLE_CHARS * 2);
  });

  it('政策线数值：单条 5000 / 合计 10000（只改 ×2 关系的断言挡不住整体改数）', () => {
    expect(MAX_RESIDENT_SINGLE_CHARS).toBe(5000);
    expect(MAX_RESIDENT_TOTAL_CHARS).toBe(10000);
  });
});

describe('residentRules', () => {
  /** 临时项目根 */
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'memora-resident-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  describe('判据（唯一实现）', () => {
    it('isResidentLayerEnabled 只认严格 true（undefined / false / "true" 均按未信任）', () => {
      expect(isResidentLayerEnabled(true)).toBe(true);
      expect(isResidentLayerEnabled(false)).toBe(false);
      expect(isResidentLayerEnabled(undefined)).toBe(false);
      // 手改清单 / 宿主传错类型时防 truthy 误判
      expect(isResidentLayerEnabled('true' as unknown as boolean)).toBe(false);
    });

    it('isResidentEntry 只认严格 true（字符串 "false" 不得变项目规则）', () => {
      expect(isResidentEntry({ resident: true })).toBe(true);
      expect(isResidentEntry({})).toBe(false);
      expect(isResidentEntry({ resident: false })).toBe(false);
      expect(isResidentEntry({ resident: 'false' as unknown as boolean })).toBe(false);
    });

    it('isNonBooleanResident 只把「字段存在且非布尔」算误配（缺失 / true / false 不算）', () => {
      // 字段缺失是合法「非规则」：绝不能把每一条普通作品投影都报成误配
      expect(isNonBooleanResident({})).toBe(false);
      expect(isNonBooleanResident({ resident: undefined })).toBe(false);
      expect(isNonBooleanResident({ resident: true })).toBe(false);
      expect(isNonBooleanResident({ resident: false })).toBe(false);
      // 手改笔误族：字符串 / null / 数字一律算误配（不猜意图）
      expect(isNonBooleanResident({ resident: 'true' as unknown as boolean })).toBe(true);
      expect(isNonBooleanResident({ resident: 'false' as unknown as boolean })).toBe(true);
      expect(isNonBooleanResident({ resident: null as unknown as boolean })).toBe(true);
      expect(isNonBooleanResident({ resident: 1 as unknown as boolean })).toBe(true);
    });
  });

  describe('readResidentSource（读盘判据）', () => {
    it('正常文本：返回正文与渲染块（标题行 + 正文）', async () => {
      await writeFile(join(projectDir, 'rules.md'), '# 规则\n保持简洁', 'utf8');
      const read = await readResidentSource(projectDir, 'rules.md');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.text).toBe('# 规则\n保持简洁');
      expect(read.block).toBe('### 来源文件：rules.md\n# 规则\n保持简洁');
    });

    it('绝对路径 ⇒ outside-workspace，且不读盘', async () => {
      const read = await readResidentSource(projectDir, 'C:/Windows/win.ini');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('outside-workspace');
      expect(read.message).toContain('不在工作区内');
    });

    it('../ 逃逸 ⇒ outside-workspace', async () => {
      const read = await readResidentSource(projectDir, '../outside.md');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('outside-workspace');
    });

    it('凭据文件 ⇒ blocked-path（复用 pathGuard 黑名单，文案可与其他类区分）', async () => {
      await writeFile(join(projectDir, '.env'), 'TOKEN=xxx', 'utf8');
      const read = await readResidentSource(projectDir, '.env');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('blocked-path');
      expect(read.message).toContain('凭据');
    });

    it('不存在的文件 ⇒ missing', async () => {
      const read = await readResidentSource(projectDir, 'gone.md');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('missing');
      expect(read.message).toContain('不存在');
    });

    it('含 NUL 字节 ⇒ not-textual', async () => {
      await writeFile(join(projectDir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
      const read = await readResidentSource(projectDir, 'bin.dat');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('not-textual');
      expect(read.message).toContain('不是文本文件');
    });

    it('无 BOM 的非法 UTF-8 字节 ⇒ not-textual（fatal 解码，不用替换字符吞掉）', async () => {
      // 首字节刻意不是 FF FE / FE FF（那是 UTF-16 BOM，会走 BOM 分支）——
      // 本用例锁的是 invalid-utf8 这一条原因码
      await writeFile(join(projectDir, 'gbk.txt'), Buffer.from([0x41, 0xff, 0x42]));
      const read = await readResidentSource(projectDir, 'gbk.txt');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('not-textual');
      expect(read.message).toContain('非 UTF-8 编码');
    });

    it('UTF-16 BOM 但内容损坏（奇数长度）⇒ not-textual 且原因是 UTF-16 编码损坏', async () => {
      // FF FE 是 UTF-16LE BOM；后面只剩 1 字节，fatal 解码必失败 ⇒ invalid-utf16
      await writeFile(join(projectDir, 'broken16.txt'), Buffer.from([0xff, 0xfe, 0x41]));
      const read = await readResidentSource(projectDir, 'broken16.txt');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('not-textual');
      expect(read.message).toContain('UTF-16 编码损坏');
    });

    it('UTF-8 BOM 的项目规则文件 ⇒ 正文不含 U+FEFF（恢复旧行为：规则段不注入 BOM）', async () => {
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('规则正文', 'utf8'),
      ]);
      await writeFile(join(projectDir, 'bom.md'), bytes);
      const read = await readResidentSource(projectDir, 'bom.md');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // 正文与渲染块都不应带 BOM（否则 U+FEFF 会随规则段进入模型上下文）
      expect(read.text).toBe('规则正文');
      expect(read.text).not.toContain('\uFEFF');
      expect(read.block).toBe('### 来源文件：bom.md\n规则正文');
    });

    it('UTF-8 BOM + NUL 的规则文件 ⇒ 走文本分支，控制字符被净化（无 \\u0000 / \\uFEFF）', async () => {
      // BOM 优先于 NUL 是刻意选择（与 read_file 同一判据）；代价是 NUL 会随正文进来，
      // 规则段又要原样拼进 system prompt，故必须在读盘层净化掉不可见控制字符
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('规则\u0000正文', 'utf8'),
      ]);
      await writeFile(join(projectDir, 'bom-nul.md'), bytes);
      const read = await readResidentSource(projectDir, 'bom-nul.md');
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // 正文与渲染块都不含 NUL / BOM，可打印内容保留
      expect(read.text).toBe('规则正文');
      expect(read.text).not.toContain('\u0000');
      expect(read.text).not.toContain('\uFEFF');
      expect(read.block).toBe('### 来源文件：bom-nul.md\n规则正文');
      expect(read.block).not.toContain('\u0000');
    });

    it('目录 / 权限类读盘异常 ⇒ read-error（可重试，文案与判据拒绝可区分）', async () => {
      await mkdir(join(projectDir, 'adir'));
      const read = await readResidentSource(projectDir, 'adir');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('read-error');
      expect(read.message).toContain('读取失败');
    });
  });

  describe('段渲染与两道上限', () => {
    it('无条目 ⇒ 空段（不注入空壳标题）', () => {
      expect(renderResidentSegment([], [])).toBe('');
    });

    it('段首三句 + 读失败未注入行 + 各条块按清单顺序', async () => {
      await writeFile(join(projectDir, 'a.md'), 'A 规则', 'utf8');
      await writeFile(join(projectDir, 'b.md'), 'B 规则', 'utf8');
      const evaluation = await evaluateResidentSegment(projectDir, ['a.md', 'missing.md', 'b.md']);

      expect(evaluation.segment).toContain('## 项目规则（本仓库具体约束；按清单顺序，靠前者优先）');
      expect(evaluation.segment).toContain('- 适用范围：');
      expect(evaluation.segment).toContain('- 优先级：');
      // 读失败与单条超限分开写：这里的处置是「下轮重试」，不是「拆分文件」
      expect(evaluation.segment).toContain(
        '（以下 1 条本次未注入（读取失败，下轮重试）：missing.md）',
      );
      // 顺序真源 = 清单数组顺序
      expect(evaluation.segment.indexOf('### 来源文件：a.md')).toBeLessThan(
        evaluation.segment.indexOf('### 来源文件：b.md'),
      );
      expect(evaluation.failures).toHaveLength(1);
      // 失效通告只给路径，失败详情留日志 / 拒绝文案
      expect(evaluation.blocks).toHaveLength(2);
    });

    it('单条超限 ⇒ 只剔该条 + 汇总行；其余照常注入（不整段陪葬）', async () => {
      await writeFile(join(projectDir, 'big.md'), 'x'.repeat(MAX_RESIDENT_SINGLE_CHARS), 'utf8');
      await writeFile(join(projectDir, 'ok.md'), '正常规则', 'utf8');
      const evaluation = await evaluateResidentSegment(projectDir, ['big.md', 'ok.md']);

      // 标题行使渲染块越限 ⇒ big 失效
      expect(evaluation.failures.map((f) => f.reason)).toEqual(['too-long']);
      expect(evaluation.segment).toContain(
        '（以下 1 条本次未注入（单文件超上限，需拆分）：big.md）',
      );
      expect(evaluation.segment).toContain('### 来源文件：ok.md');
      expect(evaluation.segment).not.toContain('### 来源文件：big.md');
      // 拒绝文案必须给实际计量与差额，并把处置指向「拆分文件」而不是「让合计迁就」
      expect(evaluation.failures[0]!.message).toMatch(/共 \d+ 字符，超过单条 5000 上限 \d+ 字符/);
      expect(evaluation.failures[0]!.message).toContain('单文件超上限，请拆分该文件');
    });

    it('合计超限 ⇒ 按清单顺序从末尾丢弃，靠前者保留（不整段降级）', async () => {
      const sources = ['a.md', 'b.md', 'c.md', 'd.md'];
      for (const s of sources) await writeFile(join(projectDir, s), '', 'utf8');

      // 先测出「正文全空时的整段长度」= 段首 + 块标题 + 分隔符的固定开销
      const probe = await evaluateResidentSegment(projectDir, sources);
      const overhead = probe.segment.length;

      // 构造：四条正文之和比合计上限多 30 字符（每条都远低于单条上限）
      const total = MAX_RESIDENT_TOTAL_CHARS - overhead + 30;
      const per = Math.floor(total / 4);
      const bodies = [per, per, per, total - 3 * per];
      for (let i = 0; i < sources.length; i += 1) {
        await writeFile(join(projectDir, sources[i]!), 'y'.repeat(bodies[i]!), 'utf8');
      }

      const evaluation = await evaluateResidentSegment(projectDir, sources);
      // 段长度必须回到上限内（丢弃的唯一目的就是装得下）
      expect(evaluation.segment.length).toBeLessThanOrEqual(MAX_RESIDENT_TOTAL_CHARS);
      // 只丢清单末尾那一条；靠前者全部保留
      expect(evaluation.dropped.map((d) => d.source)).toEqual(['d.md']);
      expect(evaluation.dropped[0]!.reason).toBe('total-exceeded');
      expect(evaluation.blocks).toHaveLength(3);
      expect(evaluation.segment).toContain('### 来源文件：a.md');
      expect(evaluation.segment).not.toContain('### 来源文件：d.md');
      // 丢弃清单必须显式上段（模型与宿主都要知道「哪篇、因为合计超限」）
      expect(evaluation.segment).toContain('（以下 1 条因合计超限未注入：d.md');
      expect(evaluation.segment).toContain('已按清单顺序丢弃靠后条目，靠前者优先');
      // 丢弃 ≠ 失效：不得混进未注入行
      expect(evaluation.failures).toHaveLength(0);
    });
  });

  describe('ResidentRulesManager（两道 fail-safe）', () => {
    /** 构造一个成功返回给定条目的依赖（可替换为抛错实现） */
    const listEntriesOf = (entries: Array<{ source: string; resident?: boolean }>) =>
      vi.fn(async () => entries.map((e) => entryOf(e.source, e.resident)));

    it('未信任 ⇒ 整层不装配，且零 IO（listEntries 不被调用）', async () => {
      const listEntries = listEntriesOf([{ source: 'a.md', resident: true }]);
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: undefined,
        listEntries,
        isListMalformed: () => false,
      });

      await manager.refresh();
      expect(manager.contextBlock()).toBe('');
      // 整层未启用不是「求值结果」：快照为 null，宿主据此区分「没求值」与「求值了但零条目」
      expect(manager.report).toBeNull();
      expect(listEntries).not.toHaveBeenCalled();
    });

    it('已信任 + 清单读失败 ⇒ 空段（不缓存、不沿用上次内容）', async () => {
      await writeFile(join(projectDir, 'a.md'), '规则正文', 'utf8');
      let fail = false;
      const listEntries = vi.fn(async () => {
        if (fail) throw new Error('IO 抖动');
        return [entryOf('a.md', true)];
      });
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries,
        isListMalformed: () => false,
      });

      await manager.refresh();
      expect(manager.contextBlock()).toContain('### 来源文件：a.md');

      fail = true;
      await manager.refresh();
      // 读失败 ⇒ 本轮一条都不注入（拿不到声明就不猜它是什么），且**不留**上一轮正文
      expect(manager.contextBlock()).toBe('');
      expect(manager.contextBlock()).not.toContain('规则正文');
      expect(manager.contextBlock()).not.toContain('沿用上次内容');

      // 恢复后重新注入（下一轮读盘即可自愈，因为根本没有「缓存」这个东西）
      fail = false;
      await manager.refresh();
      expect(manager.contextBlock()).toContain('### 来源文件：a.md');
    });

    it('已信任 + 读失败 ⇒ 空段（不抛错，turn 不中断）', async () => {
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => {
          throw new Error('IO 抖动');
        },
        isListMalformed: () => false,
      });

      await expect(manager.refresh()).resolves.toBeUndefined();
      expect(manager.contextBlock()).toBe('');
    });

    it('清单格式错误等同读失败 ⇒ 空段（不沿用上一轮已注入的正文）', async () => {
      await writeFile(join(projectDir, 'a.md'), '规则正文', 'utf8');
      let malformed = false;
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [entryOf('a.md', true)],
        isListMalformed: () => malformed,
      });

      await manager.refresh();
      expect(manager.contextBlock()).toContain('规则正文');

      malformed = true;
      await manager.refresh();
      expect(manager.contextBlock()).toBe('');
    });

    it('合计超限 ⇒ 仍注入靠前条目，段首列出丢弃清单（不再整段降级）', async () => {
      const sources = ['a.md', 'b.md', 'c.md'];
      for (const s of sources) await writeFile(join(projectDir, s), '', 'utf8');
      const overhead = (await evaluateResidentSegment(projectDir, sources)).segment.length;
      // 让渲染长度恰好越限 1 字符（每条都低于单条上限）
      const total = MAX_RESIDENT_TOTAL_CHARS + 1 - overhead;
      const per = Math.floor(total / 3);
      const bodies = [per, per, total - 2 * per];
      for (let i = 0; i < sources.length; i += 1) {
        await writeFile(join(projectDir, sources[i]!), 'z'.repeat(bodies[i]!), 'utf8');
      }

      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => sources.map((source) => entryOf(source, true)),
        isListMalformed: () => false,
      });

      await manager.refresh();
      const segment = manager.contextBlock();
      // 靠前者照常注入；只有清单末尾被丢
      expect(segment).toContain('### 来源文件：a.md');
      expect(segment).toContain('### 来源文件：b.md');
      expect(segment).not.toContain('### 来源文件：c.md');
      expect(segment).toContain('（以下 1 条因合计超限未注入：c.md');
      // 状态行只留给「丢光也装不下」的极端兜底
      expect(segment).not.toContain('项目规则未注入');
      expect(segment.length).toBeLessThanOrEqual(MAX_RESIDENT_TOTAL_CHARS);
    });

    it('无项目规则条目 ⇒ 空段（不注入空壳）', async () => {
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [entryOf('a.md')],
        isListMalformed: () => false,
      });

      await manager.refresh();
      expect(manager.contextBlock()).toBe('');
    });

    it('构造后未刷新 ⇒ 报告为 null（宿主不得把 null 当「零失效」用）', () => {
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [],
        isListMalformed: () => false,
      });

      expect(manager.report).toBeNull();
    });

    /**
     * 非布尔误配（`"resident": "true"` 手改笔误）是「复用失效通道」的核心用例：
     * 必须进完整失效集与宿主报告，但**不得**进段首（模型改不了清单文件，写进去只会
     * 让模型对一件自己无能为力的事反复解释，且句尾的「下轮重试」永远无法被满足）。
     */
    it('resident 非布尔 ⇒ 按未设规则处理 + 进完整失效集，但不进模型可见段首', async () => {
      await writeFile(join(projectDir, 'a.md'), 'A 规则', 'utf8');
      await writeFile(join(projectDir, 'b.md'), 'B 规则', 'utf8');
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [
          // 手改笔误：字符串 "true"（运行时来自 JSON.parse，故用双重断言造非法形态）
          {
            name: 'a',
            description: '',
            source: 'a.md',
            resident: 'true' as unknown as boolean,
          },
          entryOf('b.md', true),
        ],
        isListMalformed: () => false,
      });

      await manager.refresh();
      const report = manager.report;
      expect(report).not.toBeNull();
      expect(report!.listReadable).toBe(true);

      // ① 误配条目不注入正文（与 false 同效），正常条目照常注入
      expect(report!.segment).not.toContain('### 来源文件：a.md');
      expect(report!.segment).toContain('### 来源文件：b.md');

      // ② 但进完整失效集（宿主徽标据此亮），且文案带实际写入值
      const misconfigured = report!.failures.find((f) => f.source === 'a.md');
      expect(misconfigured?.reason).toBe('resident-not-boolean');
      expect(misconfigured?.message).toContain('"true"');

      // ③ 段首不出现它的路径、也不出现「下轮重试」（模型面不投影这类失效）
      expect(report!.segment).not.toContain('a.md');
      expect(report!.segment).not.toContain('下轮重试');
    });

    it('清单格式错误 ⇒ 报告非 null 且 listReadable=false（区别于「没求值」）', async () => {
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [],
        isListMalformed: () => true,
      });

      await manager.refresh();
      const report = manager.report;
      expect(report).not.toBeNull();
      expect(report!.listReadable).toBe(false);
      expect(report!.failures).toEqual([]);
      expect(report!.segment).toBe('');
    });
  });
});
