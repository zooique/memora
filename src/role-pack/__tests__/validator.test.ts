/**
 * 角色包格式校验器测试（manifest.json 唯一核心控制文件）
 */
import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  validateManifestText,
  checkCompanionContentRedline,
} from '@/role-pack/validator.js';
import type { RolePackValidationIssue } from '@/role-pack/validator.js';

/** 合法 L2 策略（已消费键集，类型化常量供展开覆写） */
const validStrategy = {
  prepare: { summaryFocus: '聚焦核心逻辑' },
  act: { toolMode: 'allow', temperature: 0.7, outputLimit: 4096 },
  reflect: { summary: 'on', selfReview: 0, userFollowup: 'silent' },
  global: { askOn: ['ambiguity', 'decision'], askLimit: 10 },
};

/** 合法基础 manifest（元数据 + 合规 + strategy + skills） */
const validManifest: Record<string, unknown> = {
  name: '测试角色包',
  formatVersion: '1.0.0',
  version: '1.0.0',
  description: '测试角色包描述',
  author: '萧然',
  interactionType: 'tool_assistant',
  aiIdentityDisclosure: true,
  minorProtection: 'required',
  strategy: validStrategy,
  skills: [
    { file: 'skills/write.md', name: 'write', description: '写文件' },
    { file: 'skills/search.md', name: 'search' },
  ],
  capabilities: [
    { capability: 'file:write', description: '写文件' },
    { capability: 'web:search', description: '搜索' },
  ],
};

/** 便捷构造：给定 manifest 覆写，返回校验结果；replaceAll=true 时整体替换 */
function validate(overrides: Record<string, unknown> = {}, replaceAll = false) {
  const manifest = replaceAll ? overrides : { ...validManifest, ...overrides };
  return validateManifest(manifest);
}

/** 提取指定 code 的问题列表 */
function findByCode(issues: readonly RolePackValidationIssue[], code: string) {
  return issues.filter((i) => i.code === code);
}

