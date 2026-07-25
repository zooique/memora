/**
 * Sprite 集成测试夹具（真实 memora 实例，非 mock）
 *
 * 复刻 sprite `src/index.ts` 的 `createAgentInstance` 装配，但注入：
 *   - 桩 LlmProvider（backgroundProvider 返回脚本化 JSON，用于语义去重判定）
 *   - 桩 EmbeddingService（确定性伪向量，供 JsonVectorStore）
 *   - 临时 dataDir / configDir（node:sqlite + 真实落盘）
 *
 * 目的：让端到端用例以真实内核类（Agent / SqliteStorage / JsonVectorStore /
 * ProjectManager / UserProfile / WorkProjectionManager / DedupManager）驱动，
 * 仅把"外部 LLM"与"外部 embedding"替换为可控桩——这正是宿主在生产中注入的依赖，
 * 不属于对内核逻辑的 mock。
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  JsonVectorStore,
  NOOP_TRACER,
  type UIMessages,
  type Memory,
  type EmbeddingService,
  type LlmProvider,
  type ChatOptions,
  type LlmChunk,
} from 'memora';
import { SqliteStorage } from '../../storage/sqliteStorage.js';
import { SqliteSessionStore } from '../../storage/sessionStore.js';
import { SqliteRelationStore } from '../../storage/sqliteRelationStore.js';
import { NodeSqliteDatabase } from '../../storage/nodeSqliteDatabase.js';

/** 所有 UIMessages 字段均可选，最小占位即可满足 Agent 构造契约 */
const MINIMAL_MESSAGES: UIMessages = {};

/**
 * 桩 LLM Provider：chat() 仅产出预设文本（用于去重判定 JSON）。
 *
 * 内核 `LlmProvider` 是抽象类，但 barrel 仅以 `type` 形式导出（见 index.d.ts
 * `export type { LlmProvider, ChatOptions }`），且 package.json 仅暴露 "." 子路径，
 * 故无法 `extends`（需要类值）或深路径 import。改用 `implements`：
 *   - `implements` 仅需类型，与 type-only 导入兼容；
 *   - esbuild 在转译时会整体剥离 `implements` 子句，运行期不会引用 LlmProvider 值，
 *     避免 `ReferenceError: LlmProvider is not defined`；
 *   - 抽象成员 name / chat 由本类实现；supportsStructuredOutput 为抽象类中的 readonly
 *     具体成员，implements 仍需提供，这里给 false（桩不声明结构化输出能力）。
 */
class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  constructor(private readonly response = '{}') {}
  // 参数用 unknown[] 以规避对 Message 类型（内核未再导出）的显式依赖；
  // 方法参数在 TS 下为双变，unknown[] 可安全赋值给 Message[]。
  async *chat(_messages: unknown[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    yield { content: this.response };
  }
}

/** 桩 EmbeddingService：基于文本哈希的确定性伪向量（维度 8） */
function makeStubEmbedding(): EmbeddingService {
  const hash = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return n;
  };
  const vec = (t: string): number[] =>
    Array.from({ length: 8 }, (_, i) => ((hash(t) + i) % 97) / 97);
  return {
    async embed(text: string): Promise<number[]> {
      return vec(text);
    },
    async batchEmbed(texts: string[]): Promise<Array<{ text: string; vector: number[] }>> {
      return texts.map((t) => ({ text: t, vector: vec(t) }));
    },
  };
}

export const nowIso = (): string => new Date('2026-01-01T00:00:00.000Z').toISOString();

export interface AgentBundle {
  agent: Agent;
  storage: SqliteStorage;
  sessionStore: SqliteSessionStore;
  relationStore: SqliteRelationStore;
  vectorStore: JsonVectorStore;
  db: NodeSqliteDatabase;
  root: string;
  dataDir: string;
  configDir: string;
}

export interface CreateAgentOptions {
  /** backgroundProvider.chat 返回的脚本化 JSON（语义去重判定） */
  backgroundProviderResponse?: string;
  /** 复用已有目录（用于"重启 Agent"场景），传此参数时 closeAgent 不清理 root */
  dataDir?: string;
  configDir?: string;
  root?: string;
}

/** 在给定目录上装配一个真实 Agent（不创建临时目录、不负责清理） */
async function makeBundle(
  root: string,
  dataDir: string,
  configDir: string,
  opts: CreateAgentOptions,
): Promise<AgentBundle> {
  for (const d of [
    dataDir,
    configDir,
    join(configDir, 'personas'),
    join(configDir, 'skills'),
    join(configDir, 'rules'),
  ]) {
    mkdirSync(d, { recursive: true });
  }

  const db = new NodeSqliteDatabase(join(dataDir, 'memora.db'));
  db.exec('PRAGMA journal_mode = WAL');
  const storage = new SqliteStorage(db);
  const sessionStore = new SqliteSessionStore(db);
  const relationStore = new SqliteRelationStore(db);
  const vectorStore = new JsonVectorStore(join(dataDir, 'vectors.json'), makeStubEmbedding());
  await vectorStore.load();

  const provider = new StubProvider('');
  const backgroundProvider = new StubProvider(opts.backgroundProviderResponse ?? '{}');

  const agent = new Agent({
    projectPath: join(root, 'workspace'),
    configDir,
    dataDir,
    provider,
    storage,
    sessionStore,
    relationStore,
    vectorStore,
    messages: MINIMAL_MESSAGES,
    enableContextSummary: true,
    tracer: NOOP_TRACER,
    backgroundProvider,
  });

  await agent.init();
  return { agent, storage, sessionStore, relationStore, vectorStore, db, root, dataDir, configDir };
}

/** 创建全新临时目录上的真实 Agent */
export async function createRealAgent(opts: CreateAgentOptions = {}): Promise<AgentBundle> {
  const root = mkdtempSync(join(tmpdir(), 'sprite-e2e-'));
  const dataDir = join(root, 'data');
  const configDir = join(root, 'config');
  return makeBundle(root, dataDir, configDir, opts);
}

/** 在已存在的 dataDir 上重建 Agent（模拟"重启 sprite"） */
export async function createAgentIn(dataDir: string, configDir: string, opts: CreateAgentOptions = {}): Promise<AgentBundle> {
  return makeBundle(dataDir, dataDir, configDir, { ...opts, root: dataDir });
}

/** 关闭 Agent 与底层 SQLite（不删除目录，目录清理由调用方负责） */
export async function closeAgent(b: AgentBundle): Promise<void> {
  try {
    await b.agent.close();
  } catch {
    /* 关闭失败不应阻塞清理 */
  }
  try {
    b.db.close();
  } catch {
    /* 已关闭 */
  }
}

/** 删除临时根目录 */
export function cleanupRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 构造一条 Memory（填充默认字段），便于测试中直接 seed 进 storage */
export function makeMemory(
  p: Partial<Memory> & { id: string; source: string; content: string; name: string },
): Memory {
  return {
    score: 0.9,
    createdAt: nowIso(),
    accessedAt: nowIso(),
    metadata: {},
    ...p,
  } as Memory;
}
