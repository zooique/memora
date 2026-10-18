# Memora

> **Agent Memory Kernel with Governance** — Local-first, Private, Zero-dep. Not a framework, a kernel.

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-covered-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**中文** → [README.md](./README.md)

---

## What problem are you facing?

- **LLM forgets everything between sessions** — Your users remember what they said, your agent doesn't
- **Existing memory solutions are either too heavy (framework-bound) or too shallow (CRUD only)** — No write-time supersede: either decay-only forgetting, or old and new memories coexist and contradict each other
- **Memory and persona are tangled** — Switch personas and lose your history
- **You don't want to send data to the cloud** — Need a local, private memory layer with zero external dependencies

## How Memora solves this

Memora is an **Agent memory kernel** — framework-agnostic, cloud-independent, focused on one thing: **giving your agent cross-session, cross-topic long-term memory that stays clean.**

"Clean" means: write-time supersede (soft `supersededBy` pointer, traceable) and last-used refresh (accessedAt, used for ordering) — no importance weighting, and not just stuffing history into the context window. **Governance happens at write time only**: there is no subscription-style post-hoc sweep (dedup / conflict detection / related suggestions were retired as a whole in 5.0.0 — see the Core Capabilities table).

```typescript
import { Agent, createProviderFromConfig } from '@zooique/memora';

const agent = new Agent({
  projectPath: '/your/project',
  dataDir: '/your/project/.memora-data', // memory data directory (required)
  provider: createProviderFromConfig('primary', {
    provider: 'openaiCompatible',
    apiKey: process.env.LLM_API_KEY!,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  }),
});
await agent.init();

// Chat — memories persist automatically
for await (const chunk of agent.chat('I love TypeScript')) {
  process.stdout.write(chunk.content);
}

// Next session — the LLM can call search_memories to retrieve this memory
const reply = await agent.chatSync('What language do I like?');

await agent.close();
```

> **Boundary**: Memora is a **non-standalone pure logic kernel** — persistence, sandbox, observability, CLI/UI are all injected by the host. The kernel guarantees **interface contracts + unit-tested logic correctness**; agent-level behavior evaluation is the host's responsibility.

---

## Why Memora?

| | Memora | Vector memory libs (agent-memory, MemStack) | Framework-builtin memory (Mastra, LangGraph) |
|---|---|---|---|
| **Memory governance** | ✅ Write-time supersede (soft `supersededBy`, traceable) | ⚠️ Decay only or none | ⚠️ Partial |
| **Framework lock-in** | ✅ Zero — pure kernel | ✅ Standalone | ❌ Tied to framework |
| **Data privacy** | ✅ 100% local | ✅ Local | ⚠️ Partially cloud |
| **Runtime deps** | ✅ Zero (node:* only) | ❌ SQLite / better-sqlite3 | ❌ Heavy |
| **Persona/memory separation** | ✅ Role-pack boundary discipline | ❌ No persona concept | ⚠️ Simple prompt |
| **Embeddable** | ✅ Any Node.js host | ✅ Standalone lib | ❌ Framework-internal |

**One-line positioning**: If you want a **framework-agnostic, governance-capable (write-time supersede), zero-dependency** memory layer, Memora is currently the only option on npm.

---

## Design Philosophy

> **Memory-as-Summary.**
>
> Conversation is the raw material: after each turn, an asynchronous round-summary is generated as the sole memory unit; the original conversation records are stored separately and traceable via source links. Persona, rules, and skills live in the role-pack, not the memory store.

Memora is a **brain kernel that cannot run standalone** — it has interfaces but no "form." A CLI, WebUI, desktop sprite, or novel generator can be its "host." The host gives it a body (UI), blood vessels (Provider), and neural circuits (event loops).

> **Version positioning (v3.0.0)**: **Node.js-only · Zero third-party runtime deps Agent kernel**. v3.0.0 is the first stable baseline after architecture convergence. **v4.0.0 (first major)**: public export surface collapsed (54 exports removed; full list in the `[4.0.0]` section of [CHANGELOG](./CHANGELOG.md)) + `agent.memory.search()` removed (`searchByKeyword()` is the sole entry). **v5.0.0 (second major, in development)**: public surface trimmed (12 general utilities / duplicate entries withdrawn) + goal-drift detection chain retired + checkpoint public-method slimming; a `node:*` built-in SQLite storage implementation added (`createNodeSqliteStorage`).

---

## Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Long-term Memory** | Cross-session, cross-topic memory persistence with tool-based recall (`search_memories`; no automatic injection) |
| **Memory Search Tool** | Keyword-only retrieval (`search_memories`), refreshes `accessedAt` on hit (semantic vector channel removed via B0, 2026-09-18) |
| **Memory Governance** | **Write-time governance only**: write-time supersede + last-used refresh (`accessedAt` used for ordering; no importance weighting). Subscription-style post-hoc governance (dedup / conflict detection / related suggestions) was retired as a whole in 5.0.0 |
| **Agent-Persona Separation** | Agent is a pure memory engine; persona is a personality vessel. Switch personas without losing memories |
| **Unified Memory Model** | Everything is a "Memory" primitive, distinguished by open-string `source` — no closed enums |
| **Domain-agnostic** | Same architecture, different memory configs → different domains |
| **Zero third-party runtime deps** | Depends on Node built-ins (`node:*`); persistence injected by host via interfaces |
| **Observability** | ITracer interface + structured spans, plug into any APM |
| **External tools** | Conditionally exposed `web_search` / `web_fetch` / `run_code` — enabled only when host injects the corresponding provider |

