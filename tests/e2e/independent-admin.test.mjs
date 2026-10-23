import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
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
      const pathname = new URL(request.url).pathname;
      return Response.json(pathname === "/v1/operator/releases"
        ? {items:[],stableChannel:{currentReleaseId:null,revision:0}}
        : {items:[]});
    }},
    INFRASTRUCTURE: {fetch: async request => {
      calls.observer++;
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
  const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-background-networking"]});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  await context.addCookies([{name:"__Host-praetorium_session",value:AUTH,url:origin,secure:true,httpOnly:true}]);
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",error=>errors.push(String(error)));
  for (const [mode,width] of [["mobile",320],["mobile",390],["desktop",1440]]) {
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
  }
  await page.goto(origin+"/infrastructure/hosts/management?ui=desktop",{waitUntil:"domcontentloaded"});
  assert.ok(await page.getByText("k3s",{exact:true}).count()>=1);
  assert.deepEqual(errors,[]);
});
