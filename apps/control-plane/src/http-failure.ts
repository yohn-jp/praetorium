/** Bounded provider diagnostics; never return SQL, credentials or raw messages. */
export function metadataFailureReason(error: unknown): "schema_missing" | "binding_invalid" | "constraint" | "query_limit" | "provider_unavailable" {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/expression tree is too large|too many SQL variables/iu.test(current.message)) return "query_limit";
    if (/no such (?:table|column)|has no column named/iu.test(current.message)) return "schema_missing";
    if (/D1_BIND_ERROR|wrong number of parameter|incorrect number of bindings/iu.test(current.message)) return "binding_invalid";
    if (/SQLITE_CONSTRAINT|constraint failed/iu.test(current.message)) return "constraint";
    current = current.cause;
  }
  return "provider_unavailable";
}
