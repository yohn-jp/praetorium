# Praetorium — 内部通信・タイマー・Cloudflareリクエスト台帳

> **種別:** **2026-10-20の特定main cutにおける内部通信監査**（`2f1369df9310ea61686e508fa055397fa72abbb1`）。本稿の周期や空振り回数は**コードからの推定**であり、2026-10-24のmain/本番の実測ではない。後続のCoordination/VPC導入は[MANAGEMENT-PLANE.md](MANAGEMENT-PLANE.md)と[THREE-VM-CONTROL.md](../verification/THREE-VM-CONTROL.md)、Admin Workerの追加観測と通信上限は[ADMINISTRATION.md](ADMINISTRATION.md)を参照する。  
> **目的:** 「何もしていない時のリクエストを極小化し、利用者数／実行インスタンス数の増加でも比例コストを抑える」。既存のLease、Writer排除、保存とリリース受入契約を捨てない。  
> **範囲:** 現行設計の棚卸しと優先順位の確定まで。**このPRでは通信周期・失敗時リトライを変更しない。** 参照先は改変しない実装の責務を示す。

## 1. 同じ「アクセス数」に含まれないもの

- **公開HTTP:** ブラウザ→Gateway、VM側のProvisioner/Build Worker→公開Control Plane、Gateway Credential Brokerへの直接HTTPなど。CloudflareのWorker `fetch` 呼び出しになる。
- **Cloudflare内部Worker Service Binding:** Gateway→Control Plane、Control Plane→Gateway。インターネットからの直接HTTPではないが、Workerの起動・D1操作・下流依存の処理コストがある。2026年のWorkers Cacheではcache HITでもWorkers request単価の対象となる場合がある。
- **Cron Scheduled Invocation:** `fetch` ではなくScheduled Worker起動。公開HTTPログのGET行からは直接分からないが、CPU/D1/その他の副作用を発生させ得る。
- **K3s内部:** Kubernetes APIのreadiness/writer censusやPod制御はCloudflare HTTPとは別。ScriptoriumのPod→Gateway／Control PlaneへHTTP送信する箇所は別途数える。
- **HTTP応答キャッシュ:** ユーザー/セッション/権限依存レスポンスは共有キャッシュしない。Workers CacheはCPU/D1処理の抑制には役立つが、cache HITを「請求対象のHTTPリクエスト0」と見積もらない。

## 2. 実装に存在する周期・契機

