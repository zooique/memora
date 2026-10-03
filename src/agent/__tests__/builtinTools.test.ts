/**
 * builtinTools.ts 单元测试
 *
 * 覆盖 BUILTIN_TOOLS 数组的结构完整性：
 *   - 工具数量与名称
 *   - 每个工具的 schema 结构（type/properties/required）
 *   - 必填参数正确性
 *   - 工具名唯一性
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_BUILTIN_TOOL_DEFS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_IDEMPOTENCY,
  OPAQUE_WRITE_TOOL_NAMES,
  PATH_WRITE_TOOL_NAMES,
  shouldSkipForIdempotency,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  RUN_CODE_TOOL,
  buildRunCodeTool,
  SEARCH_PROJECT_TOOL,
  WRITE_FILE_MODES,
  type ToolDefinition,
} from '@/agent/builtinTools.js';
import { WRITE_PATH_EXTRACTORS } from '@/agent/toolResultCache.js';
import { isReservedTaskTableFile } from '@/agent/builtinToolHandlers.js';
import { PLAN_NUDGE_PROMPT } from '@/agent/needsPlanning.js';
import { buildTeamContextBlockText } from '@/role-pack/rolePackManager.js';
import type { IdempotencyLevel, ToolExecutionRecord } from '@/agent/types.js';

describe('builtinToolHandlers · isReservedTaskTableFile（任务表保留名，2026-09-07 伪建表根治）', () => {
  it('命中任务表保留名（write_file 守卫拦截）', () => {
    expect(isReservedTaskTableFile('C:/proj/task-table.md')).toBe(true);
    expect(isReservedTaskTableFile('C:/proj/task_table.md')).toBe(true);
    expect(isReservedTaskTableFile('C:/proj/task-table-进度.md')).toBe(true);
    expect(isReservedTaskTableFile('C:/proj/.memora/task-table.md')).toBe(true);
    expect(isReservedTaskTableFile('C:/proj/任务表.md')).toBe(true);
    expect(isReservedTaskTableFile('C:/proj/Task-Table.md')).toBe(true); // 大小写不敏感
  });

  it('不误伤普通文件（保留名外路径照常可写）', () => {
    expect(isReservedTaskTableFile('C:/proj/README.md')).toBe(false);
    expect(isReservedTaskTableFile('C:/proj/tasklist.md')).toBe(false);
    expect(isReservedTaskTableFile('C:/proj/task-board.md')).toBe(false);
    expect(isReservedTaskTableFile('C:/proj/table.md')).toBe(false);
    expect(isReservedTaskTableFile('C:/proj/docs/项目计划.md')).toBe(false);
  });
});

describe('builtinTools · BUILTIN_TOOLS', () => {
  // ─── 数量与名称 ────────────────────────────────────────────

  it('应包含 22 个内置工具', () => {
    expect(BUILTIN_TOOLS).toHaveLength(22);
  });

  it('应包含 read_file / write_file / delete_file / list_dir / search_memories / trace_summary / list_sessions', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('delete_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('search_memories');
    expect(names).toContain('trace_summary');
    expect(names).toContain('list_sessions');
  });

  it('应包含第二级压缩工具 compress_context（LLM 主动触发兜底）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('compress_context');
  });

  it('应包含 L2/L3 渐进披露工具（read_skill / read_resource / run_skill_script / list_resources / list_skills）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_skill');
    expect(names).toContain('read_resource');
    expect(names).toContain('run_skill_script');
    expect(names).toContain('list_resources');
    expect(names).toContain('list_skills');
  });

  it('应包含作品投影登记工具 register_work（用户主动触发登记索引卡片）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('register_work');
    expect(BUILTIN_TOOL_IDEMPOTENCY.register_work).toBe('idempotent-key');
  });

  it('delete_file 应注册为内置工具且禁止幂等跳过（临时脚本闭环收尾：清理一次性脚本不留痕）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('delete_file');
    // 归类 non-idempotent 是「禁止跳过」而非「重跑有害」：重跑由 deleteFile 内部 ENOENT 兜底，无害。
    // 禁止跳过的原因：删除的目标态可被 write_file 重建，而幂等键只有 name+args、不含文件状态，
    // 标幂等会让同会话内第二次「写 → 执行 → 删」闭环被静默跳过 → 脚本残留且 LLM 收到假的「已删除」。
    expect(BUILTIN_TOOL_IDEMPOTENCY.delete_file).toBe('non-idempotent');
    const def = BUILTIN_TOOLS.find((t) => t.name === 'delete_file')!;
    expect(def.parameters.required).toContain('path');
  });

  it('read_skill 应注册为内置工具且标记 read-only（读操作，永不跳过）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_skill');
    expect(BUILTIN_TOOL_IDEMPOTENCY.read_skill).toBe('read-only');
  });

  it('工具名应唯一（无重复）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  // ─── schema 结构完整性 ────────────────────────────────────

  it('每个工具都应有非空 description', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('每个工具的 parameters.type 都应是 "object"', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.parameters.type).toBe('object');
    }
  });

  it('每个工具都应有 properties 字段（Record 类型）', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.parameters.properties).toBeDefined();
      expect(typeof tool.parameters.properties).toBe('object');
    }
  });

  it('每个工具都应有 required 数组（可为空）', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });

  // ─── read_file 具体契约 ───────────────────────────────────

  it('read_file 应要求 path 参数', () => {
    const readFile = BUILTIN_TOOLS.find((t) => t.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.parameters.required).toContain('path');
    expect(readFile!.parameters.properties.path).toBeDefined();
    expect(readFile!.parameters.properties.path!.type).toBe('string');
  });

  // ─── write_file 具体契约 ──────────────────────────────────

  it('write_file 应要求 path 和 content 参数', () => {
    const writeFile = BUILTIN_TOOLS.find((t) => t.name === 'write_file');
    expect(writeFile).toBeDefined();
    expect(writeFile!.parameters.required).toContain('path');
    expect(writeFile!.parameters.required).toContain('content');
    // 可选参数：mode / insert_line / old_string
    expect(writeFile!.parameters.properties.mode).toBeDefined();
    expect(writeFile!.parameters.properties.insert_line).toBeDefined();
    expect(writeFile!.parameters.properties.old_string).toBeDefined();
  });

  it('write_file mode 描述与 WRITE_FILE_MODES 同源（防描述/校验双源漂移）', () => {
    const writeFile = BUILTIN_TOOLS.find((t) => t.name === 'write_file')!;
    const modeDesc = writeFile.parameters.properties.mode!.description;
    // 描述须逐一列出单一真理源里的每个模式名（漏一处即说明又退回手工硬编码）
    for (const m of WRITE_FILE_MODES) {
      expect(modeDesc).toContain(m.name);
    }
    // 校验清单同样派生自该表：表里没有的 mode 必被拒
    expect(WRITE_FILE_MODES.map((m) => m.name)).toContain('replace');
  });

  // ─── list_dir 具体契约 ────────────────────────────────────

  it('list_dir 不应有必填参数（path 可选，默认项目根）', () => {
    const listDir = BUILTIN_TOOLS.find((t) => t.name === 'list_dir');
    expect(listDir).toBeDefined();
    expect(listDir!.parameters.required).toEqual([]);
    // 可选参数：path / recursive / maxDepth
    expect(listDir!.parameters.properties.path).toBeDefined();
    expect(listDir!.parameters.properties.recursive).toBeDefined();
    expect(listDir!.parameters.properties.maxDepth).toBeDefined();
  });

  // ─── search_memories 具体契约 ─────────────────────────────

  it('search_memories 应要求 query 参数', () => {
    const searchMemories = BUILTIN_TOOLS.find((t) => t.name === 'search_memories');
    expect(searchMemories).toBeDefined();
    expect(searchMemories!.parameters.required).toContain('query');
    // 可选参数：limit / mode
    expect(searchMemories!.parameters.properties.limit).toBeDefined();
    expect(searchMemories!.parameters.properties.mode).toBeDefined();
  });

  it('search_memories 描述含关键词检索与按需召回 + 换词重试引导（§3.3 工具升级定案 / B0 收编）', () => {
    const searchMemories = BUILTIN_TOOLS.find((t) => t.name === 'search_memories');
    // 引导：纯关键词检索（语义向量通道已收编移除），涉及过往决定/偏好/项目背景时主动按需召回；
    // 揭示 accessedAt 辅助排序；未命中提示换词重试（LLM 承担词汇桥梁）
    expect(searchMemories!.description).toContain('关键词检索记忆库');
    expect(searchMemories!.description).toContain('按需召回');
    expect(searchMemories!.description).toContain('accessedAt');
    expect(searchMemories!.description).toContain('换表述重试');
  });

  // ─── ToolDefinition 类型守卫 ──────────────────────────────

  it('所有工具应符合 ToolDefinition 类型约束', () => {
    for (const tool of BUILTIN_TOOLS) {
      // 类型守卫：确保结构完整
      const isValid: ToolDefinition = {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: tool.parameters.type,
          properties: tool.parameters.properties,
          required: tool.parameters.required,
        },
      };
      expect(isValid.name).toBe(tool.name);
    }
  });
});

describe('builtinTools · WEB_SEARCH_TOOL', () => {
  it('应定义 web_search 工具', () => {
    expect(WEB_SEARCH_TOOL).toBeDefined();
    expect(WEB_SEARCH_TOOL.name).toBe('web_search');
  });

  it('应有非空 description', () => {
    expect(WEB_SEARCH_TOOL.description).toBeTruthy();
    expect(WEB_SEARCH_TOOL.description.length).toBeGreaterThan(10);
  });

  it('parameters.type 应为 "object"', () => {
    expect(WEB_SEARCH_TOOL.parameters.type).toBe('object');
  });

  it('应定义 query 和 limit 参数', () => {
    expect(WEB_SEARCH_TOOL.parameters.properties.query).toBeDefined();
    expect(WEB_SEARCH_TOOL.parameters.properties.query!.type).toBe('string');
    expect(WEB_SEARCH_TOOL.parameters.properties.limit).toBeDefined();
    expect(WEB_SEARCH_TOOL.parameters.properties.limit!.type).toBe('string');
  });

  it('query 应为必填参数', () => {
    expect(WEB_SEARCH_TOOL.parameters.required).toContain('query');
  });

  it('limit 应为可选参数（不在 required 中）', () => {
    expect(WEB_SEARCH_TOOL.parameters.required).not.toContain('limit');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: WEB_SEARCH_TOOL.name,
      description: WEB_SEARCH_TOOL.description,
      parameters: {
        type: WEB_SEARCH_TOOL.parameters.type,
        properties: WEB_SEARCH_TOOL.parameters.properties,
        required: WEB_SEARCH_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(WEB_SEARCH_TOOL.name);
  });
});

describe('builtinTools · WEB_FETCH_TOOL（搜索→抓取闭环第二段）', () => {
  it('应定义 web_fetch 工具', () => {
    expect(WEB_FETCH_TOOL).toBeDefined();
    expect(WEB_FETCH_TOOL.name).toBe('web_fetch');
  });

  it('应标记为只读工具（readonly=true，抓取读正文）', () => {
    expect(WEB_FETCH_TOOL.readonly).toBe(true);
  });

  it('应有非空 description 且提及搜索→抓取闭环', () => {
    expect(WEB_FETCH_TOOL.description).toBeTruthy();
    expect(WEB_FETCH_TOOL.description.length).toBeGreaterThan(10);
    expect(WEB_FETCH_TOOL.description).toContain('web_search');
  });

  it('parameters.type 应为 "object"', () => {
    expect(WEB_FETCH_TOOL.parameters.type).toBe('object');
  });

  it('应定义 url 和 limit 参数', () => {
    expect(WEB_FETCH_TOOL.parameters.properties.url).toBeDefined();
    expect(WEB_FETCH_TOOL.parameters.properties.url!.type).toBe('string');
    expect(WEB_FETCH_TOOL.parameters.properties.limit).toBeDefined();
    expect(WEB_FETCH_TOOL.parameters.properties.limit!.type).toBe('string');
  });

  it('url 应为必填参数，limit 可选', () => {
    expect(WEB_FETCH_TOOL.parameters.required).toContain('url');
    expect(WEB_FETCH_TOOL.parameters.required).not.toContain('limit');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: WEB_FETCH_TOOL.name,
      description: WEB_FETCH_TOOL.description,
      readonly: WEB_FETCH_TOOL.readonly,
      parameters: {
        type: WEB_FETCH_TOOL.parameters.type,
        properties: WEB_FETCH_TOOL.parameters.properties,
        required: WEB_FETCH_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(WEB_FETCH_TOOL.name);
  });
});

describe('builtinTools · RUN_CODE_TOOL（通用计算/验证底座）', () => {
  it('应定义 run_code 工具', () => {
    expect(RUN_CODE_TOOL).toBeDefined();
    expect(RUN_CODE_TOOL.name).toBe('run_code');
  });

  it('应有非空 description 且说明源码不进上下文', () => {
    expect(RUN_CODE_TOOL.description).toBeTruthy();
    expect(RUN_CODE_TOOL.description.length).toBeGreaterThan(10);
    expect(RUN_CODE_TOOL.description).toContain('源码不进入上下文');
  });

  it('parameters.type 应为 "object"', () => {
    expect(RUN_CODE_TOOL.parameters.type).toBe('object');
  });

  it('应定义 language 和 code 参数', () => {
    expect(RUN_CODE_TOOL.parameters.properties.language).toBeDefined();
    expect(RUN_CODE_TOOL.parameters.properties.language!.type).toBe('string');
    expect(RUN_CODE_TOOL.parameters.properties.code).toBeDefined();
    expect(RUN_CODE_TOOL.parameters.properties.code!.type).toBe('string');
  });

  it('应定义 script_path 参数且无全量必填（code 与 script_path 两模式二选一）', () => {
    // code 模式（language+code）与 script_path 模式互斥，故无单参数可标全量必填
    expect(RUN_CODE_TOOL.parameters.properties.script_path).toBeDefined();
    expect(RUN_CODE_TOOL.parameters.properties.script_path!.type).toBe('string');
    expect(RUN_CODE_TOOL.parameters.required).toHaveLength(0);
    // description 引导「临时脚本」闭环（写 → 执行 → 删除，不留痕）
    expect(RUN_CODE_TOOL.description).toContain('script_path');
    expect(RUN_CODE_TOOL.description).toContain('delete_file');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: RUN_CODE_TOOL.name,
      description: RUN_CODE_TOOL.description,
      parameters: {
        type: RUN_CODE_TOOL.parameters.type,
        properties: RUN_CODE_TOOL.parameters.properties,
        required: RUN_CODE_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(RUN_CODE_TOOL.name);
  });

  it('buildRunCodeTool 未声明语言 → 描述不列举任何语言名（§11.6 防回归锁）', () => {
    // 未声明（undefined）与空数组两种形态都必须退化为去承诺文案：
    // 防「悄悄开始列举」回归——对未声明支持的宿主列举语言 = 对模型说谎（§10.3 同型伤）
    for (const def of [buildRunCodeTool(), buildRunCodeTool([])]) {
      const langDesc = def.parameters.properties.language!.description;
      expect(langDesc).not.toContain('支持：');
      expect(langDesc).not.toContain('python');
      expect(langDesc).not.toContain('javascript');
      // 去承诺文案保留（由宿主决定的如实声明）
      expect(langDesc).toContain('由宿主执行器决定');
    }
  });

  it('buildRunCodeTool 声明语言 → 描述按实际生成「支持：a、b、c」', () => {
    const def = buildRunCodeTool(['javascript', 'js', 'nodejs', 'node']);
    const langDesc = def.parameters.properties.language!.description;
    // 列举与声明逐一对应（描述从声明派生，非独立字面量）
    expect(langDesc).toContain('当前执行器支持：javascript、js、nodejs、node');
    // 未声明语言不得出现（描述宽度 = 声明宽度，不外溢）
    expect(langDesc).not.toContain('python');
    // 其他字段与缺省形态一致（name/diskWrite 不随声明变化——写盘索引依赖稳定）
    expect(def.name).toBe('run_code');
    expect(def.diskWrite).toBe('opaque');
  });
});

describe('builtinTools · SEARCH_PROJECT_TOOL（项目内搜索，等价 IDE 全局搜索）', () => {
  it('应定义 search_project 工具', () => {
    expect(SEARCH_PROJECT_TOOL).toBeDefined();
    expect(SEARCH_PROJECT_TOOL.name).toBe('search_project');
  });

  it('应标记为只读工具（readonly=true，只读搜索不修改文件）', () => {
    expect(SEARCH_PROJECT_TOOL.readonly).toBe(true);
  });

  it('应有非空 description 且提及项目/搜索语义', () => {
    expect(SEARCH_PROJECT_TOOL.description).toBeTruthy();
    expect(SEARCH_PROJECT_TOOL.description.length).toBeGreaterThan(10);
    expect(SEARCH_PROJECT_TOOL.description).toContain('搜索');
    expect(SEARCH_PROJECT_TOOL.description).toContain('read_file');
  });

  it('parameters.type 应为 "object"', () => {
    expect(SEARCH_PROJECT_TOOL.parameters.type).toBe('object');
  });

  it('应定义 query/mode/exclude/maxResults 参数', () => {
    const props = SEARCH_PROJECT_TOOL.parameters.properties;
    expect(props.query).toBeDefined();
    expect(props.mode).toBeDefined();
    expect(props.exclude).toBeDefined();
    expect(props.maxResults).toBeDefined();
    expect(props.query!.type).toBe('string');
    expect(props.mode!.type).toBe('string');
  });

  it('所有参数均应可选（不在 required 中，query 省略时列出项目文件清单）', () => {
    expect(SEARCH_PROJECT_TOOL.parameters.required).toHaveLength(0);
  });

  it('search_project 应为 read-only（只读搜索，永不跳过）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.search_project).toBe('read-only');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: SEARCH_PROJECT_TOOL.name,
      description: SEARCH_PROJECT_TOOL.description,
      readonly: SEARCH_PROJECT_TOOL.readonly,
      parameters: {
        type: SEARCH_PROJECT_TOOL.parameters.type,
        properties: SEARCH_PROJECT_TOOL.parameters.properties,
        required: SEARCH_PROJECT_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(SEARCH_PROJECT_TOOL.name);
  });
});

describe('builtinTools · 任务表描述命令式强化', () => {
  it('task_table_write 描述应命令式引导「先拆解再逐步执行」并衔接 task_table_update', () => {
    const def = BUILTIN_TOOLS.find((t) => t.name === 'task_table_write')!;
    // 命令式强化：多步任务必须拆解建表，禁止跳过拆解一次性盲目执行
    expect(def.description).toContain('多步任务必须先用本工具把任务拆解');
    expect(def.description).toContain('禁止跳过拆解一次性盲目执行');
    // 行为闭环：写表后明确用 task_table_update 逐步标记
    expect(def.description).toContain('task_table_update');
    // mode 词表对拍（TASKTABLE-NAME-1 收口）：描述与执行器判据是同一词表的两处表达，
    // 防描述漂移回旧词 update（模型被告知 update、执行器只认 replace → 永久报错循环）
    expect(def.description).toContain('replace 模式');
    expect(def.description).not.toContain('update 模式');
    const modeDesc = def.parameters.properties['mode']?.description ?? '';
    expect(modeDesc).toContain('"replace"');
    expect(modeDesc).not.toContain('"update"');
  });

  it('task_table_update 描述应明确「一次只更新一步」并禁止批量宣告完成', () => {
    const def = BUILTIN_TOOLS.find((t) => t.name === 'task_table_update')!;
    expect(def.description).toContain('一次只更新一个任务项');
    expect(def.description).toContain('禁止一次性批量标记所有任务项');
  });

  it('任务表描述应包含「先产出、后标记」顺序纪律（L1，2026-09-17：形态② 单写者语义）', () => {
    // 形态② 下 plan 推进唯一写者 = LLM 的 task_table_update；标记 done 前必须先完成该步实际产出
    //（先标后产会让内容错归下一步 + 渲染器「已完成」误导 LLM 不再产出）。两处工具描述同步锁死。
    const update = BUILTIN_TOOLS.find((t) => t.name === 'task_table_update')!;
    expect(update.description).toContain('先产出、后标记');
    expect(update.description).toContain('禁止先标记 done 再补产出');
    const write = BUILTIN_TOOLS.find((t) => t.name === 'task_table_write')!;
    expect(write.description).toContain('先产出、后标记');
  });
});

describe('builtinTools · 任务表 how 单源守卫', () => {
  /**
   * 状态取值（done / blocked）与标注方法属「工具用法」（how），唯一真源 = task_table_update 工具描述。
   * 任何**提示文案**复述该取值即构成双源——改工具描述后文案静默失配（历史的 nudge 双源即同型）。
   * 判据与不变量同源：文案里不得出现只有工具描述才该定义的**取值字面量**。
   *
   * 断言口径说明：取「取值字面量」而非「工具名/动作词」——工具名（task_table_write 等）是 when/通道
   * 语义，允许在文案出现；被复述即失配的是取值本身。
   */
  const HOW_LEAK_RE = /\b(done|blocked)\b/;

  it('真源自检：工具描述本身必须定义状态取值（防正则失明 → 守卫假绿）', () => {
    const def = BUILTIN_TOOLS.find((t) => t.name === 'task_table_update')!;
    expect(def.description).toMatch(HOW_LEAK_RE);
  });

  it('PLAN_NUDGE_PROMPT 不复述状态取值（how 指向工具描述）', () => {
    expect(PLAN_NUDGE_PROMPT).not.toMatch(HOW_LEAK_RE);
  });

  it('会议团队上下文块不复述状态取值（how 指向工具描述）', () => {
    expect(buildTeamContextBlockText('组长A', ['组员1', '组员2'])).not.toMatch(HOW_LEAK_RE);
  });

  /**
   * 寻址说明 ↔ 渲染形态 一致性守卫
   *
   * 缺陷形态：task_table_update 描述称「# **列**序号」——方框表头下措辞成立；
   * 渲染改列表（`N. 描述 [状态]`）后**列概念消失**，描述却未同批更新
   * → LLM 被要求去任务表里找一个不存在的「列」（描述失真，且跨文件无任何守卫）。
   *
   * 判据：任务表现在是**列表**，寻址说明里不得出现表格术语「列」。取「列」而非「# 列」
   * 特异串——后者只挡得住原样回退，「列序号」等变体仍会漏。
   */
  it('寻址说明与渲染形态一致：任务表是列表，描述中不出现「列」', () => {
    const def = BUILTIN_TOOLS.find((t) => t.name === 'task_table_update')!;
    const visibleText = def.description + JSON.stringify(def.parameters);
    expect(visibleText).not.toContain('列');
  });

  it('寻址说明自检：描述必须给出序号定位锚点（防上条正则失明 → 守卫假绿）', () => {
    const def = BUILTIN_TOOLS.find((t) => t.name === 'task_table_update')!;
    expect(def.description).toContain('行首序号');
  });
});

