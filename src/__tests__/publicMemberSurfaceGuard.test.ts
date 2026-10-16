/**
 * 公开成员面登记守卫（PUBLIC-MEMBER-SURFACE-1）——`publicApiSurfaceGuard` 的成员级姊妹守卫。
 *
 * 立此守卫的血训：成员级守卫缺失曾让两类伤潜伏到 major 窗口才被人工审查揪出——
 * ① no-op 谎报方法（`SessionManager.flushNow` / `flushOnShutdown`，宣称落盘实为清脏，
 *    2026-10-14 随 CHKPT-2 才删）；② 零读取僵尸字段（检查点 goal 三字段，2026-10-15
 *    随 GOAL-DRIFT-1 才删）。两者都是「符号活着、语义说谎」，导出名级守卫全程绿灯。
 *
 * 判据：`src/index.ts` 每个 class / interface / enum / const 对象导出的**公开实例成员清单**
 * 冻结于本文件 EXPECTED——增删即红。**红 ≠ 错**：须人工定性（新成员是真能力还是 no-op 谎报？
 * 删除是纠谎还是误删？按 legacy-contract-audit-rules §3.2.1 三条件裁决）后**显式更新 EXPECTED**。
 * 更新基线 = 审查结论落点；改本文件即登记，不存在无审查覆盖路径。
 *
 * 与 publicApiSurfaceGuard 分工：彼管「哪些符号可挂面」（导出名级），本管「挂面符号有哪些成员」（成员级）。
 *
 * 已知边界（诚实登记，勿默认为已覆盖）：本守卫只管**清单**、不管**活性**——
 * 成员存在于清单但零消费（僵尸出口形态）不在射程内，活性由 legacy-contract-audit-rules §4
 * 人工审查 + 文档对账覆盖；本守卫的价值是把「成员增删」从静默动作变成必过审查的红灯。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 仓库根：本文件位于 src/__tests__/，向上两级 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 包入口真源：公开面的唯一定义处 */
const INDEX_TS = join(ROOT, 'src', 'index.ts');

/** 用 TS 编译器 API 解析单文件 AST（正则解析在多行声明/重载上必埋坑，弃用） */
function parseAst(full: string, text: string): ts.SourceFile {
  return ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** '@/a/b.js' → src/a/b.ts（包内 @ 别名）；非别名返回 null */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  return join(ROOT, 'src', spec.slice(2).replace(/\.js$/, '.ts'));
}

/**
 * 在文件 AST 中按名找声明：class / interface / enum / const 对象字面量；
 * 未命中时跟随 re-export（`export type { A } from ...`）递归到源模块（限深防环）。
 * 返回 null = 纯函数/常量等无成员面的导出（向 A 已由 publicApiSurfaceGuard 覆盖，本守卫跳过）。
 */
function findDecl(
  sf: ts.SourceFile,
  name: string,
  depth = 0,
): { kind: string; decl: ts.Node } | null {
  if (depth > 4) return null;
  for (const st of sf.statements) {
    // export const X = { ... } as const → 对象字面量形态（ToolErrorCode / LOOP_CONSTANTS 同族）
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        let init: ts.Expression = d.initializer;
        if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
        if (ts.isObjectLiteralExpression(init)) return { kind: 'object', decl: init };
        return { kind: 'other', decl: d };
      }
      continue;
    }
    // 命名声明（class/interface/enum/function…）取名比对；无名语句跳过
    const named = st as ts.DeclarationStatement;
    const n = named.name && ts.isIdentifier(named.name) ? named.name.text : null;
    if (n === name) {
      if (ts.isClassDeclaration(st)) return { kind: 'class', decl: st };
      if (ts.isInterfaceDeclaration(st)) return { kind: 'interface', decl: st };
      if (ts.isEnumDeclaration(st)) return { kind: 'enum', decl: st };
      return { kind: 'other', decl: st };
    }
    // re-export 跟随：export { B as C } from '...'（as 前为源名，as 后为公开名）
    if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        const srcName = (el.propertyName ?? el.name).text;
        if (el.name.text !== name && srcName !== name) continue;
        const target = resolveAlias((st.moduleSpecifier as ts.StringLiteral).text);
        if (target && existsSync(target)) {
          const found = findDecl(
            parseAst(target, readFileSync(target, 'utf8')),
            srcName,
            depth + 1,
          );
          if (found) return found;
        }
      }
    }
  }
  return null;
}

