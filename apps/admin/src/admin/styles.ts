/** Presentation-only operator console styles. Authority stays in the existing release API. */
export const ADMIN_STYLES = `
body:has(.admin-console){background:#f3f5f0;--ink:#17372f;--muted:#596f66;--line:#d6e1da;--brand:#235d4b;--brand-dark:#174937}
body:has(.admin-console) .page-shell{padding:0;max-width:none;min-height:100vh}
.admin-console{min-height:100vh;color:#17372f}
.admin-bar{display:flex;align-items:center;gap:22px;min-height:72px;padding:12px max(24px,calc((100vw - 1320px)/2));background:#fdfefb;border-bottom:1px solid #d6e1da}
.admin-logo{display:flex;align-items:center;gap:12px;color:#153c2f;text-decoration:none;font-weight:750;font-size:16px;letter-spacing:-.015em;white-space:nowrap}
.admin-logo em{font-style:normal;font-weight:500;color:#667e6d;margin-left:4px}
.admin-mark{display:grid;place-items:center;width:36px;height:36px;color:#f3f7ef;background:#153c2f;border-radius:8px;font-size:18px}
.admin-bar nav{display:flex;gap:20px;margin-left:auto}
.admin-bar nav a{color:#486f5c;font-size:13px;font-weight:600;text-decoration:none}
.admin-bar nav a:hover{text-decoration:underline}
.admin-bar form{margin:0}
.admin-bar button{min-height:36px;font-size:12px;padding:7px 12px}
.admin-main{max-width:1320px;margin:0 auto;padding:44px 24px 80px}
.admin-heading{padding-bottom:26px;border-bottom:1px solid #d6e1da}
.admin-kicker{font:700 11px ui-monospace,SFMono-Regular,monospace;letter-spacing:.11em;color:#668676}
.admin-heading h1{font-size:clamp(29px,4vw,52px);font-weight:690;letter-spacing:-.055em;color:#173f30;margin:14px 0 8px}
.admin-heading p{color:#647c6c;font-size:14px;margin:0}
.admin-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin-top:24px;border:1px solid #d6e1da;background:#d6e1da}
.admin-metrics>div{display:flex;flex-direction:column;gap:4px;padding:22px 24px;background:#fff}
.admin-metrics strong{font-size:30px;line-height:1.15;letter-spacing:-.04em;color:#153c2f}
.admin-metrics span{font-size:12px;color:#647c6c}
.admin-stable{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:17px 24px;margin-top:12px;border:1px solid #c8dbcd;background:#e8f2e9}
.admin-stable strong{font:650 14px ui-monospace,SFMono-Regular,monospace;color:#153c2f;overflow-wrap:anywhere;text-align:right}
.admin-section{margin-top:38px;min-width:0}
.admin-section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid #d6e1da}
.admin-section-head h2{font-size:22px;font-weight:690;letter-spacing:-.035em;color:#173f30;margin:8px 0 0}
.admin-section-head .button{min-height:38px;font-size:12px}
.admin-release{display:grid;grid-template-columns:minmax(155px,.9fr) minmax(120px,.55fr) minmax(190px,1.2fr) minmax(130px,.7fr);gap:18px;align-items:center;padding:22px 0;border-bottom:1px solid #d6e1da;background:transparent}
.admin-release h3{font-size:20px;line-height:1.2;letter-spacing:-.035em;margin:9px 0 0}
.admin-release h3 a{color:#1b503d;text-decoration:none}
.admin-release-state{align-self:center}
.admin-release-state p{margin-top:7px}
.admin-digest{display:block;font:12px/1.7 ui-monospace,monospace;overflow-wrap:anywhere;margin-top:6px;color:#385946}
.admin-subtext{font-size:12px;line-height:1.55;color:#718676;overflow-wrap:anywhere}
.admin-actions{display:flex;justify-content:flex-end}
.admin-actions form{margin:0}
.admin-actions button{font-size:12px;min-height:40px;white-space:normal}
.admin-manifest-form{padding:24px;border:1px solid #d8e3da;background:#fff}
.admin-manifest-form label{display:block;font-size:13px;font-weight:650;margin:0 0 12px}
.admin-manifest-form textarea{width:100%;min-height:210px;resize:vertical;border:1px solid #cadbd0;border-radius:6px;padding:17px;background:#f9fbf8;color:#173b2d;font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.admin-form-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px}
.admin-form-footer span{color:#647c6c;font-size:12px;line-height:1.5}
.admin-form-footer button{flex-shrink:0}
.admin-audit-list{padding:0;margin:0;list-style:none}
.admin-audit-list li{display:grid;grid-template-columns:220px minmax(0,1fr) 110px;gap:16px;align-items:center;padding:15px 0;border-bottom:1px solid #d6e1da;font-size:13px}
.admin-audit-list strong{font-weight:600;overflow-wrap:anywhere}
.admin-audit-time{font:12px ui-monospace,monospace;color:#647d70}
.admin-empty{margin:20px 0;padding:27px;border:1px solid #d6e1da;background:#fff;color:#657c6d}
.admin-json{padding:22px;background:#fff;border:1px solid #d6e1da;overflow:auto;white-space:pre-wrap;word-break:break-word;max-height:75vh;font-size:12px}
.admin-notice{padding:14px 20px;background:#e5f2e9;border-left:3px solid #235d4b;color:#174937;overflow-wrap:anywhere}
.admin-footer{padding:20px 24px;border-top:1px solid #d6e1da;text-align:center;font-size:12px;color:#748979}
.admin-handoff{max-width:480px;margin:10vh auto;padding:38px;background:#fff;border:1px solid #d6e1da}
.admin-handoff h1{font-size:28px;color:#173f30;margin:12px 0}
@media(max-width:830px){
.admin-bar{flex-wrap:wrap;padding:14px 18px;gap:10px}
.admin-bar nav{order:3;width:100%;margin-left:0;padding-top:8px}
.admin-main{padding:28px 16px 60px}
.admin-metrics>div{padding:16px}
.admin-stable{padding:14px 16px;align-items:flex-start;flex-direction:column;gap:7px}
.admin-stable strong{text-align:left}
.admin-release{grid-template-columns:minmax(0,1fr) minmax(0,.75fr);gap:12px;padding:20px 0}
.admin-release>div:nth-child(3){grid-column:1/-1}
.admin-actions{justify-content:flex-start}
.admin-audit-list li{grid-template-columns:minmax(0,1fr) auto}
.admin-audit-time{grid-column:1/-1}
.admin-manifest-form{padding:15px}
.admin-form-footer{align-items:stretch;flex-direction:column}
.admin-form-footer button{width:100%}
.admin-section-head h2{font-size:20px}
}
@media(max-width:440px){
.admin-metrics>div{padding:13px 10px}
.admin-metrics strong{font-size:24px}
.admin-metrics span{font-size:11px}
.admin-bar .admin-logo{font-size:14px}
.admin-bar button{padding-inline:8px}
}
`;
