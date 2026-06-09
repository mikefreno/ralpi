import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory for test files.
 * Returns the path and a cleanup function.
 */
export function tempDir(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralpi-test-"));
	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * Write content to a temp markdown file and return its path.
 */
export function writeTaskFile(
	dir: string,
	name: string,
	content: string,
): string {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}
