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
  act: { toolMode: 'allow', temperature: 0.7, outputLimit: 4096, streaming: 'streaming' },
  reflect: { summary: 'on', selfReview: 0, userFollowup: 'silent' },
  global: { askOn: ['ambiguity', 'decision'], askLimit: 3 },
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
    expect(result.issues).toEqual([]);
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

  it('keywords/trigger 已废弃：按未知键 warning 宽容（不阻塞装载）', () => {
    // v0.13 角色包手动切换，自动匹配链死——废弃键不在已知键集，旧包带此二键
    // 走「未知键 warning + 忽略」通道，语义与校验器历史行为等价（warning 不阻塞）。
    const result = validate({ keywords: ['文档', 'API'], trigger: ['测试'] });
    expect(result.valid).toBe(true);
    expect(findByCode(result.issues, 'UNKNOWN_TOP_LEVEL_KEY')).toHaveLength(2);
  });

  it('keywords 任何形状均宽容（废弃键走未知键 warning，不判形状）', () => {
    // 校验器不再认识 keywords：数组/逗号串/数值/对象一律未知键 warning + 忽略，
    // 不阻塞装载（旧包兼容等价：历史行为对合法形状放行，废弃后形状不再有语义）。
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
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, summaryFocus: '高价值代码片段' } },
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

  it('act.outputLimit 非正整数 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, outputLimit: -1 } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('act.streaming 越界枚举 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, act: { ...validStrategy.act, streaming: 'invalid' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('reflect.summary 越界枚举 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, reflect: { ...validStrategy.reflect, summary: 'invalid' } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('askOn 含非法枚举元素 → error', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, askOn: ['ambiguity', 'chat'] } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('selfReview 非负整数合法（0=关闭 / N=最多 N 轮）→ 通过（雷-3b）', () => {
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

  it('tokenBudget 越上界（> MAX_TOKEN_BUDGET）→ error', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, tokenBudget: 1000001 } },
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
      strategy: { ...validStrategy, prepare: { ...validStrategy.prepare, summaryFocus: 'a'.repeat(501) } },
    });
    expect(findByCode(result.issues, 'INVALID_STRATEGY_VALUE')).toHaveLength(1);
  });

  it('越界错误消息带合法区间提示（指导填写）', () => {
    const result = validate({
      strategy: { ...validStrategy, global: { ...validStrategy.global, tokenBudget: 1000001 } },
    });
    const issue = findByCode(result.issues, 'INVALID_STRATEGY_VALUE')[0];
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('合法区间');
    expect(issue!.message).toContain('[0, 1000000]');
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
      skills: [
        { file: 'skills/a.md' },
        { file: 'skills/b.md' },
        { file: 'skills/c.md' },
      ],
      capabilities: [
        { capability: 'file:write' },
        { capability: 'web:search' },
      ],
    });
    expect(result.valid).toBe(true);
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
