# Memora

> **Agent Memory Kernel with Governance** — Local-first, Private, Zero-dep. Not a framework, a kernel.

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-81%25-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-2813%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**中文** → [README.md](./README.md)

---

## What problem are you facing?

- **LLM forgets everything between sessions** — Your users remember what they said, your agent doesn't
- **Existing memory solutions are either too heavy (framework-bound) or too shallow (CRUD only)** — No dedup, conflict detection, or write-time supersede
- **Memory and persona are tangled** — Switch personas and lose your history
- **You don't want to send data to the cloud** — Need a local, private memory layer with zero external dependencies

## How Memora solves this

Memora is an **Agent memory kernel** — framework-agnostic, cloud-independent, focused on one thing: **giving your agent cross-session, cross-topic long-term memory that stays clean.**

"Clean" means: semantic deduplication, conflict detection, write-time supersede, and recall boost (the more a memory is used, the more it matters) — not just stuffing history into the context window.

```typescript
import { Agent, createProviderFromConfig } from '@zooique/memora';

const agent = new Agent({
  projectPath: '/your/project',
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

// Next session — agent recalls automatically
const reply = await agent.chatSync('What language do I like?');

// Memory governance — dedup / conflict detection / source health
await agent.governance.deduplicate();
await agent.governance.detectConflicts();
const health = agent.governance.sourceHealth();

await agent.close();
```

> **Boundary**: Memora is a **non-standalone pure logic kernel** — persistence, sandbox, observability, CLI/UI are all injected by the host. The kernel guarantees **interface contracts + unit-tested logic correctness**; agent-level behavior evaluation is the host's responsibility.

---

## Why Memora?

| | Memora | Vector memory libs (agent-memory, MemStack) | Framework-builtin memory (Mastra, LangGraph) |
|---|---|---|---|
| **Memory governance** | ✅ Dedup+conflict+write-time supersede | ⚠️ Decay only or none | ⚠️ Partial |
| **Framework lock-in** | ✅ Zero — pure kernel | ✅ Standalone | ❌ Tied to framework |
| **Data privacy** | ✅ 100% local | ✅ Local | ⚠️ Partially cloud |
| **Runtime deps** | ✅ Zero (node:* only) | ❌ SQLite / better-sqlite3 | ❌ Heavy |
| **Persona/memory separation** | ✅ Role-pack boundary discipline | ❌ No persona concept | ⚠️ Simple prompt |
| **Embeddable** | ✅ Any Node.js host | ✅ Standalone lib | ❌ Framework-internal |

**One-line positioning**: If you want a **framework-agnostic, governance-capable, zero-dependency** memory layer, Memora is currently the only option on npm.

---

## Design Philosophy

> **Everything is Memory.**
>
> Persona is "I remember who I am." Rules are "I remember how to behave." Skills are "I remember how to do certain things." Conversation history is "I remember what we talked about."

Memora is a **brain kernel that cannot run standalone** — it has interfaces but no "form." A CLI, WebUI, desktop sprite, or novel generator can be its "host." The host gives it a body (UI), blood vessels (Provider), and neural circuits (event loops).

> **Version positioning (v3.0.0)**: **Node.js-only · Zero third-party runtime deps Agent kernel**. v3.0.0 is the first stable baseline after architecture convergence.

---

## Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Long-term Memory** | Cross-session, cross-topic memory persistence with intelligent recall |
| **Dual-channel Recall** | Semantic vector search + keyword search, hybridMerge fusion ranking |
| **Memory Governance** | Write-time supersede + recall boost + semantic dedup + conflict detection via `agent.governance` facade (dedup / conflict judged by LLM) |
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
// createProviderFromConfig is the single-provider entry; for multi-provider + active see createLlmProvider(loadConfig())
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
  dataDir: '.memora',                 // memory data directory
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

// Next session — the agent automatically recalls "loves TypeScript"
const reply = await agent.chatSync('What language do I like?');
// → Answers based on recalled memory
```

### Memory Management

```typescript
// Search memories (hybrid: semantic + keyword), limit is a number
const hits = await agent.memory.searchHybrid('TypeScript preference', 5);

