import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { JobStore, LongJobManifest } from "../long/types.js";

/** Durable JSON manifest store for a single Node.js host. */
export class FileJobStore implements JobStore {
  constructor(private readonly directory: string) {
    if (!directory) throw new Error("FileJobStore requires an explicit directory.");
  }

  async load(jobId: string): Promise<LongJobManifest | undefined> {
    try {
      return JSON.parse(await readFile(this.path(jobId), "utf8")) as LongJobManifest;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async save(manifest: LongJobManifest): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(manifest.jobId);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async delete(jobId: string): Promise<void> {
    await unlink(this.path(jobId)).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }

  async acquireLease(jobId: string, owner: string, ttlMs: number): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    return this.withLeaseGuard(jobId, ttlMs, async () => {
      const current = await this.readLease(jobId);
      if (current && current.expiresAt > Date.now() && current.owner !== owner) return false;
      await writeFile(this.leasePath(jobId), JSON.stringify({ owner, expiresAt: Date.now() + ttlMs }), { mode: 0o600 });
      return true;
    });
  }

  async renewLease(jobId: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.withLeaseGuard(jobId, ttlMs, async () => {
      const current = await this.readLease(jobId);
      if (!current || current.owner !== owner || current.expiresAt <= Date.now()) return false;
      await writeFile(this.leasePath(jobId), JSON.stringify({ owner, expiresAt: Date.now() + ttlMs }), { mode: 0o600 });
      return true;
    });
  }

  async releaseLease(jobId: string, owner: string): Promise<void> {
    await this.withLeaseGuard(jobId, 30_000, async () => {
      const current = await this.readLease(jobId);
      if (current?.owner !== owner) return;
      await unlink(this.leasePath(jobId)).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    });
  }

  private path(jobId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("Invalid job identifier.");
    return join(this.directory, `${jobId}.json`);
  }

  private leasePath(jobId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("Invalid job identifier.");
    return join(this.directory, `${jobId}.lease`);
  }

  private leaseGuardPath(jobId: string): string {
    return `${this.leasePath(jobId)}.guard`;
  }

  private leaseGuardRecoveryPath(jobId: string): string {
    return `${this.leaseGuardPath(jobId)}.recovery`;
  }

  private async withLeaseGuard<T>(jobId: string, ttlMs: number, work: () => Promise<T>): Promise<T> {
    const path = this.leaseGuardPath(jobId);
    const recoveryPath = this.leaseGuardRecoveryPath(jobId);
    const token = randomUUID();
    const deadline = Date.now() + 5_000;
    const guardTtlMs = Math.max(5_000, Math.min(ttlMs, 30_000));
    while (true) {
      // A stale-guard reclaimer owns this marker. Waiting here prevents a new guard from being
      // installed in the unlink window and then accidentally removed by a second reclaimer.
      if (await readJson<{ token: string }>(recoveryPath)) {
        if (Date.now() >= deadline) throw new Error(`Timed out recovering lease guard for ${jobId}.`);
        await leaseGuardDelay();
        continue;
      }
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ token, expiresAt: Date.now() + guardTtlMs }));
        await handle.close();
        // Close the race in which recovery begins after the preflight check but before open().
        // Relinquish only our own guard; the recovery owner will then retry against a stable path.
        if (await readJson<{ token: string }>(recoveryPath)) {
          await unlinkOwnedGuard(path, token);
          await leaseGuardDelay();
          continue;
        }
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const guard = await readJson<{ token: string; expiresAt: number }>(path);
        if (guard && guard.expiresAt <= Date.now()) {
          const recoveryToken = randomUUID();
          let recoveryHandle;
          try {
            recoveryHandle = await open(recoveryPath, "wx", 0o600);
            await recoveryHandle.writeFile(JSON.stringify({ token: recoveryToken }));
          } catch (recoveryError) {
            await recoveryHandle?.close().catch(() => undefined);
            if (!isAlreadyExists(recoveryError)) throw recoveryError;
            await leaseGuardDelay();
            continue;
          }
          try {
            const current = await readJson<{ token: string; expiresAt: number }>(path);
            if (current?.token === guard.token && current.expiresAt <= Date.now()) {
              await unlink(path).catch((unlinkError: unknown) => {
                if (!isNotFound(unlinkError)) throw unlinkError;
              });
            }
          } finally {
            await recoveryHandle.close();
            await unlinkOwnedGuard(recoveryPath, recoveryToken);
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring lease guard for ${jobId}.`);
        await leaseGuardDelay();
      }
    }
    try {
      return await work();
    } finally {
      await unlinkOwnedGuard(path, token);
    }
  }

  private async readLease(jobId: string): Promise<{ owner: string; expiresAt: number } | undefined> {
    try {
      return JSON.parse(await readFile(this.leasePath(jobId), "utf8")) as { owner: string; expiresAt: number };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}

async function unlinkOwnedGuard(path: string, token: string): Promise<void> {
  const guard = await readJson<{ token: string }>(path);
  if (guard?.token !== token) return;
  await unlink(path).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}

function leaseGuardDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