| 発生源 → 宛先 | 既定の周期・条件 | 目的 / 失敗時 | 無操作時の目安 | 実装 |
| --- | --- | --- | --- | --- |
| Control Plane Cron → D1/Release | **5分ごと** (`*/5 * * * *`)、1日288回 | 期限切れRuntime Git Credential最大64件の掃除、Release Discovery checkpoint（最大50件/ページ）、Promotion/Stable Rolloutの復旧 | Worker Scheduled起動は288/日。Release処理の追加D1/外部Registry通信は存在する作業に依存 | [wrangler](../../apps/control-plane/wrangler.toml)、[worker.ts](../../apps/control-plane/src/worker.ts)、[scheduled.ts](../../apps/control-plane/src/scheduled.ts)、[discovery.ts](../../packages/application/src/releases/discovery.ts) |
| Control PlaneのRelease Admission/Canary成果 → Release処理 | **イベント起動**：Operator Admission後の `waitUntil`、成功Build・Canary観測時 | スケジュール待ちを減らす既存の進行処理。Cronは通知喪失・再起動の復旧経路 | 0（イベントなしの場合） | [rollout-composition.ts](../../apps/control-plane/src/rollout-composition.ts) |
| Control Plane → Runtime通知受信器 | **WorkがD1に確定した直後**、build/operation単位、POST 1回。3秒タイムアウト | 作業ヒント `POST /internal/work-available`。通知が失敗してもD1処理はロールバックせず作業取得で復旧 | 0（Workなしの場合） | [work-notifications.ts](../../apps/control-plane/src/work-notifications.ts)、[work-notification-scheduler.ts](../../apps/control-plane/src/work-notification-scheduler.ts) |
| Provisioner → Control Plane `/internal/provisioner/claim` | **起動時・通知時・最長300秒の無Work待機後** | Durable Operationの取得と失われた通知からの回復。失敗すると5秒→最大300秒のバックオフ | Provisioner 1プロセスで概ね288回/日＋起動時。イベント時は増える | [worker.ts](../../apps/provisioner/src/worker.ts) |
| Provisioner → `/internal/provisioner/heartbeat` | **進行中のOperationのみ**、30秒Leaseに対して既定10秒。チェックポイント時は追加で権限更新し得る | Operationの所有/期限を維持。旧Workerからの二重副作用を防ぐ。失敗時は最大2秒の早期再試行 | **0（Operationがない場合）** | [worker.ts](../../apps/provisioner/src/worker.ts) |
| Build Worker → `/internal/builds/claim` | **起動時・通知時・300秒の無Work待機後**。失敗でも上限付き再試行 | Durable Build claimと通知喪失復旧 | Build Worker 1プロセスで概ね288回/日＋起動時 | [config.ts](../../apps/build-worker/src/config.ts)、[worker.ts](../../packages/application/src/builds/worker.ts) |
| Build Worker → `/internal/builds/{id}/heartbeat` | **ビルド進行中のみ15秒ごと**、Lease既定120秒 | BuildのLease・進捗・キャンセルとフェンス | **0（Buildなしの場合）** | [config.ts](../../apps/build-worker/src/config.ts)、[worker.ts](../../packages/application/src/builds/worker.ts) |
| Build Worker / Provisioner → 終端Report等 | **claim/進捗/リリース/停止など状態遷移時** | Build/Operationの結果確定、冪等性とWriter排除 | 原則0（Workなし） | [HTTP clients](../../apps/build-worker/src/http-client.ts)、[Provisioner client](../../apps/provisioner/src/operation-client.ts) |
| Provisioner Idle Controller → Control Plane `idle-candidates` | **プロセス起動時の全Inventory走査**（25件/ページ）、通知後はID単位の再取得 | 再起動後の観測対象/保存したアイドル期限の復元 | 起動時Nページ。**毎時間の全走査ではない**（最大1時間はローカル待機上限） | [idle-controller.ts](../../apps/provisioner/src/idle-controller.ts) |
| Idle Controller → Scriptorium status / Kubernetes inspection、必要時Control Plane | **各Runtimeの期限駆動**：期限が不確実/作業中/有意活動が不明なら5分後再確認。通常は最後の有意活動＋15分のdeadlineで確認 | 正規の活動・実行中Job・pending checkpoint・uncertain publicationを見ずに停止しない。失敗時は5秒→最大300秒バックオフ | 稼働Runtime数に依存。常時busy/unknownなら最大約288チェック/日/Runtime（1チェック当たり複数通信になり得る） | [idle-controller.ts](../../apps/provisioner/src/idle-controller.ts)、[idle.ts](../../packages/application/src/lifecycle/idle.ts) |
| Idle Controller → Runtime Identity更新・Canary health | **有効期限の90秒前**にCredentialを更新。Canary点の再確認は少なくとも300秒、必要なWorkがある時のみ | 時限Credential失効とCanary判定を防ぐ。状態不明をfalse Readyとして処理しない | 稼働Runtime/Canary数に依存。無Runtimeなら0 | [idle-controller.ts](../../apps/provisioner/src/idle-controller.ts) |
| Provisioner → Kubernetes Runtime API | **Runtime起動・停止の収束中のみ2秒ごと**、最大5分 | Kubernetesが実際にPod/ServiceをReady/Stoppedにしたかを確認する。**Cloudflare Control Plane HTTPではない** | 無処理なら0 | [kubernetes-lifecycle-adapter.ts](../../apps/provisioner/src/kubernetes-lifecycle-adapter.ts) |
| Runtime Auth Probe / Control Grant / JWKS | **Runtimeの入場・更新・認可検証時のHTTP**。コード上の単一固定周期はない | Secret/JWT署名、実行元とEpoch・適正アプリを確認。JWKSの実際の取得頻度はProducer側の呼び出し方を含めて別途測定 | 未知。観測ログに反復GETがあるが原因未確定 | [runtime-auth-probe.ts](../../apps/provisioner/src/runtime-auth-probe.ts)、[Control Plane JWKS](../../apps/control-plane/src/app.ts) |
| Gateway SSR画面 → Gateway → Control Plane | **実行中のみ最大5回**、1・2・4・8・16秒の指数間隔。入力編集中は停止 | 起動・Build進捗表示。リポジトリ一覧は表示時にアクセス可能なRepoそれぞれについてControl PlaneのBindingを参照 | ブラウザを閉じていれば0。操作中はSSR一回に複数Service Binding/D1参照 | [operations.ts](../../apps/gateway/src/ui/views/operations.ts)、[handler.ts](../../apps/gateway/src/ui/handler.ts)、[portal-service.ts](../../apps/gateway/src/services/portal-service.ts) |

**モデル上の目安:** 無Workで起動した各1プロセスとCRONのみなら、288（Cron）＋288（Provisioner空振りclaim）＋288（Build Worker空振りclaim）= **約864起動/HTTP要求・日**。ただしCronは公開HTTP要求ではない。実際には通知、K3s Runtime数、失敗再試行、GC、GitHub/Registry呼び出し等が加わるため、6,000件の内訳をこの式で説明したことにはならない。実際の値はWorker別・Path別・Invocation種別に測定する。

## 3. 現行のEvent/Hookと、維持すべき周期処理

**既に存在:** D1へのWork受入後にControl Planeが認証付きHTTPS POSTでVMへ通知する。Provisioner/Build WorkerともWorkAvailabilityで直ちにclaimし、通知が落ちた場合だけ最大300秒の復旧再照合を利用する。新しいWebhookレイヤーを増やす必要はない。

