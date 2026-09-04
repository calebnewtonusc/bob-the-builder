export type {
  Action,
  Binding,
  ComponentId,
  ComponentNode,
  Json,
  Op,
  Pointer,
  PropValue,
  Spec,
  SurfaceEvent,
} from "./spec.js";
export { emptySpec, isBinding } from "./spec.js";

export {
  formatPointer,
  getAt,
  parsePointer,
  setAt,
} from "./pointer.js";

export type {
  A11yName,
  A11ySpec,
  ActionDef,
  Catalog,
  CatalogInit,
  ComponentDef,
  SkeletonSpec,
} from "./catalog.js";
export {
  defineAction,
  defineCatalog,
  defineComponent,
  isValidId,
} from "./catalog.js";

export {
  LineBuffer,
  LineParseError,
  parseLine,
  parseLines,
  serializeLines,
  serializeOp,
} from "./lines.js";

export type { PartialResult } from "./partial.js";
export { parsePartialJson, PartialJsonStream } from "./partial.js";

export type { StoreOptions } from "./store.js";
export { SurfaceStore } from "./store.js";

export type { BobStreamOptions, WireFormat } from "./stream.js";
export { resolveProps, BobStream } from "./stream.js";

export type { PromptOptions } from "./prompt.js";
export { buildSystemPrompt } from "./prompt.js";
