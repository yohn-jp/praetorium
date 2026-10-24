import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { SourceBuildDetailSchema } from "../../packages/contracts/dist/index.js";
import worker from "../../apps/admin/dist/worker.js";

const ADMIN = "https://admin.praetorium.test";
const GATEWAY = "https://praetorium.test";
const AUTH = "a".repeat(43);
const OPERATOR = "213253858";
const TOKEN = "c".repeat(48);
const NOW = () => new Date().toISOString();
const HOSTS = [
  { id: "management", role: "management", observedAt: NOW(), state: "healthy",
    freshness:"fresh", cpu:{usedPercent:17.3}, memory:{usedBytes:1000,totalBytes:4000},
    disk:{usedBytes:3000,totalBytes:8000}, reasons:[], schemaVersion:1 },
  { id: "runtime", role: "runtime", observedAt: NOW(), state: "degraded",
    freshness:"fresh", cpu:{usedPercent:80.3}, memory:{usedBytes:1000,totalBytes:4000},
    disk:{usedBytes:3000,totalBytes:8000}, reasons:["service_unavailable"], schemaVersion:1 },
  { id: "builder", role: "builder", observedAt: NOW(), state: "unavailable",
    freshness:"absent", cpu:{usedPercent:null}, memory:{usedBytes:null,totalBytes:null},
    disk:{usedBytes:null,totalBytes:null}, reasons:["metrics_unavailable"], schemaVersion:1 },
];
async function renderedTextContrast(page, selectors) {
  return page.evaluate(items => {
    const rgba = color => {
      const channels = color.match(/[\d.]+/gu)?.map(Number);
      if (!channels || channels.length < 3) return null;
      return [channels[0],channels[1],channels[2],channels.length > 3 ? channels[3] : 1];
    };
    const background = element => {
      const layers=[];
      for (let node=element;node;node=node.parentElement) {
        const layer=rgba(getComputedStyle(node).backgroundColor);
        if (layer && layer[3]>0) layers.push(layer);
      }
      let result=[255,255,255];
      for (let index=layers.length-1;index>=0;index--) {
        const [red,green,blue,alpha]=layers[index];
        result=[red*alpha+result[0]*(1-alpha),green*alpha+result[1]*(1-alpha),blue*alpha+result[2]*(1-alpha)];
      }
      return result;
    };
    const luminance=channels=>channels.map(channel=>channel/255).map(channel=>
      channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4)
      .reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
    const results=[];
    for (const selector of items) for (const element of document.querySelectorAll(selector)) {
      if (!element.getClientRects().length || !element.textContent.trim()) continue;
      const foreground=rgba(getComputedStyle(element).color);
      const canvas=background(element);
      if (!foreground) continue;
      const front=luminance(foreground.slice(0,3)),back=luminance(canvas);
      results.push({selector,text:element.textContent.trim().slice(0,80),ratio:Number(((Math.max(front,back)+.05)/(Math.min(front,back)+.05)).toFixed(2))});
    }
    return results;
  },selectors);
}
function fixture() {
  let buildState = "empty";
  let evidenceMode = "detailed";
  let retryAccepted = false;
  const jobId = "sr_00000000-0000-4000-a000-000000000001";
  const sourceDetail = () => SourceBuildDetailSchema.parse({
    job:{id:jobId,sourceId:"scriptorium",releaseId:101,tag:"v1.2.0",version:"1.2.0",commit:"b".repeat(40),
      state:buildState==="retryQueued"?"queued":buildState==="retryBuilding"?"building":buildState,attempt:buildState==="queued"?0:buildState==="failed"?2:buildState==="retryQueued"||buildState==="retryBuilding"||retryAccepted&&buildState==="admitted"?3:1,revision:buildState==="failed"?0:1,
      error:buildState==="failed"?"SOURCE_BUILD_FAILED":null,admittedReleaseId:buildState==="admitted"?"rel_owned":null,
      retryable:buildState==="failed"},
    attempts:[{id:"owned-failed-attempt",attempt:1,revision:0,leaseEpoch:1,state:"failed",stage:"buildkit",
      startedAt:1792820000000,finishedAt:1792820001000,failureCode:"SOURCE_BUILD_FAILED",evidence:"expired",expiresAt:null,diagnostic:null},
      ...(buildState==="failed"||retryAccepted?[{id:"owned-detailed-attempt-"+"a".repeat(128),attempt:2,revision:0,leaseEpoch:2,
        state:"failed",stage:"metadata",startedAt:1792820010000,finishedAt:1792820020000,
        failureCode:"SOURCE_BUILD_FAILED",evidence:evidenceMode === "detailed" || evidenceMode === "summary" || evidenceMode === "unavailable" ? "available" : evidenceMode,expiresAt:evidenceMode === "expired" ? 1790000000000 : 1795412020000,
        diagnostic:evidenceMode === "not_recorded" || evidenceMode === "expired" || evidenceMode === "unavailable" ? null : {stage:"metadata",reason:"build_failed",
          summary:"BuildKit reported a build failure. Inspect the sanitized excerpt when available.",
          excerpt:evidenceMode === "summary" ? "" : "git rev-parse HEAD failed",truncated:false}}]:[]),
      ...(buildState==="building"||buildState==="admitted"&&!retryAccepted?[{id:"owned-later-attempt",attempt:1,revision:1,leaseEpoch:2,
        state:buildState==="building"?"building":"produced",stage:buildState==="building"?"buildkit":"admission",
        startedAt:1792820010000,finishedAt:buildState==="building"?null:1792820020000,
        failureCode:null,evidence:"not_recorded",expiresAt:null,diagnostic:null}]:[]),
      ...(buildState==="retryBuilding"||retryAccepted&&buildState==="admitted"?[{id:"owned-retry-attempt",attempt:3,revision:1,leaseEpoch:3,state:buildState==="retryBuilding"?"building":"produced",stage:buildState==="retryBuilding"?"source_checkout":"admission",
        startedAt:1792820030000,finishedAt:null,failureCode:null,evidence:"not_recorded",expiresAt:null,diagnostic:null}]:[])],
    nextCursor:null,evidence:buildState==="failed"?evidenceMode === "summary" || evidenceMode === "detailed" || evidenceMode === "unavailable" ? "available" : evidenceMode : "expired",
  });
  const calls = { identity:0, control:0, observer:0 };
  const env = {
    ADMIN_ORIGIN: ADMIN, GATEWAY_ORIGIN: GATEWAY,
    ADMIN_CONTROL_PLANE_AUTH: TOKEN, ADMIN_OBSERVER_AUTH: "d".repeat(48),
    ADMIN_IDENTITY: {
      redeemAdminHandoff: async () => ({kind:"expired"}),
      verifyAdminSession: async id => {
        calls.identity++;
        return id === AUTH ? { actorId:OPERATOR, csrfToken:"signed-csrf-token" } : null;
      },
      revokeAdminSession: async () => true,
      listApprovedSourceReleases: async () => [],
      resolvePublishedRelease: async () => ({kind:"unavailable"}),
      revalidateRetrySource: async (_id, job) => ({kind:"matched",sourceId:job.sourceId,githubReleaseId:job.releaseId,
        sourceTag:job.tag,sourceRevision:job.commit,releaseVersion:job.version}),
    },
    CONTROL_PLANE: {fetch: async (input, init) => {
      calls.control++;
      const request = new Request(input, init);
      const url = new URL(request.url);
      const pathname = url.pathname;
      const method = request.method;
      if (method === "POST" && pathname === "/v1/operator/source-builds/"+jobId+"/retry") {
        const payload = await request.json();
        assert.equal(payload.sourceId,"scriptorium");
        assert.equal(payload.githubReleaseId,101);
        assert.equal(payload.sourceRevision,"b".repeat(40));
        assert.equal(payload.expectedRevision,0);
        buildState = "retryQueued";
        evidenceMode = "detailed";
        retryAccepted = true;
        return Response.json({accepted:true},{status:202});
      }
      if (buildState !== "empty" && pathname === "/v1/operator/source-builds/"+jobId)
        return Response.json(sourceDetail());
      if (buildState !== "empty" && pathname === "/v1/operator/source-builds")
        return Response.json({items:[sourceDetail().job],nextCursor:null});
      if (pathname === "/v1/operator/releases/rel_owned")
        return Response.json({release:{id:"rel_owned",version:"1.2.0",imageDigest:"sha256:"+"c".repeat(64),status:"available"},
          workflow:{state:"stable",revision:4,failureCode:null,attempts:2,nextAttemptAt:null,
            canaryBuildKey:"composition-owned",canaryOperationId:"op_owned"},
          build:{id:"composition-owned",status:"available",attemptCount:1,failure:null}});
      if (pathname === "/v1/operations/op_owned/evidence")
        return Response.json({operation:{id:"op_owned",instanceId:"runtime-owned",generation:2,runtimeEpoch:5,
          kind:"deploy",status:"succeeded",phase:"stable",attempt:1,createdAt:1792820000000,updatedAt:1792820001000},
          readinessEvidence:{ready:true},rollbackCompatibilityEvidence:null,rollbackCompatible:true});
      if (pathname === "/v1/operator/releases")
        return Response.json(buildState === "admitted"
          ? {items:[{release:{id:"rel_owned",version:"1.2.0",imageDigest:"sha256:"+"c".repeat(64),
              status:"available",createdAt:"2026-10-24T00:00:00.000Z"},workflow:null}],stableChannel:{currentReleaseId:"rel_owned",revision:4}}
          : {items:[],stableChannel:{currentReleaseId:null,revision:0}});
      return Response.json({items:[],stableChannel:{currentReleaseId:null,revision:0}});
    }},
    INFRASTRUCTURE: {fetch: async (input, init) => {
      calls.observer++;
      const request = new Request(input, init);
      assert.equal(request.headers.get("Authorization"), "Bearer " + "d".repeat(48));
      const url = new URL(request.url);
      const id = url.pathname.split("/")[3];
      if (url.pathname === "/v1/hosts")
        return Response.json({schemaVersion:1,hosts:HOSTS.map(h=>({...h,observedAt:NOW()}))});
      if (url.pathname === "/v1/dependencies")
        return Response.json({schemaVersion:1,targets:HOSTS.map(h=>({id:h.id,role:h.role,services:[]}))});
      if (url.pathname.endsWith("/services"))
        return Response.json({schemaVersion:1,id,services:[{id:"k3s",state:"healthy",observedAt:NOW()}]});
      const h=HOSTS.find(x=>x.id===id);
      return h?Response.json({...h,observedAt:NOW()}):
        Response.json({error:"not_found"},{status:404});
    }},
  };
  return {env,calls,setBuildState:(value,evidence="detailed")=>{buildState=value;evidenceMode=evidence;if(value==="failed")retryAccepted=false;},jobId};
}
async function listen(env) {
  const server = createServer(async (req,res) => {
    try {
      const chunks=[];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [k,v] of Object.entries(req.headers)) {
        if (typeof v==="string") headers.set(k,v);
        else if (Array.isArray(v)) headers.set(k,v.join(","));
      }
      // Browser fixture models an already-authorized HTTPS Admin session.
      // Real host-only Secure cookies are exercised by the Worker/session tests.
      headers.set("Origin",ADMIN);
      headers.set("Cookie","__Host-praetorium_session="+AUTH+"; __Host-praetorium_csrf=signed-csrf-token");
      const method=req.method??"GET";
      const request = new Request(ADMIN+(req.url??"/"),{
        method,headers,...(method==="GET"||method==="HEAD"?{}:{body:Buffer.concat(chunks)}),
      });
      const response = await worker.fetch(request,env);
      res.writeHead(response.status,Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){
      res.writeHead(500);res.end(String(error));
    }
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();
  assert.equal(typeof address,"object");
  return {server,origin:"http://127.0.0.1:"+address.port};
}
test("dedicated Admin Worker protects host telemetry and renders distinct responsive UI", async t=>{
  const {env,calls,setBuildState,jobId}=fixture();
  const noAuth=await worker.fetch(new Request(ADMIN+"/api/admin/v1/infrastructure/hosts"),env);
  assert.equal(noAuth.status,403);
  assert.equal(calls.observer,0);
  const unrelated=await worker.fetch(new Request(GATEWAY+"/infrastructure"),env);
  assert.equal(unrelated.status,404);
  const hostHeaders={Cookie:"__Host-praetorium_session="+AUTH};
  const authorized=await worker.fetch(new Request(ADMIN+"/api/admin/v1/infrastructure/hosts",{headers:hostHeaders}),env);
  assert.equal(authorized.status,200);
  const data=await authorized.json();
  assert.equal(data.hosts.length,3);
  assert.equal(data.hosts.find(x=>x.id==="builder").state,"unknown");
  const dataMissing={...env,INFRASTRUCTURE:undefined};
  const missing=await worker.fetch(new Request(ADMIN+"/api/admin/v1/infrastructure/hosts",{headers:hostHeaders}),dataMissing);
  assert.equal(missing.status,503);
  assert.equal((await missing.json()).error.code,"OBSERVER_NOT_CONFIGURED");

  const {server,origin}=await listen(env);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browserEnv = process.env.PRAETORIUM_UI_CHROMIUM_ENV
    ? JSON.parse(await readFile(process.env.PRAETORIUM_UI_CHROMIUM_ENV, "utf8")) : null;
  const browser=await chromium.launch({headless:true,
    ...(browserEnv ? { executablePath: browserEnv.executablePath, env: { ...process.env, LD_LIBRARY_PATH: browserEnv.LD_LIBRARY_PATH } } : {}),
    args:["--no-sandbox","--disable-background-networking"]});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  const page=await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const errors=[];
  page.on("pageerror",error=>errors.push(String(error)));
  for (const [mode,width] of [["mobile",320],["mobile",375],["mobile",390],["mobile",430],["desktop",1440],["desktop",1920],["desktop",640]]) {
    await page.setViewportSize({width,height:950});
    const response=await page.goto(origin+"/infrastructure?ui="+mode,{waitUntil:"networkidle"});
    assert.equal(response.status(),200);
    await page.getByRole("heading",{name:"Infrastructure"}).waitFor();
    assert.equal(await page.locator(".infra-host-card").count(),3);
    assert.ok(await page.getByText("builder").count()>=1);
    assert.ok(await page.getByText("unavailable",{exact:false}).count()>=1);
    const dimensions=await page.evaluate(()=>({
      viewport:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth,
      nav:document.querySelector('nav[aria-label="Operator sections"]')!==null,
      sidebar:document.querySelector(".desktop-operator-sidebar")!==null,
    }));
    assert.ok(dimensions.html<=width+1,mode+" overflow: "+JSON.stringify(dimensions));
    assert.ok(dimensions.body<=width+1,mode+" body overflow: "+JSON.stringify(dimensions));
    assert.equal(dimensions.nav,true);
    assert.equal(dimensions.sidebar,mode==="desktop");
    assert.ok((await page.locator("main").innerText()).includes("Existing runtimes may remain available"));
    if (process.env.PRAETORIUM_UI_EVIDENCE_DIR) {
      await mkdir(process.env.PRAETORIUM_UI_EVIDENCE_DIR, {recursive:true});
      await page.screenshot({path:process.env.PRAETORIUM_UI_EVIDENCE_DIR+"/admin-"+mode+"-"+width+".png", fullPage:true});
    }
  }
  for (const mode of ["desktop", "mobile"]) {
    await page.goto(origin+"/?ui="+mode);
    const content = await page.locator("main").innerText();
    assert.ok(content.includes("No release promoted yet"));
    assert.ok(!content.includes("OPERATOR_UNAVAILABLE"), "canonical catalog and build fixture must validate");
    await page.getByRole("link",{name:mode==="desktop"?"Releases":"Releases",exact:true}).first().click();
  }
  // The refresh affordance must retain the selected host and must not claim
  // an unavailable metric is currently being collected.
  for (const [mode,width] of [["mobile",320],["desktop",1440]]) {
    await page.setViewportSize({width,height:950});
    await page.goto(origin+"/infrastructure/hosts/builder?ui="+mode,{waitUntil:"domcontentloaded"});
    const refresh=page.getByRole("link",{name:"Refresh status"});
    assert.equal(await refresh.getAttribute("href"),"/infrastructure/hosts/builder?ui="+mode);
    assert.equal(await page.getByText("Collecting baseline").count(),0);
    await refresh.click();
    assert.equal(new URL(page.url()).pathname,"/infrastructure/hosts/builder");
  }

  for (const mode of ["desktop","mobile"]) {
    const widths = mode === "desktop" ? [1440,1920] : [320,375,390,430];
    for (const width of widths) {
      await page.setViewportSize({width,height:900});
      for (const state of ["failed","queued","building","admitted"]) {
        setBuildState(state);
        await page.goto(origin+"/builds/"+jobId+"?ui="+mode);
        const text=await page.locator("main").innerText();
        assert.ok(text.includes("owned-failed-attempt"),"prior failure remains immutable history");
        assert.ok(text.toLowerCase().includes("expired"),"expired evidence is not a successful empty log");
        if(state==="failed") {
          assert.equal(await page.locator('input[name="expectedRevision"]').inputValue(),"0");
          assert.equal(await page.getByRole("button",{name:"Retry Source build",exact:true}).count(),1);
          await page.keyboard.press("Tab");
          const keyboardFocus=await page.evaluate(()=>({
            label:document.activeElement?.textContent?.trim(),
            outline:getComputedStyle(document.activeElement).outlineWidth,
          }));
          assert.match(keyboardFocus.label??"",/Skip to main content/i);
          assert.equal(keyboardFocus.outline,"3px","the keyboard focus indicator must be visible");
          const requiredOrder = mode === "desktop"
            ? ["AUTHORITATIVE CURRENT STATE","FAILURE DETAIL","Sanitized excerpt","SAFE NEXT ACTION","TECHNICAL IDENTIFIERS","Attempt history"]
            : ["failed","AFFECTED SOURCE","RECORDED FAILURE","Sanitized excerpt","Retry is permitted","TECHNICAL IDENTIFIERS","Attempt history"];
          const positions = requiredOrder.map(label=>text.indexOf(label));
          assert.ok(positions.every(position=>position>=0),mode+" failure detail missing: "+requiredOrder);
          assert.deepEqual(positions,[...positions].sort((left,right)=>left-right),mode+" failure detail order");
          assert.match(text,/metadata/iu,"the recorded stage is shown");
          assert.match(text,/build failed/iu,"the recorded reason is shown");
          assert.ok(text.includes("may not identify the root cause"),"a failure summary must not be presented as a diagnosis");
          const contrastSelectors=mode==="desktop"
            ? [".desktop-context-label",".desktop-eyebrow",".desktop-muted",".desktop-section-intro",".desktop-facts dt",".desktop-job-heading>div>code"]
            : [".admin-kicker",".admin-mobile-detail-heading p:not(.admin-mobile-source-name)",".admin-mobile-detail-facts dt",".admin-mobile-evidence-state",".admin-mobile-tabs a:not([aria-current])",".admin-mobile-footer"];
          const contrast=await renderedTextContrast(page,contrastSelectors);
          assert.ok(contrast.length>0,mode+" contrast audit must inspect rendered operator labels");
          assert.deepEqual(contrast.filter(item=>item.ratio<4.5),[],mode+" rendered text contrast must meet 4.5:1: "+JSON.stringify(contrast));
          if(mode==="mobile") {
            const recoveryFlow=await page.evaluate(()=>({
              position:getComputedStyle(document.querySelector(".admin-mobile-action-region")).position,
              actionTop:document.querySelector(".admin-mobile-action-region").getBoundingClientRect().top,
              evidenceBottom:document.querySelector(".admin-mobile-failure-detail").getBoundingClientRect().bottom,
            }));
            assert.equal(recoveryFlow.position,"static","retry action stays in the document flow on build detail");
            assert.ok(recoveryFlow.actionTop>=recoveryFlow.evidenceBottom,"retry action follows the failure evidence");
          }
          const identifier = await page.evaluate(()=>{
            const candidate=document.querySelector(".desktop-job-facts .desktop-fact-wide dd,.admin-mobile-detail-facts>div:first-child dd");
            const attempt=document.querySelector(".desktop-attempt-id code,.admin-mobile-attempt-heading>code");
            return candidate && attempt
              ? candidate.scrollWidth<=candidate.clientWidth+1 && attempt.scrollWidth<=attempt.clientWidth+1
              : false;
          });
          assert.equal(identifier,true,"long immutable identifiers must fit or wrap within the detail field");
          const dimensions=await page.evaluate(()=>({
            document:document.documentElement.scrollWidth,
            viewport:innerWidth,
            excerpts:[...document.querySelectorAll(".desktop-diagnostic pre,.admin-mobile-diagnostic pre")]
              .every(pre=>pre.scrollWidth<=pre.clientWidth+1),
          }));
          assert.ok(dimensions.document<=width+1,mode+" failure-detail horizontal overflow: "+JSON.stringify(dimensions));
          assert.equal(dimensions.excerpts,true,"diagnostic excerpts must fit their detail surface");
        } else assert.equal(await page.getByRole("button",{name:"Retry Source build",exact:true}).count(),0);
        if(process.env.PRAETORIUM_UI_EVIDENCE_DIR && state==="failed") {
          await mkdir(process.env.PRAETORIUM_UI_EVIDENCE_DIR, {recursive:true});
          await page.screenshot({path:process.env.PRAETORIUM_UI_EVIDENCE_DIR+"/admin-"+mode+"-source-"+state+"-"+width+".png",fullPage:true});
        }
      }
    }
  }
  for (const mode of ["desktop","mobile"]) {
    const width=mode==="desktop"?1440:320;
    await page.setViewportSize({width,height:900});
    for (const [evidence,label] of [["summary","Summary only"],["not_recorded","was not recorded"],
      ["expired","expired"],["unavailable","details are unavailable"]]) {
      setBuildState("failed",evidence);
      await page.goto(origin+"/builds/"+jobId+"?ui="+mode);
      const text=await page.locator("main").innerText();
      assert.ok(text.includes(label),mode+" must explain "+evidence+" diagnostic evidence");
      assert.match(text,/root cause/iu,mode+" must avoid claiming that a summary establishes the root cause");
      if(evidence==="summary") {
        assert.ok(text.includes("No detailed diagnostic excerpt was recorded."));
        assert.ok(!text.includes("View sanitized diagnostic excerpt"));
      }
    }
  }
  // Exercise the guarded Source retry from the rendered failure page, then
  // follow the new attempt into canonical Admission, Composition, Operation,
  // and Stable read models. The fixture validates the submitted identity and
  // revision; separate BuildKit/Control Plane integration tests prove service behavior.
  for (const mode of ["desktop","mobile"]) {
    const width=mode==="desktop"?1440:320;
    await page.setViewportSize({width,height:900});
    setBuildState("failed");
    await page.goto(origin+"/builds/"+jobId+"?ui="+mode);
    await page.getByRole("button",{name:"Retry Source build",exact:true}).click();
    assert.match(page.url(),new RegExp("/builds/"+jobId),await page.locator("body").innerText());
    let journey=await page.locator("main").innerText();
    assert.ok(journey.includes("Source retry accepted"),page.url()+"\n"+journey);
    assert.ok(journey.toLowerCase().includes("queued"),journey);
    assert.match(journey,/current attempt/iu);
    assert.match(journey,/current attempt\s+3/iu,"accepted retry advances the authoritative attempt counter");
    assert.equal(await page.getByRole("button",{name:"Retry Source build",exact:true}).count(),0);

    setBuildState("retryBuilding");
    await page.reload({waitUntil:"networkidle"});
    journey=await page.locator("main").innerText();
    assert.ok(journey.includes("owned-retry-attempt"),"the worker claim must record the new attempt");
    assert.match(journey,/source checkout/iu);
    setBuildState("admitted");
    await page.reload({waitUntil:"networkidle"});
    journey=await page.locator("main").innerText();
    assert.match(journey,/admitted release/iu);
    assert.ok(journey.includes("owned-detailed-attempt"),"the failed attempt remains in history after admission");
    await page.locator('a[href="/releases/rel_owned?ui='+mode+'#composition-build"]').first().click();
    assert.equal(new URL(page.url()).pathname,"/releases/rel_owned");
    assert.equal(new URL(page.url()).hash,"#composition-build");
    assert.ok((await page.locator("main").innerText()).includes("composition-owned"));
    await page.getByRole("link",{name:"op_owned",exact:true}).click();
    journey=await page.locator("main").innerText();
    assert.match(journey,/succeeded/iu,journey);
    await page.getByRole("link",{name:"Back to related release rel_owned",exact:true}).click();
    await page.getByRole("link",{name:"Back to Releases",exact:true}).click();
    const stableLabelContrast=await renderedTextContrast(page,mode==="desktop"?[".desktop-stable-digest span"]:[".admin-mobile-stable-panel strong"]);
    assert.ok(stableLabelContrast.length>0,mode+" Stable status label must be audited");
    assert.deepEqual(stableLabelContrast.filter(item=>item.ratio<4.5),[],mode+" Stable status label contrast must meet 4.5:1");
    await page.getByRole("link",{name:/Open .*Stable release details/}).click();
    journey=await page.locator("main").innerText();
    assert.match(journey,/stable/iu);
    assert.ok(journey.includes("composition-owned"));
  }
  setBuildState("empty");
  // The first touch visit starts as Desktop by policy, then offers a
  // non-forcing Mobile preference backed by the normal cookie.
  const touch = await browser.newContext({
    viewport:{width:390,height:844}, hasTouch:true, isMobile:true,
  });
  t.after(()=>touch.close());
  const touchPage = await touch.newPage();
  await touchPage.goto(origin+"/infrastructure",{waitUntil:"networkidle"});
  assert.equal(await touchPage.locator("body").getAttribute("data-ui"),"desktop");
  assert.equal(await touchPage.locator(".mode-choice").isVisible(),true);
  await touchPage.getByRole("link",{name:"Use mobile layout"}).click();
  assert.equal(new URL(touchPage.url()).searchParams.get("ui"),"mobile");
  assert.equal(await touchPage.locator(".mode-choice").count(),0);
  await page.goto(origin+"/infrastructure/hosts/management?ui=desktop",{waitUntil:"domcontentloaded"});
  assert.ok(await page.getByText("k3s",{exact:true}).count()>=1);
  assert.deepEqual(errors,[]);
});
