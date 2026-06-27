import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/**
 * Vitest global setup. Pushes the Prisma schema to a throwaway SQLite database
 * (prisma/test.db, the same DATABASE_URL the test workers use via
 * vitest.config `test.env`) so unit tests need no external services. Runs once
 * before the suite.
 *
 * We delete any previous DB file first so `db push` is purely additive (it just
 * creates the schema). That deliberately avoids `--force-reset`, whose
 * destructive reset is blocked by Prisma when it runs under an AI agent — and
 * keeps this setup portable to any CI. Prisma resolves the relative `file:` URL
 * against the schema directory, so the DB lives at prisma/test.db.
 */
const TEST_DATABASE_URL = 'file:./test.db';

export default function setup(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`prisma/test.db${suffix}`, { force: true });
  }
  execSync('npx prisma db push --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
