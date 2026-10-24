import { describe, expect, it } from "vitest";
import { renderInfrastructure } from "./infrastructure-view.js";
import type { ConsoleViewModel } from "./view-model.js";
import type { HostObservation, InfraServices } from "../infrastructure.js";

const absent: HostObservation = {
  id: "builder", role: "builder", observedAt: "2026-10-24T00:00:00.000Z",
  state: "unknown", freshness: "absent",
  cpu: { usedPercent: null },
  memory: { usedBytes: null, totalBytes: null },
  disk: { usedBytes: null, totalBytes: null },
  reasons: ["metrics_unavailable"],
};
const services: InfraServices = {schemaVersion:1,id:"builder",services:[]};
function model(mode: "desktop" | "mobile" = "desktop"): ConsoleViewModel {
  return {
    mode, section:"infrastructure", selectedHostId:"builder",
    hostDetail:{endpoint:"GET /v1/hosts/builder",status:200,code:null,value:absent},
    hostServices:{endpoint:"GET /v1/hosts/builder/services",status:200,code:null,value:services},
  } as ConsoleViewModel;
}

describe("infrastructure operator drill-down", () => {
  it.each(["desktop", "mobile"] as const)("refreshes the selected host without navigating to the host list (%s)", mode => {
    const html=renderInfrastructure(model(mode),mode==="mobile");
    expect(html).toContain('href="/infrastructure/hosts/builder?ui='+mode+'">Refresh status</a>');
    expect(html).toContain('href="/infrastructure?ui='+mode+'">← All hosts</a>');
  });

  it("never describes an unreachable host as actively collecting CPU metrics", () => {
    const html=renderInfrastructure(model());
    expect(html).toContain("Not collected");
    expect(html).not.toContain("Collecting baseline");
    expect(html).toContain("metrics_unavailable");
  });

  it("uses baseline wording only for a fresh baseline sample", () => {
    const host: HostObservation={...absent,freshness:"fresh",state:"healthy",
      reasons:["cpu_baseline_pending"]};
    const html=renderInfrastructure({...model(),hostDetail:{
      endpoint:"GET /v1/hosts/builder",status:200,code:null,value:host,
    }});
    expect(html).toContain("Collecting baseline");
  });
});