describe('builtinTools · BUILTIN_TOOL_IDEMPOTENCY', () => {
  it('task_table_write 保守标记 non-idempotent（mode 依赖：overwrite/replace 同参幂等，append 非幂等）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.task_table_write).toBe('non-idempotent');
  });

  it('task_table_update 标记 idempotent（步骤状态更新，目标态幂等；跳过风险见注释）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.task_table_update).toBe('idempotent');
  });

  it('web_fetch 应标记为 read-only（读操作，永不跳过）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.web_fetch).toBe('read-only');
  });

  it('run_code 应标记为 non-idempotent（任意代码执行有副作用）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.run_code).toBe('non-idempotent');
  });
});

describe('builtinTools · shouldSkipForIdempotency（仅一次语义）', () => {
  const rec = (
    name: string,
    args: string,
    ok: boolean,
    idempotent: IdempotencyLevel,
    resultSummary = 'ok',
  ): ToolExecutionRecord => ({
    name,
    argsSignature: args,
    executedAt: 0,
    resultSummary,
    ok,
    idempotent,
  });

  it('non-idempotent 工具永不跳过（失败可原样重试）', () => {
    const records = [rec('task_table_write', '{"x":1}', false, 'non-idempotent')];
    expect(
      shouldSkipForIdempotency(records, 'task_table_write', '{"x":1}', 'non-idempotent'),
    ).toEqual({
      skip: false,
    });
  });

  it('幂等工具无历史记录时不跳过', () => {
    expect(shouldSkipForIdempotency([], 'read_file', '{"path":"a.ts"}', 'idempotent')).toEqual({
      skip: false,
    });
    expect(
      shouldSkipForIdempotency(undefined, 'read_file', '{"path":"a.ts"}', 'idempotent'),
    ).toEqual({
      skip: false,
    });
  });

  it('幂等工具上次执行成功（ok=true）时跳过并返回上次结果', () => {
    const records = [rec('read_file', '{"path":"a.ts"}', true, 'idempotent', '文件内容')];
    const result = shouldSkipForIdempotency(records, 'read_file', '{"path":"a.ts"}', 'idempotent');
    expect(result.skip).toBe(true);
    expect(result.previousResult).toContain('文件内容');
  });

  it('幂等工具上次执行失败（ok=false）时不跳过——失败可重试', () => {
    const records = [rec('write_file', '{"path":"a.ts"}', false, 'idempotent-key')];
    expect(
      shouldSkipForIdempotency(records, 'write_file', '{"path":"a.ts"}', 'idempotent-key'),
    ).toEqual({
      skip: false,
    });
  });

  it('幂等工具成功但无 resultSummary 时跳过且 previousResult 为空', () => {
    const records = [rec('read_file', '{"path":"a.ts"}', true, 'idempotent', '')];
    const result = shouldSkipForIdempotency(records, 'read_file', '{"path":"a.ts"}', 'idempotent');
    expect(result.skip).toBe(true);
    expect(result.previousResult).toBeUndefined();
  });

  it('delete_file 上次删除成功后仍不跳过——目标态可被 write_file 重建，跳过会让二次闭环残留脚本', () => {
    // 用真实映射值判定（禁用硬编码 'non-idempotent'）：归类一旦回退为幂等，本例即红
    const level = BUILTIN_TOOL_IDEMPOTENCY.delete_file!;
    const args = '{"path":"tmp_analyze.cjs"}';
    const records = [rec('delete_file', args, true, level, '✅ 已删除')];
    expect(shouldSkipForIdempotency(records, 'delete_file', args, level)).toEqual({ skip: false });
  });

  it('read-only 工具即使上次成功也永不跳过——目标态可被写工具/时间改动，回喂陈旧结果误导 LLM（IDM-1）', () => {
    // 用真实映射值判定（禁用硬编码 'read-only'）：归类一旦回退为幂等/可跳过，本例即红
    const level = BUILTIN_TOOL_IDEMPOTENCY.read_file!;
    const args = '{"path":"a.ts"}';
    const records = [rec('read_file', args, true, level, '旧内容（已过时）')];
    expect(shouldSkipForIdempotency(records, 'read_file', args, level)).toEqual({ skip: false });
  });
});

