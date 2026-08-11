import type { JobStore, LongJobManifest } from "./types.js";

export class MemoryJobStore implements JobStore {
  private readonly manifests = new Map<string, LongJobManifest>();
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();

  async load(jobId: string): Promise<LongJobManifest | undefined> {
    const manifest = this.manifests.get(jobId);
    return manifest ? structuredClone(manifest) : undefined;
  }

  async save(manifest: LongJobManifest): Promise<void> {
    this.manifests.set(manifest.jobId, structuredClone(manifest));
  }

  async delete(jobId: string): Promise<void> {
    this.manifests.delete(jobId);
    this.leases.delete(jobId);
  }

  async acquireLease(jobId: string, owner: string, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(jobId);
    if (current && current.owner !== owner && current.expiresAt > Date.now()) return false;
    this.leases.set(jobId, { owner, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async renewLease(jobId: string, owner: string, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(jobId);
    if (!current || current.owner !== owner || current.expiresAt <= Date.now()) return false;
    current.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async releaseLease(jobId: string, owner: string): Promise<void> {
    if (this.leases.get(jobId)?.owner === owner) this.leases.delete(jobId);
  }
}