describe('validateManifest：合法 manifest', () => {
  it('完整 manifest（元数据 + 策略 + 多技能注册）校验通过', () => {
    const result = validate();
    expect(result.valid).toBe(true);
    // 基础样本含 file:write（中立字典名，memora 未登记映射）→ 仅 warning，不阻塞装载
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(findByCode(result.issues, 'UNREGISTERED_CAPABILITY')).toHaveLength(1);
  });

  it('skills 未声明为合法（无内嵌技能）', () => {
    const result = validate({ skills: undefined });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：必填字段', () => {
  it('缺少 name → MISSING_NAME error（拒绝加载）', () => {
    const result = validate({ name: undefined });
    expect(findByCode(result.issues, 'MISSING_NAME')).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe('error');
  });

  it('空字符串 name → MISSING_NAME error', () => {
    const result = validate({ name: '   ' });
    expect(findByCode(result.issues, 'MISSING_NAME')).toHaveLength(1);
  });
});

describe('validateManifest：版本语义', () => {
  it('formatVersion 非 semver → INVALID_FORMAT_VERSION error', () => {
    const result = validate({ formatVersion: '1.0' });
    expect(findByCode(result.issues, 'INVALID_FORMAT_VERSION')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('formatVersion 缺省合法（按 1.0.0 处理）', () => {
    const result = validate({ formatVersion: undefined });
    expect(findByCode(result.issues, 'INVALID_FORMAT_VERSION')).toHaveLength(0);
  });

  it('version 非 semver → INVALID_VERSION warning（不阻塞装载）', () => {
    const result = validate({ version: 'v2' });
    const issue = findByCode(result.issues, 'INVALID_VERSION');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：键名合法性', () => {
  it('未知顶层键 → UNKNOWN_TOP_LEVEL_KEY warning + 忽略', () => {
    const result = validate({ unknownKey: 'x' });
    const issue = findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });

  it('已知键（strategy/skills/handoffPrompt）不报未知键', () => {
    const result = validate({ handoffPrompt: '开始吧' });
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(0);
  });

  it('keywords/trigger 废弃键：按未知键 warning 宽容（不阻塞装载）', () => {
    // v0.13 角色包手动切换，自动匹配链死——废弃键不在已知键集，旧包带此二键
    // 走「未知键 warning + 忽略」通道（warning 不阻塞装载）。
    const result = validate({ keywords: ['文档', 'API'], trigger: ['测试'] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(2);
  });

  it('keywords 任何形状均宽容（废弃键走未知键 warning，不判形状）', () => {
    // 校验器不判 keywords 形状：数组/逗号串/数值/对象一律未知键 warning + 忽略，
    // 不阻塞装载（废弃键的形状无语义，任意形状同通道）。
    const asArray = validate({ keywords: ['文档', 'API'] });
    const asNumber = validate({ keywords: 12 });
    const asObject = validate({ keywords: { a: 1 } });
    for (const result of [asArray, asNumber, asObject]) {
      expect(result.valid).toBe(true);
      expect(findByCode(result.issues, 'INVALID_KEYWORDS')).toHaveLength(0);
      expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(1);
    }
  });

  it('exclusiveWith 已废弃：作为未知键 warning 忽略（不阻塞装载）', () => {
    // v0.13 移除 exclusiveWith 机制（§6.1），存量字段按未知键 warning + 忽略
    const result = validate({ exclusiveWith: ['其他包'] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(1);
  });

  it('未知策略阶段 → UNKNOWN_STRATEGY_STAGE warning', () => {
    const result = validate({ strategy: { ...validStrategy, postAct: { x: 1 } } });
    expect(findByCode(result.issues, 'UNKNOWN_STRATEGY_STAGE')).toHaveLength(1);
  });

  it('未知策略键 → UNKNOWN_STRATEGY_KEY warning（键级渐进）', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, foo: 'bar' } },
    });
    const issue = findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY');
    expect(issue).toHaveLength(1);
    expect(issue[0]?.path).toBe('strategy.act.foo');
    expect(issue[0]?.severity).toBe('warning');
  });

  it('strategy 非对象 → INVALID_STRATEGY error', () => {
    const result = validate({ strategy: 'hybrid' });
    expect(findByCode(result.issues, 'INVALID_STRATEGY')).toHaveLength(1);
  });
});

describe('validateManifest：L2 策略取值越界（角色只"选择"不"定义"）', () => {
  it('summaryFocus 合法非空字符串 → 通过（结构化保真提炼键）', () => {
    const result = validate({
      strategy: {
        ...validStrategy,
        prepare: { ...validStrategy.prepare, summaryFocus: '高价值代码片段' },
      },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
    expect(findByCode(result.issues, 'UNKNOWN_STRATEGY_KEY')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('summaryFocus 空白字符串 → INVALID_STRATEGY_VALUE error（非空才合法）', () => {
    const result = validate({
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, summaryFocus: '   ' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('temperature 越界（> 2.0）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, temperature: 3.5 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('act.outputLimit 负数 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, outputLimit: -1 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('act.outputLimit 为 0 → 通过（0 = 不干预哨兵，与 contextLimit/stepBudget 同构）', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, outputLimit: 0 } },
    });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
  });

  it('reflect.summary 越界枚举 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, summary: 'invalid' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('askOn 含非法枚举元素 → error', () => {
    const result = validate({
      strategy: {
        ...validStrategy,
        global: { ...validStrategy.global, askOn: ['ambiguity', 'chat'] },
      },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('selfReview 非负整数合法（0=关闭；>0 在解析层收敛为 1）→ 通过', () => {
    const r0 = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, selfReview: 0 } },
    });
    const r2 = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, selfReview: 2 } },
    });
    expect(r0.valid).toBe(true);
    expect(r2.valid).toBe(true);
    expect(findByCode(r0.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
  });

  it('selfReview 负数/字符串 → INVALID_STRATEGY_VALUE error（雷-3b）', () => {
    const neg = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, selfReview: -1 } },
    });
    const str = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, selfReview: 'on' } },
    });
    expect(findByCode(neg.issues, 'INVALID_STRATEGY_VALUE').length).toBeGreaterThan(0);
    expect(findByCode(str.issues, 'INVALID_STRATEGY_VALUE').length).toBeGreaterThan(0);
  });

  // ── 数值键越上界（区间上限纪律：开放键不能无条件填写）──
  it('outputLimit 越上界（> MAX_OUTPUT_LIMIT）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, outputLimit: 999999 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('contextLimit 越上界（> MAX_CONTEXT_LIMIT）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, contextLimit: 2000001 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('askLimit 越上界（> MAX_ASK_LIMIT）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, askLimit: 999 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('selfReview 越上界（> MAX_SELF_REVIEW_ROUNDS）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, selfReview: 999 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('summaryFocus 超长（> MAX_SUMMARY_FOCUS_LENGTH）→ error（防巨型注入）', () => {
    const result = validate({
      strategy: {
        ...validStrategy,
        prepare: { ...validStrategy.prepare, summaryFocus: 'a'.repeat(501) },
      },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('越界错误消息带合法区间提示（指导填写）', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, contextLimit: 2000001 } },
    });
    const issue = findByCode(result.issues, 'INVALID_STRATEGY_VALUE')[0];
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('合法区间');
    expect(issue!.message).toContain('[120000, 2000000]');
  });

  it('userFollowup 枚举合法（ask/silent）且非枚举 error（雷-3b）', () => {
    const ok = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, userFollowup: 'ask' } },
    });
    const bad = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, userFollowup: 'chat' } },
    });
    expect(ok.valid).toBe(true);
    expect(findByCode(bad.issues, 'INVALID_STRATEGY_VALUE').length).toBeGreaterThan(0);
  });
});

