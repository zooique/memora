# Memora

> Universal Agent Memory Kernel — Local-first, Private, Domain-agnostic. Everything is Memory.

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-90%25-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-1983%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**中文** → [README.md](./README.md)

---

## What is this?

Memora is an **Agent memory infrastructure** — it gives your AI Agent persistent, cross-session long-term memory.

It solves one core problem: **LLMs are stateless, but user tasks are continuous.**

Memora builds continuous evolution on top of stateless inference: memory persistence, intelligent recall, natural decay, semantic deduplication, conflict detection — a complete memory lifecycle, all running locally. Your data never leaves your machine.

## Design Philosophy

> **Everything is Memory.**
>
> Persona is "I remember who I am." Rules are "I remember how to behave." Skills are "I remember how to do certain things." Conversation history is "I remember what we talked about."

Memora is a **brain kernel that cannot run standalone** — it has interfaces but no "form." A CLI, WebUI, desktop sprite, or novel generator can be its "host." The host gives it a body (UI), blood vessels (Provider), and neural circuits (event loops).

## Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Long-term Memory** | Cross-session, cross-topic memory persistence with intelligent recall |
| **Dual-channel Recall** | Semantic vector search + keyword search, hybridMerge fusion ranking |
| **Memory Governance L1-L4** | L1 semantic dedup → L2 timeliness eval → L3 conflict detection → L4 scheduled decay |
| **Relation Graph** | contradicts / supports / follows / refines / caused — five relation types |
| **Agent-Persona Separation** | Agent is a pure memory engine; persona is a personality vessel. Switch personas without losing memories |
| **Unified Memory Model** | Everything is a "Memory" primitive, distinguished by open-string `source` — no closed enums |
| **Domain-agnostic** | Same architecture, different memory configs → different domains |
| **Zero-dependency Kernel** | No third-party runtime dependencies; persistence injected by host via interfaces |
| **Content Guardrails** | Regex rules + block/warn actions, bidirectional input/output checking |
| **Observability** | ITracer interface + structured spans, plug into any APM |

## Quick Start

### Install

```bash
npm install @zooique/memora
```

### Create an Agent

