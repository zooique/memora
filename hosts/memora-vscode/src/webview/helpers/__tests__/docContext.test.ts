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
  buildRefContextBlock,
  stripInjectedContextPrefix,
} from '../docContext.js';

const INPUT = '帮我打磨这段';
const SKILL_BLOCK = '【当前技能】design-review\n技能正文…';

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
