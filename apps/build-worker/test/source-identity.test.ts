import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertSourceIdentityOutput, sourceIdentityVerifier, type VerifiedSourceIdentity } from "../src/source-identity.js";

it("binds generated metadata to the verified revision and tree, rejecting changed source", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"praetorium-identity-"));
  try {
    const git=(...args:string[])=>{
      const result=spawnSync("git",args,{cwd:root,encoding:"utf8"});
      if(result.status!==0)throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init","--quiet");
    await writeFile(path.join(root,"source.txt"),"verified source\n");
    git("add","source.txt");
    git("-c","user.name=Identity test","-c","user.email=test@example.invalid","commit","--quiet","-m","fixture");
    const input=path.join(root,".git","input");
    const output=path.join(root,".git","output");
    await mkdir(input);await mkdir(output);
    const identity:VerifiedSourceIdentity={schemaVersion:1,githubReleaseId:123,
      sourceRepository:"yohn-jp/scriptorium",sourceTag:"v0.3.7",
      sourceRevision:git("rev-parse","HEAD"),sourceTree:git("rev-parse","HEAD^{tree}")};
    await writeFile(path.join(input,"identity.json"),JSON.stringify(identity));
    const script=path.join(input,"verify.mjs");
    await writeFile(script,sourceIdentityVerifier
      .replace("PATH: '/usr/local/bin:/usr/bin:/bin'","PATH: "+JSON.stringify(process.env.PATH))
      .replaceAll("/tmp/praetorium-source-input",input)
      .replaceAll("/tmp/praetorium-source-proof",output));
    const run=()=>spawnSync(process.execPath,[script,"export"],{cwd:root,encoding:"utf8"});
    expect(run().status).toBe(0);
    const generated:unknown=JSON.parse(await readFile(path.join(output,"source-identity.json"),"utf8"));
    expect(()=>assertSourceIdentityOutput(identity,generated)).not.toThrow();
    for(const changed of [{...identity,sourceRevision:"a".repeat(40)},
      {...identity,sourceTree:"b".repeat(40)}]){
      await writeFile(path.join(input,"identity.json"),JSON.stringify(changed));
      expect(run().stderr).toContain("Source identity verification failed");
    }
    await writeFile(path.join(input,"identity.json"),JSON.stringify(identity));
    await writeFile(path.join(root,"source.txt"),"modified source\n");
    expect(run().status).not.toBe(0);
    git("checkout","--","source.txt");
    await writeFile(path.join(root,"untracked.txt"),"unexpected source\n");
    expect(run().status).not.toBe(0);
    for(const changed of [{...identity,githubReleaseId:456},{...identity,sourceTag:"v0.3.8"},
      {...identity,sourceTree:"c".repeat(40)},{...identity,extra:true},{}])
      expect(()=>assertSourceIdentityOutput(identity,changed)).toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});
