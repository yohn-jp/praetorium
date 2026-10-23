/** Test-only stand-in for the workerd WorkerEntrypoint base class.
 * Authorization tests exercise the real broker methods and injected bindings.
 * Runtime import and RPC delivery must be covered by a separate workerd test.
 */
export class WorkerEntrypoint<Env> {
  protected readonly env: Env;
  constructor(_context: unknown, env: Env) {
    this.env = env;
  }
}
