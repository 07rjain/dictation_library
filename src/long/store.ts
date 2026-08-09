import type { JobStore, LongJobManifest } from "./types.js";

export class MemoryJobStore implements JobStore {
  private readonly manifests = new Map<string, LongJobManifest>();

  async load(jobId: string): Promise<LongJobManifest | undefined> {
    const manifest = this.manifests.get(jobId);
    return manifest ? structuredClone(manifest) : undefined;
  }

  async save(manifest: LongJobManifest): Promise<void> {
    this.manifests.set(manifest.jobId, structuredClone(manifest));
  }

  async delete(jobId: string): Promise<void> {
    this.manifests.delete(jobId);
  }
}
