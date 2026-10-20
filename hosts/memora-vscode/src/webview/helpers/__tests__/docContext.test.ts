/**
 * docContext 纯函数单测：写入/剥离对偶
 * （buildInjectedContextEnvelope ↔ stripInjectedContextPrefix）
 *
 * 覆盖面：写入/剥离对偶的三态（仅文档 / 技能+文档 / 仅技能）+ 关闭标签锚点剥离（用户输入
 * 含「用户请求：」不被误剥）。剥离判据为「消息内含宿主注入块标记」——以 startsWith 文档块
 * 开标签为判据，会在技能块排在文档块之前时整体回显泄露（坑）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildDocContextBlock,
  buildInjectedContextEnvelope,
  buildProblemsContextBlock,
  buildRefContextBlock,
  stripInjectedContextPrefix,
} from '../docContext.js';

const INPUT = '帮我打磨这段';
const SKILL_BLOCK = '【当前技能】design-review\n技能正文…';

/**
 * 诊断行的「路径:行:列」位置串（测试数据）
 *
 * 刻意**拼接**而非写死字面 `文件名.ts:行号`：commentHygiene 守卫对 `src/` 零例外禁行号
 * 字面（它不区分「源码坐标」与「测试数据」），写死即红。
 */
const loc = (line: number, col: number): string => `src/a.ts:${line}:${col}`;