## Quick Start

### Install

```bash
npm install @zooique/memora
```

### Create an Agent

```typescript
import { Agent, createProviderFromConfig } from '@zooique/memora';

// Host responsibility: create an LLM Provider
// Works with any OpenAI Chat Completions-compatible service
// createProviderFromConfig is the canonical entry (baseUrl+model+apiKey → validated creation; provider
// selection is the host's responsibility).
const provider = createProviderFromConfig('primary', {
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'deepseek-chat',
});

// Create Agent
const agent = new Agent({
  projectPath: '/path/to/project',
  provider,
  configDir: '/path/to/agent-config', // role-packs / skills
  dataDir: '/path/to/project/.memora-data', // memory data directory (required; prefer absolute)
});

await agent.init();
```

### Chat (Streaming)

```typescript
for await (const chunk of agent.chat('Hi, remember that I love TypeScript')) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.content);
  }
}

// Next session — the LLM can call search_memories to retrieve "loves TypeScript"
const reply = await agent.chatSync('What language do I like?');
// → Answers based on the memories the LLM retrieved
```

### Memory Management

```typescript
// Search memories (keyword-only; semantic vector channel removed via B0, 2026-09-18), limit is a number
const hits = await agent.memory.searchByKeyword('TypeScript preference', 5);

// Source health diagnosis (pure computation, no LLM): sources are discovered dynamically
// via getAllSources(); per-source count / days since last access
const stats = agent.memory.stats();
console.log(stats.bySource);

// Write-time governance is handled by supersede: a new memory replaces the old one and
// leaves a soft `supersededBy` pointer (nothing is deleted, history stays traceable).
// Subscription-style post-hoc governance (dedup / conflict detection / related
// suggestions) was retired as a whole in 5.0.0 - see the note in API reference §4.
```

### Cleanup

```typescript
await agent.close();
```

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Host Application (CLI / Desktop Sprite / WebUI / Game)    │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider     │◄───│ API Key / baseUrl │  ← Host job  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ inject                                          │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora Kernel (Agent)                   │               │
│  │  - chat(input) → streaming response      │               │
│  │  - Keyword-only search                   │               │
│  │  - Write-time governance (supersede)     │               │
│  │  - Role pack matching / Skill matching   │               │
│  │  - Tool registration / execution         │               │
│  │  - Session archive / round persistence   │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### Five Injectable Interfaces

The kernel interacts with the outside world through interfaces. Hosts inject implementations as needed:

| Interface | Responsibility | Built-in Implementation |
|-----------|---------------|------------------------|
| `IMemoryStorage` | Memory CRUD + search + query by source | Built-in in-memory default (placeholder, non-persistent; internal class, not on the public surface — PUB-API-PRUNE-2) + optional persistent impl `createNodeSqliteStorage(dbPath)` (built-in `node:sqlite`, zero third-party deps) | Host picks the backend: create SQLite via the kernel factory, or implement its own (JSON / own SQLite) |
| `ISessionStore` | Session history persistence | None (host implements) |
| `ILogger` | Logging output | console fallback |
| `ITracer` | Observability spans | Internal noop (not on the public surface; omit `tracer` for zero overhead) |

### Multi-project and Agent boundaries (settled model)

**One Agent binds to one project** — `projectPath` + one storage + one session domain. For multiple projects, the **host** creates one Agent instance per project; the kernel neither switches projects nor maintains a cross-project registry.

| Dimension | Model |
|-----------|-------|
| One project (one Agent) | May own N sessions (`switchSession` / `switchToSession` / `forkSession`), but **only one runs at a time** |
| N projects (N Agent instances) | Run **in parallel**, each with its own memory store / sessions / project lock |
| Parallelism | **Counted by project, not by session** |
| Sessions within a project | **Share one memory store** (search has no session filter) ⇒ experience carries across sessions |

> **Trade-off (stated explicitly)**: this model deliberately does **not** mirror the mainstream "one session = one Agent instance" design. The cost: **two sessions cannot run in parallel within the same project** (mainstream tools just open two terminals). This is known and accepted, tracked as `MULTI-SESS-1` (observation only) — it is revisited only if a real need for "two parallel tasks in one repo" appears.
> **Rationale**: the memory store belongs to the **project**; a session is just a conversation thread inside it. Drawing the identity boundary at the project (not the session) is what lets experience carry across sessions.
> See the [integration guide](docs/memora-接入指南.md) ("多项目怎么办") for wiring details and data layout.

## Project Structure

