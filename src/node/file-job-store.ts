import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

  private path(jobId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("Invalid job identifier.");
    return join(this.directory, `${jobId}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
