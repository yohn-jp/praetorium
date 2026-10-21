import { describe, expect, it, vi } from "vitest";
import type { GitHubRestClient } from "@praetorium/github";
import {
  configuredReleaseSources, publishedReleases, fetchSelectedRelease, fetchSourceReleases,
  sourceReleaseCards, type RegisteredReleaseSource,
} from "../src/admin/release-sources.js";

const source: RegisteredReleaseSource = {
  id: "scriptorium", label: "Scriptorium",
  githubRepository: "yohn-jp/scriptorium",
  adapter: "scriptorium-v1",
};
const A = "a".repeat(40);
const B = "b".repeat(40);
const release = (overrides: Record<string, unknown> = {}) => ({
  id: 416422590, tag_name: "v0.2.1", name: "Scriptorium v0.2.1",
  body: "Verified\nRelease", draft: false, prerelease: false,
  published_at: "2026-10-18T11:55:54Z", ...overrides,
});

function fakeApi(routes: Record<string, unknown>): GitHubRestClient & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (path: string, token: string) => {
    expect(token).toBe("operator-oauth-token");
    if (!Object.hasOwn(routes,path)) throw new Error("Unexpected GitHub request: "+path);
    return { status: 200, headers: new Headers(), body: routes[path] };
  });
  return { request };
}

describe("trusted GitHub Release selection", () => {
  it("registers only bounded explicitly trusted source/workflow adapters", () => {
    expect(configuredReleaseSources(JSON.stringify([source]))).toEqual([source]);
    expect(configuredReleaseSources(undefined)).toEqual([]);
    for (const input of [
      "{broken", JSON.stringify([]), JSON.stringify([source,source]),
      JSON.stringify([{...source,workflowFile:"evil.yml"}]),
      JSON.stringify([{...source,githubRepository:"attacker/copy"}]),
      JSON.stringify([{...source, workflowRepository:"attacker/repo"}]),
      JSON.stringify([{...source, extra:"not-allowed"}]),
    ]) expect(() => configuredReleaseSources(input)).toThrow();
  });

  it("lists published releases only, preserving nonsemver evidence as non-deployable", () => {
    const list = publishedReleases([
      release({ draft:true,id:1,tag_name:"v0.1.0" }),
      release({ id:2,tag_name:"perf-wave1-git-2026-10-20",prerelease:true }),
      release(),
    ]);
    expect(list).toHaveLength(2);
    expect(list.find(x=>x.tag==="v0.2.1")?.version).toBe("0.2.1");
    expect(list.find(x=>x.id===2)?.version).toBeNull();
    expect(() => publishedReleases({unexpected:true})).toThrow();
    expect(() => publishedReleases(new Array(101).fill(release()))).toThrow();
  });

  it("escapes untrusted Release notes/title and excludes non-SemVer deployment", () => {
    const cards = sourceReleaseCards([{
      source, error:null,
      releases:publishedReleases([
        release({id:5,tag_name:"perf-wave1",name:"<script>alert(1)</script>",body:"<img src=x onerror=x>" }),
        release(),
      ]),
    }],"CSRF-NONCE");
    expect(cards).not.toContain("<script>");
    expect(cards).not.toContain("<img ");
    expect(cards).toContain("&lt;script&gt;");
    expect(cards).toContain("Not deployable");
    expect(cards.match(/action="\/source-releases\/deploy"/g)).toHaveLength(1);
    expect(cards).toContain('value="416422590"');
    expect(cards).toContain('name="csrfToken" value="CSRF-NONCE"');
  });

  it("re-fetches selected Release by numeric ID, validates published state, resolves annotated tag recursively", async () => {
    const client=fakeApi({
      "/repos/yohn-jp/scriptorium/releases/416422590":release(),
      "/repos/yohn-jp/scriptorium/git/ref/tags/v0.2.1":{object:{type:"tag",sha:A}},
      ["/repos/yohn-jp/scriptorium/git/tags/"+A]:{object:{type:"commit",sha:B}},
    });
    expect(await fetchSelectedRelease(source,416422590,client,"operator-oauth-token")).toMatchObject({
      release:{tag:"v0.2.1",version:"0.2.1"},commit:B,
    });
    expect(client.request.mock.calls.map(x=>x[0])).toEqual([
      "/repos/yohn-jp/scriptorium/releases/416422590",
      "/repos/yohn-jp/scriptorium/git/ref/tags/v0.2.1",
      "/repos/yohn-jp/scriptorium/git/tags/"+A,
    ]);
  });

  it("fails closed for draft, unknown, malformed, and non-semver published release", async () => {
    for (const value of [
      release({ draft: true }), release({tag_name:"random-commit"}),
      release({id:42}), release({published_at:null}), release({tag_name:"../evil"}),
    ]) {
      const client=fakeApi({"/repos/yohn-jp/scriptorium/releases/416422590":value});
      await expect(fetchSelectedRelease(source,416422590,client,"operator-oauth-token")).rejects.toThrow();
      expect(client.request).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects tag cycles and releases without a commit, never falling back to main", async () => {
    const client=fakeApi({
      "/repos/yohn-jp/scriptorium/git/ref/tags/v0.2.1":{object:{type:"tag",sha:A}},
      ["/repos/yohn-jp/scriptorium/git/tags/"+A]:{object:{type:"tag",sha:A}},
    });
    const { resolveTagCommit }=await import("../src/admin/release-sources.js");
    await expect(resolveTagCommit(source,"v0.2.1",client,"operator-oauth-token")).rejects.toThrow();
    await expect(resolveTagCommit(source,"../../malicious",client,"operator-oauth-token")).rejects.toThrow();
  });

  it("lists only GitHub Releases while showing durable Praetorium Build Worker progress", async () => {
    const client = fakeApi({
      "/repos/yohn-jp/scriptorium/releases?per_page=50": [release()],
    });
    const selected=await fetchSourceReleases(source,client,"operator-oauth-token");
    expect(selected.releases).toHaveLength(1);
    expect(client.request.mock.calls).toHaveLength(1);
    const html=sourceReleaseCards([{source,...selected,error:null}],"csrf",[{
      id:"sr_00000000-0000-4000-a000-000000000001",
      sourceId:"scriptorium",releaseId:416422590,tag:"v0.2.1",commit:A,
      version:"0.2.1",state:"building",attempt:1,error:null,admittedReleaseId:null,
    }]);
    expect(html).toContain("Build Worker: building");
    expect(html).not.toContain("/actions/");
  });
});
