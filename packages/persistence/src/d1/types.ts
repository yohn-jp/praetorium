export interface D1Result<T = unknown> {
  readonly results: readonly T[];
  readonly success?: boolean;
  readonly meta: { readonly changes: number; readonly last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]>;
}
