import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
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
function fixture() {
  const calls = { identity:0, control:0, observer:0 };
  const env = {
    ADMIN_ORIGIN: ADMIN, GATEWAY_ORIGIN: GATEWAY,
    ADMIN_CONTROL_PLANE_AUTH: TOKEN, ADMIN_OBSERVER_AUTH: "d".repeat(48),
    ADMIN_IDENTITY: {
      redeemAdminHandoff: async () => ({kind:"expired"}),
      verifyAdminSession: async id => {
        calls.identity++;
        return id === AUTH ? { actorId:OPERATOR, csrfToken:"csrf-valid" } : null;
      },
      revokeAdminSession: async () => true,
      listApprovedSourceReleases: async () => [],
      resolvePublishedRelease: async () => ({kind:"unavailable"}),
      revalidateRetrySource: async () => ({kind:"unavailable"}),
    },
    CONTROL_PLANE: {fetch: async request => {
      calls.control++;
      const pathname = new URL(typeof request === "string" ? request : request.url).pathname;
      return Response.json(pathname === "/v1/operator/releases"
        ? {items:[],stableChannel:{currentReleaseId:null,revision:0}}
        : {items:[]});
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
  return {env,calls};
}
async function listen(env) {
  const server = createServer(async (req,res) => {
    try {
      const headers = new Headers();
      for (const [k,v] of Object.entries(req.headers)) {
        if (typeof v==="string") headers.set(k,v);
        else if (Array.isArray(v)) headers.set(k,v.join(","));
      }
      // Browser fixture models an already-authorized HTTPS Admin session.
      // Real host-only Secure cookies are exercised by the Worker/session tests.
      headers.set("Cookie","__Host-praetorium_session="+AUTH);
      const request = new Request(ADMIN+(req.url??"/"),{method:req.method??"GET",headers});
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
  const {env,calls}=fixture();
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
