import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// Durable replacement for small security-critical profile files. The new
// contents reach disk before rename, and the directory rename is flushed
// before returning. A crash can leave only a uniquely named temporary file.
export function writeAtomicFile(path: string, contents: string | Buffer, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode });
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    chmodSync(path, mode);
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
