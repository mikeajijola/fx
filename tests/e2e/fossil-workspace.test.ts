import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cleanupIsolatedTestHome, createIsolatedTestHome, runFx } from "../evals/eval-helpers";

const homes: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const home of homes.splice(0)) cleanupIsolatedTestHome(home);
});

function fixture() {
  const home = realpathSync(createIsolatedTestHome());
  homes.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  mkdirSync(join(home, ".fx"));
  const env = {
    FX_TRACE_LOG: join(home, "fossil.trace"), FX_TRACE_SCOPES: "workspace",
    HOME: home, FX_SOUND: "0", FX_AUTO_UPGRADE: "0", FX_DISABLE_KEYCHAIN: "1",
    FX_SKIP_ONBOARDING: "1", FX_CONTRACT_REVIEW: "1", FX_E2E_FOSSIL_FAULT: undefined,
    AI_GATEWAY_API_KEY: undefined, VERCEL_OIDC_TOKEN: undefined, GEMINI_API_KEY: undefined,
    FX_PROVIDER: undefined, FX_MODEL: undefined, FX_REVIEW_MODEL: undefined,
  };
  const run = async (args: string[], extra: Record<string, string | undefined> = {}, timeoutMs = 30000) => {
    const result = await runFx(args, { cwd, env: { ...env, ...extra }, timeoutMs });
    if (result.code !== 0 && existsSync(env.FX_TRACE_LOG)) result.stderr += "\n" + readFileSync(env.FX_TRACE_LOG, "utf8");
    return result;
  };
  const fossil = (...args: string[]) => {
    const result = spawnSync("fossil", [...args, "-R", join(cwd, "omos.fossil")], { env: { PATH: process.env.PATH, HOME: home, FOSSIL_HOME: home, XDG_CONFIG_HOME: home, USER: "fixture", LC_ALL: "C" }, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  return { home, cwd, env, run, fossil };
}

function model(f: ReturnType<typeof fixture>, actor: (body: any, count: number) => object, assess?: (packet: any) => string | Promise<string>) {
  let actors = 0, assessments = 0;
  const packets: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST") return Response.json({ data: [] });
      const body = await request.json() as any;
      let delta: any, reason = "stop";
      if (body.tools?.some((tool: any) => tool.function?.name === "omos_contract_assessment")) {
        assessments++;
        const packet = JSON.parse(body.messages.at(-1).content);
        packets.push(packet);
        const status = await assess?.(packet) ?? "met";
        const evidence = packet.evidence.filter((item: any) => item.kind === "candidate" || item.status === "success").map((item: any) => item.id);
        delta = { tool_calls: [{ index: 0, id: `assessment-${assessments}`, type: "function", function: {
          name: "omos_contract_assessment", arguments: JSON.stringify({ contractId: packet.contract.id, version: packet.contract.version, obligations: [{ id: "request_complete", status, evidence: status === "met" ? evidence : [], note: status === "blocked" ? "Waiting for requested input" : "Checked host evidence" }] }),
        } }] };
        reason = "tool_calls";
      } else {
        delta = actor(body, ++actors);
        if ((delta as any).tool_calls) reason = "tool_calls";
      }
      const chunks = [
        { id: "fossil-fixture", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "fossil-fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: reason }] },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  writeFileSync(join(f.home, ".fx", "settings.json"), JSON.stringify({
    provider: "local", models: { local: "fixture-model" }, permission_mode: "full-access", auto_upgrade: false, session_titles: false,
    providers: { local: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${server.port}/v1`, auth: { type: "none" }, model_metadata: { "fixture-model": { supports_tool_use: true, context_window: 262144, max_output_tokens: 8192 } } } },
  }));
  return { packets, counts: () => ({ actors, assessments }) };
}

function writeMemory(content: string) {
  return { tool_calls: [{ index: 0, id: "save-memory", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "write", path: "memory/preference.md", content }) } }] };
}

describe("portable Fossil agent workspace", () => {
  test("initializes, binds across directories, verifies and exports without overwriting", async () => {
    const f = fixture();
    const initialized = await f.run(["fossil", "init", "--json"]);
    expect(initialized.code, initialized.stderr).toBe(0);
    expect(initialized.stderr).toBe("");
    const first = JSON.parse(initialized.stdout);
    expect(first.repository).toBe(join(f.cwd, "omos.fossil"));
    const other = await runFx(["fossil", "status", "--json"], { cwd: f.home, env: f.env });
    expect(JSON.parse(other.stdout).workspace_id).toBe(first.workspace_id);
    expect((await f.run(["fossil", "verify"])).code).toBe(0);
    const destination = join(f.home, "portable.fossil");
    expect((await f.run(["fossil", "export", destination, "--json"])).code).toBe(0);
    expect((await f.run(["fossil", "export", destination, "--json"])).code).toBe(1);
    expect((await f.run(["fossil", "use", destination, "--json"])).code).toBe(0);
    expect((await f.run(["fossil", "init", destination, "--json"])).code).toBe(1);
    expect(f.fossil("settings", "autosync", "--value").trim()).toBe("off");
  }, 30000);

  test("keeps task content on a branch until reviewed and automatically publishes it", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => count === 1 ? writeMemory("Prefer concise answers.") : { content: "Saved and verified the preference." });
    const result = await f.run(["ask", "Remember that I prefer concise answers", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("fx:");
    const status = JSON.parse((await f.run(["fossil", "status", "--json"])).stdout);
    expect(status.tasks).toHaveLength(1);
    expect(status.tasks[0].state).toBe("accepted");
    expect(status.tasks[0].branch).toStartWith("task/");
    expect(m.counts()).toEqual({ actors: 2, assessments: 1 });
    expect(m.packets[0].contract.id).toBe(status.tasks[0].id);
    expect(m.packets[0].evidence.some((entry: any) => entry.tool === "fossil_workspace" && entry.status === "success")).toBe(true);
    expect(f.fossil("cat", "memory/preference.md", "-r", "trunk")).toBe("Prefer concise answers.");
    expect(f.fossil("ls", "-r", "trunk")).toContain("acceptances/");
    expect(status.pending_journals).toBe(0);
    const raw = fixture();
    const rawCopy = join(raw.home, "direct-copy.fossil");
    copyFileSync(join(f.cwd, "omos.fossil"), rawCopy);
    expect((await raw.run(["fossil", "use", rawCopy])).code).toBe(0);
    const reconstructed = JSON.parse((await raw.run(["fossil", "tasks", "--json"])).stdout);
    expect(reconstructed.tasks[0].id).toBe(status.tasks[0].id);
    expect(reconstructed.tasks[0].state).toBe("accepted");
    expect(existsSync(join(raw.home, ".fx", "settings.json"))).toBe(false);
    const portable = join(f.home, "task-export.fossil");
    expect((await f.run(["fossil", "export", portable])).code).toBe(0);
    const cold = fixture();
    expect((await cold.run(["fossil", "use", portable])).code).toBe(0);
    const reopened = JSON.parse((await cold.run(["fossil", "tasks", "--json"])).stdout);
    expect(reopened.tasks[0].id).toBe(status.tasks[0].id);
    expect(reopened.tasks[0].state).toBe("accepted");
  }, 60000);

  test("checkpoints same-length edits even when filesystem mtimes do not change", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const executable = Bun.which("fossil")!;
    const bin = join(f.home, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    // Force equal mtimes independently of host speed or timestamp precision.
    writeFileSync(join(bin, "fossil"), `#!/usr/bin/env bun
import { existsSync, utimesSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
if ((args.includes("changes") || args.includes("commit")) && existsSync("memory/preference.md")) {
  utimesSync("memory/preference.md", 946684800, 946684800);
}
const result = Bun.spawnSync([${JSON.stringify(executable)}, ...args], { env: process.env, stdin: "inherit" });
writeSync(1, result.stdout);
writeSync(2, result.stderr);
process.exit(result.exitCode);
`, { mode: 0o700 });
    model(f, (_body, count) => count <= 2 ? writeMemory(count === 1 ? "first" : "other") : { content: "The final preference is other." });
    const result = await f.run(["ask", "Save first, then replace it with other", "--json"], { PATH: `${bin}:${process.env.PATH}` }, 60000);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(f.fossil("cat", "memory/preference.md", "-r", "trunk")).toBe("other");
  }, 60000);

  test("a commit before acknowledgement recovers without repeating model actions", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => count === 1 ? writeMemory("One effect only.") : { content: "Preference recorded." });
    const failed = await f.run(["ask", "Remember this preference", "--json"], { FX_E2E_FOSSIL_FAULT: "publication-committed" });
    expect(failed.code).toBe(1);
    const before = m.counts();
    const session = JSON.parse(failed.stdout).session_id;
    expect(session).toBeTruthy();
    const resumed = await f.run(["ask", "--resume-id", session, "continue", "--json"]);
    expect(resumed.code).toBe(0);
    expect(m.counts()).toEqual(before);
    const status = JSON.parse((await f.run(["fossil", "status", "--json"])).stdout);
    expect(status.tasks[0].state).toBe("accepted");
    expect(f.fossil("cat", "memory/preference.md", "-r", "trunk")).toBe("One effect only.");
  }, 60000);

  test("user steering invalidates an uncommitted publication assessment", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, () => ({ content: "Answered with the current detail." }));
    const first = await f.run(["ask", "Answer with the supplied detail", "--json"], { FX_E2E_FOSSIL_FAULT: "publication-prepared" });
    expect(first.code).toBe(1);
    const session = JSON.parse(first.stdout).session_id;
    const previous = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    const second = await f.run(["ask", "--resume-id", session, "Use the corrected detail: blue", "--json"]);
    expect(second.code, second.stderr).toBe(0);
    const current = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(current.id).toBe(previous.id);
    expect(current.definition.version).toBe(2);
    expect(m.packets).toHaveLength(2);
    expect(m.packets[1].userSteering).toContain("Use the corrected detail: blue");
  }, 60000);

  test("verified children publish to their parent before the root publishes to trunk", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let roots = 0, children = 0;
    const m = model(f, body => {
      const root = body.tools?.some((tool: any) => tool.function?.name === "subagent");
      if (root) {
        if (++roots === 1) return { tool_calls: [{ index: 0, id: "delegate", type: "function", function: { name: "subagent", arguments: JSON.stringify({ request: { action: "run", task: "task-FOSSIL-CHILD: save the child preference" } }) } }] };
        return { content: "The child preference is saved and verified." };
      }
      return ++children === 1 ? writeMemory("Verified child preference.") : { content: "Child preference saved." };
    });
    const result = await f.run(["ask", "Delegate saving a child preference", "--json"], {}, 90000);
    expect(result.code, result.stderr).toBe(0);
    const status = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout);
    expect(status.tasks).toHaveLength(2);
    const root = status.tasks.find((task: any) => task.parent === "trunk");
    const child = status.tasks.find((task: any) => task.parent !== "trunk");
    expect(child.parent).toBe(root.branch);
    expect(child.parent_contract_version).toBe(root.definition.version);
    expect(status.tasks.every((task: any) => task.state === "accepted")).toBe(true);
    expect(m.packets.length).toBeGreaterThanOrEqual(2);
    expect(f.fossil("cat", "memory/preference.md", "-r", "trunk")).toBe("Verified child preference.");
  }, 90000);

  test("blocked work resumes the same task with a versioned user amendment", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let blocked = true;
    const m = model(f, () => ({ content: blocked ? "Need the requested detail." : "Answered with the supplied detail." }), () => blocked ? "blocked" : "met");
    const first = await f.run(["ask", "Answer after I supply a detail", "--json"]);
    expect(first.code).toBe(1);
    const session = JSON.parse(first.stdout).session_id;
    const before = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    blocked = false;
    expect((await f.run(["ask", "--resume-id", session, "The detail is blue", "--json"])).code).toBe(0);
    const after = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(after.id).toBe(before.id);
    expect(after.branch).toBe(before.branch);
    expect(after.definition.version).toBe(2);
    expect(m.packets.at(-1).contract.objective).toBe("Answer after I supply a detail");
    expect(m.packets.at(-1).userSteering).toContain("The detail is blue");
  }, 60000);

  test("artifact identities and workspace paths are enforced", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let turn = 0;
    model(f, () => {
      if (++turn === 1) return { tool_calls: [{ index: 0, id: "escape", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "write", path: "../escaped", content: "forbidden" }) } }] };
      if (turn === 2) return { tool_calls: [{ index: 0, id: "artifact", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "artifact", content: "retained report" }) } }] };
      return { content: "The report is attached." };
    });
    const result = await f.run(["ask", "Attach the report inside the workspace", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const path = f.fossil("ls", "-r", "trunk").split("\n").find(path => path.startsWith("artifacts/"))!;
    expect(path).toMatch(/^artifacts\/[a-f0-9]{64}$/);
    expect(f.fossil("cat", path, "-r", "trunk")).toBe("retained report");
    expect(existsSync(join(f.cwd, "escaped"))).toBe(false);
    expect((await f.run(["fossil", "verify"])).code).toBe(0);
  }, 60000);

  for (const fault of ["action-recorded", "evidence-checkpoint-committed"]) {
    test(`recovers ${fault} without losing evidence or replaying completed work`, async () => {
      const f = fixture();
      expect((await f.run(["fossil", "init"])).code).toBe(0);
      let effects = 0;
      model(f, body => {
        const completed = body.messages?.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("Workspace content checkpointed"));
        if (completed) return { content: "The preference was recorded." };
        effects++;
        return writeMemory("Recovered preference.");
      });
      const failed = await f.run(["ask", "Remember the preference", "--json"], { FX_E2E_FOSSIL_FAULT: fault });
      expect(failed.code, failed.stderr + failed.stdout).toBe(1);
      expect(JSON.parse(failed.stdout).error).toBe("WorkspaceInjectedFailure");
      const before = effects;
      const session = JSON.parse(failed.stdout).session_id;
      const snapshot = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout);
      const cache = createHash("sha256").update(snapshot.repository).digest("hex");
      const pending = join(f.home, ".fx", "fossil", cache, "pending", snapshot.tasks[0].id);
      mkdirSync(pending, { recursive: true });
      writeFileSync(join(pending, `${"a".repeat(64)}.pending-${"b".repeat(32)}`), "partial interrupted record");
      const recovered = await f.run(["ask", "--resume-id", session, "continue", "--json"]);
      expect(recovered.code, recovered.stderr + recovered.stdout).toBe(0);
      if (fault === "evidence-checkpoint-committed") expect(effects).toBe(before);
      expect(f.fossil("cat", "memory/preference.md", "-r", "trunk")).toBe("Recovered preference.");
      expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).pending_journals).toBe(0);
    }, 60000);
  }

  test("retains full requests and steering beyond the contract objective preview", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let blocked = true;
    const m = model(f, () => ({ content: "The answer is green." }), () => blocked ? "blocked" : "met");
    const goal = "Answer these requirements: " + "detail ".repeat(1600) + "finish with blue";
    const first = await f.run(["ask", goal, "--json"], {}, 120000);
    expect(first.code).toBe(1);
    const session = JSON.parse(first.stdout).session_id;
    blocked = false;
    const correction = "Correction: " + "note ".repeat(2000) + "use green";
    const second = await f.run(["ask", "--resume-id", session, correction, "--json"], {}, 120000);
    expect(second.code, second.stderr).toBe(0);
    expect(m.packets[0].originalRequest).toBe(goal);
    expect(m.packets[1].originalRequest).toBe(goal);
    expect(m.packets[1].userSteering).toContain(correction);
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(task.definition.objective.length).toBeLessThanOrEqual(8192);
    expect(task.request_artifact).toStartWith("artifacts/");
    expect(task.definition.version).toBe(2);
  }, 120000);

  test("no-save leaves the bound workspace unchanged", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let observedRead = false;
    model(f, (body, count) => {
      if (count === 1) return { tool_calls: [{ index: 0, id: "read-only-status", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "status" }) } }] };
      observedRead = body.messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("omos.fossil"));
      return { content: "The answer is blue." };
    });
    const before = f.fossil("info", "trunk");
    const result = await f.run(["ask", "What color is blue?", "--no-save", "--json"]);
    expect(result.code).toBe(0);
    expect(observedRead).toBe(true);
    expect(f.fossil("info", "trunk")).toBe(before);
    const status = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout);
    expect(status.tasks).toHaveLength(0);
  }, 30000);

  for (const conflicting of [false, true]) {
    test(conflicting ? "retains conflicting branches without forcing a merge" : "serializes independent task publications from the same base", async () => {
      const f = fixture();
      expect((await f.run(["fossil", "init"])).code).toBe(0);
      let arrived = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const turns = { a: 0, b: 0 };
      model(f, body => {
        const key = JSON.stringify(body.messages).includes("task-A") ? "a" : "b";
        if (++turns[key] > 1) return { content: `Saved ${key}.` };
        const call = writeMemory(key);
        call.tool_calls[0].function.arguments = JSON.stringify({ action: "write", path: conflicting ? "memory/shared.md" : `memory/${key}.md`, content: key });
        return call;
      }, async () => { if (++arrived === 2) release(); await gate; return "met"; });
      const observer = (async () => {
        for (let index = 0; index < 12; index++) {
          const snapshot = await f.run(["fossil", "status", "--json"]);
          expect(snapshot.code, snapshot.stderr).toBe(0);
        }
      })();
      const [first, second] = await Promise.all([f.run(["ask", "task-A: save preference A", "--json"]), f.run(["ask", "task-B: save preference B", "--json"]), observer]);
      const results = [first, second];
      const status = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout);
      expect(status.tasks).toHaveLength(2);
      if (conflicting) {
        expect(results.map(result => result.code).sort()).toEqual([0, 1]);
        expect(status.tasks.map((task: any) => task.state).sort()).toEqual(["accepted", "conflict"]);
      } else {
        expect(results.map(result => result.code)).toEqual([0, 0]);
        expect(status.tasks.every((task: any) => task.state === "accepted")).toBe(true);
        expect(f.fossil("cat", "memory/a.md", "-r", "trunk")).toBe("a");
        expect(f.fossil("cat", "memory/b.md", "-r", "trunk")).toBe("b");
      }
    }, 60000);
  }

  test("changed read dependencies refresh the branch and require a new assessment", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    model(f, (_body, count) => count === 1 ? writeMemory("old preference") : { content: "Initial preference saved." });
    expect((await f.run(["ask", "Save the initial preference", "--json"])).code).toBe(0);
    let release!: () => void;
    const published = new Promise<void>(resolve => { release = resolve; });
    let readerTurns = 0, writerTurns = 0;
    const readerPackets: any[] = [];
    model(f, body => {
      const reader = JSON.stringify(body.messages).includes("READER-TASK");
      if (reader) {
        if (++readerTurns === 1) return { tool_calls: [{ index: 0, id: "read-preference", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "read", path: "memory/preference.md" }) } }] };
        return { content: readerTurns > 2 ? "The current preference is new." : "The current preference is old." };
      }
      return ++writerTurns === 1 ? writeMemory("new preference") : { content: "The new preference is saved." };
    }, async packet => {
      if (packet.contract.objective.includes("READER-TASK")) {
        readerPackets.push(packet);
        if (readerPackets.length === 1) await published;
      }
      return "met";
    });
    const reader = f.run(["ask", "READER-TASK: read and report the current preference", "--json"]);
    const writer = await f.run(["ask", "WRITER-TASK: update the preference", "--json"]);
    expect(writer.code, writer.stderr).toBe(0);
    release();
    const result = await reader;
    expect(result.code, result.stderr).toBe(0);
    expect(readerPackets).toHaveLength(2);
    const snapshot = readerPackets[1].evidence.find((item: any) => item.kind === "workspace");
    expect(JSON.parse(snapshot.content).reads.some((read: any) => read.reviewed_content === "new preference")).toBe(true);
  }, 60000);

  test("archives current session event logs without changing source or importing recovery authority", async () => {
    const f = fixture();
    const directory = join(f.home, ".fx", "sessions", "current-session");
    mkdirSync(directory, { recursive: true });
    const metadata = JSON.stringify({ schema_version: 4, id: "current-session", created_at_ms: 1, updated_at_ms: 1, origin_workspace_root: "/Users/example/project", workspace_root: "/Users/example/project", conversation_language: "en", provider: "gateway", model: "test/model", effort: "auto", fast_mode: false, title: null, subagent_child: false });
    const events = [
      { user: { text: "Remember the archived request" } },
      { assistant: { text: "The archived answer" } },
      { turn_completed: {} },
    ].map((event, index) => JSON.stringify({ schema_version: 1, seq: index + 1, timestamp_ms: 1, event })).join("\n") + "\n";
    writeFileSync(join(directory, "session.json"), metadata);
    writeFileSync(join(directory, "events.jsonl"), events);
    writeFileSync(join(directory, "recovery.json"), JSON.stringify({ credential: "must-not-export" }));
    const alias = join(f.home, "profile-link");
    symlinkSync(f.home, alias, "dir");
    const result = await f.run(["fossil", "init", "--json"], { HOME: alias });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).detail).toContain("archived 1 existing sessions and skipped 0");
    const imported = f.fossil("ls", "-r", "trunk").trim().split("\n").find(path => path.startsWith("imports/"))!;
    const archive = f.fossil("cat", imported, "-r", "trunk");
    expect(archive).toContain("Remember the archived request");
    expect(archive).toContain("The archived answer");
    expect(archive).not.toContain("must-not-export");
    expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks).toHaveLength(0);
    expect(readFileSync(join(directory, "session.json"), "utf8")).toBe(metadata);
    expect(readFileSync(join(directory, "events.jsonl"), "utf8")).toBe(events);
  }, 30000);

  test("history import is archive-only and excludes runtime checkpoints and credentials", async () => {
    const f = fixture();
    const session = join(f.home, ".fx", "sessions", "legacy-session");
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "session.json"), JSON.stringify({ history: [{ assistant: { text: "Done", provider_replay: { token: "must-not-export" } } }], recovery_checkpoint: { secret: "must-not-export" }, credential: "must-not-export" }));
    const alias = join(f.home, "profile-link");
    symlinkSync(f.home, alias, "dir");
    expect((await f.run(["fossil", "init"], { HOME: alias })).code).toBe(0);
    const files = f.fossil("ls", "-r", "trunk").trim().split("\n");
    const imported = files.find(path => path.startsWith("imports/"))!;
    expect(imported).toBeTruthy();
    expect(f.fossil("cat", imported, "-r", "trunk")).not.toContain("must-not-export");
    expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks).toHaveLength(0);
    expect(existsSync(join(session, "session.json"))).toBe(true);
    expect(readFileSync(join(session, "session.json"), "utf8")).toContain("must-not-export");
  }, 30000);
});