describe('builtinTools · 写盘声明位（diskWrite）与派生索引', () => {
  it('声明契约钉：path 集 / opaque 集的工具名（行内声明变动必须复审本例）', () => {
    // 跨模块契约钉：串行闸与宿主改动追踪都由这两个集合派生，名单变动 = 排序语义变动。
    // 序无关比较（派生序 = 定义排布序，不承载语义）
    expect([...PATH_WRITE_TOOL_NAMES].sort()).toEqual(['delete_file', 'write_file']);
    expect([...OPAQUE_WRITE_TOOL_NAMES].sort()).toEqual(
      // run_command 在列：任意 shell 命令可改盘任意路径，目标不可静态定位 ⇒ opaque 屏障
      ['register_work', 'run_code', 'run_command', 'run_project_script', 'run_skill_script'].sort(),
    );
  });

  it("'path' 声明行必须以 args.path 定位目标（required 含 path），模式语义自洽", () => {
    for (const def of ALL_BUILTIN_TOOL_DEFS.filter((t) => t.diskWrite === 'path')) {
      expect(def.parameters.required, `${def.name} 声明 'path' 却不带 path 参数`).toContain('path');
    }
  });

  it('派生不变量：WRITE_PATH_EXTRACTORS 键集 ≡ PATH_WRITE_TOOL_NAMES（构造级单源）', () => {
    expect(Object.keys(WRITE_PATH_EXTRACTORS).sort()).toEqual([...PATH_WRITE_TOOL_NAMES].sort());
    // opaque 工具不得进提取器表——目标不可定位，进表 = 假定位（串行键会静默失真）
    for (const name of OPAQUE_WRITE_TOOL_NAMES) {
      expect(WRITE_PATH_EXTRACTORS[name], `${name} 是 opaque 写，不应有路径提取器`).toBeUndefined();
    }
  });
});
