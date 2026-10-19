import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  const run = async (args: string[], extra: Record<string, string | undefined> = {}, timeoutMs = 60000) => {
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

function model(f: ReturnType<typeof fixture>, actor: (body: any, count: number) => object, assess?: (packet: any) => string | { name: string; args: object } | Promise<string | { name: string; args: object }>, governance: { plan?: object; progress?: (packet: any) => object } = {}) {
  let actors = 0, assessments = 0;
  const packets: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST") return Response.json({ data: [] });
      const body = await request.json() as any;
      let delta: any, reason = "stop";
      if (body.tools?.some((tool: any) => tool.function?.name === "omos_task_plan" || tool.function?.name === "omos_progress_assessment")) {
        const planning = body.tools.some((tool: any) => tool.function?.name === "omos_task_plan");
        const packet = JSON.parse(body.messages.find((message: any) => message.role === "user").content);
        const decision = planning ? governance.plan ?? { capability: "general_task", summary: "Answer the original request", obligations: [], checks: [] }
          : governance.progress?.(packet) ?? { outcome: "continue_work", meaningful: false, evidence: [], remaining: packet.context.contract.obligations.map((o: any) => o.id), note: "No further useful progress observed" };
        delta = { tool_calls: [{ index: 0, id: `governance-${actors}`, type: "function", function: { name: planning ? "omos_task_plan" : "omos_progress_assessment", arguments: JSON.stringify(decision) } }] };
        reason = "tool_calls";
      } else if (body.tools?.some((tool: any) => tool.function?.name === "omos_contract_assessment")) {
        assessments++;
        const packet = JSON.parse(body.messages.find((message: any) => message.role === "user").content);
        packet.currentInspections = body.messages.filter((message: any) => message.role === "tool").map((message: any) => JSON.parse(message.content));
        packet.inspections = [...(packet.previousInspections ?? []), ...packet.currentInspections];
        packets.push(packet);
        const status = await assess?.(packet) ?? "met";
        const evidence = packet.evidence.filter((item: any) => item.complete && (item.kind === "candidate" || item.status === "success")).map((item: any) => item.id);
        delta = { tool_calls: [{ index: 0, id: `assessment-${assessments}`, type: "function", function: {
          name: typeof status === "string" ? "omos_contract_assessment" : status.name, arguments: JSON.stringify(typeof status === "string" ? { contractId: packet.contract.id, version: packet.contract.version, obligations: packet.contract.obligations.map((o: any) => ({ id: o.id, status, evidence: status === "met" ? evidence : [], note: status === "blocked" ? "Waiting for requested input" : "Checked host evidence" })) } : status.args),
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
  test("shares pinned OmniForm validation with the vendored validator and rejects unsupported profile policy", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const standard = join(import.meta.dir, "../../src/core/workspace/standard");
    const seed = JSON.parse(readFileSync(join(standard, "omos.json"), "utf8"));
    const validatorSource = readFileSync(join(standard, "validate.js"), "utf8")
      .replace(/import schema from .*?;/, `const schema = ${readFileSync(join(standard, "omniform.schema.json"), "utf8")};`)
      .replace('"ajv/dist/2020.js"', JSON.stringify(pathToFileURL(Bun.resolveSync("ajv/dist/2020.js", import.meta.dir)).href));
    const validatorPath = join(f.home, "omniform-validator.mjs");
    writeFileSync(validatorPath, validatorSource);
    const upstream = await import(pathToFileURL(validatorPath).href);
    const semanticSource = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(join(standard, "semantic.ts"), "utf8"))
      .replace('"zod"', JSON.stringify(pathToFileURL(Bun.resolveSync("zod", import.meta.dir)).href));
    const semanticPath = join(f.home, "omniform-semantic.mjs");
    writeFileSync(semanticPath, semanticSource);
    const sharedSemantic = await import(pathToFileURL(semanticPath).href);
    const variants: Array<{ change: (v: any) => void; valid: boolean; upstreamValid?: boolean }> = [
      { change() {}, valid: true },
      { change(v) { v.apiVersion = "wrong/v1"; }, valid: false },
      { change(v) { v.spec.unknown = true; }, valid: false },
      { change(v) { v.metadata.id = "9_invalid"; }, valid: false },
      { change(v) { v.spec.capabilities.push(v.spec.capabilities[0]); }, valid: false },
      { change(v) { v.spec.realisations[0].participants[0].resource = "missing"; }, valid: false },
      { change(v) { v.spec.operations[0].input.format = "executable"; }, valid: false, upstreamValid: true },
      { change(v) { v.spec.operations[0].approval = "required"; }, valid: false, upstreamValid: true },
      { change(v) { delete v.spec.semantic.version; }, valid: false },
      { change(v) { v.spec.semantic.search = { version: 1, ranking: { relevance: 1, precedent: 1, evidence: 1, recency: 1 } }; }, valid: false },
      { change(v) { v.spec.semantic.relationships = [{ id: "self", from: "omos_task", to: "omos_task", kind: "containment" }]; }, valid: false },
      { change(v) { v.spec.semantic.migration = { version: "omniseedos.data-migration/v1", defaults: { omos_task: { objective: "default" } } }; }, valid: false, upstreamValid: true },
    ];
    for (const [index, variant] of variants.entries()) {
      const value = structuredClone(seed);
      variant.change(value);
      const base = structuredClone(value);
      delete base.spec.semantic;
      const structural = upstream.validateStructure(base);
      const semantic = structural.valid ? upstream.validateSemantics(base) : { valid: false };
      const semanticValid = sharedSemantic.validateSemantics(value.spec.semantic, value.spec.capabilities.map((c: any) => c.id)).length === 0;
      expect(structural.valid && semantic.valid && semanticValid, `upstream fixture ${index}`).toBe(variant.upstreamValid ?? variant.valid);
      const path = join(f.home, `declaration-${index}.json`);
      writeFileSync(path, JSON.stringify(value));
      const result = await f.run(["fossil", "definition", "validate", path, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).model_data.valid, `native fixture ${index}`).toBe(variant.valid);
    }
  }, 90000);

  test("activates additive proposals for future tasks and retains incompatible proposals inactive", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    model(f, () => ({ content: "Retained task" }), () => "blocked");
    expect((await f.run(["ask", "Keep this task open", "--json"])).code).toBe(1);
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    const before = JSON.parse((await f.run(["fossil", "definition", "show", "--json"])).stdout).model_data;
    const value = structuredClone(before.declaration);
    value.spec.semantic.entityTypes.push({ id: "company_note", fields: { text: "string" }, required: ["text"] });
    const path = join(f.home, "proposal.json");
    writeFileSync(path, JSON.stringify(value));
    const added = await f.run(["fossil", "definition", "propose", path, "--json"]);
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout).model_data.state).toBe("activated");
    const pinned = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(pinned.model_basis).toEqual(task.model_basis);
    const after = JSON.parse((await f.run(["fossil", "definition", "show", "--json"])).stdout).model_data;
    expect(after.basis.definition_hash).not.toBe(before.basis.definition_hash);
    value.spec.semantic.entityTypes[0].fields.objective = "boolean";
    writeFileSync(path, JSON.stringify(value));
    const incompatible = await f.run(["fossil", "definition", "propose", path, "--json"]);
    expect(incompatible.code, incompatible.stderr).toBe(0);
    expect(JSON.parse(incompatible.stdout).model_data.state).toBe("inactive");
    expect(JSON.parse((await f.run(["fossil", "definition", "show", "--json"])).stdout).model_data.basis.definition_hash).toBe(after.basis.definition_hash);
    expect(f.fossil("ls", "-r", "trunk").split("\n").filter(path => path.startsWith("proposals/"))).toHaveLength(2);
    expect((await f.run(["fossil", "migrate"])).code).toBe(0);
  }, 120000);

  test("stops a repeated successful search after three stalled progress checks", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (body, count) => !body.tools?.length ? { content: "The search is unfinished. The repeated results are retained." } : {
      tool_calls: [{ index: 0, id: `search-${count}`, type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "read", path: "workspace.json" }) } }],
    });
    const result = await f.run(["ask", "Inspect the workspace repeatedly until useful information is found", "--json"], {}, 180000);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("Task paused");
    expect(m.counts().actors).toBe(13);
    expect(m.counts().assessments).toBe(0);
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(task.state).toBe("paused");
    expect(f.fossil("ls", "-r", "trunk")).not.toContain(`tasks/${task.id}`);
  }, 180000);

  test("reserves the last actor slot for a summary and resets the invocation budget on continue", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const seed = JSON.parse(readFileSync(join(import.meta.dir, "../../src/core/workspace/standard/omos.json"), "utf8"));
    const declaration = join(f.home, "same-definition.json");
    const execution = join(f.home, "execution.json");
    writeFileSync(declaration, JSON.stringify(seed));
    writeFileSync(execution, JSON.stringify({ defaults: { max_actor_steps: 3 } }));
    expect((await f.run(["fossil", "definition", "propose", declaration, "--execution", execution, "--json"])).code).toBe(0);
    const m = model(f, (body, count) => !body.tools?.length ? { content: "Two workspace inspections completed; further work remains." } : {
      tool_calls: [{ index: 0, id: `inspect-${count}`, type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "read", path: "workspace.json" }) } }],
    });
    const first = await f.run(["ask", "Inspect this workspace until a useful result is found", "--json"], {}, 120000);
    expect(first.code, first.stderr).toBe(1);
    expect(first.stderr).toContain("actor-step budget");
    expect(m.counts().actors).toBe(3);
    const session = JSON.parse(first.stdout).session_id;
    const second = await f.run(["ask", "--resume-id", session, "continue", "--json"], {}, 120000);
    expect(second.code, second.stderr).toBe(1);
    expect(m.counts().actors).toBe(6);
    expect(m.counts().assessments).toBe(0);
  }, 180000);

  test("a progress finalize decision still passes the independent completion gate", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (body, count) => !body.tools?.length ? { content: "This is an omos agent workspace." } : {
      tool_calls: [{ index: 0, id: `inspect-${count}`, type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "read", path: "workspace.json" }) } }],
    }, undefined, { progress: () => ({ outcome: "finalize", meaningful: false, evidence: [], remaining: ["request_complete"], note: "The actor has enough information to answer" }) });
    const result = await f.run(["ask", "Identify the workspace kind", "--json"], {}, 120000);
    expect(result.code, result.stderr).toBe(0);
    expect(m.counts()).toEqual({ actors: 5, assessments: 1 });
    expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0].state).toBe("accepted");
  }, 120000);

  test("pins a coding plan and validates the final source before publication", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, ".gitignore"), "omos.fossil\n");
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const commands = ["printf 'verified\\n' > answer.txt", "test \"$(cat answer.txt)\" = verified"];
    const m = model(f, (_body, count) => count <= 2 ? {
      tool_calls: [{ index: 0, id: `coding-${count}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ request: { action: "run", command: commands[count - 1], timeout_ms: 10000 } }) } }],
    } : { content: "Created answer.txt with verified and ran the content check successfully." }, undefined, { plan: { capability: "coding_task", summary: "Create and check answer.txt", obligations: [], checks: [commands[1]] } });
    const result = await f.run(["ask", "Implement answer.txt containing verified and test its contents", "--json"], {}, 120000);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(join(f.cwd, "answer.txt"), "utf8")).toBe("verified\n");
    expect(m.counts()).toEqual({ actors: 3, assessments: 1 });
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(task.model_basis.capability).toBe("coding_task");
    expect(task.definition.obligations.map((o: any) => o.id)).toEqual(["request_complete", "coding_validation", "coding_summary"]);
    expect(task.state).toBe("accepted");
  }, 120000);

  test("migrates a legacy workspace with a backup while retaining its task contract", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const tree = join(f.home, "legacy-checkout");
    mkdirSync(tree);
    const fossil = (...args: string[]) => {
      const result = spawnSync("fossil", args, { cwd: tree, env: { PATH: process.env.PATH, HOME: f.home, FOSSIL_HOME: f.home, USER: "omos", LC_ALL: "C" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    fossil("open", "--nosync", join(f.cwd, "omos.fossil"), "trunk");
    const manifest = JSON.parse(readFileSync(join(tree, "workspace.json"), "utf8"));
    manifest.format = 1;
    writeFileSync(join(tree, "workspace.json"), JSON.stringify(manifest));
    fossil("rm", "omniform/company.json", "execution/omos.json");
    fossil("commit", "--hash", "--nosync", "--nosign", "--no-verify", "--no-warnings", "-m", "Construct legacy fixture");
    model(f, () => ({ content: "Retain the original task" }), () => "blocked");
    expect((await f.run(["ask", "Retain the original task", "--json"])).code).toBe(1);
    const old = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(old.model_basis).toBeNull();
    const migrated = await f.run(["fossil", "migrate", "--json"], {}, 120000);
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(readdirSync(f.cwd).filter(path => path.includes(".pre-omniform-") && path.endsWith(".fossil"))).toHaveLength(1);
    const saved = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(saved.definition).toEqual(old.definition);
    expect(saved.model_basis).toBeNull();
    expect((await f.run(["fossil", "migrate"])).code).toBe(0);
    expect(readdirSync(f.cwd).filter(path => path.includes(".pre-omniform-") && path.endsWith(".fossil"))).toHaveLength(1);
    expect((await f.run(["ask", "Start another task", "--json"])).code).toBe(1);
    const tasks = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks;
    expect(tasks.find((t: any) => t.id !== old.id).model_basis.definition_hash).toHaveLength(64);
  }, 150000);

  test("rejects coding validation after source changes during review and requires a current check", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, ".gitignore"), "omos.fossil\n");
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let changed = false;
    const m = model(f, (_body, count) => count === 1 || count === 2 || count === 4 ? {
      tool_calls: [{ index: 0, id: `code-${count}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ request: { action: "run", command: count === 1 ? "touch answer.txt" : "test -f answer.txt", timeout_ms: 10000 } }) } }],
    } : { content: "Created answer.txt and checked that it exists." }, () => {
      if (!changed) { writeFileSync(join(f.cwd, "answer.txt"), "A concurrent source edit"); changed = true; }
      return "met";
    }, { plan: { capability: "coding_task", summary: "Create and test a file", obligations: [], checks: ["test -f answer.txt"] } });
    const result = await f.run(["ask", "Implement answer.txt and test that it exists", "--json"], {}, 150000);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(m.counts()).toEqual({ actors: 5, assessments: 2 });
  }, 150000);

  test("does not execute a repeated invalid tool proposal", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => ({ tool_calls: [{ index: 0, id: `invalid-${count}`, type: "function", function: { name: "mcp_nonexistent_tool", arguments: "{}" } }] }));
    const result = await f.run(["ask", "Use the configured tools", "--json"]);
    expect(result.code).toBe(1);
    expect(m.counts().actors).toBe(2);
    expect(m.counts().assessments).toBe(0);
  }, 60000);

  test("verifies file manifests and rejects a byte mismatch", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const manifest = JSON.stringify({ files: [{ path: "memory/preference.md", bytes: 5, sha256: createHash("sha256").update("hello").digest("hex") }] });
    const m = model(f, (_body, count) => count === 1 ? writeMemory("hello") : count === 2 ? {
      tool_calls: [{ index: 0, id: "save-manifest", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "write", path: "memory/manifest.json", content: manifest }) } }],
    } : count === 3 ? { tool_calls: [{ index: 0, id: "verify-files", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "verify_manifest", path: "memory/manifest.json" }) } }] }
      : { content: "The file matches the manifest." });
    const result = await f.run(["ask", "Save hello and verify it against the file manifest", "--json"], {}, 120000);
    expect(result.code, result.stderr).toBe(0);
    expect(m.packets.at(-1).evidence.find((e: any) => e.tool === "fossil_workspace" && e.arguments?.includes("verify_manifest")).content).toContain("verified");
    const bad = model(f, (_body, count) => count === 1 ? writeMemory("other") : count === 2 ? {
      tool_calls: [{ index: 0, id: "verify-mismatch", type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "verify_manifest", path: "memory/manifest.json" }) } }],
    } : { content: "The changed bytes do not match." }, () => "blocked");
    expect((await f.run(["ask", "Replace hello with other and check the old manifest", "--json"])).code).toBe(1);
    expect(bad.packets.at(-1).evidence.find((e: any) => e.arguments?.includes("verify_manifest")).status).toBe("failure");
  }, 150000);

  test("discovers declared capabilities and validates custom records without granting host authority", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const declaration = JSON.parse(readFileSync(join(import.meta.dir, "../../src/core/workspace/standard/omos.json"), "utf8"));
    declaration.spec.semantic.entityTypes.push({ id: "company_note", fields: { text: "string" }, required: ["text"] });
    declaration.spec.capabilities.push({ ...structuredClone(declaration.spec.capabilities[0]), id: "cv_builder", name: "Custom CV builder", realisations: ["cv_builder_native"] });
    declaration.spec.realisations.push({ ...structuredClone(declaration.spec.realisations[0]), id: "cv_builder_native", capability: "cv_builder" });
    declaration.spec.operations.push({ ...structuredClone(declaration.spec.operations[0]), id: "build_cv", capability: "cv_builder" });
    const path = join(f.home, "declaration.json");
    writeFileSync(path, JSON.stringify(declaration));
    expect((await f.run(["fossil", "definition", "propose", path, "--json"])).code).toBe(0);
    const inputs = [
      { name: "capability_search", args: { query: "cv_builder" } },
      { name: "fossil_workspace", args: { action: "record", entity: "company_note", content: JSON.stringify({ text: "Retained company fact" }) } },
      { name: "fossil_workspace", args: { action: "query", entity: "company_note" } },
      { name: "fossil_workspace", args: { action: "record", entity: "omos_evidence", content: JSON.stringify({ task: "forged", records: [] }) } },
    ];
    const m = model(f, (_body, count) => count <= inputs.length ? {
      tool_calls: [{ index: 0, id: `record-${count}`, type: "function", function: { name: inputs[count - 1].name, arguments: JSON.stringify(inputs[count - 1].args) } }],
    } : { content: "The typed note was saved; host evidence remains protected." });
    const result = await f.run(["ask", "Discover the CV capability, save and query a typed note, and check that host evidence cannot be forged", "--json"], {}, 150000);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const evidence = m.packets.at(-1).evidence;
    const discovered = JSON.parse(evidence.find((e: any) => e.tool === "capability_search").content);
    expect(discovered.workspace_capabilities[0].id).toBe("cv_builder");
    expect(discovered.workspace_capabilities[0].availability).toBe("declared_only");
    expect(evidence.find((e: any) => e.arguments?.includes('"action":"query"')).content).toContain("Retained company fact");
    expect(evidence.find((e: any) => e.arguments?.includes("omos_evidence")).status).toBe("failure");
  }, 150000);

  test("reviews retained evidence beyond the former aggregate limit through bounded pages", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let seeded = false;
    const target = "tool:fixture:0";
    const m = model(f, () => ({ content: "The retained receipt confirms the requested outcome." }), packet => {
      if (!seeded) return "blocked";
      // The target can be on any manifest page. Exercise list retrieval on
      // every attempt without assuming history files have a particular order.
      if (!packet.currentInspections.some((page: any) => page.evidence)) return {
        name: "omos_review_evidence", args: { action: "list", offset: packet.nextEvidenceOffset ?? 0, limit: 32 },
      };
      const previous = packet.inspections.filter((page: any) => page.id === target).at(-1);
      if (!previous || previous.nextOffset !== null) return {
        name: "omos_review_evidence", args: { action: "read", id: target, offset: previous?.nextOffset ?? 0 },
      };
      return { name: "omos_contract_assessment", args: {
        contractId: packet.contract.id, version: packet.contract.version,
        obligations: [{ id: "request_complete", status: "met", evidence: [target], note: "Inspected the complete retained receipt" }],
      } };
    });
    const first = await f.run(["ask", "Confirm the retained fixture receipt", "--json"]);
    expect(first.code).toBe(1);
    const session = JSON.parse(first.stdout).session_id;
    const status = JSON.parse((await f.run(["fossil", "status", "--json"])).stdout);
    const task = status.tasks[0];
    const tree = join(f.home, "evidence-fixture");
    mkdirSync(tree);
    const fossil = (...args: string[]) => {
      const result = spawnSync("fossil", args, { cwd: tree, env: { PATH: process.env.PATH, HOME: f.home, FOSSIL_HOME: f.home, USER: "omos", LC_ALL: "C" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    fossil("open", "--nosync", join(f.cwd, "omos.fossil"), task.branch);
    const history = join(tree, "history", task.id);
    mkdirSync(history, { recursive: true });
    for (let i = 0; i < 36; i++) {
      const value = JSON.stringify({ kind: "tool_evidence", task: task.id, contract_version: task.definition.version,
        value: [{ id: `tool:fixture:${i}`, kind: "tool", tool: "fixture_receipt", arguments: "{}", status: "success", content: JSON.stringify({ receipt: "confirmed", padding: "x".repeat(i === 0 ? 184926 : 24576) }) }],
      });
      writeFileSync(join(history, createHash("sha256").update(value).digest("hex") + ".json"), value);
    }
    fossil("addremove");
    fossil("commit", "--nosync", "--nosign", "--no-verify", "--no-warnings", "-m", "Retain fixture evidence");
    seeded = true;
    const pending = await f.run(["ask", "--resume-id", session, "continue", "--json"], {}, 120000);
    expect(pending.code, pending.stderr).toBe(1);
    expect(pending.stderr).toContain("Verification reached its evidence budget");
    const actorCount = m.counts().actors;
    const resumed = await f.run(["ask", "--resume-id", session, "continue", "--json"], {}, 120000);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(m.counts().actors).toBe(actorCount);
    expect(m.packets.at(-1).previousInspections.length).toBeGreaterThan(0);
    expect(m.packets.at(-1).inspections.at(-1).fullyInspected).toBe(true);
    expect(m.packets.every(packet => JSON.stringify(packet).length < 524288)).toBe(true);
    const manifest = [...m.packets.at(-1).evidence, ...m.packets.at(-1).inspections.flatMap((page: any) => page.evidence ?? [])];
    expect(manifest.find((item: any) => item.id === target).complete).toBe(false);
  }, 240000);

  test("resumes independent segment assessment beyond a single review packet without replaying effects", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let seeded = false;
    const target = "tool:large-receipt";
    let maximumRequest = 0;
    const m = model(f, () => ({ content: "The retained receipt confirms the fixture outcome." }), packet => {
      if (!seeded) return "blocked";
      maximumRequest = Math.max(maximumRequest, JSON.stringify(packet).length);
      const receipt = packet.currentInspections.filter((p: any) => p.segment?.id === target).at(-1);
      const saved = packet.previousAssessments.find((p: any) => p.id === target);
      const assessed = receipt ? receipt.segment.offset + receipt.segment.bytes : saved?.assessed_bytes ?? 0;
      const pages = packet.inspections.filter((p: any) => p.id === target && p.offset >= assessed);
      const last = pages.at(-1);
      const bytes = last?.bytes ?? saved?.bytes;
      const offset = last ? last.offset + last.content.length : assessed;
      if (bytes && assessed === bytes) return { name: "omos_contract_assessment", args: {
        contractId: packet.contract.id, version: packet.contract.version,
        obligations: packet.contract.obligations.map((o: any) => ({ id: o.id, status: "met", evidence: [target], note: "Every byte was independently assessed against the fixture receipt." })),
      } };
      if (pages.length >= 6 || (last && last.nextOffset === null)) return { name: "omos_review_checkpoint", args: {
        id: target, offset: assessed, bytes: offset - assessed,
        obligations: packet.contract.obligations.map((o: any) => ({ id: o.id, verdict: "supports", note: "This inspected fixture segment confirms the receipt; no contrary outcome occurs in these bytes." })),
      } };
      return { name: "omos_review_evidence", args: { action: "read", id: target, offset } };
    });
    const first = await f.run(["ask", "Verify the complete retained fixture receipt", "--json"]);
    const session = JSON.parse(first.stdout).session_id;
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    const tree = join(f.home, "large-receipt-checkout");
    mkdirSync(tree);
    const fossil = (...args: string[]) => {
      const result = spawnSync("fossil", args, { cwd: tree, env: { PATH: process.env.PATH, HOME: f.home, FOSSIL_HOME: f.home, USER: "omos", LC_ALL: "C" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    fossil("open", "--nosync", join(f.cwd, "omos.fossil"), task.branch);
    const history = join(tree, "history", task.id);
    mkdirSync(history, { recursive: true });
    const record = JSON.stringify({ kind: "tool_evidence", task: task.id, contract_version: task.definition.version,
      value: [{ id: target, kind: "tool", tool: "fixture_receipt", arguments: "{}", status: "success", content: JSON.stringify({ receipt: "confirmed", padding: "x".repeat(600000) }) }],
    });
    writeFileSync(join(history, createHash("sha256").update(record).digest("hex") + ".json"), record);
    fossil("addremove");
    fossil("commit", "--hash", "--nosync", "--nosign", "--no-verify", "--no-warnings", "-m", "Retain large fixture receipt");
    seeded = true;
    let completed = false;
    let lastPrefix = 0;
    let actorCount: number | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await f.run(["ask", "--resume-id", session, "continue", "--json"], {}, 120000);
      actorCount ??= m.counts().actors;
      expect(m.counts().actors).toBe(actorCount);
      if (result.code === 0) { completed = true; break; }
      expect(result.stderr).toContain("Verification reached its evidence budget");
      const prefix = m.packets.at(-1).currentInspections.filter((p: any) => p.segment?.id === target).at(-1)?.segment;
      const current = prefix ? prefix.offset + prefix.bytes : m.packets.at(-1).previousAssessments.find((p: any) => p.id === target)?.assessed_bytes ?? 0;
      expect(current).toBeGreaterThan(lastPrefix);
      lastPrefix = current;
    }
    expect(completed).toBe(true);
    expect(maximumRequest).toBeLessThan(524288);
    expect(m.packets.at(-1).previousAssessments.find((p: any) => p.id === target).segments).toBeGreaterThan(1);
    expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0].state).toBe("accepted");
  }, 240000);

  test("corrects one unadvertised tool proposal without executing it", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => count === 1
      ? { tool_calls: [{ index: 0, id: "rejected-proposal", type: "function", function: { name: "mcp_unavailable_fixture", arguments: "{}" } }] }
      : { content: "The corrected answer." });
    const result = await f.run(["ask", "Give a short answer using the available tools only", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("The corrected answer.");
    expect(m.counts().actors).toBe(2);
    const status = JSON.parse((await f.run(["fossil", "status", "--json"])).stdout);
    const files = f.fossil("ls", "-r", status.tasks[0].branch).trim().split("\n").filter(path => path.startsWith("history/"));
    const records = files.map(path => JSON.parse(f.fossil("cat", path, "-r", status.tasks[0].branch)));
    const failure = records.find(record => record.kind === "protocol_failure");
    expect(failure.value.stage).toBe("response");
    expect(failure.value.rejected_name).toBe("mcp_unavailable_fixture");
    expect(records.filter(record => record.kind === "action_intent").flatMap(record => record.value.calls).some(call => call.name === "mcp_unavailable_fixture")).toBe(false);
  }, 60000);

  test("reviews read dependencies above the former aggregate content limit", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const tree = join(f.home, "dependency-checkout");
    mkdirSync(tree);
    const fossil = (...args: string[]) => {
      const result = spawnSync("fossil", args, { cwd: tree, env: { PATH: process.env.PATH, HOME: f.home, FOSSIL_HOME: f.home, USER: "omos", LC_ALL: "C" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    fossil("open", "--nosync", join(f.cwd, "omos.fossil"), "trunk");
    mkdirSync(join(tree, "memory"), { recursive: true });
    for (const name of ["first", "second"]) writeFileSync(join(tree, "memory", `${name}.txt`), name + "x".repeat(150000));
    fossil("addremove");
    fossil("commit", "--hash", "--nosync", "--nosign", "--no-verify", "--no-warnings", "-m", "Seed dependency fixtures");
    const m = model(f, (_body, count) => count <= 2 ? {
      tool_calls: [{ index: 0, id: `dependency-${count}`, type: "function", function: { name: "fossil_workspace", arguments: JSON.stringify({ action: "read", path: `memory/${count === 1 ? "first" : "second"}.txt` }) } }],
    } : { content: "The recorded dependencies are memory/first.txt and memory/second.txt." }, packet => {
      const snapshot = packet.evidence.find((e: any) => e.kind === "workspace" && e.id.startsWith("workspace:"));
      const page = packet.inspections.find((p: any) => p.id === snapshot.id);
      if (!page) return { name: "omos_review_evidence", args: { action: "read", id: snapshot.id } };
      const state = JSON.parse(JSON.parse(page.content).content);
      expect(state.reads).toHaveLength(2);
      expect(state.reads.reduce((n: number, read: any) => n + read.bytes, 0)).toBeGreaterThan(262144);
      expect(state.reads.every((read: any) => !read.complete)).toBe(true);
      return { name: "omos_contract_assessment", args: {
        contractId: packet.contract.id, version: packet.contract.version,
        obligations: packet.contract.obligations.map((o: any) => ({ id: o.id, status: "met", evidence: [snapshot.id], note: "The host records both dependency paths at the reviewed revision." })),
      } };
    });
    const result = await f.run(["ask", "Read both memory fixtures and report the recorded dependency paths", "--json"], {}, 120000);
    expect(result.code, result.stderr).toBe(0);
    expect(m.counts().actors).toBe(3);
    expect(m.packets.at(-1).evidence.filter((e: any) => e.id.startsWith("workspace-file:")).map((e: any) => e.bytes).every((bytes: number) => bytes > 150000)).toBe(true);
  }, 150000);

  test("continues a failed review from its retained candidate without repeating actor work", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let permit = false;
    const m = model(f, () => ({ content: "A retained answer." }), packet => permit ? "met" : {
      name: "omos_contract_assessment",
      args: { contractId: packet.contract.id, version: packet.contract.version, obligations: [{ id: "request_complete", status: "met", evidence: ["invented"], note: "Invalid fixture evidence" }] },
    });
    const first = await f.run(["ask", "Give a short informational answer", "--json"]);
    expect(first.code).toBe(1);
    const status = JSON.parse((await f.run(["fossil", "status", "--json"])).stdout);
    const session = status.tasks[0].session;
    const actual = JSON.parse(first.stdout).session_id;
    expect(session).toBe(createHash("sha256").update(actual).digest("hex"));
    permit = true;
    const resumed = await f.run(["ask", "--resume-id", actual, "continue", "--json"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("A retained answer.");
    expect(m.counts().actors).toBe(1);
  }, 60000);

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
import { appendFileSync, existsSync, utimesSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
if ((args.includes("changes") || args.includes("commit")) && existsSync("memory/preference.md")) {
  utimesSync("memory/preference.md", 946684800, 946684800);
}
const result = Bun.spawnSync([${JSON.stringify(executable)}, ...args], { env: process.env, stdin: "inherit" });
if (result.exitCode !== 0) appendFileSync(${JSON.stringify(join(f.home, "fossil-wrapper.errors"))}, JSON.stringify({ args, exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }) + "\\n");
writeSync(1, result.stdout);
writeSync(2, result.stderr);
process.exit(result.exitCode);
`, { mode: 0o700 });
    model(f, (_body, count) => count <= 2 ? writeMemory(count === 1 ? "first" : "other") : { content: "The final preference is other." });
    const result = await f.run(["ask", "Save first, then replace it with other", "--json"], { PATH: `${bin}:${process.env.PATH}` }, 60000);
    if (result.code !== 0 && existsSync(join(f.home, "fossil-wrapper.errors"))) result.stderr += readFileSync(join(f.home, "fossil-wrapper.errors"), "utf8");
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
    const m = model(f, () => ({ content: "The answer is green." }), packet => {
      if (blocked) return "blocked";
      for (const record of packet.evidence.filter((e: any) => e.kind === "context" && !e.complete)) {
        const previous = packet.inspections.filter((p: any) => p.id === record.id).at(-1);
        if (!previous || previous.nextOffset !== null) return { name: "omos_review_evidence", args: {
          action: "read", id: record.id, offset: previous?.nextOffset ?? 0,
        } };
      }
      return "met";
    });
    const goal = "Answer these requirements: " + "detail ".repeat(1600) + "finish with blue";
    const first = await f.run(["ask", goal, "--json"], {}, 120000);
    expect(first.code).toBe(1);
    const session = JSON.parse(first.stdout).session_id;
    blocked = false;
    const correction = "Correction: " + "note ".repeat(2000) + "use green";
    const second = await f.run(["ask", "--resume-id", session, correction, "--json"], {}, 120000);
    expect(second.code, second.stderr).toBe(0);
    expect(goal.startsWith(m.packets[0].originalRequest)).toBe(true);
    expect(m.packets[0].originalRequestEvidence).toBe("context:original");
    const packet = m.packets.at(-1);
    const inspected = (id: string) => JSON.parse(packet.inspections.filter((p: any) => p.id === id).sort((a: any, b: any) => a.offset - b.offset).map((p: any) => p.content).join("")).content;
    expect(inspected(packet.originalRequestEvidence)).toBe(goal);
    expect(JSON.parse(inspected(packet.userSteeringEvidence))).toContain(correction);
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
        expect(status.tasks.map((task: any) => task.state).sort(), JSON.stringify(results)).toEqual(["accepted", "conflict"]);
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
