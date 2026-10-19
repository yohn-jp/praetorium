# Cloudflareネイティブのレート制限設計・KVカウンター撤去計画

> **状態:** [PR #14](https://github.com/yohn-jp/praetorium/pull/14) にWorkers公式API移行のソースとテストを実装（**未マージ、未デプロイ**）。WAFは後日の手動運用設定。2026-10-19 JST。調査時のPraetorium `main` は `ac0d519cb2ede2f3e9beb3956e270da820ccbbb5`。
> **Authority:** 最新のオーナー指示、[Praetorium Epic #1](https://github.com/yohn-jp/praetorium/issues/1)、[Issue #13](https://github.com/yohn-jp/praetorium/issues/13)。実コードは現状の証拠であり、歴史的設計文書は独立した製品要件ではない。

## 1. 目的、非目的、導入経緯

- **目的:** HTTP濫用抑制はCloudflareの公式機能へ、コンテナ／Operationの一意性・容量・権限は既存のControl Plane／D1へ戻す。レート制限のためのKV Read/Write、追加Durable Object、追加データベース、独自カウンターを**ゼロ**にする。今回の実装対象は **Gateway native API＋既存Control Planeの保証維持**であり、WAFの作成・変更は後日手動で行う。
- **維持:** 認証済み主体の判定、失効、CSRF、single-use handoff、権限の鮮度、D1 CAS／冪等性、既存のセッション・コード用DO、ユーザー向けエラー契約。DOは不要なカウンター用途に拡張しない。
- **非目的:** 課金上限をレート制限APIで保証すること、全拠点で厳密な回数を数えること、Podの生死監視、WAFルールやCloudflare本番設定の変更、既存KVの鍵・セッション索引の移行、他アプリへのルール適用、任意の新規セキュリティ機能の導入。
- **履歴:** [旧Arcadiaの `d4b216c`](https://github.com/yohn-jp/arcadia-platform/commit/d4b216c07074c756d91089b4f7e62d35f1b8bbb7) がKVレートリミッターを追加。元の[Arcadia #19](https://github.com/yohn-jp/arcadia-platform/issues/19) はMCPトークン交換のレート／並行数制限を要求したが、KV利用は指定していない。旧実装をPraetoriumへ引き継ぎ、現行[REVIEW A-08](REVIEW.md)も非原子的カウンターを指摘している。

## 2. 現行コードで確定する事実（targetではない）

[`context.ts`](../../apps/gateway/src/context.ts) が以下の5つを[`rate-limiter-kv.ts`](../../apps/gateway/src/adapters/rate-limiter-kv.ts) へ結線する。`consume()` は `KV.get(key) → count + 1 → KV.put(key)` を**許可するたびに実行**する。`put` は固定窓（60秒）ごとにTTL 120秒。原子的increment、強整合性、厳密な上限保証はない。

| 現行制限／経路 | 現行キー | 設定 | 実際の呼び出し | 注意 |
| --- | --- | --- | --- | --- |
| Login | `CF-Connecting-IP`、欠落時は全員共通 `unknown` | 10/60秒 | [`router.ts` `handleGithubStart`](../../apps/gateway/src/router.ts) | OAuth開始ごと。認証前 |
| Token Exchange | 提示Bearer文字列の鍵付きdigest | 20/60秒 | [`router.ts` `handleTokenExchange`](../../apps/gateway/src/router.ts) → [`token-exchange.ts`](../../packages/auth/src/credential/token-exchange.ts) | **不正なBearerを毎回変えるとキーが変わる**。現状はControl Plane照会後に制限 |
| Runtime Git Credential | `CF-Connecting-IP` の鍵付きdigest、欠落時は `unknown` | 120/60秒 | [`router.ts` `handleRuntimeGitCredential`](../../apps/gateway/src/router.ts) | 認可されたRuntime IDではなく接続元単位。内部呼び出しの経路確認が必要 |
| Wake / Repository Entry | `userId:repositoryId` | 10/60秒 | [`portal-service.ts` `enterRepository`](../../apps/gateway/src/services/portal-service.ts) | **既にReadyな環境への通常Entryも消費**する |
| Mutation Receipt | `actorUserId:repositoryId` | 10/60秒 | [`router.ts` `handleMutationAuthorization`](../../apps/gateway/src/router.ts) | Browser sessionまたは検証済みHosted Grantの主体で制限 |

`RATE_LIMITED` は現在、Gateway上でJSON `error.code=RATE_LIMITED` ／HTTP 429を返す（[`error-response.ts`](../../apps/gateway/src/middleware/error-response.ts)）。これはWAFが発生させるブロック／チャレンジ応答とは同じ契約ではない。

別のKV用途である公開JWK Registry（`key-registry-kv.ts`）とセッション／MCP credentialのDigest→User索引（`digest-user-index.ts`）は今回**維持**する。したがって`GATEWAY_KV` binding全体を削除してはならない。ユーザー提示の集計値「1,190 Writes」の発生源別内訳はコードから確定しない。レートリミッターに限る書き込み経路は上表のとおり確認済み。

## 3. 目標アーキテクチャと責務境界

~~~text
外部Browser / API / MCP
    │
    ▼
Cloudflare Zone WAF (ルール容量/Host指定が許す場合の入口保護)
    │
    ▼
Gateway Worker ── Workers Rate Limiting API binding
    │                 best-effort / location-local、独自永続カウンターなし
    ├── 既存UserAuthState / EphemeralCode DO (認証正本、原子的one-use)
    ├── 既存Gateway KV (公開JWK、digest routing hintのみ)
    └── Control Plane service binding ── D1 CAS / 冪等処理
                                               │
                                               └── Provisioner / K3s admission / capacity
Instance Access / 内部Caller ──▶ Gateway (WAFを経由する保証なし)
                                   └── 認証・利用者スコープに応じたnative limiter
~~~

1. **WAF:** パブリックHTTP入口でのIP単位濫用緩和。オーナーがセキュリティルールを管理。ゾーンに適用され、Gatewayの認証主体／repository IDは信頼済み情報として参照できない。**単独で内部Service Bindingと認証後の主体制限を覆わない**。
2. **Workers Rate Limiting API:** Gateway内の特定の高リスク操作だけで`limit({ key })` を呼ぶ。Cloudflare管理のカウンターを使い、KV read-modify-writeを廃止。レート制限は**負荷・濫用抑制**であって認可判定や正確な課金上限ではない。
3. **Control Plane / D1:** 一つのRepositoryに一つの論理Instance、Operationの重複抑止、世代・lease・capacity、Writer fencingの強制。Workersの許容結果だけでコンテナ起動やMutationを承認しない。
4. **既存DO:** Session、Credential、single-use code等の本来の原子的状態に限定。レートリミッター用DOの追加も、既存DOにカウンターを詰め込む変更も行わない。
5. **通常のScriptorium本文:** 引き続きインスタンスoriginへ直接到達し、Gatewayへプロキシしない。

## 4. 公式仕様と配置制約（2026-10-19に確認）

| 公式機能 | 能力・限界 | Praetoriumの設計判断 |
| --- | --- | --- |
| [WAF Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) | Zoneプラン依存。Freeは**1ルール・10秒窓・IP集計・マッチ条件はPath/Verified Bot**（Hostはマッチ条件に利用不可）。Pro以上の制約は別。拠点間で厳密なグローバル上限を保証しない | Freeの場合、`yohn.jp`の**別サブドメインにも同じPathルールが影響**し得るため、現在の利用状況／Zoneプラン／スコープを確認せず新規適用しない。10/60秒の代替にFreeの10秒ルールを等価扱いしない |
| [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | Wrangler ≥4.36.0。Bindingの`simple.period` は**10または60秒**、`namespace_id`はアカウント内一意の正整数を文字列で指定。同じnamespaceとkeyならWorker間でカウンターを共有。各Cloudflare locationローカル、非同期の近似値 | Gatewayの現在の`wrangler 4.118.0`は対応条件を満たす。用途別に独立namespaceを割り当てる。値は例示IDをそのまま本番採用せずアカウント内衝突確認をする |
| [Workersの料金／KV](https://developers.cloudflare.com/workers/platform/pricing/) | Workers Freeは100,000リクエスト/日、KV Writesは1,000/日。WorkersリクエストとZone WAF契約・課金は別管理 | この変更で**レートリミッター起因のKV Reads/Writes=0**、追加DO request/storage=0を目標とする。公式API自体の適用可能プラン／課金・Zone既存枠はoperatorが確認する。全体費用が0円になるとは主張しない |
| [Native APIの監視](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#monitoring) | Rate Limiting bindingのカウンターはDashboardに直接出ない。429とWorkers Logs/Tracesで観測 | 既存requestログのstatus/routeと限定的な拒否理由だけ使用。Analytics Engine・新しい課金対象の常時テレメトリは追加しない |

※WAFはゲート前のbest-effort緩和であり、Block/Challenge/1015などCloudflare側の応答を発生させる。GatewayのJSON 429と互換と仮定しない。Workerへ到達した通信だけがWorker APIのレート判定対象。

## 5. 各操作の移行契約

| 操作 | 推奨制御と暫定数値 | 信頼するキー・判定位置 | 強制的に維持する別の仕組み |
| --- | --- | --- | --- |
| Login `GET /auth/github/start` | **Workers native 10/60秒**を当面維持。WAFは公開入口の追加防御として、有効なHost/Path範囲が設定可能なら導入 | 認証前なのでCloudflare管理の接続元IP（共有NATの誤検知を評価）。`unknown` を全利用者の単一bucketにしない。OAuth開始前にconsume | OAuth state/nonce、既存のLoginAttempt DO |
| MCP `POST /api/token` | **native 20/60秒／検証済みcredential**を維持。**認証前の接続元bucket 60/60秒**を暫定追加（要実負荷で調整、厳密契約ではない） | まず入力形式検査→信頼できる接続元で粗制限→Control Plane等の高コスト照会→既存のcredential検証。成功した検証済みcredentialのdigestで20/60秒（Bearer生値をログ／keyへ直載せしない）。無効値を変えても粗制限から逃れない | 無効・失効・他Repoへのアクセス拒否、scopeと署名検証、失敗の一様性 |
| Runtime Git `POST /internal/github/credential` | **native 120/60秒**、内部経路へのWAF依存なし | Edgeの接続元IPがあればその鍵付きdigest、Service Binding等でIPがなければ提示されたruntime service tokenの鍵付きdigestを暫定使用。後者の前段で明示的な共有 `service-binding:preauth` 制限を適用する。偽トークンを変更しても同じpre-auth枠を消費するが、正規の内部caller間で相互干渉し得る。検証済みruntime identityへの移行は別の根拠・API境界が必要 | 現行のbrokerによるservice proof、repository/epoch/lease照合、GitHub発行権限 |
| Wake / Entry | **native 10/60秒／userId:repositoryId**。ReadyなEntryは消費しない | 既存ユーザーセッションとGitHub Repoアクセス確認後、**実際にstart/resumeが必要なときだけ**consume | D1の`requestDesiredState`、CAS／冪等キー／capacity／単一Writer、Kubernetes Admission |
| Mutation Receipt | **native 10/60秒／userId:repositoryId** | 検証済みsessionまたはHosted grantの主体を使用。無効grantの入力文字列で他ユーザーのquotaを消費させない | 現行GitHub権限再確認、署名、binding/epoch/revision、operation id／payload digest |

**閾値の扱い:** 10/20/120/10/10は現行設定の初期互換値であり、新しい製品要件ではない。MCP認証前の60/60秒は回避経路封鎖のための**提案値**。既存利用頻度・共有NAT・並列クライアント・誤拒否を確認して適用前に確定する。WAFプラン／既存ルールが未確認の現状では、WAF稼働を条件にnativeのアプリ層制御を先に外してはならない。

**MCP順序に関する実装上の注意:** 現在の`handleTokenExchange`は`controlPlane.getByInstanceId`、`getSigningKey`を先に実行し、auth packageの`consume`はその後である。移行では認証前の粗制限を**それらの照会より前**へ移す。credential存在の有無を推定可能にする差分エラーを増やさない。valid-credential quotaは検証後のみ消費する。無効credentialの総当たりをper-credential bucket単独で守ろうとしてはならない。

**Runtime Gitに関する外部条件:** 現状`CF-Connecting-IP ?? "unknown"`が何を表すかは、Pod／Instance Accessからの実際の到達経路（直接Cloudflare HTTPか、Service Binding等）で変わる。WAFが全ての呼び出しに効くとは仮定しない。信頼できる接続元も検証済みRuntime IDも得られない場合は、内部呼び出し専用の明示的な共有pre-auth枠で要求数を制限する。これはCaller識別ではなく負荷緩和であり、実際の経路と既存Broker認証の確認はデプロイ前の必須条件である。

## 6. 設定・アダプターの最小構成（将来の実装PR用）

~~~toml
# 例示のみ。namespace_idの所有・衝突と環境差を確認して確定する。
[[ratelimits]]
name = "LOGIN_LIMIT"
namespace_id = "41001"
[ratelimits.simple]
limit = 10
period = 60

[[ratelimits]]
name = "MCP_CREDENTIAL_LIMIT"
namespace_id = "41002"
[ratelimits.simple]
limit = 20
period = 60

[[ratelimits]]
name = "MCP_SOURCE_LIMIT"
namespace_id = "41003"
[ratelimits.simple]
limit = 60
period = 60

# 残るRuntime Git / Wake / Mutationも、それぞれ独立namespaceで指定する。
~~~

- `apps/gateway/wrangler.toml` に必要なnative bindingsを宣言し、`apps/gateway/src/env.ts` にCloudflare型を追加する。`context.ts` の5つの`createKvRateLimiter`を置き換える。
- 既存`@praetorium/auth`の`RateLimiter.consume(key, now)`ポートは、必要なら薄いCloudflareアダプターで維持する。Native APIが独自の時刻引数を使わないことを明示する。新しい共通レート制限フレームワークは作らない。
- 受入に必要なMCPのpre-auth粗制限とWakeの判定位置だけ最小限の呼び出し順序修正を行う。過去のKVカウンター値を移行・複製しない（時間窓限りの状態）。既存の署名鍵KV／Digest索引／DOは変更しない。
- 配備後に旧`rate-limiter-kv.ts`が参照されないことを確認したうえで削除し、KVに書くコードが署名鍵管理／Digest索引だけになったことを静的検索で証明する。`GATEWAY_KV`のbindingは残す。
- ProductionのWAFルールは**運用者が別途承認・適用**する。新しいルールがアカウント／Zoneの既存ルールを上書きしないこと、`yohn.jp`配下の別アプリへ波及しないこと、Rule利用可能数・課金を確認する。

## 7. セキュリティ、故障、応答契約

- **認証／認可はレート制限と独立。** Native APIが`success=true`でも、GitHub権限・署名・epoch・Operation等の不変条件を全て通す。`success=false`では既存Gateway JSON `RATE_LIMITED`／HTTP 429を返す。
- **Binding不存在・呼出失敗:** 保護対象の新しい認証情報発行やWake/Mutationは勝手に無制限へfail-openしない。運用上の一時Unavailable（HTTP 503、秘密情報を含まない記録）として処理。静的／Healthの要求に不要なbinding判定を持ち込まない。
- **WAFのBlock/Challenge:** Gatewayへ到達しない場合はGateway式JSONレスポンスを保証できない。ブラウザとMCPの違いを明示し、WAF適用前にAPIクライアントのエラー認識と復旧を確認する。
- **キーの正当性:** raw Bearer、OAuth code、Cookie、Private IP、ログイン秘密情報をログにもKVにも保存しない。認証後bucketは**確認済み主体**だけを用いる。認証前bucketのSource IDはCloudflareが保証するヘッダーから得る。実際のヘッダー境界が不明な経路では導入判断を保留する。
- **地域境界:** Workers API／WAFのカウンターはCloudflare拠点単位の**best-effort**であり、同時大量リクエスト・PoP間移動時に厳密な最大回数や資源予算を保証しない。料金上限、Writer一意性、同時起動、ジョブ実行枠には使用しない。
- **濫用による自己枯渇回避:** Native limiterに失敗／成功するだけでKV Writesを発生させない。追加DO作成・D1行書き込みをレート制限のために行わない。ログは既存の構造化イベントを必要な範囲で用い、ユーザー・鍵ごとの高頻度追跡ログを追加しない。

## 8. 移行手順と受入ゲート（PR #14はWorker側のソース・テストまで。Cloudflare本番適用は未実施）

| Phase | 実施 | 必須の証明／停止条件 |
| --- | --- | --- |
| 0 — 構成確認 | OperatorがWorkersプラン、Zone/WAFプラン、残りルール枠、既存セキュリティルール、Gateway外部・内部入口の実経路、namespace ID利用状況を読取確認 | Free WAFの1ルール/10秒/Host非対応を踏まえ、別アプリを巻き込まない経路が確保できなければWAF追加は**別保留**。native移行を阻害しない |
| 1 — Native化 | **実装Issue #15／PR #14に実装コミット済み**。5経路のadapter/Bindingを置換、MCP入力源の粗制限・Wake実Wake時の判定を実装 | 独自KV limiterの参照ゼロ、native bindingが全環境で必須、既存JWK/Session/DOの経路不変。検証ステータスはGitHub Checksの結果で確定し、まだPASSと仮定しない |
| 2 — 隔離環境検証 | Worker実行環境で期限窓・同一/別キー・無効Bearer連投・並列要求・同一共有IP・異なるPoPの制約を検証。Hosted内部Caller経路も確認 | Gateway JSON 429と503、WAFの異なるエラー、失効・権限変更・Operation CASが維持される。正確なグローバル上限を合格条件にしない |
| 3 — Edge構成（**後日の手動作業**） | 今回WAFルールを作成・変更しない。オーナーがZoneに適合する既存WAF Security Ruleを必要に応じ調整／追加。ルール容量不足やHost区別不能ならnativeだけで運用 | 別サブドメイン・GitHub callback・正規MCPクライアントを誤遮断しない。設定の実際のRule IDとZoneを物証として残す |
| 4 — Cutover | 承認済みWorkerだけ段階切替、現行Workerロギングで429/503/レイテンシー/ログイン成功率を確認 | **Rate limiter由来KV Read/Writeゼロ**（コード上）を確認。KV総量は公開鍵とDigest索引が残るためゼロを求めない。既存D1/DO利用の増加と請求計測も確認 |
| 5 — 清掃・確定 | 旧アダプターと古いテスト／bindings参照を削除し、SYSTEM・REVIEWの**現行状態**欄を実測に合わせて更新 | 新しい独自rate-limit stateなし。migrationコード・設定・検証結果のSHAを紐付ける |

**ロールバック:** WAFは影響のあるルールのみOperatorが戻す。Workerは既知の動作するnative binding構成へ戻し、該当Bindingを欠いたままfail-openさせない。初回移行で旧KV版へ緊急復帰する場合は1,000 Writes/日等の既知欠陥が再発するため、**自動ロールバック先とせず**オーナーによる明示的な例外判断と期限を必要とする。Binding未設定やGateway認証系の広域503が続く場合は適用を止める。

## 9. コスト・効果の評価式

- 現行: レートリミッターの`KV.put`回数は、その制限を**通過した**呼び出し回数の合計に等しい（ほかのKV書き込みは別）。`KV.get`は各`consume`呼び出しで1回。19キー／約4KBといった保存容量から操作回数を推定しない。
- 目標: 5種レートリミッターに起因する`KV.put`／`KV.get` = **0**、新規DO request/duration/storage = **0**、レート制限用D1 row writes = **0**。公開鍵・Digest索引による通常のKV操作は残る。
- Workersの通常リクエスト・CPU、WAFのZoneプラン・ルール請求、native APIの契約上の利用可否・課金条件は**現在のアカウントで確認が必要**。APIを使うだけで「総費用0」「永久無料」とは断言しない。
- 対象の既存ログからRouteごとの429/503、通常時の遅延・成功率、WorkersリクエストとCPU、KV Reads/Writes、DO request/Duration、D1の行数を切替前後で比較する。WAFによるEdge遮断はWorkersログに出ないため、WAF Security Events等のOperator観測と区別する。

## 10. 受入条件（実装Issueに引き継ぐ契約）

1. 5種類のレート制限が公式APIで動作し、`rate-limiter-kv.ts`とその`kv.put`経路は消えている。署名公開鍵・既存Digest索引は破壊しない。
2. 無効なBearerを毎回変更しても、トークン交換の**認証前**濫用抑制を回避できない。正規MCPクライアントの並列動作とNAT誤検知の評価を残す。
3. WAFに依存しない内部Gateway呼び出しも守られる。未検証caller IDや欠落した`CF-Connecting-IP`を全員共有の`unknown`へ押し込まない。
4. ReadyなRepository EntryはWake quotaを消費せず、実際のWakeは権限再確認、D1 CAS/冪等性／capacity／単一Writerを維持する。
5. Rate-limit拒否のGateway `429/RATE_LIMITED`、Binding障害時の`503`、認可拒否・失効・CSRF・Replay契約、single-use DOは維持される。WAFの応答相違は公開・内部クライアントで検証する。
6. 新しいDO、D1保存カウンター、KVレート制限カウンターはない。Cloudflareの実プラン・WAFルール干渉・権限・コストはデプロイ前に確認し、Production変更は別途オーナーの承認で実施する。

**未確認の外部条件:** 現在のCloudflare Zone/WAF契約、既存セキュリティルール、Binding namespace利用実態、Pod/Instance Access→Gatewayの実ネットワーク境界、Hosted実トラフィックと費用。未確認は未確認のまま記録し、Issue #13の文書PRをデプロイ権限の承認と解釈しない。

### 参照

- [現行SYSTEM：責務／データ正本](SYSTEM.md)、[EXECUTION：実経路とCloudflare呼出頻度](EXECUTION.md)、[REVIEW A-08：KV limiter既知問題](REVIEW.md)
- [Cloudflare WAF Rate Limiting Rules：Availability](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)
- [Cloudflare Workers Rate Limiting API：Configuration/Locality/Accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Workers Pricing：Workers/KV/DO](https://developers.cloudflare.com/workers/platform/pricing/)