/**
 * 提取声明的公开实例成员名：排 private / protected / `#` 私有字段 / 构造器；
 * 方法重载去重（Set）；getter 记 `get x`、setter 记 `set x`（与属性名 `x` 区分，防清单撞名）。
 */
function collectMembers(kind: string, decl: ts.Node): string[] {
  const names = new Set<string>();
  const add = (n?: string, prefix = '') => {
    if (n) names.add(prefix + n);
  };
  if (kind === 'enum') {
    for (const m of (decl as ts.EnumDeclaration).members) {
      if (m.name && ts.isIdentifier(m.name)) add(m.name.text);
    }
    return [...names].sort();
  }
  if (kind === 'object') {
    // const 对象字面量：取属性键（普通 / shorthand / 字符串字面量），跳过方法与展开
    for (const p of (decl as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(p)) {
        const kn = p.name;
        if (ts.isIdentifier(kn)) add(kn.text);
        else if (ts.isStringLiteral(kn)) add(kn.text);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        add(p.name.text);
      }
    }
    return [...names].sort();
  }
  for (const m of (decl as ts.ClassDeclaration | ts.InterfaceDeclaration).members) {
    const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) || [] : [];
    const nonPublic = mods.some(
      (x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword,
    );
    if (nonPublic) continue;
    if (ts.isConstructorDeclaration(m)) continue;
    if (!m.name) continue;
    if (ts.isPrivateIdentifier(m.name)) continue;
    if (!ts.isIdentifier(m.name)) continue;
    const n = m.name.text;
    if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) add(n);
    else if (ts.isGetAccessorDeclaration(m)) add(n, 'get ');
    else if (ts.isSetAccessorDeclaration(m)) add(n, 'set ');
    else add(n);
  }
  return [...names].sort();
}

/** 收集 index.ts 全部具名导出（公开名 → 源模块说明符） */
function parseIndexExports(): { name: string; module: string }[] {
  const sf = parseAst(INDEX_TS, readFileSync(INDEX_TS, 'utf8'));
  const out: { name: string; module: string }[] = [];
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !st.moduleSpecifier) continue;
    if (!ts.isNamedExports(st.exportClause)) continue;
    const mod = (st.moduleSpecifier as ts.StringLiteral).text;
    for (const el of st.exportClause.elements) out.push({ name: el.name.text, module: mod });
  }
  return out;
}

/** 实际成员面：导出符号 → { kind, members }（纯函数导出无成员面，不入账） */
function collectActualSurface(): Record<string, { kind: string; members: string[] }> {
  const actual: Record<string, { kind: string; members: string[] }> = {};
  const fileCache = new Map<string, ts.SourceFile>();
  for (const { name, module } of parseIndexExports()) {
    const file = resolveAlias(module);
    if (!file || !existsSync(file)) continue;
    if (!fileCache.has(file)) fileCache.set(file, parseAst(file, readFileSync(file, 'utf8')));
    const found = findDecl(fileCache.get(file)!, name);
    if (!found || found.kind === 'other') continue;
    actual[name] = { kind: found.kind, members: collectMembers(found.kind, found.decl) };
  }
  return actual;
}

/**
 * 冻结基线（EXPECTED）——88 个有成员面的公开符号。
 * 更新规则：仅在人工按 legacy-contract-audit-rules §3.2.1 定性后，把实际差异显式写进本表；
 * 禁止「先改基线后补审查」。基线生成于 2026-10-16 公开 API 面全量审查（5.0.0 发版前）。
 */
