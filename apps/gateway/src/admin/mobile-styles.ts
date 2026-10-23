/** Presentation-only styles for the task-oriented mobile operator console. */
export const MOBILE_ADMIN_STYLES = `
body:has(.admin-mobile-console){background:#f3f5f0;--ink:#17372f;--muted:#596f66;--line:#d6e1da;--brand:#235d4b;--brand-dark:#174937}
body:has(.admin-mobile-console) .page-shell{padding:0;max-width:none;min-height:100vh}
.admin-mobile-console{min-height:100vh;max-width:640px;margin:0 auto;padding-bottom:calc(82px + env(safe-area-inset-bottom));color:#17372f;background:#f3f5f0}
.admin-mobile-skip{position:absolute;z-index:30;top:8px;left:8px;transform:translateY(-180%);padding:9px 12px;background:#fff;border:2px solid #235d4b;color:#17372f}
.admin-mobile-skip:focus{transform:none}
.admin-mobile-header{display:flex;min-height:66px;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;background:#fdfefb;border-bottom:1px solid #d6e1da}
.admin-mobile-brand{display:flex;min-width:0;align-items:center;gap:9px;color:#153c2f;text-decoration:none;font-size:14px;font-weight:750;white-space:nowrap}
.admin-mobile-brand em{margin-left:3px;color:#667e6d;font-style:normal;font-weight:500}
.admin-mobile-mark{display:grid;flex:0 0 32px;place-items:center;width:32px;height:32px;border-radius:7px;background:#153c2f;color:#f3f7ef;font-size:16px}
.admin-mobile-header-actions{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:7px}
.admin-mobile-header-actions form{margin:0}
.admin-mobile-header-actions button,.admin-mobile-mode{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:7px 9px;font-size:12px;text-align:center}
.admin-mobile-mode{border:1px solid #c9dacd;border-radius:6px;background:#fff;color:#17372f;text-decoration:none}
.admin-mobile-mode:hover{background:#eef2ed;text-decoration:none}
.admin-mobile-main{min-width:0;padding:22px 16px 190px}
.admin-mobile-page-heading{margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid #d6e1da}
.admin-mobile-page-heading .admin-kicker{display:block;margin-bottom:7px}
.admin-mobile-page-heading h1{font-size:clamp(26px,7vw,36px);line-height:1.16;letter-spacing:-.05em;overflow-wrap:anywhere}
.admin-mobile-page-heading p{margin:7px 0 0;color:#647c6c;font-size:14px}
.admin-mobile-toast{position:fixed;z-index:24;top:calc(80px + env(safe-area-inset-top));right:10px;left:10px;width:min(600px,calc(100vw - 20px));max-height:min(25vh,9rem);margin-inline:auto;padding:12px 14px;border:1px solid #b9d0c1;border-left:3px solid #235d4b;border-radius:8px;background:#f5fbf6;color:#174937;box-shadow:0 5px 24px #153c2f24;overflow:auto;overflow-wrap:anywhere}
.admin-mobile-console:has(.admin-mobile-action-region) .admin-mobile-toast{bottom:calc(220px + env(safe-area-inset-bottom))}
.admin-mobile-section{min-width:0;margin:24px 0 0}
.admin-mobile-section-heading{display:flex;min-width:0;align-items:flex-end;justify-content:space-between;gap:10px;margin:0 0 12px}
.admin-mobile-section-heading h2{min-width:0;margin:5px 0 0;font-size:20px;letter-spacing:-.03em;overflow-wrap:anywhere}
.admin-mobile-section-heading>a{flex:0 0 auto;font-size:13px;font-weight:650}
.admin-mobile-empty,.admin-mobile-empty-inline{padding:17px 0;color:#647c6c}
.admin-mobile-unavailable{display:grid;min-width:0;gap:5px;margin:12px 0;padding:13px 14px;border:1px solid #e3b5ae;border-left:3px solid #a44337;background:#fff7f5;color:#7f3028;overflow-wrap:anywhere}
.admin-mobile-unavailable code{overflow-wrap:anywhere}
.admin-mobile-focus{min-width:0;padding:17px;border:1px solid #c8dbcd;border-radius:12px;background:#fff;box-shadow:0 4px 18px #153c2f0a}
.admin-mobile-focus-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.admin-mobile-focus h2{margin:12px 0 4px;font-size:22px;line-height:1.2;letter-spacing:-.035em;overflow-wrap:anywhere}
.admin-mobile-focus .button{width:100%;min-height:48px;margin-top:8px}
.admin-mobile-next-action{display:grid;gap:3px;margin:12px 0;padding:10px 11px;border-radius:7px;background:#eef4ef;color:#315545;overflow-wrap:anywhere}
.admin-mobile-next-action strong{font-size:12px}
.admin-mobile-stable{margin:0;padding:15px 16px;border:1px solid #c8dbcd;border-radius:9px;background:#e8f2e9;font:650 14px/1.55 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.admin-mobile-stable-panel{display:grid;gap:6px;margin:0 0 18px;padding:13px 15px;border:1px solid #c8dbcd;border-radius:9px;background:#e8f2e9}
.admin-mobile-stable-panel strong{font:650 14px/1.55 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.admin-mobile-release-list,.admin-mobile-job-list,.admin-mobile-platform-releases{display:grid;min-width:0;gap:11px;margin:0;padding:0;list-style:none}
.admin-mobile-release-list>li{min-width:0;border-bottom:1px solid #d6e1da}
.admin-mobile-release-list>li>a{display:flex;min-height:48px;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;color:#1b503d;text-decoration:none}
.admin-mobile-release-list>li>a span{color:#647c6c;font-size:13px;text-align:right}
.admin-mobile-job-card,.admin-mobile-release-card,.admin-mobile-platform-release,.admin-mobile-audit-list article{min-width:0;padding:15px;border:1px solid #d6e1da;border-radius:10px;background:#fff;overflow-wrap:anywhere}
.admin-mobile-job-card-compact{padding:13px}
.admin-mobile-job-link{display:block;color:inherit;text-decoration:none}
.admin-mobile-job-link:hover{text-decoration:none}
.admin-mobile-job-card-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.admin-mobile-attempt-count{color:#647c6c;font-size:12px}
.admin-mobile-job-card h3,.admin-mobile-release-card h3,.admin-mobile-platform-release h3{margin:10px 0 5px;font-size:18px;line-height:1.25;letter-spacing:-.025em;overflow-wrap:anywhere}
.admin-mobile-job-id,.admin-mobile-release-id{display:block;max-width:100%;margin:4px 0;color:#536d5c;font-size:11px;overflow-wrap:anywhere;word-break:break-word}
.admin-mobile-job-facts,.admin-mobile-release-facts,.admin-mobile-detail-facts,.admin-mobile-attempt-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;margin:13px 0 0}
.admin-mobile-job-facts>div,.admin-mobile-release-facts>div,.admin-mobile-detail-facts>div,.admin-mobile-attempt-facts>div{min-width:0}
.admin-mobile-job-facts dt,.admin-mobile-release-facts dt,.admin-mobile-detail-facts dt,.admin-mobile-attempt-facts dt,.admin-mobile-diagnostic dt{color:#647c6c;font-size:12px}
.admin-mobile-job-facts dd,.admin-mobile-release-facts dd,.admin-mobile-detail-facts dd,.admin-mobile-attempt-facts dd,.admin-mobile-diagnostic dd{margin:2px 0 0;font-size:13px;overflow-wrap:anywhere;word-break:break-word}
.admin-mobile-error-code{margin:10px 0 0;color:#87372f;font-size:13px;overflow-wrap:anywhere}
.admin-mobile-filter,.admin-mobile-search{display:grid;min-width:0;gap:8px;margin:0 0 18px;padding:14px;border:1px solid #d6e1da;border-radius:9px;background:#fff}
.admin-mobile-filter label,.admin-mobile-search label{font-size:13px;font-weight:650}
.admin-mobile-filter select,.admin-mobile-search input{display:block;width:100%;min-width:0;min-height:48px;padding:10px 12px;border:1px solid #bdcfc2;border-radius:6px;background:#fff;color:#17372f;font:inherit;font-size:16px}
.admin-mobile-filter button,.admin-mobile-search button{min-height:48px}
.admin-mobile-search>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
.admin-mobile-search button{padding-inline:13px}
.admin-mobile-older{width:100%;margin-top:16px}
.admin-mobile-back{display:inline-flex;min-height:44px;align-items:center;margin:0 0 12px;color:#1b503d;font-weight:650}
.admin-mobile-release-detail-heading{display:grid;justify-items:start;gap:9px;padding:12px 0 17px;border-bottom:1px solid #d6e1da}
.admin-mobile-release-detail-heading h1{margin:2px 0 0;font-size:clamp(27px,7vw,38px);line-height:1.15;letter-spacing:-.05em;overflow-wrap:anywhere}
.admin-mobile-release-detail-heading p{margin:0;color:#647c6c;overflow-wrap:anywhere}
.admin-mobile-release-detail-heading .button{min-height:44px}
.admin-mobile-release-digest{display:grid;gap:6px;min-width:0;margin:15px 0;padding:13px 14px;border:1px solid #d6e1da;border-radius:8px;background:#fff}
.admin-mobile-release-digest code{overflow-wrap:anywhere;word-break:break-word}
.admin-mobile-detail-heading{display:grid;justify-items:start;gap:7px;padding:17px 0 16px;border-bottom:1px solid #d6e1da}
.admin-mobile-detail-heading h1{margin:3px 0 0;font-size:clamp(27px,7vw,38px);line-height:1.15;letter-spacing:-.05em;overflow-wrap:anywhere}
.admin-mobile-detail-heading p{margin:0;color:#647c6c}
.admin-mobile-detail-facts{padding:14px 0 17px;border-bottom:1px solid #d6e1da}
.admin-mobile-detail-facts code{display:block}
.admin-mobile-evidence-state{margin:0 0 12px;color:#647c6c;font-size:13px}
.admin-mobile-attempt-list{display:grid;gap:13px;margin:0;padding:0;list-style:none;counter-reset:attempt}
.admin-mobile-attempt{min-width:0}
.admin-mobile-attempt>article{min-width:0;padding:15px;border:1px solid #d6e1da;border-radius:10px;background:#fff;overflow-wrap:anywhere}
.admin-mobile-attempt-heading{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:10px}
.admin-mobile-attempt-heading>div{display:grid;justify-items:start;gap:6px}
.admin-mobile-attempt-heading h3{margin:0;font-size:14px}
.admin-mobile-attempt-heading>code{max-width:55%;font-size:10px;overflow-wrap:anywhere;word-break:break-word}
.admin-mobile-diagnostic{min-width:0;margin-top:14px;padding-top:12px;border-top:1px solid #d6e1da}
.admin-mobile-diagnostic h4{margin:0 0 5px;font-size:14px}
.admin-mobile-diagnostic p{overflow-wrap:anywhere}
.admin-mobile-diagnostic dl{display:grid;gap:7px}
.admin-mobile-diagnostic details{margin-top:12px}
.admin-mobile-diagnostic summary{min-height:48px;padding:10px 0}
.admin-mobile-diagnostic pre{max-width:100%;max-height:20rem;margin:10px 0;padding:12px;border-radius:6px;background:#f3f5f0;color:#17372f;font-size:12px;line-height:1.55;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.admin-mobile-evidence-unavailable{margin:12px 0;padding:11px 12px;border-left:3px solid #885421;background:#fff6e6;color:#694219;font-size:13px;overflow-wrap:anywhere}
.admin-mobile-action-region{position:fixed;z-index:12;bottom:calc(75px + env(safe-area-inset-bottom));left:50%;display:grid;width:min(600px,calc(100vw - 20px));max-height:140px;gap:9px;padding:13px;border:1px solid #c8dbcd;border-radius:10px;background:#fdfefb;box-shadow:0 5px 26px #153c2f2a;overflow:auto;transform:translateX(-50%)}
.admin-mobile-action-copy{display:grid;gap:3px;margin:0;color:#496958;font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.admin-mobile-action-region form{margin:0}
.admin-mobile-action-region button{width:100%;min-height:48px}
.admin-mobile-audit-list{display:grid;gap:11px;margin:0;padding:0;list-style:none}
.admin-mobile-audit-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.admin-mobile-audit-heading time{color:#647c6c;font:11px ui-monospace,SFMono-Regular,monospace}
.admin-mobile-audit-list h2{margin:11px 0 3px;font-size:16px;overflow-wrap:anywhere}
.admin-mobile-audit-list p{margin:5px 0 0;color:#647c6c;font-size:13px;overflow-wrap:anywhere}
.admin-mobile-footer{padding:13px 16px 18px;border-top:1px solid #d6e1da;color:#748979;font-size:11px;text-align:center}
.admin-mobile-tabs{position:fixed;inset:auto 0 0;z-index:20;min-height:72px;padding:4px max(8px,env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));border-top:1px solid #cbd9cf;background:#fdfefb;box-shadow:0 -7px 24px #153c2f14}
.admin-mobile-tabs ul{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));width:100%;max-width:640px;min-height:60px;margin:0 auto;padding:0;list-style:none}
.admin-mobile-tabs li{min-width:0}
.admin-mobile-tabs a{display:flex;min-width:0;min-height:56px;align-items:center;justify-content:center;padding:5px 2px;border-radius:7px;color:#678071;font-size:12px;font-weight:650;text-align:center;text-decoration:none;overflow-wrap:anywhere}
.admin-mobile-tabs a:hover,.admin-mobile-tabs a:focus-visible{color:#153c2f}
.admin-mobile-tabs a[aria-current="page"]{background:#e4eee6;color:#153c2f;font-weight:750}
@media(max-width:360px){
  .admin-mobile-header{gap:6px;padding-inline:10px}
  .admin-mobile-brand{gap:6px;font-size:12px}
  .admin-mobile-mark{flex-basis:29px;width:29px;height:29px}
  .admin-mobile-header-actions{gap:5px}
  .admin-mobile-header-actions button,.admin-mobile-mode{padding-inline:6px;font-size:11px}
  .admin-mobile-main{padding-inline:12px}
  .admin-mobile-tabs a{font-size:11px}
  .admin-mobile-job-card,.admin-mobile-release-card,.admin-mobile-platform-release,.admin-mobile-attempt>article{padding:12px}
}
@media(prefers-reduced-motion:reduce){.admin-mobile-console *,.admin-mobile-console *::before,.admin-mobile-console *::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
`;
