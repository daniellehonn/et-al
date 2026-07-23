// Barrel for the v6 store.
//
// Replaces the single monolithic src/store.ts of v5. Each module owns one
// entity and the rules that belong to it, so a rule like "an active project
// needs a next action" lives next to the data it constrains rather than in a
// route handler.

// Re-exported so callers get the vocabulary and the operations from one import.
export type {
  SubjectType, BlockType, RelationType, ProjectStatus, Mastery, ToolStatus,
  ContentStatus, LogEntryType, NoteType, GoalType, GoalStatus, Priority,
  CaptureInputType, ProcessingStatus, Classification, ReviewStatus, SourcePlatform,
} from "../schema.ts";

export * from "./context.ts";
export * from "./db.ts";
export * from "./documents.ts";
export * from "./areas.ts";
export * from "./goals.ts";
export * from "./projects.ts";
export * from "./logs.ts";
export * from "./notes.ts";
export * from "./relations.ts";
export * from "./tools.ts";
export * from "./sources.ts";
export * from "./content.ts";
export * from "./captures.ts";
export * from "./embeddings.ts";
export * from "./search.ts";
export * from "./jobs.ts";
export * from "./assets.ts";