describe('stripInjectedContextPrefix', () => {
  it('剥离文档上下文前缀，只留用户请求', () => {
    const content = buildInjectedContextEnvelope([buildDocContextBlock('# 设计文档')], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('技能块排在文档块之前时同样剥离（不得用 startsWith 开标签判据，会整块回显）', () => {
    const content = buildInjectedContextEnvelope(
      [SKILL_BLOCK, buildDocContextBlock('# 设计文档')],
      INPUT,
    );
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('仅技能块（无文档上下文）时同样剥离', () => {
    const content = buildInjectedContextEnvelope([SKILL_BLOCK], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('仅引用块（右键「添加到对话」，无技能/文档）时同样剥离，只留用户请求', () => {
    const refs = [
      { path: 'src/foo.ts', kind: 'file' as const },
      { path: 'src/utils', kind: 'folder' as const },
    ];
    const content = buildInjectedContextEnvelope([buildRefContextBlock(refs)], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('buildRefContextBlock 目录显式标注按需读取、文件不带后缀', () => {
    const block = buildRefContextBlock([
      { path: 'src/foo.ts', kind: 'file' as const },
      { path: 'src/utils', kind: 'folder' as const },
    ]);
    expect(block).toContain('[参考文件/目录]');
    expect(block).toContain('[/参考文件/目录]');
    expect(block).toContain('- 参考文件：src/foo.ts');
    expect(block).toContain('- 参考目录：src/utils（内容按需经 list_dir 读取）');
  });

  it('带行区间的引用：输出 #L 区间 + read_file 的 offset/limit 参数（引用模式精确到行）', () => {
    const block = buildRefContextBlock([
      { path: 'src/foo.ts', kind: 'file' as const, range: { start: 5, end: 24 } },
    ]);
    expect(block).toContain('- 参考文件：src/foo.ts#L5-L24');
    // 参数由宿主算好，模型不必自己推 limit = end - start + 1（算错即读偏）
    expect(block).toContain('offset=5 limit=20');
    // 行号是指针不是快照：明确提示模型以实际内容为准
    expect(block).toContain('以实际内容为准');
  });

  it('单行区间（start === end）→ limit 为 1，不带冗余区间', () => {
    const block = buildRefContextBlock([
      { path: 'src/foo.ts', kind: 'file' as const, range: { start: 7, end: 7 } },
    ]);
    // 单行折叠成 `#L7`：标签格式唯一产地 = formatRefRange，与 chip 显示同形
    // （旧断言要求 `#L7-L7` —— 那正是「信封与 UI 各写一套」的漂移，与用例标题「不带冗余区间」自相矛盾）
    expect(block).toContain('src/foo.ts#L7');
    expect(block).not.toContain('#L7-L7');
    expect(block).toContain('offset=7 limit=1');
  });

  it('非法区间（start > end）降级为整文件行，不产出负数 limit', () => {
    // range 可能从协议外部上行（webview 构造的 open_ref 载荷）；不归一会算出 limit<=0，
    // 模型据此读不到任何内容且无报错。归一化单点 = normalizeRefRange。
    const block = buildRefContextBlock([
      { path: 'src/foo.ts', kind: 'file' as const, range: { start: 24, end: 5 } },
    ]);
    expect(block).toContain('- 参考文件：src/foo.ts\n');
    expect(block).not.toContain('offset=');
  });

  it('当前打开文件（干净态）作为指针行并入同块，已挂同 path 引用时不重复', () => {
    const withFile = buildRefContextBlock([], 'docs/方案.md');
    expect(withFile).toContain('- 当前打开文件：docs/方案.md（内容未注入，按需经 read_file 读取）');
    // 已显式挂同一文件 ⇒ 引用行已经告诉模型，不再追加
    const dup = buildRefContextBlock(
      [{ path: 'docs/方案.md', kind: 'file' as const }],
      'docs/方案.md',
    );
    expect(dup).not.toContain('当前打开文件');
    // 无引用且无当前文件 ⇒ 空串（调用方据此不产空信封）
    expect(buildRefContextBlock([], undefined)).toBe('');
  });

  it('无前缀消息原样返回（resume 补写 / 无上下文场景）', () => {
    expect(stripInjectedContextPrefix('普通对话消息')).toBe('普通对话消息');
  });

  it('用户输入含「用户请求：」不被误剥（关闭标签锚点）', () => {
    // 注入 marker 总紧跟关闭标签；用户 input 内的「用户请求：」出现在其后，应保留
    const content =
      `[当前打磨文档内容]\n# 设计文档\n[/当前打磨文档内容]\n\n` +
      `用户请求：请改写这句\n\n用户请求：这句是用户输入里的`;
    expect(stripInjectedContextPrefix(content)).toBe('请改写这句\n\n用户请求：这句是用户输入里的');
  });

  it('仅技能块 + 用户输入含「用户请求：」不被误剥', () => {
    const content = `${SKILL_BLOCK}\n\n用户请求：请改写这句\n\n用户请求：这句是用户输入里的`;
    expect(stripInjectedContextPrefix(content)).toBe('请改写这句\n\n用户请求：这句是用户输入里的');
  });

  it('文档正文自带「用户请求：」字样不被误剥（关闭标签锚点）', () => {
    const doc = '# 设计文档\n\n用户请求：这段是文档正文里的字样';
    const content = buildInjectedContextEnvelope([buildDocContextBlock(doc)], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('普通消息含「用户请求：」但无注入块标记 → 不剥离', () => {
    const content = '先看这段\n\n用户请求：这只是一条普通消息';
    expect(stripInjectedContextPrefix(content)).toBe(content);
  });

  it('缺少关闭标签时原样返回（不误剥）', () => {
    const content = '[当前打磨文档内容]\n无关闭标签的异常消息';
    expect(stripInjectedContextPrefix(content)).toBe(content);
  });

  it('缺少分隔 marker 时原样返回', () => {
    const content = '[当前打磨文档内容]\n内容\n[/当前打磨文档内容]';
    expect(stripInjectedContextPrefix(content)).toBe(content);
  });

  // ── HOST-CTX-4：诊断块是**成对块**，剥离侧锚点须覆盖它的闭标签 ──
  it('诊断块（@problems）与文档块同为成对块 → 剥离只留用户请求', () => {
    const content = buildInjectedContextEnvelope(
      [buildProblemsContextBlock('共 1 条诊断…')],
      INPUT,
    );
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('诊断正文 / 源码行自带「用户请求：」字样不被误剥（闭标签锚点，同文档块）', () => {
    // 诊断块内可能整行抄源码——源码里出现「用户请求：」是完全可能的
    const body = `- ${loc(1, 1)} [错误] 未定义变量\n    源码：const s = "用户请求：字面量";`;
    const content = buildInjectedContextEnvelope([buildProblemsContextBlock(body)], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('诊断块正文自带**空行 + 「用户请求：」** → 锚点取诊断块闭标签之后（防回显泄漏）', () => {
    // 判据锚点必须能把块内字样排除在搜索区外：分隔符是 `\n\n用户请求：`（带空行），
    // 块内出现同样的空行 + 字样时，若锚点不认诊断块闭标签，就会从块内截断 ⇒ 诊断正文
    // 被当成用户请求回显给用户（CTX-5 同款泄漏形态）。
    // ⚠️ 现状说明（诚实）：`@problems` 正文经采集器 clip 压平（无空行），本例当前是**纵深**
    // 而非可达路径；终端输出块（正文不压平）落地时必须同样登记进 paired，否则锚点失效。
    const body = `- ${loc(1, 1)} [错误] x\n\n用户请求：这段是块内字样`;
    const content = buildInjectedContextEnvelope([buildProblemsContextBlock(body)], INPUT);
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });

  it('文档块与诊断块并存 → 锚点取**两者中更靠后**的闭标签（不互相遮蔽）', () => {
    // 诊断块在后：若只认文档块闭标签，搜索区会从文档块末尾起，命中块内字样即误剥
    const content = buildInjectedContextEnvelope(
      [buildDocContextBlock('用户请求：文档里的字样'), buildProblemsContextBlock('共 1 条诊断…')],
      INPUT,
    );
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
    // 反序（诊断在前）同样成立
    const flipped = buildInjectedContextEnvelope(
      [buildProblemsContextBlock('用户请求：诊断里的字样'), buildDocContextBlock('# 文档')],
      INPUT,
    );
    expect(stripInjectedContextPrefix(flipped)).toBe(INPUT);
  });

  it('仅诊断块（无技能 / 文档 / 引用）→ 判据 1 命中即剥离', () => {
    const content = buildInjectedContextEnvelope(
      [buildProblemsContextBlock('当前工作区没有错误或警告诊断。')],
      INPUT,
    );
    expect(stripInjectedContextPrefix(content)).toBe(INPUT);
  });
});

describe('buildInjectedContextEnvelope ↔ stripInjectedContextPrefix 对偶', () => {
  it('无任何块时不注入信封（chatInput 即用户原文，不含分隔符）', () => {
    const built = buildInjectedContextEnvelope([undefined, ''], INPUT);
    expect(built).toBe(INPUT);
    expect(built).not.toContain('用户请求：');
  });

  it('三态信封剥离后均还原用户原文（对称的另一半）', () => {
    const docBlock = buildDocContextBlock('# 文档\n多行内容');
    const shapes: string[][] = [[SKILL_BLOCK], [docBlock], [SKILL_BLOCK, docBlock]];
    for (const blocks of shapes) {
      expect(stripInjectedContextPrefix(buildInjectedContextEnvelope(blocks, INPUT))).toBe(INPUT);
    }
  });
});

// HOST-CTX-9 发送侧：失效引用（添加后文件已删 / 改名）降级为「裸指针 + 标记」。
// 核心纪律「绝不给 read_file 一条必然失败的指令」——死文件上连 #L 区间与 offset/limit
// 也必须去掉（同样注定读空），故断言不仅查标记，还断言参数形态消失。
describe('引用失效标记（发送前 stat 降级）', () => {
  it('失效文件引用 → 裸指针 + 标记，去掉 #L 区间与 read_file 参数', () => {
    const block = buildRefContextBlock(
      [
        { path: 'src/gone.ts', kind: 'file' as const, range: { start: 5, end: 24 } },
        { path: 'src/ok.ts', kind: 'file' as const, range: { start: 1, end: 3 } },
      ],
      undefined,
      new Set(['src/gone.ts']),
    );
    expect(block).toContain('- 参考文件：src/gone.ts（注意：添加后已不存在，请向用户确认）');
    // 死文件不得带 #L 区间与 offset/limit（与「无 range」同一条纪律）
    expect(block).not.toContain('src/gone.ts#L');
    expect(block).not.toContain('offset=5');
    // 未失效引用不受影响，仍带精确读参数
    expect(block).toContain('src/ok.ts#L1-L3');
    expect(block).toContain('offset=1 limit=3');
  });

  it('失效且无 range → 同样裸指针 + 标记', () => {
    const block = buildRefContextBlock(
      [{ path: 'src/gone.ts', kind: 'file' as const }],
      undefined,
      new Set(['src/gone.ts']),
    );
    expect(block).toContain('- 参考文件：src/gone.ts（注意：添加后已不存在，请向用户确认）');
  });

  it('目录引用即使传入 missingPaths 也不标（目录不检测）', () => {
    const block = buildRefContextBlock(
      [{ path: 'src/utils', kind: 'folder' as const }],
      undefined,
      new Set(['src/utils']),
    );
    expect(block).toContain('- 参考目录：src/utils（内容按需经 list_dir 读取）');
    expect(block).not.toContain('已不存在');
  });

  it('未命中失效集合 → 引用行与当前文件行原样（向后兼容：第三参缺省亦同）', () => {
    const block = buildRefContextBlock(
      [{ path: 'src/ok.ts', kind: 'file' as const }],
      'docs/方案.md',
      new Set(['other.ts']),
    );
    expect(block).toContain('- 参考文件：src/ok.ts');
    expect(block).toContain('- 当前打开文件：docs/方案.md（内容未注入，按需经 read_file 读取）');
    expect(block).not.toContain('已不存在');
    // 缺省第三参（旧调用点）行为不变
    expect(buildRefContextBlock([{ path: 'src/ok.ts', kind: 'file' as const }])).toContain(
      '- 参考文件：src/ok.ts',
    );
  });
});