**維持すべきもの:**

1. **Lease Heartbeat（進行中だけ）**は単なるスケジューリングではなくOwner/Writerのフェンス。Webhook 1回や期限切れだけでは実行プロセスの停止を証明できない。
2. **最終活動のIdle期限、Credential有効期限、Canaryの時限観測**は現実の時間を使う。イベントに切替えても、通知喪失や再起動時に復帰するDurableな期限が必要。
3. **CRONの復旧スキャン**はイベント主導の漏れを回収する。Releaseごとに永続retry期限が存在するため、単に長周期へ変更すると配布遅延のSLAが変わる。
4. **K3s Pod/Service収束の2秒確認**は短時間のローカル操作内だけであり、無操作時のCloudflareリクエスト削減とは直結しない。

## 4. 最適化候補（追加実装なし。費用効果と安全性の順）

| 優先 | 候補 | 必要な実測/証拠 | 推奨する方向 |
| --- | --- | --- | --- |
| P0 | 空WorkのProvisioner/Build claimが本番で何回発生するか | Path・status(204/200/503)・時間・通知数・VM再起動/失敗を突合 | 既存通知を主要経路とし、復旧タイマーを維持。正常な空振りだけが主因なら間隔を再設計 |
| P0 | Idle Controllerの稼働Runtimeあたりの反復Control/Producer/JWKS取得 | `idle_candidate_page`・`idle_runtime_page`・`idle_*_retry`・`runtime_identity_refreshed` とHTTP取得元を突合 | 既存のdeadline journalを利用し、有意なActivity/Job/Checkpoint状態変化を認証付きEventで通知。停止直前と障害復帰時だけ必ず再確認 |
| P1 | Control JWKSの反復取得 | どのProducer/Probeが何秒おきにGETしているか、鍵の更新/失効SLA | 呼出側でKid/Keysetを短命キャッシュ。鍵ローテーション/緊急失効/失敗時のフェイルクローズ条件を先に固定。Worker Cacheで請求要求数が消えるとは想定しない |
| P1 | Release CRON毎5分 | 毎回のD1 Query数・候補0件比率・ロールアウト稼働中か・遅延許容 | Admission/Canaryの既存イベント処理を軸に、耐障害用定期チェックを必要最小頻度へ。Credential purgeは別周期へ分割する余地 |
| P1 | SSR画面更新とRepo一覧のN+1照会 | 1ページ閲覧当たりWorker内部RPC/D1/GitHub要求数、操作期間 | 変更されたOperation中心に進捗だけ送る方式（SSE/短命通知等）、または集約されたBatch取得。認証と個別リポジトリ権限を維持 |
| P2 | 再試行時の大量リクエスト | 503/401/409のPath・発生時刻・同一Operation ID | 真のエラー修正を優先。Retry/backoffの待機時間だけを伸ばして障害を隠さない |
| P2 | per-repository DNS publication | 旧ProvisionerのDNS `GET→POST/PATCH→GET` | **このPRで廃止**。DNSは静的ワイルドカード。Runtime置換でCloudflare DNS APIを呼ばない |

**関連する既存のコード不整合:** [Provisioner HTTP client](../../apps/provisioner/src/operation-client.ts) の `releaseRuntime()` は `POST /internal/provisioner/reservations/release` を送る一方、[Control Plane](../../apps/control-plane/src/provisioner-routes.ts) のリリースハンドラーは `POST /internal/provisioner/release`。この経路が実際に実行されれば404/再試行の原因となる。今回のURL/TLS/通信台帳PRでは修正せず、Lifecycle影響と既存テストを確認したうえで別の最小修正とする。

## 5. 計測と受入

デプロイ済みの設定変更や効果を推測しない。診断には同一期間（例24時間）の以下を収集する。

1. **Workerごとの起動種別:** `fetch`（公開HTTP）、Service Binding、`scheduled`、Durable Object、外部Subrequest、D1 read/write。Cloudflareのダッシュボード数値を単一のHTTP合計と混同しない。
2. **Path・メソッド・応答・呼出元:** `/internal/provisioner/claim`、`/internal/builds/claim`、`idle-candidates`、JWKS、Runtime状態観測、Error retry、Gateway SSR。API tokenや秘密値は一切記録しない。
3. **利用条件:** ブラウザなし・Runtime 0・Worker常駐と、Runtime 1のIdle、実際のBuild中、ページを開いた状態の差分を測る。
4. **運用指標:** 無操作の固定リクエスト/日、Runtime一つ追加時の増分/日、ユーザーセッション一つ追加時の増分、通知から開始までの遅延、失われた通知からの回復時間、Writer安全性。
5. **受入原則:** `Ready`やキャッシュHITを、Scriptorium作業回復済み/実接続成功と誤認しない。数値の削減と機能退行・安全性を別に確認する。

この文書は最適化の候補を分類したもので、6,000リクエストの原因や削減量を実測確定したものではない。
