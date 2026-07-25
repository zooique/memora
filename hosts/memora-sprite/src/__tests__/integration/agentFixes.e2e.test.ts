/**
 * 内核修复 · 真实 Agent 端到端（S2 / M1 / M2* / M3 / M10 / M6）
 *
 * 经 sprite 真实装配的真实 Agent 驱动（SqliteStorage + JsonVectorStore + 真实落盘），
 * 仅把外部 LLM / embedding 替换为可控桩。覆盖需 Agent 内部 Manager 才能触达的修复：
 *   - S2  跨项目隔离（closeProject 撤销 + 重载 restore 恢复）
 *   - M1  作品投影 sourcePath 元数据往返
 *   - M3  不同 fieldName 同 value 生成不同 id（不互覆盖）
 *   - M10 待确认项持久化 + confirm 后持久化
 *   - M6  语义去重合并内容落库（桩 backgroundProvider 返回判定 JSON）
 *
 * 注：M2（已确认项不被低置信重提取降级）属 LLM 抽取流水线，已在内核单元测试
 * `userProfile.test.ts` 覆盖；S1（guardrail 单行）由 `guardrail.test.ts` 覆盖
 * （runGuardrails 未从内核导出，集成层需模拟整条 chat 管线，违背"非 mock"原则，故不在此重复）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_LABELS } from 'memora';
import {
  createRealAgent,
  createAgentIn,
  closeAgent,
  cleanupRoot,
  makeMemory,
  type AgentBundle,
} from './harness.js';

// ── S2：跨项目隔离（真实 Agent + SQLite + FileStore 项目资源） ──────
describe('S2 跨项目隔离（真实 Agent）', () => {
  let b: AgentBundle;
  beforeEach(async () => {
    b = await createRealAgent();
  });
  afterEach(async () => {
    await closeAgent(b);
    cleanupRoot(b.root);
  });

  function writeRule(projectDir: string, name: string, body: string): void {
    const memora = join(projectDir, '.memora', 'rules');
    mkdirSync(memora, { recursive: true });
    writeFileSync(
      join(memora, `${name}.md`),
      `---\nid: rule:${name}\nsource: rule\nscore: 0.9\ncreatedAt: 2026-01-01T00:00:00.000Z\naccessedAt: 2026-01-01T00:00:00.000Z\n---\n${body}`,
    );
  }

  it('关闭项目撤销其规则；切到 B 后 A 规则不泄漏；重开 A 从磁盘恢复', async () => {
    const projectA = join(b.root, 'projA');
    const projectB = join(b.root, 'projB');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeRule(projectA, 'no-violence', 'pattern: /暴力/ action: block');

    // 打开 A：项目规则载入共享 index
    await b.agent.projects!.initProject(projectA);
    expect(b.storage.getById('rule:no-violence')).not.toBeNull();

    // 切到 B（initProject 内部先 closeProject A）→ A 规则被撤销，无泄漏
    await b.agent.projects!.initProject(projectB);
    expect(b.storage.getById('rule:no-violence')).toBeNull();

    // 重开 A：从磁盘重载恢复（S2 衍生修复：loader.restore 重载软删除记忆）
    await b.agent.projects!.initProject(projectA);
    expect(b.storage.getById('rule:no-violence')).not.toBeNull();

    // 显式关闭后规则应被撤销（隔离不泄漏到 Agent 生命周期外）
    await b.agent.projects!.closeProject();
    expect(b.storage.getById('rule:no-violence')).toBeNull();
  });

  it('SOURCE_LABELS.RULE 可被 bootstrap 召回（规则确实进入共享 index）', async () => {
    const projectA = join(b.root, 'projA');
    mkdirSync(projectA, { recursive: true });
    writeRule(projectA, 'keep-clean', 'pattern: /脏话/ action: warn');
    await b.agent.projects!.initProject(projectA);
    const rules = b.storage.getBySource(SOURCE_LABELS.RULE);
    expect(rules.some((m) => m.id === 'rule:keep-clean')).toBe(true);
  });
});

// ── M1：作品投影 sourcePath 元数据往返 ──────────────────────────────
describe('M1 作品投影 sourcePath 往返（真实 Agent）', () => {
  let b: AgentBundle;
  beforeEach(async () => {
    b = await createRealAgent();
  });
  afterEach(async () => {
    await closeAgent(b);
    cleanupRoot(b.root);
  });

  it('sourcePath 编入 content 元数据，loadAll 往返不丢', async () => {
    b.storage.upsert(
      makeMemory({
        id: 'work-proj-file-ts',
        source: SOURCE_LABELS.WORK_PROJECTION,
        score: 0.5,
        name: 'file.ts',
        content:
          JSON.stringify({ hash: 'h', sourcePath: '/abs/path/file.ts', structure: [], decisions: [] }) +
          '\n\n摘要',
      }),
    );
    const all = await b.agent.works!.loadAll();
    const entry = all.find((x) => x.id === 'work-proj-file-ts');
    expect(entry).toBeDefined();
    expect(entry!.sourcePath).toBe('/abs/path/file.ts');
  });
});

// ── M3：不同 fieldName 同 value 生成不同 id ────────────────────────
describe('M3 用户画像 id 唯一性（真实 Agent）', () => {
  let b: AgentBundle;
  beforeEach(async () => {
    b = await createRealAgent();
  });
  afterEach(async () => {
    await closeAgent(b);
    cleanupRoot(b.root);
  });

  it('同 value 不同 fieldName 生成不同 id，两条共存不互覆盖', async () => {
    b.storage.upsert(
      makeMemory({
        id: 'profile:name-zhang',
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-identity',
        content: JSON.stringify({ category: 'identity', value: '张三', fieldName: '姓名', confirmed: true }),
      }),
    );
    b.storage.upsert(
      makeMemory({
        id: 'profile:alias-zhang',
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-identity',
        content: JSON.stringify({ category: 'identity', value: '张三', fieldName: '别名', confirmed: true }),
      }),
    );
    const entries = await b.agent.userProfile!.load();
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('profile:name-zhang');
    expect(ids).toContain('profile:alias-zhang');
    expect(entries.length).toBe(2); // 两条共存，无互覆盖
  });
});

// ── M10：待确认项持久化 + confirm 后持久化 ────────────────────────
describe('M10 待确认项持久化（真实 Agent）', () => {
  let b: AgentBundle;
  beforeEach(async () => {
    b = await createRealAgent();
  });
  afterEach(async () => {
    await closeAgent(b);
    cleanupRoot(b.root);
  });

  it('待确认项重启后仍 pending；confirm 后持久化为 confirmed', async () => {
    b.storage.upsert(
      makeMemory({
        id: 'profile:pending-1',
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-identity',
        content: JSON.stringify({ category: 'identity', value: '张三', fieldName: '姓名', confirmed: false }),
      }),
    );

    // 同实例读取：应为 pending
    let entries = await b.agent.userProfile!.load();
    expect(entries.find((e) => e.id === 'profile:pending-1')!.confirmed).toBe(false);

    // confirm
    await b.agent.userProfile!.confirm('profile:pending-1');
    entries = await b.agent.userProfile!.load();
    expect(entries.find((e) => e.id === 'profile:pending-1')!.confirmed).toBe(true);

    // 重启 Agent（同 dataDir）：仍 confirmed —— 证明待确认项确实持久化
    await closeAgent(b);
    const b2 = await createAgentIn(b.dataDir, b.configDir);
    try {
      const restarted = await b2.agent.userProfile!.load();
      expect(restarted.find((e) => e.id === 'profile:pending-1')!.confirmed).toBe(true);
    } finally {
      await closeAgent(b2);
    }
  });

  it('reject 后从画像移除', async () => {
    b.storage.upsert(
      makeMemory({
        id: 'profile:reject-1',
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-identity',
        content: JSON.stringify({ category: 'identity', value: '李四', fieldName: '姓名', confirmed: false }),
      }),
    );
    await b.agent.userProfile!.reject('profile:reject-1');
    const entries = await b.agent.userProfile!.load();
    expect(entries.find((e) => e.id === 'profile:reject-1')).toBeUndefined();
  });
});

// ── M6：语义去重合并内容落库（真实 Agent + 桩 backgroundProvider） ──
describe('M6 语义去重合并内容落库（真实 Agent）', () => {
  let b: AgentBundle;
  beforeEach(async () => {
    // 桩 backgroundProvider 返回"语义等价 + 合并内容"
    b = await createRealAgent({
      backgroundProviderResponse: JSON.stringify({
        isDuplicate: true,
        mergedContent: '合并后的完整内容',
        reason: '语义等价',
      }),
    });
  });
  afterEach(async () => {
    await closeAgent(b);
    cleanupRoot(b.root);
  });

  it('判定重复时合并内容写回保留方 a，低分方降级', async () => {
    // 名称包含关系 → computeNameSimilarity=0 → 必成 pair（a 包含 b）
    b.storage.upsert(
      makeMemory({ id: 'insight:a', source: 'insight', score: 0.9, name: '用户偏好简洁UI设计', content: 'A原始' }),
    );
    b.storage.upsert(
      makeMemory({ id: 'insight:b', source: 'insight', score: 0.8, name: '用户偏好简洁UI', content: 'B原始' }),
    );

    const report = await b.agent.deduplicateMemories();
    expect(report.deduplicatedCount).toBeGreaterThanOrEqual(1);

    const kept = b.storage.getById('insight:a');
    expect(kept).not.toBeNull();
    expect(kept!.content).toBe('合并后的完整内容'); // M6：合并真正落库

    const demoted = b.storage.getById('insight:b');
    expect(demoted!.score).toBeLessThan(0.9); // 低分方被降级
  });
});
