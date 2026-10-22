import { afterEach, expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { NativeClient } from "./workspace-ui-client.mjs";
import { cleanupFixtures, fixture, model, writeMemory } from "./fossil-workspace-helpers";

const clients: NativeClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  cleanupFixtures();
});

async function savedContract(f: ReturnType<typeof fixture>, assessment: Parameters<typeof model>[2] = () => "blocked") {
  expect((await f.run(["fossil", "init", "--json"])).code).toBe(0);
  const provider = model(f, (_body, count) => count === 1 ? writeMemory("Retain this contract's evidence.") : { content: "The work and evidence are retained." }, assessment);
  const first = await f.run(["ask", "Save a preference and keep the work contract available for continuation", "--json"]);
  expect(first.code, first.stderr).toBe(1);
  const snapshot = JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout);
  return { task: snapshot.tasks[0], provider, first };
}

function host(f: ReturnType<typeof fixture>) {
  const client = new NativeClient({ binary: resolve(import.meta.dir, "../../zig-out/bin/fx"), project: f.cwd, env: { ...process.env, ...f.env } });
  clients.push(client);
  return client;
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30000;
  let latest: T;
  do {
    latest = await read();
    if (matches(latest)) return latest;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw Error(`Scheduled state did not converge: ${JSON.stringify(latest!)}`);
}

test("CLI schedules share a revision-fenced calendar and survive workspace export", async () => {
  const f = fixture();
  const { task } = await savedContract(f);
  const invoke = async (...args: string[]) => {
    const result = await f.run(["schedule", ...args, "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    return JSON.parse(result.stdout);
  };
  const created = await invoke("add", task.id, "--at", "2099-10-23T09:00:00+01:00");
  const event = created.schedules[0];
  expect(event.task).toBe(task.id);
  expect(event.at_ms).toBe(Date.parse("2099-10-23T08:00:00Z"));
  expect(event.state).toBe("scheduled");
  expect(event.definition.obligations).toEqual(task.definition.obligations);
  expect((await f.run(["schedule", "add", task.id, "--at", "2099-10-24T09:00:00Z", "--json"])).code).toBe(1);
  const moved = await invoke("move", event.id, "--at", "2099-10-24T10:00:00Z", "--revision", created.revision);
  expect(moved.revision).not.toBe(created.revision);
  expect(moved.schedules[0].history.map((entry: any) => entry.kind)).toEqual(["created", "rescheduled"]);
  const stale = await f.run(["schedule", "cancel", event.id, "--revision", created.revision, "--json"]);
  expect(stale.code).toBe(1);
  expect(stale.stdout + stale.stderr).toContain("WorkspaceRevisionChanged");
  expect((await invoke("list", "--from", "2099-10-23T00:00:00Z", "--to", "2099-10-24T00:00:00Z")).schedules).toEqual([]);
  const native = host(f);
  const calendar = await native.request("schedule", { action: "show", id: event.id });
  expect(calendar.schedules[0]).toEqual(moved.schedules[0]);
  await expect(native.request("schedule", { action: "cancel", id: event.id })).rejects.toThrow("WorkspaceRevisionRequired");
  const cancelled = await native.request("schedule", { action: "cancel", id: event.id, revision: moved.revision });
  expect(cancelled.schedules[0].state).toBe("cancelled");
  await native.close(); clients.splice(clients.indexOf(native), 1);
  const archive = join(f.home, "portable-schedules.fossil");
  expect((await f.run(["fossil", "export", archive, "--json"])).code).toBe(0);
  expect((await f.run(["fossil", "use", archive, "--json"])).code).toBe(0);
  expect((await invoke("show", event.id)).schedules[0].state).toBe("cancelled");
  expect(JSON.parse((await f.run(["fossil", "tasks", "--json"])).stdout).tasks[0].state).not.toBe("accepted");
}, 120000);

test("workspace host starts an overdue contract once and publishes retained work", async () => {
  const f = fixture();
  let resume = false;
  const { task, provider, first } = await savedContract(f, () => resume ? "met" : {
    name: "omos_review_evidence", args: { action: "query", kind: "candidate" },
  });
  expect(first.stderr, first.stdout).toContain("Verification is pending");
  const actors = provider.counts().actors;
  const created = await f.run(["schedule", "add", task.id, "--at", "2020-01-01T09:00:00Z", "--json"]);
  expect(created.code, created.stderr).toBe(0);
  const schedule = JSON.parse(created.stdout).schedules[0];
  expect(schedule.state).toBe("overdue");
  resume = true;
  const native = host(f);
  const final: any = await until(() => native.request("schedule", { action: "show", id: schedule.id }), (snapshot: any) => snapshot.schedules[0]?.finished_ms != null && ["completed", "failed", "waiting"].includes(snapshot.schedules[0]?.state));
  expect(final.schedules[0].state, final.schedules[0].reason + native.stderr).toBe("completed");
  expect(final.schedules[0].task_state).toBe("accepted");
  expect(final.schedules[0].started_ms).toBeGreaterThan(schedule.at_ms);
  expect(final.schedules[0].finished_ms).toBeGreaterThanOrEqual(final.schedules[0].started_ms);
  expect(final.schedules[0].history.filter((event: any) => event.kind === "running")).toHaveLength(1);
  expect(provider.counts().actors).toBe(actors);
  await native.close(); clients.splice(clients.indexOf(native), 1);
  const restarted = host(f);
  const persisted = await restarted.request("schedule", { action: "show", id: schedule.id });
  expect(persisted.schedules[0].state).toBe("completed");
  expect(persisted.schedules[0].history.filter((event: any) => event.kind === "running")).toHaveLength(1);
}, 120000);

test("schedule CLI rejects ambiguous and out-of-range dates before creating durable events", async () => {
  const f = fixture();
  expect((await f.run(["fossil", "init", "--json"])).code).toBe(0);
  for (const at of ["2026-10-23T09:00:00", "2026-02-29T09:00:00Z", "2026-10-23T25:00:00Z", "1970-01-01T00:00:00+01:00", "9999-12-31T23:00:00-01:00"]) {
    const result = await f.run(["schedule", "add", "missing-task", "--at", at, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("InvalidScheduleTime");
  }
  const list = await f.run(["schedule", "list", "--json"]);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).schedules).toEqual([]);
}, 30000);
