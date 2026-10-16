function metricLabel(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/gu, "_").slice(0, 64) || "unknown";
}

/** Small in-process metrics surface; operation payloads and credentials stay out. */
export class ProvisionerMetrics {
  private readonly events = new Map<string, number>();
  private inFlight = 0;
  private ready = 0;

  increment(event: string, amount = 1): void {
    this.events.set(event, (this.events.get(event) ?? 0) + amount);
  }

  changeInFlight(delta: number): void {
    this.inFlight = Math.max(0, this.inFlight + delta);
  }

  setReady(value: boolean): void {
    this.ready = value ? 1 : 0;
  }

  renderPrometheus(): string {
    const lines = [
      "# HELP praetorium_provisioner_ready Whether the provisioner can reach the operation service.",
      "# TYPE praetorium_provisioner_ready gauge",
      `praetorium_provisioner_ready ${this.ready}`,
      "# HELP praetorium_provisioner_operations_in_flight Current operation count.",
      "# TYPE praetorium_provisioner_operations_in_flight gauge",
      `praetorium_provisioner_operations_in_flight ${this.inFlight}`,
      "# HELP praetorium_provisioner_events_total Provisioner event count.",
      "# TYPE praetorium_provisioner_events_total counter",
    ];
    for (const [event, count] of [...this.events].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`praetorium_provisioner_events_total{event="${metricLabel(event)}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
