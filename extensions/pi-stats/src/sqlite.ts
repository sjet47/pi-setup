import Database from "better-sqlite3";

export const BUSY_TIMEOUT_MS = 5000;

export function configureDb(db: Database.Database): void {
	try {
		// WAL lets readers proceed while a writer commits, and shrinks the write
		// lock to a single autocommit transaction.
		db.pragma("journal_mode = WAL");
	} catch {
		// Read-only filesystems or network mounts may not support WAL; fall back
		// to the default journal mode. busy_timeout below still serializes
		// cross-process writers safely.
	}
	db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}
