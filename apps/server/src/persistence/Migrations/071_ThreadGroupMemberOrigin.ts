import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The agent thread that brought a member in, such as one that launched it in
  // another project. Like members, it can live on any environment.
  yield* sql`ALTER TABLE thread_group_members ADD COLUMN from_environment_id TEXT`;
  yield* sql`ALTER TABLE thread_group_members ADD COLUMN from_thread_id TEXT`;
});