```typescript
import { Agent, createLlmProvider } from '@zooique/memora';

// Host responsibility: create an LLM Provider
// Works with any OpenAI Chat Completions-compatible service
const provider = createLlmProvider({
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

// Create Agent
const agent = new Agent({
  projectPath: '/path/to/project',
  provider,
  configDir: '/path/to/agent-config', // personas / rules / skills
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
// Search memories (hybrid: semantic + keyword)
const hits = await agent.memory.searchHybrid('TypeScript preference', { limit: 5 });

// Governance: semantic deduplication
const report = await agent.deduplicateMemories();
console.log(`Deduplicated ${report.deduplicatedCount} memories`);

// Governance: timeliness evaluation
const timeliness = await agent.evaluateTimeliness();

// Governance: conflict detection
const conflicts = await agent.detectConflicts();

// Manual decay trigger
await agent.runMemoryDecayOnce();
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
│  │  - Governance L1-L4 (dedup/age/conflict) │               │
│  │  - Persona matching / Skill matching     │               │
│  │  - Tool registration / execution         │               │
│  │  - Session archive / Insight extraction  │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### Six Injectable Interfaces

The kernel interacts with the outside world through interfaces. Hosts inject implementations as needed:

| Interface | Responsibility | Built-in Implementation |
|-----------|---------------|------------------------|
| `IMemoryStorage` | Memory CRUD + search + decay | `InMemoryStorage` |
| `IVectorStore` | Semantic vector index | `JsonVectorStore` |
| `IMemoryRelationStore` | Memory relation graph | `InMemoryRelationStore` |
| `ISessionStore` | Session history persistence | None (host implements) |
| `ILogger` | Logging output | console fallback |
| `ITracer` | Observability spans | `NOOP_TRACER` |

## Project Structure

```
src/
├── index.ts          # Library exports (pure types + interfaces, no CLI)
├── agent/            # Agent facade + AgentLoop execution engine
│   ├── agent.ts      # Facade class (single entry point for hosts)
│   ├── loop.ts       # Core loop (reason → tool call → reflection retry)
│   ├── assembler.ts  # Component assembler (pure factory, stateless)
│   ├── toolExecutor.ts    # Tool registration & execution
│   ├── contextManager.ts  # Context window management (truncation + summary)
│   ├── guardrail.ts       # Content guardrails (regex + block/warn)
│   └── managers/          # 15 specialized Managers
│       ├── archiveCoordinator.ts   # Archive coordination
│       ├── memoryInspector.ts      # Memory read/write (CRUD + search + stats)
│       ├── memoryGovernance.ts     # Governance unified facade (L1-L4)
│       ├── dedupManager.ts         # L1 semantic deduplication
│       ├── memoryDecayScheduler.ts # L4 scheduled decay + L2 timeliness
│       ├── memoryAdvisor.ts        # L3 conflict detection + health diagnosis
│       ├── insightExtractor.ts     # Conversation insight extraction
│       ├── relationBuilder.ts      # Memory relation building (ADR-014)
│       ├── sessionManager.ts       # Session management (fork/switch)
│       ├── sessionArchiver.ts      # Session content archiving
│       ├── configManager.ts        # Config management (hot-reload rules/skills)
│       ├── autoConfigRefiner.ts    # Self-evolving config suggestions
│       ├── workProjection.ts       # Work projection management
│       ├── textPolishManager.ts    # Text polishing
│       └── chatLockManager.ts      # Chat concurrency lock
├── memory/           # Memory engine
│   ├── types.ts          # Memory primitive (8 fields) + relation types
│   ├── storageInterface.ts  # IMemoryStorage interface (16 methods)
│   ├── recall.ts         # Dual-channel recall (semantic + keyword)
│   ├── hybridMerge.ts    # Fusion ranking algorithm
│   ├── vectorStore.ts    # IVectorStore + JsonVectorStore
│   ├── relationStore.ts  # IMemoryRelationStore interface
│   ├── governance.ts     # Governance shared constants (decay/boost/ceiling)
│   ├── userProfile.ts    # User profile management
│   └── projectManager.ts # Multi-project registry + lock management
├── llm/              # LLM adapter layer
│   ├── provider.ts       # LlmProvider abstract class
│   ├── openaiCompatible.ts  # OpenAI-compatible protocol implementation
│   ├── embedding.ts      # EmbeddingProvider (/embeddings endpoint)
│   └── factory.ts        # createLlmProvider factory
├── persona/          # Persona management (pure files + in-memory cache)
├── skill/            # Skill management (keyword matching + per-turn injection)
├── security/         # Security (two-level permissions + path whitelist + audit)
├── config/           # Config loading (JSON + env variable interpolation)
├── logging/          # Logging (ILogger interface + lazy initialization)
├── eval/             # Eval framework (EvalScenario + EvalRunner, for CI)
└── utils/            # Utilities (event emitter / segmenter / errors / timers)
```

## Tech Stack

| Category | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | ADR-001 |
| Data Layer | IMemoryStorage interface (host injects persistence) | ADR-002 |
| LLM Protocol | OpenAI Chat Completions compatible (streaming SSE + Tool Calling) | ADR-003 |
| Memory Model | Open-string source primitive ("Everything is Memory" v2) | ADR-004 |
| Vector Search | IVectorStore interface + built-in JsonVectorStore (pure JS cosine similarity) | ADR-002 |
| Relation Graph | IMemoryRelationStore sidecar model (non-invasive to Memory primitive) | ADR-014 |
| Form Factor | Pure logic library (zero native deps, CLI/UI provided by host) | ADR-002 |
| Security | Two-level permissions + path whitelist + audit log | ADR-006 |
| Testing | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## Engineering Quality

| Metric | Value |
|--------|-------|
| Source | 82 files / 17,459 lines |
| Tests | 75 files / 23,042 lines (test code > production code) |
| Tests Passing | 1,715+ |
| Statement Coverage | 89.3% |
| Branch Coverage | 81.7% |
| Function Coverage | 91.7% |
| Runtime Dependencies | **0** |
| Architecture Decision Records | 25 ADRs |

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

[memora-sprite](hosts/memora-sprite/) — An Electron-based desktop sprite host (v1.5.0), demonstrating a complete Memora integration: SQLite persistence, vector indexing, system tray, global shortcuts, and memory graph visualization.

## Why Memora?

| | Memora | Cloud memory services | Framework memory modules |
|---|---|---|---|
| Data privacy | ✅ 100% local | ❌ Cloud-dependent | ⚠️ Varies |
| Runtime deps | ✅ Zero | N/A (SaaS) | ❌ Heavy |
| Memory lifecycle | ✅ Full (dedup/decay/conflict) | ⚠️ Partial | ❌ CRUD only |
| Domain-agnostic | ✅ Open-string source | ⚠️ Opinionated | ⚠️ Framework-locked |
| Embeddable | ✅ Any Node.js host | ❌ API calls only | ⚠️ Framework-bound |
| Relation graph | ✅ Built-in sidecar | ❌ Rare | ❌ Rare |

## Contributing

This project follows the "Big Tree Model" engineering philosophy. Architecture Decision Records (ADRs) are in `.trae/decisions/`.

## License

[MIT](LICENSE)
