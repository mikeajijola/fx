import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export class NativeClient extends EventEmitter {
  constructor({ binary, project, env = process.env }) {
    super();
    if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary))
      throw Error("Build omos and select its absolute repository binary.");
    this.pending = new Map();
    this.process = spawn(binary, ["ui-host", "--stdio"], {
      cwd: project,
      env: {
        ...env,

        FX_AUTO_UPGRADE: "0",
        FX_SOUND: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.process.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-4096);
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("protocol-error", Error("Native host emitted invalid JSON"));
        return;
      }
      if (message.version !== "omos.ui-host/v1") return;
      if (message.type === "event") {
        this.emit("event", message);
        return;
      }
      const call = this.pending.get(message.id);
      if (call) {
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        message.err
          ? call.reject(
              Object.assign(Error(message.err), { code: message.err }),
            )
          : call.resolve(message.result);
      }
    });
    this.process.on("error", (e) => this.fail(e));
    this.process.on("exit", (code, signal) =>
      this.fail(
        Error(`Native host exited (${signal || code}). ${this.stderr}`),
      ),
    );
  }
  request(method, params = {}, options = {}) {
    const id = options.id || randomUUID();
    return new Promise((resolve, reject) => {
      if (this.process.exitCode !== null)
        return reject(Error("Native host is unavailable"));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Native host request timed out"));
      }, options.timeout || 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(
        JSON.stringify({ version: "omos.ui-host/v1", id, method, params }) +
          "\n",
        (e) => {
          if (e) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(e);
          }
        },
      );
    });
  }
  fail(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("offline", error);
  }
  async close() {
    this.process.stdin.end();
    await new Promise((resolve) => {
      if (this.process.exitCode !== null) return resolve();
      this.process.once("exit", resolve);
      setTimeout(() => {
        this.process.kill("SIGTERM");
      }, 5000).unref();
    });
  }
}