// Governance (exposed via agent.governance facade, LLM-judged)
const report = await agent.governance.deduplicate();
console.log(`Deduplicated ${report.deduplicatedCount} memories`);

const conflicts = await agent.governance.detectConflicts();

// Source health diagnosis (pure computation, no LLM): per-source count / days since last access (score retired → factual observation only)
const health = agent.governance.sourceHealth();
console.log(health?.sources);
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
│  │  - Dual-channel recall (semantic+keyword)│               │
│  │  - Memory governance (dedup/conflict/supersede) │         │
│  │  - Role pack matching / Skill matching   │               │
│  │  - Tool registration / execution         │               │
│  │  - Session archive / external task loop  │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### Five Injectable Interfaces

The kernel interacts with the outside world through interfaces. Hosts inject implementations as needed:

| Interface | Responsibility | Built-in Implementation |
|-----------|---------------|------------------------|
| `IMemoryStorage` | Memory CRUD + search + query by source | `InMemoryStorage` |
| `IVectorStore` | Semantic vector index | `JsonVectorStore` |
| `ISessionStore` | Session history persistence | None (host implements) |
| `ILogger` | Logging output | console fallback |
| `ITracer` | Observability spans | `NOOP_TRACER` |

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
│   └── managers/     # 16 specialized Managers/service classes (memoryInspector / memoryGovernance / roundSummaryGenerator / sessionManager / sessionArchiver / archiveCoordinator / workProjection / textPolishManager / chatLockManager, etc.)
├── memory/           # Memory engine (IMemoryStorage + InMemoryStorage + recall / hybrid ranking / vector / governance constants)
├── role-pack/        # Role packs (manifest parsing + validator + strategyResolver + capability mapping)
├── skill/            # Skill management (global pool + role-pack binding, progressive disclosure + skillScriptRunner)
├── llm/              # LLM adapter layer (provider + openaiCompatible + factory + embedding)
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
| Memory Model | Open-string source primitive ("Everything is Memory" v2) | ADR-004 |
| Vector Search | IVectorStore interface + built-in JsonVectorStore (pure JS cosine similarity) | ADR-002 |
| Conflict Resolution | Memory conflicts resolved via supersededBy boolean flag | ADR-021 |
| Form Factor | Pure logic library (zero native deps, CLI/UI provided by host) | ADR-002 |
| Security | Two-level permissions + path whitelist + audit log | ADR-006 |
| Testing | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## Engineering Quality

| Metric | Value |
|--------|-------|
| Source | 114 production files (src/, zero third-party runtime deps) |
| Tests | 102 test files |
| Tests Passing | 2,813 passed / 1 skipped |
| Statement Coverage | 80.8% |
| Branch Coverage | 72.5% |
| Function Coverage | 83.2% |
| Line Coverage | 82.3% |
| Runtime Dependencies | **0** |
| Architecture Decision Records | 24 ADRs |

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
- [API Reference](docs/memora-api-reference.md) — Public API quick reference (Chinese)
- [Config Example](config.example.json) — LLM / Embedding / Security config template

## Host Project

[memora-vscode](https://gitee.com/zooique/memora/tree/main/hosts/memora-vscode) — The VS Code extension host (primary host), demonstrating a complete Memora integration: SQLite persistence, dual-channel recall, role pack management, and memory views.

## Why Memora?

| | Memora | Cloud memory services | Framework memory modules |
|---|---|---|---|
| Data privacy | ✅ 100% local | ❌ Cloud-dependent | ⚠️ Varies |
| Runtime deps | ✅ Zero | N/A (SaaS) | ❌ Heavy |
| Memory lifecycle | ✅ Full (dedup/conflict/supersede) | ⚠️ Partial | ❌ CRUD only |
| Domain-agnostic | ✅ Open-string source | ⚠️ Opinionated | ⚠️ Framework-locked |
| Embeddable | ✅ Any Node.js host | ❌ API calls only | ⚠️ Framework-bound |
| Relation graph | ✅ Built-in sidecar | ❌ Rare | ❌ Rare |

## Contributing

This project follows the "Big Tree Model" engineering philosophy. Architecture Decision Records (ADRs) are in the repository [.trae/decisions/](https://gitee.com/zooique/memora/tree/main/.trae/decisions).

## License

[MIT](LICENSE)