const EXPECTED: Record<string, { kind: string; members: string[] }> = {
  Agent: {
    kind: 'class',
    members: [
      'answerQuestion',
      'appendPlanItem',
      'archiveSession',
      'canContinueWithoutInput',
      'cancelAsk',
      'cancelPauseRequest',
      'chat',
      'chatSync',
      'clearPendingInterjections',
      'clearPlan',
      'close',
      'createCheckpoint',
      'discardCurrentCheckpoint',
      'forkSession',
      'gcNow',
      'get agentHistory',
      'get agentLoop',
      'get context',
      'get governance',
      'get initialized',
      'get isBusy',
      'get lastInteractionAt',
      'get memory',
      'get polish',
      'get projects',
      'get provider',
      'get rolePack',
      'get rolePackManager',
      'get rolePacks',
      'get security',
      'get sessionManager',
      'get skills',
      'get tools',
      'get works',
      'getActiveStrategy',
      'getActiveTraits',
      'getArchiveMode',
      'getBackgroundTaskStats',
      'getCheckpoint',
      'getEffectiveMaxTokens',
      'getMessageCount',
      'getMessages',
      'getMetrics',
      'getPendingInterjections',
      'getRecentToolExecutions',
      'getRolePackSwitchLockStatus',
      'init',
      'injectAffect',
      'injectSystemMessage',
      'interject',
      'isPausePending',
      'killBackgroundTask',
      'listBackgroundTasks',
      'pause',
      'rebuildComponents',
      'recover',
      'reloadConfig',
      'removePendingInterject',
      'requestPause',
      'resume',
      'resumeExecution',
      'setArchiveMode',
      'setBackgroundProvider',
      'setContextWindow',
      'setMaxTokens',
      'setProvider',
      'switchProject',
      'switchRolePack',
      'triggerError',
    ],
  },
  UIMessages: {
    kind: 'interface',
    members: [
      'abortedByTimeout',
      'abortedByUser',
      'assistantLabel',
      'contextTruncated',
      'duplicateToolCallWarning',
      'emptyResponseFallback',
      'emptyResponseFallbackTruncated',
      'interrupted',
      'maxIterationsReached',
      'recentConversationLabel',
      'reflectionHint',
      'selfReviewPrompt',
      'softLimitWrapup',
      'userLabel',
    ],
  },
  AgentOptions: {
    kind: 'interface',
    members: [
      'activeRolePack',
      'allowedPaths',
      'archiveMode',
      'backgroundProvider',
      'builtinFallbackRole',
      'codeExecutionProvider',
      'configDir',
      'confirmScripts',
      'confirmWrites',
      'dataDir',
      'disabledSkills',
      'enableContextSummary',
      'environmentProvider',
      'fetchProvider',
      'maxContextTokens',
      'maxTokens',
      'messages',
      'permission',
      'preExecutionCheck',
      'projectPath',
      'projectSearchProvider',
      'provider',
      'providerRouter',
      'registryDir',
      'rolePackTeams',
      'roundStore',
      'scriptNodePath',
      'sessionStore',
      'storage',
      'strategyOverride',
      'tracer',
      'webSearchProvider',
    ],
  },
  AGENT_CONSTANTS: {
    kind: 'object',
    members: [
      'CHAT_INPUT_MAX_LENGTH',
      'CHAT_LOCK_TIMEOUT_MS',
      'COMPLETED_TOOL_CALLS_MAX',
      'DEFAULT_LOCALE',
      'DEFAULT_MAX_CONTEXT_TOKENS',
      'DEFAULT_RECALL_LIMIT',
      'GC_INTERVAL_MS',
      'PAUSE_TIMEOUT_MS',
      'SHUTDOWN_ARCHIVE_TIMEOUT_MS',
    ],
  },
  LOOP_CONSTANTS: {
    kind: 'object',
    members: [
      'CHARS_PER_TOKEN',
      'CJK_CHARS_PER_TOKEN',
      'CONTEXT_PRESSURE_HINT',
      'CONTEXT_TOKENS_BUFFER_RATIO',
      'DEFAULT_INTERRUPTED_MARK',
      'DEFAULT_MAX_ITERATIONS_REACHED_MARK',
      'LLM_TIMEOUT_MS',
      'MAX_INTEL_PREFIX_LEN',
      'MAX_LLM_RETRIES',
      'MAX_PENDING_COMMAND_RESULTS',
      'MAX_PENDING_INTERJECTIONS',
      'MEMORY_SEARCH_TIMEOUT_MS',
      'REASONING_INPUT_CHARS',
      'RETRY_BASE_DELAY_MS',
      'SEARCH_CONVERGENCE_HINT',
      'SEARCH_CONVERGENCE_THRESHOLD',
      'SINGLE_TOOL_RESULT_MAX_TOKENS',
      'SUMMARY_CACHE_TTL_MSGS',
      'SUMMARY_CONTENT_SLICE',
      'SUMMARY_LAYER_TOKEN_RATIO',
      'SUMMARY_MAX_TOKENS',
      'SUMMARY_MSG_COUNT',
      'TASK_TYPE_WINDOW',
      'TOOL_NARRATION_DISCIPLINE',
      'TOOL_RESULT_OFFLOAD_TAIL_PREVIEW_CHARS',
      'TOOL_RESULT_WRAP_OVERHEAD_TOKENS',
    ],
  },
  COMPRESS_TARGET_LABELS: {
    kind: 'object',
    members: ['earliest_round', 'earliest_steps', 'largest_tool_result'],
  },
  SessionManager: {
    kind: 'class',
    members: [
      'appendPlanItem',
      'cancelPendingPause',
      'clearPlan',
      'compensateAllNonIdempotent',
      'compensateTool',
      'completePlanItem',
      'concludeActivePlanItemIfPlanFullyReached',
      'consumePendingPause',
      'createCheckpoint',
      'destroy',
      'discardCheckpoint',
      'forkSession',
      'get errorInfo',
      'get pauseInfo',
      'get pendingPauseInfo',
      'get status',
      'getActivePlanItem',
      'getCheckpoint',
      'getCurrentSessionInfo',
      'getNextPendingPlanItem',
      'getSessionMeta',
      'hasInflightPlan',
      'isPausePending',
      'isPlanAllBlocked',
      'loadSessionMessages',
      'logPlanItemBoundary',
      'logToolExecution',
      'pause',
      'recover',
      'renameSession',
      'requestPause',
      'restoreMostRecentSession',
      'restoreSession',
      'resume',
      'setPauseMeta',
      'switchSession',
      'switchToSession',
      'triggerError',
      'updatePlan',
      'updatePlanItemStatus',
      'writePlan',
    ],
  },
  ToolDefinition: {
    kind: 'interface',
    members: ['description', 'diskWrite', 'name', 'parameters', 'readonly'],
  },
  ToolContext: { kind: 'interface', members: ['guardPath'] },
  WriteExtensions: { kind: 'interface', members: ['onBeforeWrite'] },
  RolePackMeta: {
    kind: 'interface',
    members: [
      'aiIdentityDisclosure',
      'author',
      'description',
      'displayName',
      'formatVersion',
      'handoffPrompt',
      'interactionType',
      'minorProtection',
      'name',
      'version',
    ],
  },
  RolePackManager: {
    kind: 'class',
    members: [
      'activate',
      'buildSystemPrompt',
      'buildTeamContextBlock',
      'close',
      'deriveSkillNameFromFile',
      'get',
      'get activeName',
      'get roundAssemblyPerspective',
      'getActive',
      'getActiveRules',
      'getActiveTeam',
      'getActiveTraits',
      'getSkillScriptInfo',
      'getSkillScriptPath',
      'getSwitchLockStatus',
      'getTeam',
      'listMeta',
      'listSkillResources',
      'listSkills',
      'load',
      'loadExtraDir',
      'onRolePackActivated',
      'onRolePackSwitchLocked',
      'readSkillContent',
      'readSkillResource',
      'reload',
      'resolveRoundAssemblyRole',
      'resyncUserPacks',
      'setBuiltinFallbackRole',
      'setRolePackTeams',
      'setRoundAssemblyRole',
      'tryBuildMeetingPlan',
    ],
  },
  StrategyKeyFace: {
    kind: 'interface',
    members: ['key', 'kind', 'options', 'range', 'stage', 'values'],
  },
  MemoryInspector: {
    kind: 'class',
    members: [
      'getById',
      'getBySource',
      'getDeletedById',
      'list',
      'listDeleted',
      'searchByKeyword',
      'snapshot',
      'softDeleteRoundSummaries',
      'stats',
      'writeDelete',
      'writePurge',
      'writePurgeExpired',
      'writeRestore',
      'writeUpsert',
    ],
  },
  MemorySnapshot: { kind: 'interface', members: ['archive', 'bootstrap', 'working'] },
  WorkingMemorySnapshot: { kind: 'interface', members: ['preview', 'total'] },
  BootstrapSnapshot: { kind: 'interface', members: ['items', 'total'] },
  ArchiveSnapshot: {
    kind: 'interface',
    members: ['archiveCount', 'currentSession', 'currentSessionName', 'hint', 'stats'],
  },
  AgentSearchHit: {
    kind: 'interface',
    members: [
      'accessedAt',
      'contentPreview',
      'createdAt',
      'id',
      'name',
      'roundId',
      'sessionId',
      'source',
    ],
  },
  AgentStats: { kind: 'interface', members: ['bySource', 'total'] },
  MemoryGovernance: {
    kind: 'class',
    members: ['deduplicate', 'detectConflicts', 'sourceHealth', 'suggest'],
  },
  WorkProjectionEntry: { kind: 'interface', members: ['description', 'name', 'source'] },
  PolishResult: { kind: 'interface', members: ['changed', 'polished'] },
  ProviderConfig: {
    kind: 'interface',
    members: [
      'apiKey',
      'baseUrl',
      'model',
      'provider',
      'supportsStructuredOutput',
      'supportsToolCalling',
    ],
  },
  LlmProvider: {
    kind: 'class',
    members: ['chat', 'name', 'supportsStructuredOutput', 'supportsToolCalling'],
  },
  ChatOptions: {
    kind: 'interface',
    members: [
      'maxTokens',
      'model',
      'reasoning_effort',
      'response_format',
      'signal',
      'temperature',
      'timeoutMs',
      'tools',
    ],
  },
  LlmChunk: {
    kind: 'interface',
    members: ['content', 'finishReason', 'partialToolCall', 'thought', 'toolCalls', 'usage'],
  },
  Config: { kind: 'interface', members: ['allowedPaths', 'llm', 'memory', 'security'] },
  TypedEventEmitter: { kind: 'class', members: ['off', 'on', 'once'] },
  AgentEventMap: {
    kind: 'interface',
    members: [
      'archiveFailed',
      'archiveModeChanged',
      'backgroundTaskSettled',
      'configReloaded',
      'contextCompressed',
      'contextTruncated',
      'dedupCompleted',
      'inputTooLarge',
      'memoryAdded',
      'memoryRecalled',
      'projectSwitched',
      'questionPending',
      'rolePackSwitchLocked',
      'rolePackSwitched',
      'roundSummaryGenerated',
      'sessionArchived',
      'sessionError',
      'sessionForked',
      'sessionPauseTimedOut',
      'sessionPaused',
      'sessionRecovered',
      'sessionResumeBlocked',
      'sessionResumeFailed',
      'sessionResumed',
      'sessionSwitched',
      'sessionTitleUpdated',
      'workProjectionGenerated',
    ],
  },
  ITracer: { kind: 'interface', members: ['startSpan'] },
  ISpan: { kind: 'interface', members: ['end', 'recordException', 'setAttribute'] },
  AgentMetrics: { kind: 'interface', members: ['context', 'llm', 'plan', 'tasks', 'tools'] },
  TRACE_SPANS: {
    kind: 'object',
    members: [
      'CONTEXT_SUMMARY',
      'DIFFICULTY',
      'LLM_CALL',
      'POST_PROCESS',
      'REPORT',
      'RESPONSE',
      'TOOL_EXEC',
    ],
  },
  SOURCE_LABELS: {
    kind: 'object',
    members: ['PERSONA', 'ROUND_SUMMARY', 'RULE', 'SKILL', 'UNKNOWN', 'WORK_PROJECTION'],
  },
  Memory: {
    kind: 'interface',
    members: [
      'accessedAt',
      'content',
      'createdAt',
      'deletedAt',
      'id',
      'isModified',
      'materialFingerprint',
      'metadata',
      'name',
      'roundId',
      'sessionName',
      'source',
      'summaryType',
      'supersededBy',
    ],
  },
  IMemoryStorage: {
    kind: 'interface',
    members: [
      'close',
      'count',
      'countBySource',
      'delete',
      'getAllSources',
      'getById',
      'getBySource',
      'getDeletedById',
      'listDeleted',
      'purge',
      'purgeExpired',
      'restore',
      'search',
      'touch',
      'upsert',
    ],
  },
  InMemoryStorage: {
    kind: 'class',
    members: [
      'close',
      'count',
      'countBySource',
      'delete',
      'getAllSources',
      'getById',
      'getBySource',
      'getDeletedById',
      'listDeleted',
      'purge',
      'purgeExpired',
      'restore',
      'search',
      'touch',
      'upsert',
    ],
  },
  IWebSearchProvider: { kind: 'interface', members: ['search'] },
  SearchResult: { kind: 'interface', members: ['endpoint', 'snippet', 'title', 'url'] },
  WebSearchOptions: { kind: 'interface', members: ['limit'] },
  SearchEndpoint: { kind: 'interface', members: ['buildUrl', 'name', 'parse'] },
  FetchWebSearchProvider: { kind: 'class', members: ['search'] },
  IFetchProvider: { kind: 'interface', members: ['fetch'] },
  FetchedPage: {
    kind: 'interface',
    members: ['content', 'contentType', 'fetchFailed', 'title', 'url'],
  },
  FetchOptions: { kind: 'interface', members: ['maxChars'] },
  FetchWebFetchProvider: { kind: 'class', members: ['fetch'] },
  ICodeExecutionProvider: { kind: 'interface', members: ['execute', 'supportedLanguages'] },
  CodeExecutionResult: { kind: 'interface', members: ['exitCode', 'stderr', 'stdout', 'timedOut'] },
  CodeExecutionOptions: { kind: 'interface', members: ['cwd', 'timeoutMs'] },
  IEnvironmentProvider: { kind: 'interface', members: ['getEnvironment'] },
  HostEnvironmentInfo: { kind: 'interface', members: ['os', 'runtimes', 'shell'] },
  IProjectSearchProvider: { kind: 'interface', members: ['searchFiles', 'searchText'] },
  ProjectFileMatch: { kind: 'interface', members: ['path'] },
  ProjectFileSearchOptions: {
    kind: 'interface',
    members: ['exclude', 'include', 'maxResults', 'query', 'terms'],
  },
  ProjectFileSearchResult: {
    kind: 'interface',
    members: ['failed', 'matches', 'relaxed', 'termsUsed', 'truncated', 'truncatedBy'],
  },
  ProjectTextMatch: { kind: 'interface', members: ['line', 'path', 'preview'] },
  ProjectTextSearchOptions: { kind: 'interface', members: ['pattern'] },
  ProjectTextSearchResult: {
    kind: 'interface',
    members: [
      'failed',
      'matches',
      'partialReadFiles',
      'perFileCapped',
      'relaxed',
      'scannedFiles',
      'termsUsed',
      'truncated',
      'truncatedBy',
      'unreadableSkipped',
    ],
  },
  ProjectRegistry: {
    kind: 'class',
    members: ['get list', 'inferProjectName', 'register', 'unregister'],
  },
  ProjectEntry: { kind: 'interface', members: ['lastOpened', 'name', 'path'] },
  LockManager: { kind: 'class', members: ['acquire', 'get currentPath', 'release'] },
  ISessionStore: {
    kind: 'interface',
    members: [
      'appendRoundId',
      'appendRoundIds',
      'createSession',
      'deleteSession',
      'getRoundIds',
      'getSessionMeta',
      'listSessionMetas',
      'listSessions',
      'loadMessages',
      'setRoundIds',
      'setSessionTitle',
      'updateSessionMeta',
    ],
  },
  SessionMessage: { kind: 'interface', members: ['content', 'role', 'roundId', 'timestamp'] },
  SessionMeta: {
    kind: 'interface',
    members: [
      'autoName',
      'createdAt',
      'displayName',
      'keyTopics',
      'messageCount',
      'sessionId',
      'summary',
      'updatedAt',
    ],
  },
  Round: {
    kind: 'interface',
    members: [
      'assistantLog',
      'assistantMessage',
      'completedAt',
      'createdAt',
      'evidence',
      'id',
      'interactiveInputs',
      'processEvents',
      'refCount',
      'status',
      'userMessage',
    ],
  },
  RoundMessage: {
    kind: 'interface',
    members: ['content', 'id', 'name', 'role', 'timestamp', 'tokenUsage'],
  },
  IRoundStore: {
    kind: 'interface',
    members: [
      'decrementRef',
      'delete',
      'getById',
      'getByIds',
      'incrementRef',
      'listAll',
      'listByStatus',
      'listInterruptedRecent',
      'listOrphaned',
      'save',
    ],
  },
  ProcessMetaPayload: {
    kind: 'interface',
    members: ['contextWindow', 'llm', 'maxTokens', 'providerKind', 'reasoningEffort', 'role'],
  },
  ProcessMetricsPayload: {
    kind: 'interface',
    members: [
      'durationMs',
      'emptyResponseCount',
      'success',
      'tokenIn',
      'tokenOut',
      'toolFailureCount',
      'truncationRecoveryCount',
      'unparsedToolIntentCount',
    ],
  },
  ISessionViewLoader: {
    kind: 'interface',
    members: ['getMessageCount', 'loadBatchSummaries', 'loadSummary', 'loadView', 'loadViewUpTo'],
  },
  SessionView: { kind: 'interface', members: ['messages', 'meta', 'rounds', 'sessionId'] },
  SessionSummary: {
    kind: 'interface',
    members: ['lastMessagePreview', 'roundCount', 'sessionId', 'title', 'updatedAt'],
  },
  InMemorySessionViewLoader: {
    kind: 'class',
    members: ['getMessageCount', 'loadBatchSummaries', 'loadSummary', 'loadView', 'loadViewUpTo'],
  },
  InMemorySessionStore: {
    kind: 'class',
    members: [
      'appendRoundId',
      'appendRoundIds',
      'clear',
      'createSession',
      'deleteSession',
      'getRoundIds',
      'getSessionMeta',
      'listSessionMetas',
      'listSessions',
      'loadMessages',
      'setRoundIds',
      'setSessionTitle',
      'updateSessionMeta',
    ],
  },
  SessionCheckpoint: {
    kind: 'interface',
    members: [
      'completedToolCalls',
      'error',
      'lastHeartbeat',
      'pauseMeta',
      'pausedAt',
      'plan',
      'planItemLog',
      'sessionId',
      'status',
    ],
  },
  BackgroundTask: {
    kind: 'interface',
    members: ['command', 'result', 'startedAt', 'status', 'taskId'],
  },
  BACKGROUND_TASK_STATUS_LABELS: {
    kind: 'object',
    members: ['completed', 'killed', 'running', 'timedOut'],
  },
  ForkResult: { kind: 'interface', members: ['date', 'newSession', 'roundIds'] },
  ILogger: { kind: 'interface', members: ['debug', 'error', 'info', 'warn'] },
  logger: { kind: 'object', members: ['debug', 'error', 'info', 'warn'] },
  SkillEntry: {
    kind: 'interface',
    members: ['content', 'description', 'filePath', 'layer', 'layer3', 'name'],
  },
  AuditEvent: {
    kind: 'interface',
    members: ['decision', 'path', 'reason', 'source', 'timestamp', 'tool', 'type'],
  },
  WriteConfirmationInfo: {
    kind: 'interface',
    members: [
      'afterContent',
      'beforeContent',
      'description',
      'hasDiff',
      'needsConfirm',
      'permission',
      'targetPath',
      'tool',
    ],
  },
  MemoraError: {
    kind: 'class',
    members: ['category', 'cause', 'detail', 'errorCode', 'format', 'suggestions', 'title'],
  },
  ToolErrorCode: {
    kind: 'object',
    members: [
      'ARGUMENT_ERROR',
      'CUSTOM_TOOL_FAILED',
      'DIR_NOT_FOUND',
      'FILE_NOT_FOUND',
      'NOT_AVAILABLE',
      'PATH_NOT_ALLOWED',
      'PERMISSION_DENIED',
      'UNKNOWN',
      'UNKNOWN_TOOL',
      'WRITE_REJECTED',
    ],
  },
};