```
src/
├── index.ts          # Library exports (types + interfaces + functions + classes, no CLI)
├── agent/            # Agent facade + AgentLoop + seed/ (single-turn execution loop)
│   ├── agent.ts      # Facade class (single entry point for hosts)
│   ├── loop.ts       # Core loop (reason → tool call → reflection retry)
│   ├── assembler.ts  # Component assembler (pure factory)
│   ├── contextManager.ts / contextPreparer.ts / toolExecutor.ts / toolRunner.ts ···
│   ├── seed/         # Minimal execution loop (prepare → act/difficulty → reflect, incl. external task outer loop)
│   └── managers/     # Specialized Managers/service classes (memoryInspector / roundSummaryGenerator / sessionManager / sessionArchiver / archiveCoordinator / workProjection / textPolishManager / chatLockManager, etc.)
├── memory/           # Memory engine (IMemoryStorage + InMemoryStorage + optional SQLite store + keyword recall / supersede resolution)
├── role-pack/        # Role packs (manifest parsing + validator + strategyResolver + capability mapping)
├── skill/            # Skill management (global pool + role-pack binding, progressive disclosure + skillScriptRunner)
├── llm/              # LLM adapter layer (provider + openaiCompatible + factory)
├── security/         # Security (path guard / write confirmation)
├── config/           # Config loading
├── code-exec/        # Generic code execution abstraction (conditionally exposed)
├── web-search/       # Web search abstraction (conditionally exposed)
├── web-fetch/        # Web fetch abstraction (conditionally exposed)
├── logging/          # Logging (ILogger interface + console fallback)
└── utils/            # Utilities (scanner / segmenter / event system / atomic write)
```

## Tech Stack

| Category | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | ADR-001 |
| Data Layer | IMemoryStorage interface (host injects persistence) | ADR-002 |
| LLM Protocol | OpenAI Chat Completions compatible (streaming SSE + Tool Calling) | ADR-003 |
| Memory Model | Memory-as-summary: round-summary single track, traceable to source; source open-string primitive | ADR-004 · memory-as-summary.md |
| Conflict Resolution | Memory conflicts resolved via supersededBy boolean flag | ADR-021 |
| Form Factor | Pure logic library (zero native deps, CLI/UI provided by host) | ADR-002 |
| Security | Two-level permissions + path whitelist + audit log | ADR-006 |
| Testing | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## Engineering Quality

| Metric | Value |
|--------|-------|
| Source | All production files under src/ (zero third-party runtime deps; no count listed — any count is a point-in-time snapshot) |
| Tests | Dual vitest suites (kernel + host), run by the root vitest config |
| Tests Passing | All passing (pass/skip counts as measured by pre-release CI — point-in-time snapshots, not recorded here) |
| Test Coverage | Statement / branch / function / line coverage: run `npm run test:cov` for current values (no percentages recorded here — they are point-in-time snapshots) |
| Runtime Dependencies | **0** |
| Architecture Decision Records | In-repo `.trae/decisions/` directory (see its `README.md` for the index; no count listed here — any count is a point-in-time snapshot) |

## Development

```bash
npm test             # Run tests
npm run test:cov     # Run tests + coverage
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run build        # Compile to dist/
```

## Documentation

- [Integration Guide](docs/memora-接入指南.md) — Complete host developer onboarding manual (Chinese)
- [**Upgrading from 4.x to 5.0.0**](docs/memora-升级指南-4.x-到-5.0.0.md) — What was removed and how to migrate each item (Chinese; required for the major upgrade)
- [API Reference](docs/memora-api-reference.md) — Public API quick reference (Chinese)
- [Config Example](config.example.json) — LLM / Security config template

## Host Project

[memora-vscode](https://github.com/zooique/memora/tree/main/hosts/memora-vscode) — The VS Code extension host (primary host), demonstrating a complete Memora integration: JSON file persistence (`.memora/memories.json`), keyword-only search, role pack management, and memory views.

## Why not cloud or framework memory?

| | Memora | Cloud memory services | Framework memory modules |
|---|---|---|---|
| Data privacy | ✅ 100% local | ❌ Cloud-dependent | ⚠️ Varies |
| Runtime deps | ✅ Zero | N/A (SaaS) | ❌ Heavy |
| Memory lifecycle | ✅ Write-time supersede | ⚠️ Partial | ❌ CRUD only |
| Domain-agnostic | ✅ Open-string source | ⚠️ Opinionated | ⚠️ Framework-locked |
| Embeddable | ✅ Any Node.js host | ❌ API calls only | ⚠️ Framework-bound |
| Relation graph | ✅ Built-in sidecar | ❌ Rare | ❌ Rare |

## Feedback

Found a bug or have a suggestion? Please open an issue at [GitHub Issues](https://github.com/zooique/memora/issues) (primary repository); Gitee Issues (https://gitee.com/zooique/memora/issues) is a synced mirror for users in mainland China, checked less frequently.

## Contributing

This project follows the "Big Tree Model" engineering philosophy. Architecture Decision Records (ADRs) are in the repository [.trae/decisions/](https://github.com/zooique/memora/tree/main/.trae/decisions).

## License

[MIT](LICENSE)
