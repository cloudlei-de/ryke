// Turns node:test output (TAP or spec reporter) into the summary verify reports: pass/fail counts and
// one failure per failing leaf test (PLAN.md §5.3 step 2). Pure functions, no I/O, so the same code
// is unit tested against fixed samples.
//
// A parent test or suite whose subtests failed is reported by node as failed too. Counting it would
// list one problem twice, so only leaves are counted and a failing parent is listed only when none of
// its descendants failed (it failed on its own, e.g. a throw after its subtests passed).

const MAX_FAILURES = 50; // the runner only reads the last 1 MB of stdout for the result line
const MAX_MESSAGE_CHARS = 1000;
const FALLBACK_TAIL_LINES = 20;
const NAME_SEP = " > ";

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function tailLines(text, count) {
  return text.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// Names of the suites and tests enclosing the current line, keyed by indentation: both reporters
// print a header line when a suite/subtest opens, and indentation grows with nesting.
function nameStack() {
  const stack = [];
  return {
    open(indent, name) {
      while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
      stack.push({ indent, name, closed: false });
    },
    ancestors: (indent) => stack.filter((e) => e.indent < indent).map((e) => e.name),
    // The spec reporter prints a suite's name again when it closes. True when this line is that
    // closing line, so it is not mistaken for a leaf test of the same name.
    close(indent, name) {
      const open = stack.find((e) => e.indent === indent);
      if (open === undefined || open.name !== name || open.closed) return false;
      open.closed = true;
      return true;
    },
  };
}

// ---- TAP -------------------------------------------------------------------------------------

const TAP_SUBTEST = /^(\s*)# Subtest: (.*)$/;
const TAP_SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/;
const TAP_ENTRY = /^(\s*)(not ok|ok) \d+(?: - (.*?))?(?:\s+# (SKIP|TODO)\b.*)?$/i;

function unquote(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

// Only the handful of keys verify needs, from node's YAML diagnostics block. `pad` is the block's
// own indentation: keys sit exactly there, block-scalar lines deeper.
function yamlFields(lines, pad) {
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(pad)) continue;
    const key = /^(\w+):(?: (.*))?$/.exec(lines[i].slice(pad.length));
    if (key === null) continue;
    const value = key[2] ?? "";
    if (/^\|[-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].startsWith(`${pad}  `))) {
        block.push(lines[++i].slice(pad.length + 2));
      }
      fields[key[1]] = block.join("\n").trimEnd();
    } else {
      fields[key[1]] = unquote(value);
    }
  }
  return fields;
}

