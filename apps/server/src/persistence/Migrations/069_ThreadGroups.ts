import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_groups (
      group_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Members can be threads on other environments, so a member is the pair and
  // nothing here references the thread tables. One group per thread, as with
  // browser tab groups: adding a thread to a group moves it out of its last one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_group_members (
      group_id TEXT NOT NULL REFERENCES thread_groups (group_id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS thread_group_members_by_group
    ON thread_group_members (group_id, added_at)
  `;
});
