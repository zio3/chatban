// E2E用DBをサーバー起動前に削除する (playwright testの前段で実行)
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(resolve(here, `../../backend/e2e-test.db${suffix}`), { force: true });
}
