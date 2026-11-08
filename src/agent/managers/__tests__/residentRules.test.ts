/**
 * 项目常驻规则层测试（读盘判据 + 两道上限 + 段渲染 + 三道 fail-safe）
 *
 * 重点锁死三类「没有测试会红」的语义：
 * ① 判据只认严格 `true`（`"false"` 字符串不得变常驻）；
 * ② 计量按**渲染块**（单条 = 标题行 + 正文；合计 = 整段渲染长度）；
 * ③ 「沿用上次内容」标注行**不计入 15000 预算**（有意例外，自噬链）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_RESIDENT_SINGLE_CHARS,
  MAX_RESIDENT_TOTAL_CHARS,
  ResidentRulesManager,
  annotateReadFailure,
  evaluateResidentSegment,
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
 * @param resident 常驻标记（缺省 = 字段缺失）
 * @returns 完整条目（满足 WorkProjectionEntry 形状）
 */
function entryOf(source: string, resident?: boolean): WorkProjectionEntry {
  return { name: source, description: '', source, resident };
}

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

    it('isResidentEntry 只认严格 true（字符串 "false" 不得变常驻）', () => {
      expect(isResidentEntry({ resident: true })).toBe(true);
      expect(isResidentEntry({})).toBe(false);
      expect(isResidentEntry({ resident: false })).toBe(false);
      expect(isResidentEntry({ resident: 'false' as unknown as boolean })).toBe(false);
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

    it('非 UTF-8 字节 ⇒ not-textual（fatal 解码，不用替换字符吞掉）', async () => {
      await writeFile(join(projectDir, 'gbk.txt'), Buffer.from([0xff, 0xfe, 0x41]));
      const read = await readResidentSource(projectDir, 'gbk.txt');
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.failure).toBe('not-textual');
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

    it('段首三句 + 失效汇总行 + 各条块按清单顺序', async () => {
      await writeFile(join(projectDir, 'a.md'), 'A 规则', 'utf8');
      await writeFile(join(projectDir, 'b.md'), 'B 规则', 'utf8');
      const evaluation = await evaluateResidentSegment(projectDir, ['a.md', 'missing.md', 'b.md']);

      expect(evaluation.segment).toContain(
        '## 项目常驻规则（本仓库具体约束；按清单顺序，靠前者优先）',
      );
      expect(evaluation.segment).toContain('- 适用范围：');
      expect(evaluation.segment).toContain('- 优先级：');
      expect(evaluation.segment).toContain('（以下 1 条未能注入：missing.md）');
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
      expect(evaluation.segment).toContain('（以下 1 条未能注入：big.md）');
      expect(evaluation.segment).toContain('### 来源文件：ok.md');
      expect(evaluation.segment).not.toContain('### 来源文件：big.md');
      // 拒绝文案必须给实际计量与差额
      expect(evaluation.failures[0]!.message).toMatch(/共 \d+ 字符，超过单条 6000 上限 \d+ 字符/);
    });

    it('用户钉住的边界：正文之和 14990 但加段首文案越 15000 ⇒ 整段降级', async () => {
      const sources = ['a.md', 'b.md', 'c.md', 'd.md'];
      for (const s of sources) await writeFile(join(projectDir, s), '', 'utf8');

      // 先测出「正文全空时的整段长度」= 段首 + 块标题 + 分隔符的固定开销
      const probe = await evaluateResidentSegment(projectDir, sources);
      const overhead = probe.segment.length;

      // 构造：四条正文之和恰好 14990（每条都低于单条上限）
      const bodies = [4000, 4000, 4000, 14990 - 12000];
      for (let i = 0; i < sources.length; i += 1) {
        await writeFile(join(projectDir, sources[i]!), 'y'.repeat(bodies[i]!), 'utf8');
      }

      const evaluation = await evaluateResidentSegment(projectDir, sources);
      // 正文 14990 + 段首/标题开销 ⇒ 渲染长度必然超过合计上限（这正是定稿要求的口径）
      expect(14990 + overhead).toBeGreaterThan(MAX_RESIDENT_TOTAL_CHARS);
      expect(evaluation.segment.length).toBe(14990 + overhead);
    });

    it('标注行插入段首标题下一行', () => {
      const annotated = annotateReadFailure('## 标题\n- 第一行\n- 第二行');
      expect(annotated).toBe('## 标题\n（本次读取失败，沿用上次内容）\n- 第一行\n- 第二行');
    });
  });

  describe('ResidentRulesManager（三道 fail-safe）', () => {
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
      expect(listEntries).not.toHaveBeenCalled();
    });

    it('已信任 + 读失败 + 有缓存 ⇒ 沿用缓存 + 段首标注', async () => {
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
      const beforeFailure = manager.contextBlock();
      expect(beforeFailure).toContain('### 来源文件：a.md');

      fail = true;
      await manager.refresh();
      const afterFailure = manager.contextBlock();
      // 内容未丢 + 标注已给模型
      expect(afterFailure).toContain('### 来源文件：a.md');
      expect(afterFailure).toContain('（本次读取失败，沿用上次内容）');

      // 恢复后标注消失（缓存本体无标注，不叠罗汉）
      fail = false;
      await manager.refresh();
      expect(manager.contextBlock()).not.toContain('（本次读取失败，沿用上次内容）');
    });

    it('已信任 + 读失败 + 无缓存 ⇒ 空段（不抛错，turn 不中断）', async () => {
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

    it('清单格式错误等同读失败（有缓存 ⇒ 沿用 + 标注）', async () => {
      await writeFile(join(projectDir, 'a.md'), '规则正文', 'utf8');
      let malformed = false;
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [entryOf('a.md', true)],
        isListMalformed: () => malformed,
      });

      await manager.refresh();
      const healthy = manager.contextBlock();
      expect(healthy).toContain('规则正文');

      malformed = true;
      await manager.refresh();
      expect(manager.contextBlock()).toContain('（本次读取失败，沿用上次内容）');
    });

    it('合计超限 ⇒ 整段降级为一条状态行（不注入残段）', async () => {
      const sources = ['a.md', 'b.md', 'c.md'];
      for (const s of sources) await writeFile(join(projectDir, s), '', 'utf8');
      const overhead = (await evaluateResidentSegment(projectDir, sources)).segment.length;
      // 让渲染长度恰好越限 1 字符（每条都低于单条上限）
      const bodies = [5000, 5000, MAX_RESIDENT_TOTAL_CHARS + 1 - overhead - 10000];
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
      expect(segment).toContain('项目常驻规则未注入');
      expect(segment).toContain('本轮常驻规则未生效');
      // 残段不得被当规则注入
      expect(segment).not.toContain('### 来源文件：');
    });

    it('🔴 有意例外：带失败标注的段可以超过 15000 但不降级（自噬链）', async () => {
      const sources = ['a.md', 'b.md', 'c.md', 'd.md'];
      for (const s of sources) await writeFile(join(projectDir, s), '', 'utf8');
      const overhead = (await evaluateResidentSegment(projectDir, sources)).segment.length;

      // 构造「成功时长度紧贴上限之下」的段：14997（标注 16 字符后会越限）
      const targetLength = MAX_RESIDENT_TOTAL_CHARS - 3;
      const bodies = [4000, 4000, 4000, targetLength - 12000 - overhead];
      for (let i = 0; i < sources.length; i += 1) {
        await writeFile(join(projectDir, sources[i]!), 'k'.repeat(bodies[i]!), 'utf8');
      }

      let fail = false;
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => {
          if (fail) throw new Error('IO 抖动');
          return sources.map((source) => entryOf(source, true));
        },
        isListMalformed: () => false,
      });

      await manager.refresh();
      expect(manager.contextBlock().length).toBeLessThanOrEqual(MAX_RESIDENT_TOTAL_CHARS);

      fail = true;
      await manager.refresh();
      const annotated = manager.contextBlock();
      // 标注行不入预算 ⇒ 段长度 > 15000 是设计预期，规则正文必须仍在
      expect(annotated.length).toBeGreaterThan(MAX_RESIDENT_TOTAL_CHARS);
      expect(annotated).toContain('### 来源文件：a.md');
      expect(annotated).not.toContain('项目常驻规则未注入');
    });

    it('无常驻条目 ⇒ 空段（不注入空壳）', async () => {
      const manager = new ResidentRulesManager({
        projectDir,
        workspaceTrusted: true,
        listEntries: async () => [entryOf('a.md')],
        isListMalformed: () => false,
      });

      await manager.refresh();
      expect(manager.contextBlock()).toBe('');
    });
  });
});
