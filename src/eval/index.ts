export type { ModelAdapter, ReplayFixtures } from "./adapter.js";
export { defineAdapter, replayAdapter } from "./adapter.js";

export type { StabilityReport } from "./metrics.js";
export {
  componentCount,
  componentCounts,
  measureStability,
  multisetJaccard,
  shapeSignature,
  treeDepth,
} from "./metrics.js";

export type {
  Assertion,
  AssertionResult,
  RunResult,
  Scenario,
  Suite,
  SuiteInit,
} from "./scenario.js";
export {
  allInteractiveNamed,
  avoidsComponent,
  bindsData,
  custom,
  defineScenarios,
  firstPaintUnder,
  maxComponents,
  maxDepth,
  maxTokens,
  noPlaceholders,
  noWarnings,
  renders,
  usesComponent,
  usesOneOf,
} from "./scenario.js";

export type {
  Baseline,
  BaselineTolerance,
  EvalReport,
  Regression,
  RunOptions,
  ScenarioReport,
} from "./runner.js";
export { compareToBaseline, runEval, toBaseline } from "./runner.js";