const actual = collectActualSurface();

/** 成员级差异清单：kind 变更 + 成员增删（双向），供红时报出可读定位 */
function diffSurface(): string[] {
  const issues: string[] = [];
  const actualKeys = new Set(Object.keys(actual));
  const expectedKeys = new Set(Object.keys(EXPECTED));
  for (const k of actualKeys) if (!expectedKeys.has(k)) issues.push(`[新符号] ${k}`);
  for (const k of expectedKeys) if (!actualKeys.has(k)) issues.push(`[符号消失] ${k}`);
  for (const k of actualKeys) {
    const a = actual[k];
    const e = EXPECTED[k];
    if (!e || !a) continue;
    if (a.kind !== e.kind) issues.push(`[形态变更] ${k}: ${e.kind} → ${a.kind}`);
    const expSet = new Set(e.members);
    const actSet = new Set(a.members);
    for (const m of a.members) if (!expSet.has(m)) issues.push(`[新成员] ${k}.${m}`);
    for (const m of e.members) if (!actSet.has(m)) issues.push(`[成员消失] ${k}.${m}`);
  }
  return issues;
}

describe('公开成员面登记守卫（PUBLIC-MEMBER-SURFACE-1）', () => {
  it('扫描面自检：成员面符号量与总导出量非空（防守卫失明假绿）', () => {
    const exportCount = parseIndexExports().length;
    expect(exportCount).toBeGreaterThan(50);
    expect(Object.keys(actual).length).toBeGreaterThan(80);
  });

  it('成员面与冻结基线一致（增删即红；红须按 §3.2.1 定性后显式更新 EXPECTED）', () => {
    const issues = diffSurface();
    const hint =
      `公开成员面发生增删/形态变更——先按 legacy-contract-audit-rules §3.2.1 人工定性：\n` +
      `  · 新成员：是真能力（补消费/文档）还是 no-op 谎报（删）？\n` +
      `  · 消失成员：是纠谎/收回（更新基线 + CHANGELOG 登记）还是误删（还原）？\n` +
      `定性结论即审查落点：把差异显式写进本文件 EXPECTED（禁止无审查直接对齐）。\n` +
      `已定性记录（2026-10-16 · 5.0.0）：\n` +
      `  ① AgentOptions.fileConsistencyCheck + FileConsistencyCheck 类型删除——全仓零读取僵尸字段\n` +
      `    （透传链路先删、project-rules 已宣告移除），属纠谎非删能力；FileConsistencyCheck 从未过\n` +
      `    index.ts 公开面，删除零破坏。\n` +
      `  ② SessionManager.heartbeat / isPaused / isRunning 提前于 DEPRECATE-1 计划删除（用户按\n` +
      `    SSOT/不带伤裁决）——isPaused/isRunning 是 status getter 的判据重复（三态两布尔吞 error 态）、\n` +
      `    heartbeat 是私有 touchCheckpoint 的机制外漏，三者内核+宿主+手册零消费；提前删除的代价\n` +
      `    = 4.x 升级者失去 deprecation 预警期，已由 CHANGELOG Breaking 段明示。`;
    expect(
      issues,
      `\n成员面差异 ${issues.length} 项：\n${issues.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });
});
