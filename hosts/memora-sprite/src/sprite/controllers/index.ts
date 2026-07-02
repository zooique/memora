export { MemoryController } from './memoryController.js';
export type { DashboardData, MemoryListItem, MemoryDetail, MemorySearchResult, RapportLevel, RapportAssessment } from './memoryController.js';

export { PersonaController } from './personaController.js';
export type { PersonaInfo } from './personaController.js';

export { ProactiveEngine } from './proactiveEngine.js';
export type { ProactiveConfig, ProactiveStats, SpriteEmitter } from './proactiveEngine.js';

export { PresenceController } from './presenceController.js';
export type { PresenceState, PresenceChangeEvent, PresenceControllerOptions, IPowerMonitor, IApp } from './presenceController.js';

export { AffectController } from './affectController.js';
export type { AffectState, AffectControllerOptions } from './affectController.js';

export { RapportController } from './rapportController.js';
export type { RapportState, RapportControllerOptions } from './rapportController.js';

export { ContextAwareness } from './contextAwareness.js';
export type { ContextState, ContextAwarenessOptions, RhythmType, CoherenceLevel, DepthLevel } from './contextAwareness.js';

export { PatternDetector } from './patternDetector.js';
export type { DetectedPattern, PatternType, PatternDetectorOptions } from './patternDetector.js';
