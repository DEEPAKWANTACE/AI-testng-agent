import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Artifact bytes (screenshots, traces, logs). `Artifact.storageKey` is a relative key.
 *
 * - S3-compatible object storage when ARTIFACT_S3_BUCKET is set (production: the web app and
 *   workers run on different machines, so they need shared storage);
 * - otherwise the local filesystem under ARTIFACT_STORAGE_DIR (development, tests).
 */

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)*$/i;

function assertKey(key: string) {
  if (!KEY_PATTERN.test(key) || key.includes("..")) throw new Error("Invalid artifact key");
}

// ─── S3 backend ─────────────────────────────────────────────────────────────

type S3Config = { bucket: string; client: S3Client };
const globalForS3 = globalThis as unknown as { qaArtifactS3?: S3Config };

function s3(): S3Config | null {
  const bucket = process.env.ARTIFACT_S3_BUCKET;
  if (!bucket) return null;
  if (!globalForS3.qaArtifactS3 || globalForS3.qaArtifactS3.bucket !== bucket) {
    globalForS3.qaArtifactS3 = {
      bucket,
      client: new S3Client({
        endpoint: process.env.ARTIFACT_S3_ENDPOINT || undefined,
        region: process.env.ARTIFACT_S3_REGION || "auto",
        forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
        credentials:
          process.env.ARTIFACT_S3_ACCESS_KEY_ID && process.env.ARTIFACT_S3_SECRET_ACCESS_KEY
            ? { accessKeyId: process.env.ARTIFACT_S3_ACCESS_KEY_ID, secretAccessKey: process.env.ARTIFACT_S3_SECRET_ACCESS_KEY }
            : undefined,
      }),
    };
  }
  return globalForS3.qaArtifactS3;
}

// ─── Local backend ──────────────────────────────────────────────────────────

export function artifactRoot(): string {
  return path.resolve(process.env.ARTIFACT_STORAGE_DIR ?? path.join(process.cwd(), "storage", "artifacts"));
}

/** Maps a key to a path inside the local root, refusing anything that could escape it. */
export function artifactPath(key: string): string {
  assertKey(key);
  const root = artifactRoot();
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid artifact key");
  return full;
}

// ─── API ────────────────────────────────────────────────────────────────────

export async function writeArtifact(key: string, data: Buffer | string, contentType = "application/octet-stream"): Promise<number> {
  assertKey(key);
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  const remote = s3();
  if (remote) {
    // IfNoneMatch: never overwrite existing evidence.
    await remote.client.send(new PutObjectCommand({ Bucket: remote.bucket, Key: key, Body: buffer, ContentType: contentType, IfNoneMatch: "*" }));
    return buffer.length;
  }
  const file = artifactPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer, { flag: "wx" });
  return buffer.length;
}

export async function readArtifact(key: string): Promise<Buffer> {
  assertKey(key);
  const remote = s3();
  if (remote) {
    const object = await remote.client.send(new GetObjectCommand({ Bucket: remote.bucket, Key: key }));
    return Buffer.from(await object.Body!.transformToByteArray());
  }
  return readFile(artifactPath(key));
}

/** Removes all objects stored under a key prefix (e.g. a run's folder). */
export async function removeArtifactPrefix(prefix: string): Promise<void> {
  assertKey(prefix);
  const remote = s3();
  if (!remote) {
    await rm(artifactPath(prefix), { recursive: true, force: true });
    return;
  }
  let token: string | undefined;
  do {
    const page = await remote.client.send(new ListObjectsV2Command({ Bucket: remote.bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) await remote.client.send(new DeleteObjectsCommand({ Bucket: remote.bucket, Delete: { Objects: keys, Quiet: true } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}
