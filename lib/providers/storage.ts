import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@/lib/env';

export type PutObjectInput = {
  key: string;
  body: Buffer | string;
  contentType?: string;
};

export interface StorageProvider {
  readonly name: string;
  put(input: PutObjectInput): Promise<{ key: string; sizeBytes: number }>;
  get(key: string): Promise<Buffer>;
  /** Time-limited access. Files are never publicly readable. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

/**
 * Local disk storage for development. Keys are hashed into a directory tree
 * and served only through the authorised /api/files route — never statically.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';

  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    const safe = createHash('sha256').update(key).digest('hex');
    return path.join(this.baseDir, safe.slice(0, 2), safe);
  }

  async put(input: PutObjectInput): Promise<{ key: string; sizeBytes: number }> {
    const filePath = this.resolve(input.key);
    await mkdir(path.dirname(filePath), { recursive: true });
    const buffer = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');
    await writeFile(filePath, buffer, { mode: 0o600 });
    return { key: input.key, sizeBytes: buffer.length };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    return `${env().APP_URL}/api/files?key=${encodeURIComponent(key)}&expires=${expires}`;
  }
}

/** S3 provider stub — implement with @aws-sdk/client-s3 when credentials exist. */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';

  constructor(
    private readonly bucket: string,
    private readonly region: string,
  ) {}

  async put(): Promise<{ key: string; sizeBytes: number }> {
    throw new Error(`S3 storage not wired for ${this.bucket}/${this.region} — see docs/INTEGRATIONS.md.`);
  }

  async get(): Promise<Buffer> {
    throw new Error('S3 storage not wired — see docs/INTEGRATIONS.md.');
  }

  async signedUrl(): Promise<string> {
    throw new Error('S3 storage not wired — see docs/INTEGRATIONS.md.');
  }
}

let cached: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (cached) return cached;
  const config = env();
  cached =
    config.STORAGE_PROVIDER === 's3' && config.S3_BUCKET && config.S3_REGION
      ? new S3StorageProvider(config.S3_BUCKET, config.S3_REGION)
      : new LocalStorageProvider(config.STORAGE_LOCAL_DIR);
  return cached;
}

export function setStorage(provider: StorageProvider | null): void {
  cached = provider;
}
