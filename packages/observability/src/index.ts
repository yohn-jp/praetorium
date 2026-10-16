export const packageBoundary = "observability" as const;

export interface ObservabilitySink {
  record(event: string): void;
}
