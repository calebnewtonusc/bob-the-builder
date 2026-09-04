/**
 * Does the HUD's catalog actually produce good panels?
 *
 * The whole argument for this project is that generated interfaces have never
 * been testable, and until the HUD had a catalog it was not testable either: the
 * vocabulary lived in prose, so there was nothing to run a scenario against.
 *
 * The interesting number here is not whether the assertions pass. It is
 * stability. A scenario can fail with every assertion green, which is the point:
 * the model produced a correct panel five times and a *different* correct panel
 * each time, which is exactly what people complain about with generative UI and
 * what an assertion-only harness reports as five passes.
 *
 * When stability is low the cause is almost never the model. It is an ambiguous
 * `describe` field, and the report names the competing layouts, so read those
 * before touching anything else.
 *
 *   BOB_MODEL_CMD='claude -p' npx tsx src/audit/cli.ts eval eval/hud.eval.ts
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import { hudCatalog } from "../src/hud/catalog.js";
import {
  avoidsComponent,
  defineAdapter,
  defineScenarios,
  firstPaintUnder,
  noPlaceholders,
  renders,
  usesComponent,
} from "../src/eval/index.js";

/**
 * Any command that reads a prompt on stdin and writes the answer to stdout.
 *
 * The same contract the app layer uses, so this repo still ships no SDK and
 * holds no key. It streams by line because that is what the wire format is: a
 * line is either complete or invisible, so chunking on newlines is lossless.
 */
export const adapter = defineAdapter("cmd", async function* (system, user) {
  const command = process.env["BOB_MODEL_CMD"] ?? "claude -p";
  const [bin, ...args] = command.split(" ");

  // Isolate the model from whatever the person running this has configured.
  //
  // The first run of this suite scored 3/7 and the numbers were not about the
  // catalog at all. `claude -p` loads the user's own CLAUDE.md, so on this
  // machine every scenario came back with a prayer and a "What do you need?"
  // instead of Bob Lines, and the diagram scenario rendered nothing three times
  // out of three. The harness was measuring somebody's global instructions.
  //
  // `--setting-sources ""` was checked against the real binary: `--bare` also
  // skips CLAUDE.md but forces API-key auth, and `--system-prompt` does not
  // suppress it at all, which is worth knowing because it looks like it should.
  const isolated =
    basename(bin!) === "claude" && !args.includes("--setting-sources")
      ? [...args, "--setting-sources", ""]
      : args;

  const child = spawn(bin!, isolated, { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(`${system}\n\n${user}\n`);
  child.stdin.end();

  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += String(chunk);
    let cut = buffer.indexOf("\n");
    while (cut !== -1) {
      yield `${buffer.slice(0, cut)}\n`;
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  }
  if (buffer) yield buffer;
});

export const suite = defineScenarios({
  catalog: hudCatalog,
  runs: 3,
  // Lower than the app layer's bar, deliberately. A HUD panel has more freedom
  // in it than a form does: two different but reasonable layouts for "how is my
  // week" is a real disagreement about emphasis, not a defect. Below this it is
  // the catalog being unclear.
  minStability: 0.7,
  scenarios: [
    {
      name: "a trend over time becomes a Sparkline, not a table of numbers",
      prompt:
        "Show me how many messages I sent each day this week: 31, 28, 44, 39, 58, 52, 71.",
      expect: [
        renders(),
        usesComponent("Sparkline"),
        avoidsComponent("Table"),
        noPlaceholders(),
        firstPaintUnder(0.4),
      ],
    },
    {
      name: "comparing a handful of named things becomes Bars",
      prompt:
        "Compare how long since I last replied to each person: Sagar 2 hours, Langston 9 hours, Ava 1 day, Erik 8 days.",
      expect: [
        renders(),
        usesComponent("Bars"),
        // Prose about a comparison the chart already makes is the single most
        // common way a generated panel wastes the glance it gets.
        avoidsComponent("Text"),
        noPlaceholders(),
      ],
    },
    {
      name: "a proportion of a known total becomes a Ring",
      prompt: "I have attended 82% of my classes this semester. Show me.",
      expect: [renders(), usesComponent("Ring"), noPlaceholders()],
    },
    {
      name: "things with dates become Events rather than a List",
      prompt:
        "What is coming up: Origin Story on Sep 9, two assignments on Sep 10, a quiz on Sep 14.",
      expect: [
        renders(),
        usesComponent("Events"),
        avoidsComponent("List"),
        noPlaceholders(),
      ],
    },
    {
      name: "several small numbers go in a grid, not a column",
      prompt:
        "Show me four numbers at once: 12 unread, 3 due today, 4 overdue, a 7 day streak.",
      expect: [
        renders(),
        usesComponent("Metric", 4),
        usesComponent("Stack"),
        noPlaceholders(),
      ],
    },
    {
      name: "a structure becomes a Diagram, not a description of one",
      prompt:
        "Explain how a request reaches the screen: the model writes lines, they go through a socket, the display draws them.",
      expect: [renders(), usesComponent("Diagram"), noPlaceholders()],
    },
    {
      name: "a named document is shown rather than described",
      prompt: "Pull up my resume, it is at ~/Downloads/resume.pdf",
      expect: [renders(), usesComponent("File"), avoidsComponent("Text")],
    },
  ],
});