describe('validateManifest：skills 注册（对象数组）', () => {
  it('skills 非数组 → SKILLS_NOT_ARRAY error', () => {
    const result = validate({ skills: { file: 'x.md' } });
    expect(findByCode(result.issues, 'SKILLS_NOT_ARRAY')).toHaveLength(1);
  });

  it('skills 项非对象 → INVALID_MANIFEST_SKILL error', () => {
    const result = validate({ skills: ['skills/a.md'] });
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL')).toHaveLength(1);
  });

  it('skills 项缺 file → INVALID_MANIFEST_SKILL error（skills 仅文件引用）', () => {
    const result = validate({ skills: [{ name: 'no-file' }] });
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL').length).toBeGreaterThan(0);
  });

  it('纯能力声明在顶层 capabilities 合法', () => {
    const result = validate({ capabilities: [{ capability: 'file:read' }] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(0);
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL')).toHaveLength(0);
  });

  it('name/description 非字符串 → warning（不阻塞）', () => {
    const result = validate({ skills: [{ file: 'a.md', name: 1, description: 2 }] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_MANIFEST_SKILL').length).toBeGreaterThan(0);
  });

  it('capabilities 非法格式 → INVALID_CAPABILITY error（顶层校验）', () => {
    const result = validate({ capabilities: [{ capability: 'writeFile' }] });
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('多个技能项（对象数组）均可注册', () => {
    const result = validate({
      skills: [{ file: 'skills/a.md' }, { file: 'skills/b.md' }, { file: 'skills/c.md' }],
      capabilities: [{ capability: 'file:write' }, { capability: 'web:search' }],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：未登记能力诊断（静默降级 → 可见 warning）', () => {
  it('格式合法但未登记 → UNREGISTERED_CAPABILITY warning，且文案说清后果', () => {
    const result = validate({ capabilities: [{ capability: 'file:read' }] });
    const diags = findByCode(result.issues, 'UNREGISTERED_CAPABILITY');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe('warning');
    // 必须让作者看到两件事：这个能力不解锁工具；工具面会被收窄
    expect(diags[0]!.message).toContain('不会解锁任何工具');
    expect(diags[0]!.message).toContain('收窄');
    // warning 不阻塞装载
    expect(result.valid).toBe(true);
  });

  it('已登记能力（含空映射条目）→ 不产生未登记诊断', () => {
    const result = validate({
      capabilities: [{ capability: 'web:search' }, { capability: 'llm:summarize' }],
    });
    expect(findByCode(result.issues, 'UNREGISTERED_CAPABILITY')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('未声明 capabilities → 不产生未登记诊断，既有语义不变', () => {
    const result = validate({ capabilities: undefined });
    expect(findByCode(result.issues, 'UNREGISTERED_CAPABILITY')).toHaveLength(0);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('格式非法仍是 INVALID_CAPABILITY error（不进未登记 warning 分支）', () => {
    const result = validate({ capabilities: [{ capability: 'writeFile' }] });
    expect(findByCode(result.issues, 'INVALID_CAPABILITY')).toHaveLength(1);
    expect(findByCode(result.issues, 'UNREGISTERED_CAPABILITY')).toHaveLength(0);
    expect(result.valid).toBe(false);
  });
});

describe('validateManifest：合规分档', () => {
  it('interactionType 越界 → INVALID_INTERACTION_TYPE error', () => {
    const result = validate({ interactionType: 'fun' });
    expect(findByCode(result.issues, 'INVALID_INTERACTION_TYPE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('缺省 interactionType = tool_assistant：无合规字段也可装载（分档兜底）', () => {
    const result = validate({
      interactionType: undefined,
      aiIdentityDisclosure: undefined,
      minorProtection: undefined,
    });
    expect(result.valid).toBe(true);
  });

  it('显式非法 minorProtection（非 required）→ INVALID_MINOR_PROTECTION error（阻塞装载）', () => {
    const result = validate({ minorProtection: 'optional' });
    expect(findByCode(result.issues, 'INVALID_MINOR_PROTECTION')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('companion 缺失 aiIdentityDisclosure → COMPANION_MISSING_AI_DISCLOSURE error', () => {
    const result = validate({ interactionType: 'companion', aiIdentityDisclosure: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_AI_DISCLOSURE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('companion 缺失 minorProtection → COMPANION_MISSING_MINOR_PROTECTION error', () => {
    const result = validate({ interactionType: 'companion', minorProtection: undefined });
    expect(findByCode(result.issues, 'COMPANION_MISSING_MINOR_PROTECTION')).toHaveLength(1);
  });

  it('companion 完整合规声明 → 校验通过（红线检测归属内容文件层）', () => {
    const result = validate({ interactionType: 'companion' });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'COMPANION_INTIMATE_REDLINE')).toHaveLength(0);
  });
});

describe('validateManifestText：原始文本便捷入口', () => {
  it('合法 JSON → 校验通过', () => {
    const raw = JSON.stringify({ name: '测试', formatVersion: '1.0.0' });
    expect(validateManifestText(raw).valid).toBe(true);
  });

  it('非合法 JSON → INVALID_JSON error', () => {
    const result = validateManifestText('{ not json');
    expect(findByCode(result.issues, 'INVALID_JSON')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });
});

describe('checkCompanionContentRedline：companion 内容红线', () => {
  it('内容含虚拟伴侣特征 → COMPANION_INTIMATE_REDLINE error', () => {
    const issues = checkCompanionContentRedline('你是用户的虚拟伴侣。');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('COMPANION_INTIMATE_REDLINE');
    expect(issues[0]?.severity).toBe('error');
  });

  it('干净内容 → 无红线', () => {
    expect(checkCompanionContentRedline('你是一位温和的学习陪练。')).toEqual([]);
  });

  it('空内容 → 无红线', () => {
    expect(checkCompanionContentRedline('')).toEqual([]);
  });
});

describe('validateManifest：handoffPrompt 接手衔接提示词（自洽声明）', () => {
  it('合法字符串 → 无问题', () => {
    const result = validate({ handoffPrompt: '我已准备好，请告诉我主题与要求。' });
    expect(findByCode(result.issues, 'INVALID_HANDOFF_PROMPT')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('非字符串（数字/对象）→ INVALID_HANDOFF_PROMPT warning（不阻塞装载）', () => {
    const result = validate({ handoffPrompt: 42 });
    const issues = findByCode(result.issues, 'INVALID_HANDOFF_PROMPT');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(result.valid).toBe(true);
  });

  it('未声明 → 合法（可选）', () => {
    const result = validate({ handoffPrompt: undefined });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'INVALID_HANDOFF_PROMPT')).toHaveLength(0);
  });
});

describe('validateManifest：非策略键字段上限（开放字段防无条件填写）', () => {
  it('skills 白名单超过 50 项 → SKILLS_TOO_MANY error', () => {
    const skills = Array.from({ length: 51 }, (_, i) => ({ file: `skills/s${i}.md` }));
    const result = validate({ skills });
    expect(findByCode(result.issues, 'SKILLS_TOO_MANY')).toHaveLength(1);
  });

  it('capabilities 超过 50 项 → CAPABILITIES_TOO_MANY error', () => {
    const caps = Array.from({ length: 51 }, (_, i) => ({ capability: `dom:act${i}` }));
    const result = validate({ capabilities: caps });
    expect(findByCode(result.issues, 'CAPABILITIES_TOO_MANY')).toHaveLength(1);
  });

  it('handoffPrompt 超过 2000 字符 → HANDOFF_PROMPT_TOO_LONG error', () => {
    const result = validate({ handoffPrompt: 'a'.repeat(2001) });
    expect(findByCode(result.issues, 'HANDOFF_PROMPT_TOO_LONG')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('元数据字符串（description/author）超过 200 字符 → META_STRING_TOO_LONG error', () => {
    const result = validate({ description: 'd'.repeat(201), author: 'a'.repeat(201) });
    expect(findByCode(result.issues, 'META_STRING_TOO_LONG')).toHaveLength(2);
    expect(result.valid).toBe(false);
  });

  it('边界值合法（2000 字符 / 50 项）→ 通过', () => {
    const result = validate({
      handoffPrompt: 'h'.repeat(2000),
      skills: Array.from({ length: 50 }, (_, i) => ({ file: `skills/s${i}.md` })),
      capabilities: Array.from({ length: 50 }, (_, i) => ({ capability: `dom:act${i}` })),
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：无消费远期键按未知键宽容', () => {
  it('minKernelVersion 已移出白名单 → 未知键 warning（不阻塞）', () => {
    const result = validate({ minKernelVersion: 'v1' });
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(1);
    expect(result.valid).toBe(true);
  });

  it('extensions 已移出白名单 → 作为未知键报 UNKNOWN_TOP_LEVEL_KEY warning', () => {
    const result = validate({ extensions: { 'com.memora': { foo: 'bar' } } });
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(1);
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest：kind 与组名闭集（§7.6 锚点 2）', () => {
  it('kind 拼写错误（"assisstant"）→ INVALID_KIND error（不静默折叠回 work）', () => {
    // 折叠回 work = 拼错的助手包静默拿到写盘/执行工具（fail-open），必须 error 拦下
    const result = validate({ kind: 'assisstant' });
    expect(findByCode(result.issues, 'INVALID_KIND')).toHaveLength(1);
    expect(findByCode(result.issues, 'INVALID_KIND')[0]?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('kind 非字符串（数字/布尔）→ INVALID_KIND error', () => {
    expect(findByCode(validate({ kind: 1 }).issues, 'INVALID_KIND')).toHaveLength(1);
    expect(findByCode(validate({ kind: true }).issues, 'INVALID_KIND')).toHaveLength(1);
  });

  it('kind 合法值（work / assistant）与缺省 → 无 INVALID_KIND', () => {
    expect(findByCode(validate({ kind: 'work' }).issues, 'INVALID_KIND')).toHaveLength(0);
    expect(findByCode(validate({ kind: 'assistant' }).issues, 'INVALID_KIND')).toHaveLength(0);
    expect(findByCode(validate({ kind: undefined }).issues, 'INVALID_KIND')).toHaveLength(0);
  });

  it('kind 为已知顶层键（MANIFEST_KEYS 放行，不报未知键）', () => {
    const result = validate({ kind: 'work' });
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(0);
  });

  it('disableGroups 含非法组名 → INVALID_STRATEGY_VALUE error（组名也是闭集）', () => {
    const result = validate({
      strategy: {
        ...validStrategy,
        act: { ...validStrategy.act, disableGroups: ['readonly', 'write'] },
      },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('disableGroups 合法（三组闭集子集）→ 通过', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, disableGroups: ['act'] } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('disableTools 形状校验：数组与逗号字符串双形态合法，非字符串/超长 error', () => {
    // 双形态（normalizeDisableTools）：JSON 数组与逗号分隔字符串都合法
    const arr = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, disableTools: ['read_file'] } },
    });
    expect(findByCode(arr.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);

    const csv = validate({
      strategy: {
        ...validStrategy,
        act: { ...validStrategy.act, disableTools: 'read_file,run_command' },
      },
    });
    expect(findByCode(csv.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);

    // 非字符串/非数组（数字）→ 形状 error
    const bad = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, disableTools: 42 } },
    });
    expect(findByCode(bad.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);

    // 工具名拼写错误 validator 判不了（纯函数无 IO），由装配期对照注册表判（§7.6 锚点 3）
    const shapeOk = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, disableTools: ['read_fil'] } },
    });
    expect(findByCode(shapeOk.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(0);
  });
});

describe('validateManifest：tools 声明形状（§8.7 锚点 9）', () => {
  /**
   * 构造一份合法的包内工具声明（各用例按需覆写字段）
   *
   * @param over 覆盖字段（用于构造各类非法形态）
   * @returns manifest.tools 的单项
   */
  const validTool = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'pack_echo',
    description: '把输入原样回显',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
    impl: { type: 'script', path: 'scripts/echo.mjs' },
    ...over,
  });

  it('合法声明（含缺省 group/readonly）→ 无 tools 类错误', () => {
    const result = validate({ tools: [validTool()] });
    expect(result.valid).toBe(true);
    expect(
      result.issues.filter((i) => i.code.startsWith('TOOL') || i.code.startsWith('INVALID_TOOL')),
    ).toHaveLength(0);
  });

  it('tools 非数组 → TOOLS_NOT_ARRAY error（坏声明阻塞装载，不是 warning）', () => {
    const result = validate({ tools: 'scripts/echo.mjs' });
    expect(findByCode(result.issues, 'TOOLS_NOT_ARRAY')).toHaveLength(1);
    expect(findByCode(result.issues, 'TOOLS_NOT_ARRAY')[0]?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('超过 50 项 → TOOLS_TOO_MANY error', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      validTool({ name: `pack_tool_${i}`, impl: { type: 'script', path: `scripts/t${i}.mjs` } }),
    );
    const result = validate({ tools: many });
    expect(findByCode(result.issues, 'TOOLS_TOO_MANY')).toHaveLength(1);
    expect(result.valid).toBe(false);
  });

  it('工具名非法 → INVALID_TOOL_DECL；重名 → DUPLICATE_TOOL_NAME', () => {
    const badName = validate({ tools: [validTool({ name: '9bad-name' })] });
    expect(findByCode(badName.issues, 'INVALID_TOOL_DECL').length).toBeGreaterThan(0);

    const dup = validate({ tools: [validTool(), validTool()] });
    expect(findByCode(dup.issues, 'DUPLICATE_TOOL_NAME')).toHaveLength(1);
    expect(dup.valid).toBe(false);
  });

  it('description 空 / group 越界 / readonly 非布尔 → INVALID_TOOL_DECL', () => {
    expect(
      findByCode(
        validate({ tools: [validTool({ description: '   ' })] }).issues,
        'INVALID_TOOL_DECL',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      findByCode(validate({ tools: [validTool({ group: 'write' })] }).issues, 'INVALID_TOOL_DECL')
        .length,
    ).toBeGreaterThan(0);
    expect(
      findByCode(validate({ tools: [validTool({ readonly: 'yes' })] }).issues, 'INVALID_TOOL_DECL')
        .length,
    ).toBeGreaterThan(0);
  });

  it('声明确认策略（confirmPolicy）→ TOOL_CONFIRM_POLICY_FORBIDDEN error（§8.9 R2）', () => {
    const result = validate({ tools: [validTool({ confirmPolicy: 'never' })] });
    expect(findByCode(result.issues, 'TOOL_CONFIRM_POLICY_FORBIDDEN')).toHaveLength(1);
    expect(findByCode(result.issues, 'TOOL_CONFIRM_POLICY_FORBIDDEN')[0]?.severity).toBe('error');
    expect(result.valid).toBe(false);
  });

  it('parameters 形状错误 → INVALID_TOOL_PARAMETERS（type 非 object / 参数缺说明 / required 点名不存在）', () => {
    const badType = validate({
      tools: [validTool({ parameters: { type: 'array', properties: {}, required: [] } })],
    });
    expect(findByCode(badType.issues, 'INVALID_TOOL_PARAMETERS').length).toBeGreaterThan(0);

    const badProp = validate({
      tools: [
        validTool({
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
        }),
      ],
    });
    expect(findByCode(badProp.issues, 'INVALID_TOOL_PARAMETERS').length).toBeGreaterThan(0);

    const missingReq = validate({
      tools: [
        validTool({
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 't' } },
            required: ['nope'],
          },
        }),
      ],
    });
    expect(findByCode(missingReq.issues, 'INVALID_TOOL_PARAMETERS').length).toBeGreaterThan(0);
  });

  it('impl 越界 → INVALID_TOOL_IMPL（type 非 script / path 空）', () => {
    expect(
      findByCode(
        validate({ tools: [validTool({ impl: { type: 'mcp', path: 'x' } })] }).issues,
        'INVALID_TOOL_IMPL',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      findByCode(
        validate({ tools: [validTool({ impl: { type: 'script', path: '   ' } })] }).issues,
        'INVALID_TOOL_IMPL',
      ).length,
    ).toBeGreaterThan(0);
  });
});
