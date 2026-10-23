import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The thread for talking about a whole group. It is an ordinary thread on
  // this environment; deleting it leaves the group, which starts a new one.
  yield* sql`ALTER TABLE thread_groups ADD COLUMN session_thread_id TEXT`;
});
