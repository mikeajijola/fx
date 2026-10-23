import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cleanupFixtures, fixture, model, writeMemory } from "./fossil-workspace-helpers";

afterEach(cleanupFixtures);

async function startWorkspaceService(f: ReturnType<typeof fixture>, writable = false, extra: Record<string, string | undefined> = {}) {
  const token = "isolated-workspace-service-token-for-fixtures";
  const child = Bun.spawn([join(import.meta.dir, "../../zig-out/bin/fx"), "fossil", "serve", "0", "--json", ...(writable ? ["--write"] : [])], {
    cwd: f.cwd, env: { ...process.env, ...f.env, ...extra, OMOS_WORKSPACE_TOKEN: token }, stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let output = "";
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes("\n")) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => { throw new Error("Workspace service did not become ready"); })]);
      if (chunk.done) throw new Error(`Service exited: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(chunk.value);
    }
    const ready = JSON.parse(output.trim().split("\n")[0]);
    const url = `http://127.0.0.1:${ready.port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    return { child, ready, url, headers, post: async (body: object) => {
      try {
        return await fetch(`${url}/v1/workspace`, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (error) {
        const exitCode = child.exitCode;
        child.kill();
        await child.exited;
        throw new Error(`${error instanceof Error ? error.stack : error}\nService exit before cleanup: ${exitCode}\n${await new Response(child.stderr).text()}\n${existsSync(f.env.FX_TRACE_LOG) ? readFileSync(f.env.FX_TRACE_LOG, "utf8").slice(-16000) : ""}`);
      }
    } };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// These fault, boundary, migration, and authority cases qualify the candidate without training it.
describe("portable Fossil workspace recovery", () => {
  test("authenticates scoped company views, fences concurrent checkpoints, retains outcomes and revokes access", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const admin = async (request: object) => {
      const file = join(f.home, "company-admin.json");
      writeFileSync(file, JSON.stringify({ version: "omos.company-admin/v1", ...request }));
      const result = await f.run(["fossil", "company", file, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout).model_data;
    };
    const initialized = await admin({ action: "initialize" });
    const key = generateKeyPairSync("ed25519");
    const publicKey = key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    let control = await admin({ action: "grant", revision: initialized.revision, grant: {
      id: "alice-team", actor: "alice", public_key: publicKey, paths: ["documents/team/"],
      actions: ["discover", "read", "create_view", "checkpoint", "submit", "status", "export_scope"], expires_ms: Date.now() + 3600000,
    } });
    let service = await startWorkspaceService(f, true);
    const boot = await (await fetch(service.url + "/v1/company")).json() as any;
    const envelope = (action: string, params: object = {}, operation = crypto.randomUUID()) => {
      const payload = JSON.stringify({ version: "omos.company/v1", workspace: boot.workspace, actor: "alice", grant: "alice-team", operation, expires_ms: Date.now() + 120000, action, ...params });
      return { payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("hex") };
    };
    const post = async (body: object, headers = {}) => {
      try { return await fetch(service.url + "/v1/company", { method: "POST", headers: { "content-type": "application/json", connection: "close", ...headers }, body: JSON.stringify(body) }); }
      catch (error) {
        service.child.kill(); await service.child.exited;
        throw Error(`${error}\n${await new Response(service.child.stderr).text()}\n${existsSync(f.env.FX_TRACE_LOG) ? readFileSync(f.env.FX_TRACE_LOG, "utf8").slice(-12000) : ""}`);
      }
    };
    const unpack = async (response: Response) => {
      const result = await response.json() as any;
      expect(response.status, JSON.stringify(result)).toBe(200);
      const issuer = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(result.issuer, "hex")]), format: "der", type: "spki" });
      expect(result.issuer).toBe(boot.issuer);
      expect(verify(null, Buffer.from(result.payload), issuer, Buffer.from(result.signature, "hex"))).toBe(true);
      return JSON.parse(result.payload).result;
    };
    try {
      const invalid = envelope("discover");
      invalid.signature = "00".repeat(64);
      expect((await post(invalid)).status).toBe(403);
      expect((await post(envelope("discover"), { origin: "https://untrusted.invalid" })).status).toBe(401);
      const create = envelope("create_view", { objective: "Prepare a portable team report", revision: boot.revision });
      const view = await unpack(await post(create));
      expect((await unpack(await post(create))).view).toBe(view.view);
      const a = envelope("checkpoint", { view: view.view, revision: view.revision, path: "documents/team/report.md", content: "Team report", previous_hash: null });
      const b = envelope("checkpoint", { view: view.view, revision: view.revision, path: "documents/team/other.md", content: "Other report", previous_hash: null });
      const replies = await Promise.all([post(a), post(b)]);
      expect(replies.map(reply => reply.status).sort()).toEqual([200, 409]);
      const firstIndex = replies[0].status === 200 ? 0 : 1;
      const successful = await unpack(replies[firstIndex]);
      const acceptedRequest = firstIndex === 0 ? a : b;
      expect(await unpack(await post(acceptedRequest))).toEqual(successful);
      expect(await unpack(await post({ signature: acceptedRequest.signature.toUpperCase(), payload: acceptedRequest.payload }))).toEqual(successful);
      const changed = JSON.parse(acceptedRequest.payload);
      const changedRequest = envelope("checkpoint", { ...changed, content: "Changed operation" }, changed.operation);
      expect((await post(changedRequest)).status).toBe(409);
      const denied = envelope("checkpoint", { view: view.view, revision: successful.revision, path: "documents/private/report.md", content: "leak" });
      expect((await post(denied)).status).toBe(403);
      const inventory = await unpack(await post(envelope("export_scope", { view: view.view, revision: successful.revision })));
      expect(inventory.files).toHaveLength(1);
      expect(inventory.files[0].path.startsWith("documents/team/")).toBe(true);
      expect(inventory.authority).toBe("content_only");
      const read = await unpack(await post(envelope("read", { view: view.view, revision: successful.revision, path: inventory.files[0].path, limit: 4 })));
      expect(read.next_offset).toBe(4);
      expect(Buffer.from(read.content, "base64").length).toBe(4);
      const otherKey = generateKeyPairSync("ed25519");
      control = await admin({ action: "status" });
      control = await admin({ action: "grant", revision: control.revision, grant: {
        id: "bob-team", actor: "bob", public_key: otherKey.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"), paths: ["documents/team/"], actions: ["read"], expires_ms: Date.now() + 3600000,
      } });
      const stolenPayload = JSON.stringify({ version: "omos.company/v1", workspace: boot.workspace, actor: "bob", grant: "bob-team", operation: crypto.randomUUID(), expires_ms: Date.now() + 120000, action: "read", path: inventory.files[0].path, revision: successful.revision });
      expect((await post({ payload: stolenPayload, signature: sign(null, Buffer.from(stolenPayload), otherKey.privateKey).toString("hex") })).status).toBe(403);
      service.child.kill();
      await service.child.exited;
      service = await startWorkspaceService(f, true);
      expect(await unpack(await post(acceptedRequest))).toEqual(successful);
      // Administrative revisions include operations as well as grants.
      control = await admin({ action: "status" });
      await admin({ action: "revoke", revision: control.revision, id: "alice-team" });
      expect((await post(acceptedRequest)).status).toBe(403);
      expect((await post(envelope("read", { view: view.view, revision: successful.revision, path: inventory.files[0].path }))).status).toBe(403);
    } finally {
      service.child.kill();
      await service.child.exited;
    }
  }, 120000);

  test("publishes independently reviewed company proposals and fences revocation during assessment", async () => {
    for (const revoked of [false, true]) {
      const f = fixture();
      let release: (() => void) | undefined;
      let reviewing = false;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const modelServer = model(f, () => { throw Error("Company verification must never run actor tools"); }, async () => {
        reviewing = true;
        if (revoked) await wait;
        return "met";
      });
      const initialized = await f.run(["fossil", "init"]);
      expect(initialized.code, initialized.stderr).toBe(0);
      const admin = async (body: object) => {
        const file = join(f.home, "operator.json");
        writeFileSync(file, JSON.stringify({ version: "omos.company-admin/v1", ...body }));
        const result = await f.run(["fossil", "company", file, "--json"]);
        expect(result.code, result.stderr).toBe(0);
        return JSON.parse(result.stdout).model_data;
      };
      const company = await admin({ action: "initialize" });
      const key = generateKeyPairSync("ed25519");
      await admin({ action: "grant", revision: company.revision, grant: { id: "reviewed-worker", actor: "worker", public_key: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"), paths: ["documents/"], actions: ["create_view", "checkpoint", "submit", "status"], expires_ms: Date.now() + 3600000 } });
      const service = await startWorkspaceService(f, true);
      const boot = await (await fetch(service.url + "/v1/company")).json() as any;
      const send = async (action: string, params: object = {}) => {
        const payload = JSON.stringify({ version: "omos.company/v1", workspace: boot.workspace, actor: "worker", grant: "reviewed-worker", operation: crypto.randomUUID(), expires_ms: Date.now() + 120000, action, ...params });
        const response = await fetch(service.url + "/v1/company", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("hex") }) });
        const result = await response.json() as any;
        expect(response.status, JSON.stringify(result)).toBe(200);
        return JSON.parse(result.payload).result;
      };
      try {
        const view = await send("create_view", { revision: boot.revision, objective: "Save documents/report.md containing Reviewed report" });
        const saved = await send("checkpoint", { view: view.view, revision: view.revision, path: "documents/report.md", content: "Reviewed report", previous_hash: null });
        const submitted = await send("submit", { view: view.view, revision: saved.revision, candidate: "Saved documents/report.md containing Reviewed report." });
        const deadline = Date.now() + 60000;
        while (!reviewing && Date.now() < deadline) await Bun.sleep(20);
        expect(reviewing).toBe(true);
        if (revoked) {
          const current = await admin({ action: "status" });
          await admin({ action: "revoke", revision: current.revision, id: "reviewed-worker" });
          release!();
        }
        let job: any;
        while (Date.now() < deadline) {
          const tasks = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks;
          const task = tasks.find((task: any) => task.review_job === submitted.job);
          job = JSON.parse(f.fossil("cat", `jobs/${submitted.job}.json`, "-r", task.state === "accepted" ? task.parent : task.branch));
          if (!["queued", "running"].includes(job.state)) break;
          await Bun.sleep(20);
        }
        expect(job.state, JSON.stringify({ job, model: modelServer.counts() }) + "\n" + readFileSync(f.env.FX_TRACE_LOG, "utf8").slice(-6000)).toBe(revoked ? "failed" : "published");
        if (revoked) expect(f.fossil("ls", "-r", "trunk")).not.toContain("documents/report.md");
        else expect(f.fossil("cat", "documents/report.md", "-r", "trunk")).toBe("Reviewed report");
        expect(modelServer.counts().actors).toBe(0);
      } finally {
        release!(); service.child.kill(); await service.child.exited;
      }
    }
  }, 180000);

  test("reconciles a committed company checkpoint after losing its acknowledgement", async () => {
    const f = fixture();
    const initialized = await f.run(["fossil", "init"]);
    expect(initialized.code, initialized.stderr).toBe(0);
    const admin = async (body: object) => {
      const file = join(f.home, "admin.json");
      writeFileSync(file, JSON.stringify({ version: "omos.company-admin/v1", ...body }));
      const result = await f.run(["fossil", "company", file, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout).model_data;
    };
    const company = await admin({ action: "initialize" });
    const key = generateKeyPairSync("ed25519");
    await admin({ action: "grant", revision: company.revision, grant: { id: "worker", actor: "worker", public_key: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"), paths: ["documents/"], actions: ["create_view", "checkpoint", "status", "discover"], expires_ms: Date.now() + 3600000 } });
    const service = await startWorkspaceService(f, true, { FX_E2E_FOSSIL_FAULT: "company-checkpoint-committed" });
    const boot = await (await fetch(service.url + "/v1/company")).json() as any;
    const seal = (action: string, params: object = {}) => {
      const payload = JSON.stringify({ version: "omos.company/v1", workspace: boot.workspace, actor: "worker", grant: "worker", operation: crypto.randomUUID(), expires_ms: Date.now() + 120000, action, ...params });
      return { payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("hex") };
    };
    const send = (request: object) => fetch(service.url + "/v1/company", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(request) });
    const data = async (response: Response) => {
      const result = await response.json() as any;
      expect(response.status, JSON.stringify(result)).toBe(200);
      return JSON.parse(result.payload).result;
    };
    try {
      const view = await data(await send(seal("create_view", { revision: boot.revision, objective: "Save an interrupted report" })));
      const original = seal("checkpoint", { view: view.view, revision: view.revision, path: "documents/report.md", content: "Saved once", previous_hash: null });
      const failure = await send(original);
      expect(failure.status).toBe(400);
      expect((await failure.json() as any).error).toBe("WorkspaceInjectedFailure");
      const operation = JSON.parse(original.payload).operation;
      const pending = await data(await send(seal("status", { outcome: operation })));
      expect(pending.state).toBe("uncertain");
      const blocked = await send(seal("checkpoint", { view: view.view, revision: view.revision, path: "documents/other.md", content: "Must wait" }));
      expect((await blocked.json() as any).error).toBe("CompanyOperationRecoveryRequired");
      const resumed = await data(await send(original));
      expect(resumed.state).toBe("checkpointed");
      expect(await data(await send(original))).toEqual(resumed);
      const completed = await data(await send(seal("status", { outcome: operation })));
      expect(completed.state).toBe("completed");
      const snapshot = await data(await send(seal("discover", { view: view.view, revision: resumed.revision })));
      expect(snapshot.files).toHaveLength(1);
      expect(snapshot.files[0].sha256).toBe(createHash("sha256").update("Saved once").digest("hex"));
      expect(f.fossil("ls", "-r", resumed.revision).split("\n").filter(path => path.startsWith("company/checkpoints/"))).toHaveLength(1);
    } finally {
      service.child.kill(); await service.child.exited;
    }
  }, 90000);

  test("does not initialize personal persistence for an unsaved turn", async () => {
    const f = fixture();
    model(f, () => ({ content: "Hello." }));
    const result = await f.run(["ask", "Say hello", "--no-save", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(f.home, ".fx/omos-workspace.json"))).toBe(false);
    expect(existsSync(join(f.home, ".fx/instances/personal.fossil"))).toBe(false);
  }, 60000);

  test("installs a verified Fossil helper and rejects changes before executing it", async () => {
    const f = fixture();
    const script = join(import.meta.dir, "../../scripts/install-omos.sh");
    const installed = spawnSync("sh", [script], { cwd: f.cwd, env: { ...process.env, ...f.env, XDG_BIN_HOME: join(f.home, ".local/bin") }, encoding: "utf8", timeout: 60000 });
    expect(installed.status, installed.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.home, ".fx/libexec/fossil.json"), "utf8"));
    const helper = join(f.home, ".fx/libexec", manifest.file);
    expect(createHash("sha256").update(readFileSync(helper)).digest("hex")).toBe(manifest.sha256);
    const status = await f.run(["fossil", "status", "--json"], { PATH: "/nonexistent" });
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).tasks).toEqual([]);
    for (const command of ["omos", "omo"]) {
      const alias = spawnSync(join(f.home, ".local/bin", command), ["fossil", "status", "--json"], { cwd: f.cwd, env: { ...process.env, ...f.env }, encoding: "utf8" });
      expect(alias.status, alias.stderr).toBe(0);
      expect(JSON.parse(alias.stdout).workspace_id).toBe(JSON.parse(status.stdout).workspace_id);
    }
    appendFileSync(helper, "changed");
    const changed = await f.run(["fossil", "status", "--json"]);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("FossilExecutableChanged");
  }, 90000);

  test("creates one empty personal instance automatically without importing existing sessions", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".fx", "sessions", "legacy"), { recursive: true });
    writeFileSync(join(f.home, ".fx", "sessions", "legacy", "session.json"), JSON.stringify({ private: "legacy-session-must-not-be-imported" }));
    const attempts = await Promise.all([f.run(["fossil", "ensure", "--json"]), f.run(["fossil", "ensure", "--json"])]);
    for (const attempt of attempts) expect(attempt.code, attempt.stderr).toBe(0);
    const first = JSON.parse(attempts[0].stdout);
    const second = JSON.parse(attempts[1].stdout);
    expect(first.workspace_id).toBe(second.workspace_id);
    expect(first.repository).toBe(join(f.home, ".fx", "instances", "personal.fossil"));
    expect(first.tasks).toEqual([]);
    expect(first.files).toContain("omniform/company.json");
    expect(first.files).toContain("execution/omos.json");
    expect(first.files.some((path: string) => /^(imports|history|skills|memory)\//.test(path))).toBe(false);
    expect(readFileSync(join(f.home, ".fx", "sessions", "legacy", "session.json"), "utf8")).toContain("legacy-session");
    const other = fixture();
    const otherInstance = JSON.parse((await other.run(["fossil", "ensure", "--json"])).stdout);
    expect(otherInstance.workspace_id).not.toBe(first.workspace_id);
  }, 60000);

  test("keeps the explicitly bound repository when ensuring a personal instance", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const result = await f.run(["fossil", "ensure", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).repository).toBe(join(f.cwd, "omos.fossil"));
    expect(existsSync(join(f.home, ".fx", "instances", "personal.fossil"))).toBe(false);
  }, 60000);

  test("restores a complete versioned skill package and prefers it over a legacy copy", async () => {
    const f = fixture();
    const instructions = "---\nname: portable-skill\ndescription: Read the fixture dataset using the included script\n---\nCanonical portable skill.\n" + "Retained package instructions. ".repeat(180);
    const program = 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(new URL("./data/input.json", import.meta.url))).name);';
    const makeLegacy = (home: string) => {
      mkdirSync(join(home, "project/.fx/skills/portable-skill"), { recursive: true });
      writeFileSync(join(home, "project/.fx/skills/portable-skill/SKILL.md"), "---\nname: portable-skill\ndescription: A stale compatibility copy\n---\nLegacy instructions must not shadow the versioned package.");
    };
    makeLegacy(f.home);
    model(f, (body, count) => {
      const text = body.messages.map((message: any) => typeof message.content === "string" ? message.content : "").join("\n");
      const match = text.match(/"workingDirectory":\s*("(?:[^"\\]|\\.)*")/);
      expect(match).not.toBeNull();
      const root = JSON.parse(match![1]);
      if (count === 1) return { tool_calls: [
        { path: "skills/portable-skill/SKILL.md", content: instructions },
        { path: "skills/portable-skill/run.mjs", content: program },
        { path: "skills/portable-skill/data/input.json", content: JSON.stringify({ name: "fixture-package-data" }) },
      ].map((file, index) => ({ index, id: `package-${index}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ ...file, path: join(root, file.path) }) } })) };
      if (count === 2) return { tool_calls: [{ index: 0, id: "load-package", type: "function", function: { name: "skill", arguments: JSON.stringify({ name: "portable-skill" }) } }] };
      if (count === 3) {
        expect(body.messages.some((message: any) => message.role === "tool" && typeof message.content === "string" && message.content.includes("Canonical portable skill."))).toBe(true);
        return { tool_calls: [{ index: 0, id: "run-package", type: "function", function: { name: "shell", arguments: JSON.stringify({ request: { action: "run", command: `node '${root}/skills/portable-skill/run.mjs'`, timeout_ms: 10000 } }) } }] };
      }
      expect(body.messages.some((message: any) => message.role === "tool" && typeof message.content === "string" && message.content.includes("fixture-package-data"))).toBe(true);
      return { content: "The complete portable skill package loaded and its executable read the included dataset." };
    });
    const initial = await f.run(["ask", "Save and exercise a complete portable skill package", "--json"]);
    expect(initial.code, initial.stderr).toBe(0);
    const exported = join(f.home, "skill-package.fossil");
    expect((await f.run(["fossil", "export", exported])).code).toBe(0);
    const clean = fixture();
    makeLegacy(clean.home);
    expect((await clean.run(["fossil", "use", exported])).code).toBe(0);
    model(clean, (body, count) => {
      const text = body.messages.map((message: any) => typeof message.content === "string" ? message.content : "").join("\n");
      const root = JSON.parse(text.match(/"workingDirectory":\s*("(?:[^"\\]|\\.)*")/)![1]);
      expect(readFileSync(join(root, "skills/portable-skill/SKILL.md"), "utf8")).toBe(instructions);
      expect(readFileSync(join(root, "skills/portable-skill/run.mjs"), "utf8")).toBe(program);
      if (count === 1) return { tool_calls: [{ index: 0, id: "find-restored", type: "function", function: { name: "capability_search", arguments: JSON.stringify({ query: "portable skill" }) } }] };
      if (count === 2) return { tool_calls: [{ index: 0, id: "load-restored", type: "function", function: { name: "skill", arguments: JSON.stringify({ name: "portable-skill" }) } }] };
      if (count === 3) {
        expect(body.messages.some((message: any) => message.role === "tool" && typeof message.content === "string" && message.content.includes("Canonical portable skill."))).toBe(true);
        return { tool_calls: [{ index: 0, id: "execute-restored", type: "function", function: { name: "shell", arguments: JSON.stringify({ request: { action: "run", command: `node '${root}/skills/portable-skill/run.mjs'`, timeout_ms: 10000 } }) } }] };
      }
      expect(body.messages.some((message: any) => message.role === "tool" && typeof message.content === "string" && message.content.includes("fixture-package-data"))).toBe(true);
      return { content: "The restored skill and dataset work without the previous profile." };
    });
    const restored = await clean.run(["ask", "Discover and run the restored skill", "--json"]);
    expect(restored.code, restored.stderr).toBe(0);
  }, 120000);

  test("checkpoints ordinary file and shell changes and rebuilds the view from an exported repository", async () => {
    const f = fixture();
    let workingDirectory = "";
    model(f, (body, count) => {
      const context = body.messages.map((message: any) => typeof message.content === "string" ? message.content : "").join("\n");
      const match = context.match(/"workingDirectory":\s*("(?:[^"\\]|\\.)*")/);
      expect(match).not.toBeNull();
      workingDirectory = JSON.parse(match![1]);
      if (count <= 2) return { tool_calls: [{ index: 0, id: `ordinary-${count}`, type: "function", function: {
        name: count === 1 ? "write_file" : "shell",
        arguments: JSON.stringify(count === 1 ? { path: join(workingDirectory, "memory", "portable.md"), content: "Portable memory from the ordinary file tool." } : { request: { action: "run", command: `mkdir -p '${workingDirectory}/documents'; printf 'Report from shell' > '${workingDirectory}/documents/report.txt'`, timeout_ms: 10000 } }),
      } }] };
      return { content: "Saved the memory and report in the workspace." };
    });
    const result = await f.run(["ask", "Save a memory and a report using ordinary file and shell tools", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const saved = JSON.parse((await f.run(["fossil", "status", "--json"])).stdout);
    const fossil = (...args: string[]) => {
      const command = spawnSync("fossil", [...args, "-R", saved.repository], { env: { ...process.env, HOME: f.home }, encoding: "utf8" });
      expect(command.status, command.stderr).toBe(0);
      return command.stdout;
    };
    expect(fossil("cat", "memory/portable.md", "-r", "trunk")).toContain("ordinary file tool");
    expect(fossil("cat", "documents/report.txt", "-r", "trunk")).toBe("Report from shell");
    const exported = join(f.home, "portable.fossil");
    expect((await f.run(["fossil", "export", exported])).code).toBe(0);
    const clean = fixture();
    expect((await clean.run(["fossil", "use", exported])).code).toBe(0);
    model(clean, (body, count) => {
      const context = body.messages.map((message: any) => typeof message.content === "string" ? message.content : "").join("\n");
      const match = context.match(/"workingDirectory":\s*("(?:[^"\\]|\\.)*")/);
      expect(match).not.toBeNull();
      const rebuilt = JSON.parse(match![1]);
      expect(rebuilt).not.toBe(workingDirectory);
      expect(readFileSync(join(rebuilt, "memory", "portable.md"), "utf8")).toContain("ordinary file tool");
      expect(readFileSync(join(rebuilt, "documents", "report.txt"), "utf8")).toBe("Report from shell");
      if (count === 1) return { tool_calls: [{ index: 0, id: "inspect-portable", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: join(rebuilt, "documents", "report.txt") }) } }] };
      return { content: "The report was restored from the portable workspace." };
    });
    const restored = await clean.run(["ask", "Read the portable report", "--json"]);
    expect(restored.code, restored.stderr).toBe(0);
  }, 120000);

  test("accepts current coding validation through a compact host receipt and preserves its proof chain", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, ".gitignore"), "omos.fossil\n");
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => count <= 2 ? {
      tool_calls: [{ index: 0, id: `coding-${count}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ request: { action: "run", command: count === 1 ? "touch answer.txt" : "test -f answer.txt", timeout_ms: 10000 } }) } }],
    } : { content: "Created answer.txt and checked that it exists." }, packet => {
      const receipts = packet.evidence.filter((e: any) => e.id.startsWith("command-receipt:") && e.complete);
      const receipt = receipts.find((e: any) => JSON.parse(e.content).arguments?.includes("test -f answer.txt"));
      expect(receipt).toBeDefined();
      return { name: "omos_contract_assessment", args: {
        contractId: packet.contract.id, version: packet.contract.version,
        obligations: packet.contract.obligations.map((o: any) => ({ id: o.id, status: "met", evidence: [receipt.id, packet.evidence.find((e: any) => e.kind === "candidate").id], note: "The host receipt records the check and resolves to validation of the current source." })),
      } };
    }, { plan: { capability: "coding_task", summary: "Create and check answer.txt", obligations: [], checks: ["test -f answer.txt"] } });
    const result = await f.run(["ask", "Create answer.txt and verify it exists", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(m.counts().actors).toBe(3);
    const results = await f.run(["fossil", "query", "omos_result", "--json"]);
    expect(results.code, results.stderr).toBe(0);
    const data = JSON.parse(results.stdout).model_data;
    expect(data.records.some((row: any) => row.data.status === "published" && row.data.assessment)).toBe(true);
    expect(data.relationships.some((edge: any) => edge.relationship === "omos_assessment_result" && edge.authority === "host_observed")).toBe(true);
  }, 90000);

  test("rejects a failed compact receipt as success evidence for a general task", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => count === 1 ? {
      tool_calls: [{ index: 0, id: "failed-check", type: "function", function: { name: "shell", arguments: JSON.stringify({ request: { action: "run", command: "test -f missing.txt", timeout_ms: 10000 } }) } }],
    } : { content: "The file exists." }, packet => {
      const receipt = packet.evidence.find((record: any) => record.id.startsWith("command-receipt:") && record.status === "failure");
      expect(receipt).toBeDefined();
      if (!receipt.complete && !packet.currentInspections.some((page: any) => page.id === receipt.id)) {
        return { name: "omos_review_evidence", args: { action: "read", id: receipt.id } };
      }
      return { name: "omos_contract_assessment", args: {
        contractId: packet.contract.id, version: packet.contract.version,
        obligations: packet.contract.obligations.map((obligation: any) => ({ id: obligation.id, status: "met", evidence: [receipt.id], note: "This failed receipt must not establish success." })),
      } };
    });
    const result = await f.run(["ask", "Confirm missing.txt exists", "--json"]);
    expect(result.code, result.stderr).toBe(1);
    expect(m.counts().actors).toBe(2);
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(task.state).not.toBe("accepted");
    expect(f.fossil("ls", "-r", "trunk")).not.toContain(`acceptances/${task.id}/`);
  }, 60000);

  test("bounds typed query payloads and retrieves complete original evidence at a pinned revision", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const content = "retained evidence ".repeat(3000);
    model(f, (_body, count) => count === 1 ? writeMemory(content) : { content: "The preference was retained." }, () => "blocked");
    const first = await f.run(["ask", "Save this preference and keep the task open", "--json"]);
    expect(first.code).toBe(1);
    const session = JSON.parse(first.stdout).session_id;
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    const service = await startWorkspaceService(f);
    try {
      const bootstrap = await (await fetch(`${service.url}/v1/definition`, { headers: service.headers })).json() as any;
      const basis = { version: "omos.workspace-api/v1", workspace: service.ready.workspace, definition_hash: bootstrap.definition.basis.definition_hash, revision: bootstrap.revision };
      const directory = await (await service.post({ ...basis, action: "query", entity: "omos_task" })).json() as any;
      const revision = directory.data.records.find((row: any) => row.id === task.id).revision;
      const response = await service.post({ ...basis, revision, task: task.id, action: "query", entity: "omos_evidence" });
      const raw = await response.text();
      expect(response.status, raw).toBe(200);
      expect(Buffer.byteLength(raw)).toBeLessThan(65536);
      const reference = JSON.parse(raw).data.records.find((row: any) => row.complete === false);
      expect(reference.source_path).toStartWith(`history/${task.id}/`);
      expect((await f.run(["ask", "--resume-id", session, "Keep the preference and add this authenticated detail", "--json"])).code).toBe(1);
      let original = "";
      let offset = 0;
      for (;;) {
        const page = await service.post({ ...basis, revision, task: task.id, action: "read", path: reference.source_path, offset, limit: 4096 });
        expect(page.status, await page.clone().text()).toBe(200);
        const data = (await page.json() as any).data;
        expect(data.encoding).toBe("utf8");
        expect(Buffer.byteLength(data.content)).toBeLessThanOrEqual(4096);
        original += data.content;
        if (data.next_offset === null) break;
        expect(data.next_offset).toBeGreaterThan(offset);
        offset = data.next_offset;
      }
      expect(createHash("sha256").update(original).digest("hex")).toBe(reference.sha256);
      expect(JSON.parse(original).value[0].arguments).toContain(content);
    } finally {
      service.child.kill();
      await service.child.exited;
    }
  }, 90000);

  test("recovers an expired server review lease and retains evidence inspection without actor replay", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let phase: "initial" | "interrupt" | "resume" = "initial";
    let held = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const m = model(f, () => ({ content: "An answer with retained inspection progress." }), async packet => {
      if (phase === "initial") return { name: "omos_contract_assessment", args: { contractId: packet.contract.id, version: packet.contract.version, obligations: [{ id: "request_complete", status: "met", evidence: ["invented"], note: "Fixture retains candidate" }] } };
      if (phase === "interrupt") {
        const candidate = packet.evidence.find((record: any) => record.kind === "candidate");
        if (!packet.currentInspections.some((page: any) => page.id === candidate.id)) return { name: "omos_review_evidence", args: { action: "read", id: candidate.id } };
        held = true;
        await gate;
      }
      return "met";
    });
    expect((await f.run(["ask", "Give a short informational answer", "--json"])).code).toBe(1);
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    const actors = m.counts().actors;
    phase = "interrupt";
    let service = await startWorkspaceService(f, true);
    let jobId = "";
    let basis: any;
    try {
      const bootstrap = await (await fetch(`${service.url}/v1/definition`, { headers: service.headers })).json() as any;
      basis = { version: "omos.workspace-api/v1", workspace: service.ready.workspace, definition_hash: bootstrap.definition.basis.definition_hash, revision: bootstrap.revision };
      const directory = await (await service.post({ ...basis, action: "query", entity: "omos_task" })).json() as any;
      const queued = await (await service.post({ ...basis, revision: directory.data.records.find((row: any) => row.id === task.id).revision, action: "queue_review", task: task.id })).json() as any;
      jobId = queued.data.id;
      const deadline = Date.now() + 15000;
      while (!held && Date.now() < deadline) await Bun.sleep(50);
      expect(held).toBe(true);
      service.child.kill("SIGKILL");
      await service.child.exited;
      const tree = join(f.home, "expired-review-lease");
      mkdirSync(tree);
      const fossil = (...args: string[]) => {
        const result = spawnSync("fossil", args, { cwd: tree, env: { PATH: process.env.PATH, HOME: f.home, FOSSIL_HOME: f.home, USER: "omos", LC_ALL: "C" }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      };
      fossil("open", "--nosync", join(f.cwd, "omos.fossil"), task.branch);
      const path = join(tree, "jobs", `${jobId}.json`);
      const job = JSON.parse(readFileSync(path, "utf8"));
      expect(job.generation).toBe(1);
      // Advance only the fixture's lease clock; no original effects are replayed.
      job.lease_expires_ms = 0;
      writeFileSync(path, JSON.stringify(job));
      fossil("commit", "--nosync", "--nosign", "--no-verify", "--no-warnings", "-m", "Expire fixture worker lease");
      phase = "resume";
      release!();
      service = await startWorkspaceService(f, true);
      let result: any;
      const resumedDeadline = Date.now() + 30000;
      while (Date.now() < resumedDeadline) {
        const response = await service.post({ ...basis, action: "job", task: task.id, job: jobId });
        if (response.status === 409) continue;
        expect(response.status, await response.clone().text()).toBe(200);
        result = (await response.json() as any).data;
        if (["published", "failed", "pending", "changes_required"].includes(result.state)) break;
        await Bun.sleep(100);
      }
      expect(result).toMatchObject({ state: "published", generation: 2, review_attempts: 2 });
      expect(m.packets.at(-1).previousInspections.length).toBeGreaterThan(0);
      expect(m.counts().actors).toBe(actors);
    } finally {
      release!();
      service.child.kill();
      await service.child.exited;
    }
  }, 90000);

  test("upgrades future contracts with a verified backup while preserving active task bases", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const declaration = JSON.parse((await f.run(["fossil", "definition", "show", "--json"])).stdout).model_data.declaration;
    declaration.spec.operations = declaration.spec.operations.filter((o: any) => !o.id.startsWith("omos_"));
    declaration.spec.semantic.entityTypes = declaration.spec.semantic.entityTypes.filter((e: any) => !["omos_event", "omos_review_job"].includes(e.id));
    const tree = join(f.home, "legacy-contracts");
    mkdirSync(tree);
    const fossil = (...args: string[]) => {
      const result = spawnSync("fossil", args, { cwd: tree, env: { PATH: process.env.PATH, HOME: f.home, FOSSIL_HOME: f.home, USER: "omos", LC_ALL: "C" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    fossil("open", "--nosync", join(f.cwd, "omos.fossil"), "trunk");
    writeFileSync(join(tree, "omniform/company.json"), JSON.stringify(declaration));
    writeFileSync(join(tree, "execution/omos.json"), JSON.stringify({ version: "omos.execution/v1", defaults: { progress_interval: 4, stalled_checks: 3, max_actor_steps: 100 } }));
    fossil("commit", "--nosync", "--nosign", "--no-verify", "--no-warnings", "-m", "Retain legacy contract fixture");
    model(f, () => ({ content: "Retained legacy task." }), () => "blocked");
    expect((await f.run(["ask", "Keep this task open", "--json"])).code).toBe(1);
    const before = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(before.model_basis.execution.review.attempt_timeout_ms).toBe(60000);
    const upgraded = await f.run(["fossil", "migrate", "--contracts", "--json"], {}, 90000);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    const after = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(after.model_basis).toEqual(before.model_basis);
    expect(after.definition).toEqual(before.definition);
    const future = JSON.parse((await f.run(["fossil", "definition", "show", "--json"])).stdout).model_data;
    expect(future.declaration.spec.operations.some((o: any) => o.id === "omos_record_evidence")).toBe(true);
    expect(future.basis.execution.review.attempt_timeout_ms).toBe(300000);
    const backups = readdirSync(f.cwd).filter(path => path.includes(".pre-contracts-"));
    expect(backups).toHaveLength(1);
    expect((await f.run(["fossil", "migrate", "--contracts", "--json"])).code).toBe(0);
    expect(readdirSync(f.cwd).filter(path => path.includes(".pre-contracts-"))).toEqual(backups);
  }, 120000);

  test("verifies a retained answer on the server without replaying actor work", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let permit = false;
    const m = model(f, () => ({ content: "The retained answer can be reviewed independently." }), packet => permit ? "met" : {
      name: "omos_contract_assessment", args: { contractId: packet.contract.id, version: packet.contract.version, obligations: [{ id: "request_complete", status: "met", evidence: ["invented"], note: "Fixture forces retained review failure" }] },
    });
    const first = await f.run(["ask", "Give a short informational answer", "--json"]);
    expect(first.code).toBe(1);
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    const actorCount = m.counts().actors;
    permit = true;
    const service = await startWorkspaceService(f, true);
    try {
      const bootstrap = await (await fetch(`${service.url}/v1/definition`, { headers: service.headers })).json() as any;
      const basis = { version: "omos.workspace-api/v1", workspace: service.ready.workspace, definition_hash: bootstrap.definition.basis.definition_hash, revision: bootstrap.revision };
      const directoryResponse = await service.post({ ...basis, action: "query", entity: "omos_task" });
      expect(directoryResponse.status, await directoryResponse.clone().text()).toBe(200);
      const directory = await directoryResponse.json() as any;
      const selected = directory.data.records.find((row: any) => row.id === task.id);
      const queuedResponse = await service.post({ ...basis, revision: selected.revision, action: "queue_review", task: task.id });
      expect(queuedResponse.status, await queuedResponse.clone().text()).toBe(200);
      const queued = await queuedResponse.json() as any;
      expect(queued.data.state).toBe("queued");
      let completed: any;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const result = await service.post({ ...basis, action: "job", task: task.id, job: queued.data.id });
        if (result.status === 409) continue;
        expect(result.status, await result.clone().text()).toBe(200);
        completed = (await result.json() as any).data;
        if (["published", "failed", "changes_required", "blocked", "pending"].includes(completed.state)) break;
        await Bun.sleep(100);
      }
      expect(completed, existsSync(f.env.FX_TRACE_LOG) ? readFileSync(f.env.FX_TRACE_LOG, "utf8").slice(-4000) : "").toMatchObject({ state: "published", generation: 1 });
      expect(m.counts().actors).toBe(actorCount);
      expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0].state).toBe("accepted");
      expect(f.fossil("ls", "-r", "trunk")).toContain(`jobs/${queued.data.id}.json`);
      permit = false;
      expect((await f.run(["ask", "Give another short informational answer", "--json"])).code).toBe(1);
      const secondTask = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks.find((item: any) => item.id !== task.id);
      permit = true;
      const nextBootstrap = await (await fetch(`${service.url}/v1/definition`, { headers: service.headers })).json() as any;
      const nextBasis = { ...basis, revision: nextBootstrap.revision };
      const nextDirectory = await (await service.post({ ...nextBasis, action: "query", entity: "omos_task" })).json() as any;
      const nextQueued = await (await service.post({ ...nextBasis, revision: nextDirectory.data.records.find((row: any) => row.id === secondTask.id).revision, action: "queue_review", task: secondTask.id })).json() as any;
      let nextResult: any;
      const nextDeadline = Date.now() + 30000;
      while (Date.now() < nextDeadline) {
        const response = await service.post({ ...nextBasis, action: "job", task: secondTask.id, job: nextQueued.data.id });
        if (response.status === 409) continue;
        expect(response.status, await response.clone().text()).toBe(200);
        nextResult = (await response.json() as any).data;
        if (["published", "failed", "pending", "changes_required"].includes(nextResult.state)) break;
        await Bun.sleep(100);
      }
      expect(nextResult).toMatchObject({ state: "published", generation: 1 });
      expect(m.counts().actors).toBe(actorCount + 1);
    } finally {
      service.child.kill();
      await service.child.exited;
    }
  }, 60000);

  test("pauses exhausted verification without replaying the actor and resumes the retained answer", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    let permit = false;
    const m = model(f, () => ({ content: "Retained answer awaiting verification." }), () => permit ? "met" : {
      name: "omos_review_evidence", args: { action: "query", kind: "candidate" },
    });
    const first = await f.run(["ask", "Give a short informational answer", "--json"]);
    expect(first.code).toBe(1);
    expect(first.stderr, first.stdout).toContain("Verification is pending");
    expect(first.stderr).not.toContain("request failed: ContractReviewPending");
    const session = JSON.parse(first.stdout).session_id;
    const task = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0];
    expect(task.state).toBe("paused");
    expect(m.counts().actors).toBe(1);
    expect(m.counts().assessments).toBeLessThanOrEqual(16);
    permit = true;
    const resumed = await f.run(["ask", "--resume-id", session, "continue", "--json"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("Retained answer awaiting verification.");
    expect(m.counts().actors).toBe(1);
  }, 60000);

  test("queries evidence by producing action and audits its pinned contracts", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const m = model(f, (_body, count) => count === 1 ? writeMemory("Contract-linked evidence") : { content: "Saved the preference." }, packet => {
      if (!packet.currentInspections.some((page: any) => page.scope === "pinned_review_manifest")) return {
        name: "omos_review_evidence", args: { action: "query", tool: "fossil_workspace", status: "success" },
      };
      const records = packet.currentInspections.flatMap((page: any) => page.evidence ?? []);
      const record = records.find((item: any) => item.raw_call_id === "save-memory");
      expect(record).toBeDefined();
      return { name: "omos_contract_assessment", args: {
        contractId: packet.contract.id, version: packet.contract.version,
        obligations: packet.contract.obligations.map((o: any) => ({ id: o.id, status: "met", evidence: [record.id], note: "The host recorded the requested write and its producing action." })),
      } };
    });
    const result = await f.run(["ask", "Save the preference", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(m.counts().actors).toBe(2);
    const audit = await f.run(["fossil", "audit", "--json"]);
    expect(audit.code, audit.stderr).toBe(0);
    expect(JSON.parse(audit.stdout).model_data).toMatchObject({ valid: true, legacy_tasks: 0 });
    expect(JSON.parse(audit.stdout).model_data.checked_records).toBeGreaterThan(0);
    const status = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout);
    const branch = status.tasks[0].branch;
    const history = f.fossil("ls", "-r", branch).split("\n").filter(path => path.startsWith(`history/${status.tasks[0].id}/`));
    const action = history.map(path => JSON.parse(f.fossil("cat", path, "-r", branch))).find(row => row.kind === "action_intent");
    expect(action.definition_hash).toBe(status.tasks[0].model_basis.definition_hash);
  }, 60000);

  test("serves authenticated workspace queries and rejects cross-workspace and stale contracts", async () => {
    const f = fixture();
    expect((await f.run(["fossil", "init"])).code).toBe(0);
    const token = "isolated-workspace-service-token-for-fixtures";
    const child = Bun.spawn([join(import.meta.dir, "../../zig-out/bin/fx"), "fossil", "serve", "0", "--json"], {
      cwd: f.cwd, env: { ...process.env, ...f.env, OMOS_WORKSPACE_TOKEN: token }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let output = "";
      const deadline = Date.now() + 15000;
      while (!output.includes("\n")) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => { throw new Error("Workspace service did not become ready"); })]);
        if (chunk.done) throw new Error(`Service exited: ${await new Response(child.stderr).text()}`);
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      const ready = JSON.parse(output.trim().split("\n")[0]);
      const url = `http://127.0.0.1:${ready.port}`;
      expect((await fetch(`${url}/v1/definition`)).status).toBe(401);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const bootstrap = await (await fetch(`${url}/v1/definition`, { headers })).json() as any;
      const request = { version: "omos.workspace-api/v1", workspace: ready.workspace, definition_hash: bootstrap.definition.basis.definition_hash, revision: bootstrap.revision, action: "query" };
      const post = (body: object) => fetch(`${url}/v1/workspace`, { method: "POST", headers, body: JSON.stringify(body) });
      const queried = await post(request);
      expect(queried.status, await queried.clone().text()).toBe(200);
      expect((await queried.json() as any).workspace).toBe(ready.workspace);
      expect((await post({ ...request, workspace: "another-workspace" })).status).toBe(403);
      expect((await post({ ...request, definition_hash: "stale" })).status).toBe(409);
      expect((await post({ ...request, revision: "stale" })).status).toBe(409);
      expect((await post({ ...request, action: "record" })).status).toBe(403);
      expect((await fetch(`${url}/v1/definition`, { headers: { ...headers, origin: "https://example.com" } })).status).toBe(401);
      const client = fixture();
      const remote = await client.run(["fossil", "remote", url, "--json"], { OMOS_WORKSPACE_TOKEN: token });
      expect(remote.code, remote.stderr).toBe(0);
      expect(JSON.parse(remote.stdout).model_data.workspace).toBe(ready.workspace);
      expect(existsSync(join(client.cwd, "omos.fossil"))).toBe(false);
    } catch (error) {
      child.kill();
      await child.exited;
      throw new Error(`${error instanceof Error ? error.stack : error}\n${await new Response(child.stderr).text()}\n${existsSync(f.env.FX_TRACE_LOG) ? readFileSync(f.env.FX_TRACE_LOG, "utf8").slice(-8000) : ""}`);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30000);

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
      { change(v) { v.spec.operations[0].input.properties.request = { type: ["string", "null"] }; }, valid: true },
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
    let resumed = await f.run(["ask", "--resume-id", session, "continue", "--json"], {}, 120000);
    const actorCount = m.counts().actors;
    for (let invocation = 0; resumed.code !== 0 && invocation < 3; invocation++) {
      expect(resumed.stderr).toContain("Verification is pending");
      expect(m.counts().actors).toBe(actorCount);
      resumed = await f.run(["ask", "--resume-id", session, "continue", "--json"], {}, 120000);
    }
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
      expect(result.stderr).toContain("Verification is pending");
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