function parseTap(lines) {
  const entries = [];
  const summary = {};
  const names = nameStack();
  let yaml;
  for (const line of lines) {
    // Inside a diagnostics block nothing is an entry, even an error message that quotes TAP.
    if (yaml !== undefined) {
      if (line.trimEnd() === `${yaml.pad}...`) {
        const fields = yamlFields(yaml.lines, yaml.pad);
        yaml.entry.suite = fields.type === "suite";
        yaml.entry.message = fields.error ?? fields.message ?? fields.failureType ?? "";
        yaml = undefined;
      } else {
        yaml.lines.push(line);
      }
      continue;
    }
    let m = TAP_SUBTEST.exec(line);
    if (m !== null) {
      names.open(m[1].length, m[2]);
      continue;
    }
    m = TAP_SUMMARY.exec(line);
    if (m !== null) {
      summary[m[1]] = Number(m[2]);
      continue;
    }
    m = TAP_ENTRY.exec(line);
    if (m !== null) {
      const indent = m[1].length;
      entries.push({
        indent,
        ok: m[2].toLowerCase() === "ok",
        skipped: m[4] !== undefined,
        name: (m[3] ?? "").replace(/\\([\\#])/g, "$1"),
        path: names.ancestors(indent),
        suite: false,
        closesHeader: false,
        message: "",
      });
      continue;
    }
    m = /^(\s*)---\s*$/.exec(line);
    if (m !== null && entries.length > 0) yaml = { pad: m[1], lines: [], entry: entries.at(-1) };
  }
  return { entries, summary };
}

// ---- spec ------------------------------------------------------------------------------------

const SPEC_ENTRY = /^(\s*)([✔✖﹣]) (.*)$/u;
const SPEC_HEADER = /^(\s*)▶ (.*)$/u;
const SPEC_SUMMARY = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u;
const SPEC_FAILING = /^✖ failing tests:\s*$/u;

const stripDuration = (text) => text.replace(/\s+\(\d+(?:\.\d+)?ms\)$/, "");

// The spec reporter prints messages only in a "failing tests" section after the summary, as
// `✖ name (1.2ms)` followed by the indented error, whose stack frames end the message.
function blockMessage(lines) {
  const body = [];
  for (const line of lines) {
    if (/^\s+at \S/.test(line)) break;
    body.push(line.replace(/^ {2}/, ""));
  }
  return body.join("\n").trim();
}

function parseSpec(lines) {
  const entries = [];
  const summary = {};
  const details = [];
  const names = nameStack();
  let inDetails = false;
  for (const line of lines) {
    if (inDetails) {
      const head = /^✖ (.*)$/u.exec(line);
      if (head !== null) details.push({ name: stripDuration(head[1]), lines: [], used: false });
      else if (details.length > 0 && !/^test at /.test(line)) details.at(-1).lines.push(line);
      continue;
    }
    if (SPEC_FAILING.test(line)) {
      inDetails = true;
      continue;
    }
    let m = SPEC_HEADER.exec(line);
    if (m !== null) {
      names.open(m[1].length, m[2]);
      continue;
    }
    m = SPEC_SUMMARY.exec(line);
    if (m !== null) {
      summary[m[1]] = Number(m[2]);
      continue;
    }
    m = SPEC_ENTRY.exec(line);
    if (m !== null) {
      const indent = m[1].length;
      let rest = m[3];
      let skipped = m[2] === "﹣";
      const directive = /\s+# (?:SKIP|TODO)\b.*$/i.exec(rest);
      if (directive !== null) {
        skipped = true;
        rest = rest.slice(0, directive.index);
      }
      const name = stripDuration(rest);
      entries.push({
        indent,
        ok: m[2] !== "✖",
        skipped,
        name,
        path: names.ancestors(indent),
        suite: false,
        closesHeader: names.close(indent, name),
        message: "",
      });
    }
  }
  for (const entry of entries) {
    if (entry.ok || entry.skipped) continue;
    const full = [...entry.path, entry.name].join(NAME_SEP);
    const detail = details.find((d) => !d.used && (d.name === entry.name || d.name === full));
    if (detail === undefined) continue;
    detail.used = true;
    entry.message = blockMessage(detail.lines);
  }
  return { entries, summary };
}

// ---- shared ----------------------------------------------------------------------------------

function hasFailedDescendant(entries, index) {
  for (let i = index - 1; i >= 0 && entries[i].indent > entries[index].indent; i--) {
    if (!entries[i].ok && !entries[i].skipped) return true;
  }
  return false;
}

function tally({ entries, summary }) {
  let passed = 0;
  let passedParents = 0;
  let failedParents = 0;
  const failures = [];
  entries.forEach((entry, i) => {
    if (entry.skipped) return;
    // Children are printed before their parent, so a parent is an entry that follows deeper ones.
    const parent = entry.closesHeader || (i > 0 && entries[i - 1].indent > entry.indent);
    if (entry.ok) {
      if (!entry.suite) {
        if (parent) passedParents++;
        else passed++;
      }
    } else if (parent && hasFailedDescendant(entries, i)) {
      failedParents++;
    } else {
      failures.push({ name: [...entry.path, entry.name].join(NAME_SEP), message: entry.message });
    }
  });
  // The summary lines survive when the log tail cut off earlier entries; node counts parents in
  // them, which the entries above did not, hence the subtraction.
  return {
    passed: Math.max(passed, (summary.pass ?? 0) - passedParents),
    failed: Math.max(failures.length, (summary.fail ?? 0) - failedParents),
    failures,
  };
}

// Undefined when the text holds no recognisable node:test output.
export function parseTestOutput(raw) {
  const lines = stripAnsi(raw).split(/\r?\n/);
  const score = ({ entries, summary }) => entries.length + (summary.pass !== undefined || summary.fail !== undefined ? 1 : 0);
  const tap = parseTap(lines);
  const spec = parseSpec(lines);
  const best = score(tap) >= score(spec) ? tap : spec;
  return score(best) === 0 ? undefined : tally(best);
}

// What verify reports as `tests`. A run that went wrong always names at least one failure, so a
// failed verify never reaches the dashboard without a reason (unrecognised output, a crashed
// command, a timeout, or tests that passed before the command itself exited non-zero).
export function summarizeTests(output, { exitCode, timedOut = false, timeoutSeconds = 0 }) {
  const text = stripAnsi(output);
  const parsed = parseTestOutput(text) ?? { passed: 0, failed: 0, failures: [] };
  let { failed, failures } = parsed;
  if (failures.length === 0 && (failed > 0 || exitCode !== 0 || timedOut)) {
    const note = timedOut ? `timed out after ${timeoutSeconds}s\n` : "";
    // The end of the output is what explains the exit, so a long tail is cut from its start.
    const tail = tailLines(text, FALLBACK_TAIL_LINES).slice(-(MAX_MESSAGE_CHARS - note.length));
    failures = [{ name: "verify", message: `${note}${tail}`.trim() }];
    failed = Math.max(failed, 1);
  }
  return {
    passed: parsed.passed,
    failed,
    failures: failures.slice(0, MAX_FAILURES).map((f) => ({ name: f.name, message: clip(f.message, MAX_MESSAGE_CHARS) })),
  };
}
