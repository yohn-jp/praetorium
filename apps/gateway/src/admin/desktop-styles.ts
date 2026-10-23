/** Forest and ivory desktop operator composition; state authority remains in the existing APIs. */
export const DESKTOP_ADMIN_STYLES = `
body:has(.desktop-operator-console){background:#f5f3eb;color:#18372e;--desktop-ink:#18372e;--desktop-forest:#194937;--desktop-forest-dark:#12382b;--desktop-muted:#64796d;--desktop-line:#d8ded4;--desktop-paper:#fffefa;--desktop-soft:#ecefe5}
body:has(.desktop-operator-console) .page-shell{padding:0;max-width:none;min-height:100vh}
.desktop-operator-console{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh;color:var(--desktop-ink)}
.desktop-operator-sidebar{position:sticky;top:0;display:flex;flex-direction:column;height:100vh;min-height:620px;padding:28px 18px 20px;background:var(--desktop-forest-dark);color:#f4f2e8}
.desktop-operator-brand{display:flex;align-items:center;gap:12px;padding:4px 10px 28px;color:#f4f2e8;text-decoration:none;font-size:16px;font-weight:720;letter-spacing:-.02em}
.desktop-operator-brand>span:first-child{display:grid;place-items:center;width:38px;height:38px;border:1px solid #648372;border-radius:9px;background:#214e3e;color:#f7f3e8;font-size:19px}
.desktop-operator-brand small{display:block;margin-top:4px;color:#b6c8bb;font-size:11px;font-weight:500;letter-spacing:.01em}
.desktop-operator-nav{display:grid;gap:6px}
.desktop-operator-nav a{display:flex;align-items:center;min-height:44px;padding:0 13px;border-radius:6px;color:#d3dfd4;text-decoration:none;font-size:13px;font-weight:560;transition:background-color .12s ease,color .12s ease}
.desktop-operator-nav a:hover{background:#284f3f;color:#fffdf5}
.desktop-operator-nav a[aria-current="page"]{background:#edf1e7;color:#173d30;font-weight:700}
.desktop-sidebar-footer{display:grid;gap:5px;margin-top:auto;padding:16px 10px 0;border-top:1px solid #41604e;color:#b5c6b9;font-size:10px;line-height:1.5}
.desktop-operator-main{min-width:0}
.desktop-notice-slot{position:fixed;z-index:20;top:88px;right:24px;width:min(420px,calc(100vw - 48px));pointer-events:none}
.desktop-notice{margin:0;padding:13px 16px;border:1px solid #c4d8c6;border-left:3px solid #2e7657;border-radius:4px;background:#f5fbf0;box-shadow:0 8px 22px rgba(24,55,46,.13);color:#1b5139;font-size:12px;line-height:1.6;overflow-wrap:anywhere;pointer-events:auto}
.desktop-operator-topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:76px;padding:12px clamp(24px,4.5vw,66px);border-bottom:1px solid var(--desktop-line);background:rgba(255,254,250,.94)}
.desktop-context-label{display:block;margin-bottom:5px;color:#75897b;font:700 9px ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em}
.desktop-operator-topbar strong{font-size:13px;font-weight:640}
.desktop-topbar-actions{display:flex;align-items:center;gap:20px}
.desktop-topbar-actions nav{display:flex;gap:5px;padding:3px;border:1px solid var(--desktop-line);border-radius:6px;background:#f7f6ef}
.desktop-topbar-actions nav a{padding:7px 10px;border-radius:4px;color:#5e7567;text-decoration:none;font-size:11px;font-weight:650}
.desktop-topbar-actions nav a:hover,.desktop-topbar-actions nav a[aria-current="true"]{background:#dfe9dc;color:#1a4a37}
.desktop-topbar-actions form,.desktop-inline-form,.desktop-retry-form{margin:0}
.desktop-button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:9px 15px;border:1px solid var(--desktop-forest);border-radius:5px;background:var(--desktop-forest);color:#fffdf5;text-decoration:none;font:inherit;font-size:12px;font-weight:650;line-height:1.25;cursor:pointer}
.desktop-button:hover{background:#103b2b;color:white}
.desktop-button-secondary{border-color:#c6d3c6;background:var(--desktop-paper);color:#244d3b}
.desktop-button-secondary:hover{border-color:#87a18c;background:#edf3e9;color:#183f30}
.desktop-button:focus-visible,.desktop-operator-console a:focus-visible,.desktop-operator-console select:focus-visible,.desktop-operator-console input:focus-visible{outline:3px solid #c06b36;outline-offset:3px}
.desktop-operator-content{width:min(100%,1320px);margin:0 auto;padding:38px clamp(24px,4.5vw,66px) 72px}
.desktop-page-heading{padding:5px 0 23px;border-bottom:1px solid var(--desktop-line)}
.desktop-page-heading h1{margin:8px 0 8px;color:#163d2e;font-size:clamp(30px,3.1vw,43px);font-weight:680;letter-spacing:-.055em;line-height:1.08}
.desktop-page-heading>p:last-of-type{max-width:720px;margin:0;color:var(--desktop-muted);font-size:13px;line-height:1.65}
.desktop-page-heading>.desktop-text-link{display:inline-block;margin-top:13px}
.desktop-eyebrow{margin:0;color:#728879;font:700 9px/1.4 ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em;text-transform:uppercase}
.desktop-muted{color:var(--desktop-muted);font-size:11px;line-height:1.55;overflow-wrap:anywhere}
.desktop-text-link{color:#245f46;font-size:12px;font-weight:650;text-decoration:none}
.desktop-text-link:hover{text-decoration:underline;text-underline-offset:3px}
.desktop-stable{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:22px;padding:20px 22px;border:1px solid #cbd8c9;border-radius:6px;background:#e8efe3}
.desktop-stable h2{margin:5px 0;color:#173e2e;font-size:22px;font-weight:680;letter-spacing:-.035em}
.desktop-stable code{color:#57715f;font-size:11px;overflow-wrap:anywhere}
.desktop-stable-digest{display:grid;gap:7px;max-width:46%;text-align:right}
.desktop-stable-digest span{color:#6b806f;font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}
.desktop-stable-digest code{color:#315440;font-size:11px;overflow-wrap:anywhere}
.desktop-stable-unavailable{border-color:#d8d9ce;background:#efeee7}
.desktop-section{margin-top:34px;min-width:0}
.desktop-section-heading{display:flex;align-items:end;justify-content:space-between;gap:18px;padding-bottom:13px;border-bottom:1px solid var(--desktop-line)}
.desktop-section-heading h2{margin:5px 0 0;color:#1c4232;font-size:20px;font-weight:670;letter-spacing:-.035em}
.desktop-section-intro{max-width:850px;margin:14px 0;color:var(--desktop-muted);font-size:12px;line-height:1.65}
.desktop-incident-list{display:grid;gap:0;margin:0;padding:0;list-style:none}
.desktop-incident-list li{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 3px;border-bottom:1px solid var(--desktop-line);font-size:12px}
.desktop-incident-list li>div{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.desktop-incident-list a,.desktop-build-table a{color:#205740;font-weight:670;text-decoration:none}
.desktop-incident-list a:hover,.desktop-build-table a:hover{text-decoration:underline;text-underline-offset:3px}
.desktop-incident-code{display:block;margin-top:5px;color:#8e4939;font:11px ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.desktop-status{display:inline-flex;align-items:center;min-height:22px;padding:3px 8px;border:1px solid transparent;border-radius:3px;font-size:10px;font-weight:690;line-height:1.3;text-transform:capitalize}
.desktop-status-good{border-color:#c5ddca;background:#e5f2e6;color:#24563b}
.desktop-status-warn{border-color:#e3d5a9;background:#f6f0dc;color:#795b18}
.desktop-status-bad{border-color:#e4c2b8;background:#f8e8e1;color:#823c2e}
.desktop-status-neutral{border-color:#d9ded5;background:#eff0ea;color:#5e6f63}
.desktop-overview-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}
.desktop-overview-metrics article{display:grid;gap:4px;padding:17px 18px;border:1px solid var(--desktop-line);border-radius:5px;background:var(--desktop-paper)}
.desktop-overview-metrics strong{color:#204c37;font-size:27px;font-weight:680;letter-spacing:-.04em}
.desktop-overview-metrics span{color:var(--desktop-muted);font-size:11px}
.desktop-empty,.desktop-unavailable{margin:15px 0;padding:16px 18px;border:1px solid var(--desktop-line);border-radius:5px;background:var(--desktop-paper);color:#65796d;font-size:12px;line-height:1.65}
.desktop-unavailable{display:grid;gap:6px;border-color:#dfd5c2;background:#f3efe3;color:#674b2c}
.desktop-unavailable code{font-size:10px;overflow-wrap:anywhere}
.desktop-source-card{margin-top:14px;padding:18px 20px;border:1px solid var(--desktop-line);border-radius:5px;background:var(--desktop-paper)}
.desktop-source-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid #e5e7de}
.desktop-source-header h3{margin:5px 0 4px;color:#1e4935;font-size:17px;letter-spacing:-.025em}
.desktop-source-header code,.desktop-source-release code{font-size:11px;overflow-wrap:anywhere}
.desktop-source-releases{display:grid}
.desktop-source-release{padding:17px 0;border-bottom:1px solid #e7e8df}
.desktop-source-release:last-child{border-bottom:0;padding-bottom:2px}
.desktop-source-release-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.desktop-source-release-heading h4{margin:0 0 5px;color:#244b38;font-size:14px;font-weight:670}
.desktop-source-release-heading p{margin:0 0 5px;color:#536c5c;font-size:11px;line-height:1.55}
.desktop-source-identity{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:10px;color:#6b806f;font-size:10px}
.desktop-source-identity code{color:#325944}
.desktop-source-identity a{color:#276044}
.desktop-release-notes{max-width:780px;margin:12px 0 0;color:#697c6e;font-size:11px;line-height:1.6}
.desktop-release-card{display:grid;grid-template-columns:minmax(155px,1fr) minmax(130px,.8fr) minmax(220px,1.5fr) minmax(130px,.8fr);gap:17px;align-items:center;padding:19px 0;border-bottom:1px solid var(--desktop-line)}
.desktop-release-card h3{margin:6px 0;font-size:16px;letter-spacing:-.025em}
.desktop-release-card h3 a{color:#24553c;text-decoration:none}
.desktop-release-card>div>code{color:#738476;font-size:10px}
.desktop-field-label{display:block;margin-bottom:7px;color:#77877a;font-size:9px;font-weight:690;letter-spacing:.1em;text-transform:uppercase}
.desktop-digest{display:block;color:#385844;font:11px/1.6 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.desktop-release-actions{display:flex;justify-content:flex-end}
.desktop-release-actions form button{font-size:10px}
.desktop-build-filter,.desktop-audit-search{display:flex;align-items:center;gap:9px;margin:15px 0;padding:12px 14px;border:1px solid var(--desktop-line);border-radius:5px;background:#f0f0e8}
.desktop-build-filter label,.desktop-audit-search label{color:#4d6658;font-size:11px;font-weight:650}
.desktop-build-filter select,.desktop-audit-search input{min-height:37px;padding:7px 10px;border:1px solid #c6d2c5;border-radius:4px;background:#fffefa;color:#203e30;font:inherit;font-size:12px}
.desktop-table-scroll{width:100%;overflow-x:auto;border:1px solid var(--desktop-line);border-radius:5px;background:var(--desktop-paper)}
.desktop-build-table,.desktop-audit-table{width:100%;border-collapse:collapse;text-align:left}
.desktop-build-table th,.desktop-build-table td,.desktop-audit-table th,.desktop-audit-table td{padding:12px 13px;border-bottom:1px solid #e4e7dd;vertical-align:middle;font-size:11px}
.desktop-build-table thead th,.desktop-audit-table thead th{background:#f0f1e9;color:#617668;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
.desktop-build-table thead a{color:inherit;text-decoration:none}
.desktop-build-table thead a:hover{text-decoration:underline;text-underline-offset:3px}
.desktop-build-table tbody tr:last-child th,.desktop-build-table tbody tr:last-child td,.desktop-audit-table tbody tr:last-child th,.desktop-audit-table tbody tr:last-child td{border-bottom:0}
.desktop-build-table tbody th{min-width:180px;font-weight:650}
.desktop-table-id,.desktop-build-table td>code{display:block;margin-top:5px;color:#79887c;font:9px ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.desktop-table-identity{display:block;margin-bottom:5px;color:#63796a;font-size:9px}
.desktop-platform-release-link{display:block;color:#255b41;font-size:10px;font-weight:650;text-decoration:none}
.desktop-platform-release-link:hover{text-decoration:underline;text-underline-offset:2px}
.desktop-table-error{display:block;margin-top:5px;color:#964939;font:9px ui-monospace,SFMono-Regular,monospace}
.desktop-policy-available{color:#26583e;font-size:10px;font-weight:650}
.desktop-table-footnote{margin:10px 0 0;color:#718175;font-size:10px;line-height:1.6}
.desktop-job-summary{margin-top:22px;padding:19px 21px;border:1px solid var(--desktop-line);border-radius:5px;background:var(--desktop-paper)}
.desktop-job-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:16px;border-bottom:1px solid #e4e6dc}
.desktop-job-heading h2{margin:6px 0;font-size:16px}
.desktop-job-heading>div>code{color:#758578;font-size:10px;overflow-wrap:anywhere}
.desktop-retry-form{max-width:350px}
.desktop-retry-form p{margin:7px 0 0;color:#708176;font-size:10px;line-height:1.55}
.desktop-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px 21px;margin:17px 0 0}
.desktop-facts>div{min-width:0}
.desktop-facts dt{margin-bottom:5px;color:#75877a;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.desktop-facts dd{margin:0;color:#274936;font-size:11px;line-height:1.55;overflow-wrap:anywhere}
.desktop-facts dd code{font:11px ui-monospace,SFMono-Regular,monospace}
.desktop-fact-wide{grid-column:span 2}
.desktop-attempt-timeline{margin:20px 0 0;padding:0;list-style:none}
.desktop-attempt{display:grid;grid-template-columns:22px minmax(0,1fr);gap:13px;position:relative;padding:0 0 22px}
.desktop-attempt:not(:last-child)::before{position:absolute;top:13px;bottom:-1px;left:9px;width:2px;background:#d9e1d6;content:""}
.desktop-attempt-rail{position:relative;z-index:1;padding-top:4px}
.desktop-attempt-dot{display:block;width:12px;height:12px;border:2px solid #f5f3eb;border-radius:50%;background:#5b8066;box-shadow:0 0 0 1px #9fb5a0}
.desktop-attempt-dot-good{background:#5b8066;box-shadow:0 0 0 1px #9fb5a0}
.desktop-attempt-dot-bad{background:#a15342;box-shadow:0 0 0 1px #cf9d90}
.desktop-attempt-dot-warn{background:#9c7a35;box-shadow:0 0 0 1px #d4bd7c}
.desktop-attempt-dot-neutral{background:#738078;box-shadow:0 0 0 1px #aeb8af}
.desktop-attempt-content{min-width:0;padding:15px 17px;border:1px solid var(--desktop-line);border-radius:5px;background:var(--desktop-paper)}
.desktop-attempt-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.desktop-attempt-heading h3{margin:4px 0 0;color:#234936;font-size:15px;font-weight:670;text-transform:capitalize}
.desktop-attempt-id{margin:6px 0 0;color:#6d7f71;font-size:9px}
.desktop-attempt-id code{color:#496653;font:9px ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.desktop-evidence-state{margin:13px 0 0;padding:10px 12px;border-left:2px solid #b69a57;background:#f4f0e4;color:#68552d;font-size:11px;line-height:1.55}
.desktop-diagnostic{margin-top:13px;padding:12px 14px;border-left:2px solid #6b8e72;background:#eef2e8}
.desktop-diagnostic>p{margin:0;color:#274a35;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.desktop-diagnostic .desktop-diagnostic-meta{margin-top:6px;color:#6a7c6e;font-size:10px}
.desktop-diagnostic details{margin-top:9px}
.desktop-diagnostic summary{color:#255b41;font-size:10px;font-weight:650;cursor:pointer}
.desktop-diagnostic pre{max-height:360px;margin:9px 0 0;padding:12px;overflow:auto;border:1px solid #d8e0d5;border-radius:3px;background:#fffefa;color:#334b3c;font:10px/1.55 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.desktop-pagination{display:flex;justify-content:flex-end;margin:17px 0}
.desktop-release-followthrough{display:flex;align-items:center;gap:13px;margin-top:15px;padding:14px;border:1px solid var(--desktop-line);border-radius:4px;background:var(--desktop-paper)}
.desktop-audit-search input{width:min(100%,340px)}
.desktop-audit-table tbody th{color:#31533e;font-weight:630;overflow-wrap:anywhere}
.desktop-audit-table tbody td{color:#536d5e}
.desktop-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1050px){
.desktop-operator-console{grid-template-columns:205px minmax(0,1fr)}
.desktop-operator-sidebar{padding-inline:13px}
.desktop-operator-content{padding-inline:30px}
.desktop-release-card{grid-template-columns:minmax(135px,1fr) minmax(110px,.8fr) minmax(180px,1.4fr)}
.desktop-release-actions{grid-column:1/-1;justify-content:flex-start}
.desktop-build-table th,.desktop-build-table td{padding:10px 9px}
}
@media(max-width:760px){
.desktop-operator-console{display:block}
.desktop-operator-sidebar{position:static;height:auto;min-height:0;padding:13px 16px}
.desktop-operator-brand{padding:0 3px 12px}
.desktop-operator-brand>span:first-child{width:32px;height:32px}
.desktop-operator-nav{grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.desktop-operator-nav a{justify-content:center;min-height:38px;padding:0 5px;font-size:10px}
.desktop-sidebar-footer{display:none}
.desktop-operator-topbar{min-height:63px;padding:10px 18px}
.desktop-notice-slot{top:102px;right:16px;width:min(420px,calc(100vw - 32px))}
.desktop-topbar-actions{gap:9px}
.desktop-topbar-actions nav a{padding:6px 7px;font-size:10px}
.desktop-operator-content{padding:25px 18px 52px}
.desktop-stable{align-items:flex-start;flex-direction:column;gap:12px;padding:16px}
.desktop-stable-digest{max-width:none;text-align:left}
.desktop-overview-metrics{gap:6px}
.desktop-overview-metrics article{padding:12px}
.desktop-overview-metrics strong{font-size:21px}
.desktop-overview-metrics span{font-size:9px}
.desktop-incident-list li{align-items:flex-start;flex-direction:column;gap:8px}
.desktop-source-release-heading{align-items:flex-start;flex-direction:column}
.desktop-release-card{grid-template-columns:minmax(0,1fr) minmax(0,.8fr);gap:12px;padding:15px 0}
.desktop-release-card>div:nth-child(3){grid-column:1/-1}
.desktop-release-actions{grid-column:1/-1}
.desktop-build-filter,.desktop-audit-search{align-items:flex-start;flex-wrap:wrap}
.desktop-build-filter label,.desktop-audit-search label{width:100%}
.desktop-facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.desktop-fact-wide{grid-column:1/-1}
.desktop-job-heading{align-items:flex-start;flex-direction:column}
.desktop-release-followthrough{align-items:flex-start;flex-direction:column}
}
@media(max-width:460px){
.desktop-operator-topbar{align-items:flex-start;flex-direction:column;gap:10px}
.desktop-topbar-actions{width:100%;justify-content:space-between}
.desktop-operator-content{padding:22px 14px 42px}
.desktop-overview-metrics{grid-template-columns:1fr}
.desktop-overview-metrics article{display:flex;align-items:baseline;justify-content:space-between}
.desktop-release-card{grid-template-columns:1fr}
.desktop-release-card>div:nth-child(3){grid-column:auto}
.desktop-release-actions{grid-column:auto}
.desktop-source-card{padding:15px}
.desktop-facts{grid-template-columns:1fr 1fr}
.desktop-attempt-content{padding:12px}
}
`;
