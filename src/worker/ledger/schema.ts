// SQL DDL for the Ledger DO, applied by version number (PLAN.md §4.1). Never edit a shipped
// migration; append a new one.
export const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE txn (id TEXT PRIMARY KEY, agent TEXT NOT NULL, model TEXT, intent TEXT NOT NULL,
     criteria TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
     snapshot TEXT NOT NULL, snapshot_seq INTEGER NOT NULL, fork TEXT NOT NULL, head TEXT,
     train TEXT, landed_seq INTEGER, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     submitted_at INTEGER, skips INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '{}', commit_sha TEXT);
   CREATE INDEX txn_state ON txn (state);
   CREATE TABLE access (txn TEXT NOT NULL, attempt INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
     at INTEGER NOT NULL, PRIMARY KEY (txn, attempt, path, kind));
   CREATE TABLE trunk (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, txn TEXT, at INTEGER NOT NULL);
   CREATE TABLE changed (seq INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (seq, path));
   CREATE TABLE op (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
     txn TEXT, agent TEXT, data TEXT NOT NULL DEFAULT '{}');
   CREATE INDEX op_txn ON op (txn);
   CREATE TABLE heat (path TEXT PRIMARY KEY, value REAL NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE verdict (txn TEXT NOT NULL, attempt INTEGER NOT NULL, question TEXT NOT NULL, value REAL NOT NULL,
     confidence REAL, detail TEXT, PRIMARY KEY (txn, attempt, question));
   CREATE TABLE evidence (txn TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL,
     summary TEXT NOT NULL, ref TEXT, PRIMARY KEY (txn, attempt, kind));
   CREATE TABLE lease (path TEXT PRIMARY KEY, txn TEXT NOT NULL, expires INTEGER NOT NULL);
   CREATE TABLE train (id TEXT PRIMARY KEY, base TEXT NOT NULL, base_seq INTEGER NOT NULL, txns TEXT NOT NULL,
     state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE txn_index (txn TEXT PRIMARY KEY, repo TEXT NOT NULL);`,
  // Speculative trains (PLAN.md §5.6): the train a train was built on, the candidate it reported after
  // prepare with the paths that candidate changes and the trunk seq it would have, and whether its
  // predecessor landed exactly its base.
  `ALTER TABLE train ADD COLUMN pred TEXT;
   ALTER TABLE train ADD COLUMN candidate TEXT;
   ALTER TABLE train ADD COLUMN candidate_paths TEXT;
   ALTER TABLE train ADD COLUMN candidate_seq INTEGER;
   ALTER TABLE train ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;`,
];

export function migrate(sql: SqlStorage): number {
  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0];
  let version = row?.version ?? 0;
  if (!row) sql.exec("INSERT INTO schema_version (version) VALUES (0)");
  while (version < MIGRATIONS.length) {
    sql.exec(MIGRATIONS[version]!);
    version++;
    sql.exec("UPDATE schema_version SET version = ?", version);
  }
  return version;
}
