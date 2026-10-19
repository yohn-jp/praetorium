# Praetorium — 責務・通信・起動契機の再設計レビュー

> **状態:** 2026-10-20 現行main `7194bb43275ccb7295b8f7e7f577450ea91aeabe` を調査した設計監査。**実装変更を承認する仕様・新規要件ではない。** ユーザーが求める「不要なCloudflare Workersアクセスの徹底削減」に対し、現行機構と削減候補を分ける。実運用のログ・環境変数・通信費用は未実測であり、推定値と混同しない。
>
> 関連: [SYSTEM.md](SYSTEM.md)（actor/正本）・[EXECUTION.md](EXECUTION.md)（操作経路）・[INTERNAL-TRAFFIC.md](INTERNAL-TRAFFIC.md)（周期の台帳）・[REVIEW.md](REVIEW.md)（既知の整合性問題）。

## 1. 先に固定する原則

1. **イベントが主、期限・復旧は従。** Durableな要求を確定したら、通知によって実行担当を起動する。通知成功を永続処理成功とみなさない。通知喪失時の復旧は必要だが、一定周期の空振り要求を当然視しない。
2. **GitHubの現在権限が利用者認可のauthority。** 画面の描画や読み取り集約は最適化できるが、起動・停止・構成変更時に必要な最新権限と世代/期待値の検証は維持する。
3. **D1は制御状態の正本、k3sは実行状態、GitHubは作業成果の正本。** Control PlaneがPodの生存を常時ポーリングする機構にしない。ブラウザ/DOキャッシュをWriter存在の証明にしない。
4. **正本への書き込みを削減目的で弱めない。** 旧Writerの完全排除、quiesce、checkpoint、epoch/fence、署名・Artifact受入は維持する。Lease失効だけで旧Writerが消えたと扱わない。
5. **料金はInvocationと内部Subrequestを分けて測る。** Gateway→Control PlaneのService Binding、外部VM→Control Plane HTTPS、Cron Scheduled、Durable Objects/D1は別のコスト/ログ系列。
6. **新しいイベント基盤を無条件に作らない。** Control Plane→Provisioner/Build Workerの認証付き `/internal/work-available` 通知が既に存在する。追加のQueue/Hook/DOは既存通知が不十分である証拠が出た場合に限定する。

## 2. コンポーネントごとの責務と正本

| コンポーネント | 所有すべきもの | 受ける入力 / 発する出力 | 所有すべきでないもの |
| --- | --- | --- | --- |
| Gateway Worker | OAuth、ユーザーSession、GitHubアクセス決定、Portal、Runtime向けGrant・Handoff | Browser/GitHub → Control Planeの要求、ユーザー向け応答 | Runtime状態の永続正本、K8s監視、保存本文の中継 |
| Control Plane Worker | Repository Binding、Desired/Observed、Configuration、Build/Operation/Release queue、CAS/期限 | GatewayやOperatorからDurable要求→D1、実行担当へWork通知、Workerから報告 | 実Pod/Writerの生存判定、ユーザー本文の保存 |
| Repository Coordinator DO | Repository単位の変更の直列化（D1が結果の正本） | 対象の変更要求→Control Plane D1操作 | 第二の永続Desired State |
| Build Worker | 承認済みCompositionをBuildKitでビルド・署名・報告 | Build claim（受信通知/復旧確認）→成果/失敗Report | リリースの正本、アプリ実行の管理 |
| Provisioner | Runtimeの配置・停止・安全な置換、観測とOperation Report | Operation claim→k3sへ作用、Runtime状態観測→Control Plane | GitHubユーザー認可、リリースの正本 |
| Idle Controller（Provisioner内部） | 現在Runtimeの期限計画、観測と停止要求、再起動時復旧Journal | Deadline到来/通知/起動時Scan→Scriptorium/K8s確認→必要な停止Operation | 独立のユーザー状態DB、単独のWriter死亡断定 |
| Instance Access | 公開Hostでのone-use Handoff、Refresh、未稼働Fallback | Browser公開Host→Gatewayで再検証→Runtime/Portalへ | Runtimeの配置、権限正本、POST本文の自動再送 |
| Scriptorium Runtime | Git作業本文、活動・Job・Mutation・checkpointの実状態、quiesce | Browser/MCP直接アクセス→必要なプラットフォーム状態を公開/通知 | プラットフォームのDesired Stateや他Repo権限 |
| cert-manager/Traefik | k3sの公開TLS・Ingressルーティング | DNS-01で証明書更新、Host→ReadyなService | Runtime起動の決定、GitHub認可 |

**境界上の注意:** 現行Release進行はControl PlaneのCronだけでなくOperator Admission・成功Build・Canary観測から直接起動される。恒常的ポーリングが唯一の駆動機構ではない。

## 3. ユーザー要求からRuntimeまで：必要な通信だけを並べる

### 3.1 一覧と詳細の閲覧（Read Path）

1. Browser→Gateway（Portal）。Gatewayが現在のGitHubログイン・アクセス可能Repositoryを取得する。
2. **現行一覧**: `apps/gateway/src/services/portal-service.ts::listRepositories` はGitHub一覧の各Repositoryに `controlPlane.getByRepositoryId()` を `Promise.all` で発行。N個なら最大N回のService Binding呼び出し（接続先側で別Invocation/D1アクセス）。
3. **現行詳細**: `getRepository()` は権限確認とRepository一覧照会後に `getByRepositoryId()` と `getDashboard(instanceId)` を分離して実行。権限検証を単純に省いてよいわけではないが、同一表示の読取を集約できる。
4. **改善候補**: GitHubが許可したnumeric Repository ID群に対する **bounded batch read**。アカウント全件一括無制限ではなく上限/ページング、権限の交差検証、最新状態の確認は従来どおり。
5. **優先判定**: 読取を一括RPCにしてもDBがN SELECTのままならD1削減はない。新APIの採否はInvocation・D1読取・CPUの両方を比較する。

### 3.2 ユーザー操作（Write Path）

1. Gatewayが現在のRepository権限を照会し、特に変更操作では `authorizedManagement` がInstance・Dashboard・Binding・Epoch/Authorization Revisionを再検証。
2. Control Planeへ期待generation/epoch/冪等キーを含む要求を渡し、D1の正本を変更。Repository Coordinator DOは変更要求をRepository単位に直列化するが、D1のCAS/フェンスは残す。
3. Durable Build/Operationを確定した場合に対応Workerへ**ベストエフォートWork通知**（Control Plane `work-notifications.ts`）。通知送信そのものは後段WorkerのClaimを代替する権限ではない。
4. Gatewayの画面は進捗表示のため指数バックオフで最大5回更新（`apps/gateway/src/ui/views/operations.ts`、1/2/4/8/16秒）。このPortal更新1回には認可・Binding・Dashboard等の内部呼び出しが含まれ得る。Push/SSE化は対象が明確になってから検討。**開きっぱなしの定常ポーリングではない。**
5. **改善候補**: 一画面・一コマンド内の読み取り重複排除。変更前のフェンスとGitHubの現権限は維持。操作時にすべての全Repositoryを再取得する必要があるかはGitHub API利用形態を精査して判断する。

### 3.3 Build（ビルドが発生するときだけ）

1. D1へBuildを登録→Control PlaneがBuild Workerの認証付きReceiverへ `POST /internal/work-available`（3秒タイムアウト、失敗しても要求の成否は変更しない）。
2. Workerはプロセス起動・通知時に `POST /internal/builds/claim`。空なら既定 **300秒待機**→通知喪失時の復旧Claim。
3. Claim中はBuildKitによる実作業。Lease既定 **120秒**、Heartbeat既定 **15秒**、初期/最終の報告は別。Cancel/進捗に関わるためイベントだけに置換しない。
4. 成果をD1へReport。Control Plane側で成功時のRelease/Canary進行を起動可能。
5. **削減候補**: 無Work時の復旧Claimのみ。通知配送の信頼性を測らず30分に増やすと取りこぼし時の起動遅延が30分になる。HeartbeatはWork稼働中だけ発生し、放置状態の主要固定費ではない。

### 3.4 Provisioning（Runtimeを起動・停止・置換するときだけ）

1. D1にOperation→`/internal/work-available` 通知。Provisionerは起動・通知時に `/internal/provisioner/claim`、空なら既定 **300秒**待機。
2. 処理中のLease既定 **30秒**、Heartbeatは既定 **10秒**。Lease状態の検証なしにRuntimeの副作用を繰り返してはならない。
3. K8s収束待ちには短時間の**2秒間隔**観測があるが、これはVM→K8sのローカル観測であり、Idle時のCloudflare固定要求とは区別する。
4. Writerを排除し、quiesce/未公開成果/予約/世代フェンスを満たしたうえで実状態をControl Planeへ報告。
5. **削減候補**: 無Work時の復旧Claim（通知の実効性とのトレードオフ）、重複する同一Operationの参照、動作中ステータス取得。Lease/Writer安全性の短縮・削除は対象外。

### 3.5 Runtime活動・Idle停止（稼働インスタンス数に比例）

1. Idle Controllerは起動時にControl Planeの候補一覧を**25件/ページ**で取得してK8sの現実と照合し、Journalを復元。**周期的に全対象を5分ごとに再走査する実装ではない。**
2. 稼働RuntimeごとにK8sのProvider観測・Scriptorium `status()` から最後の意味ある活動、進行中API/MCP/Job/Mutation、pending Checkpoint、uncertain publicationを確認。
3. 正常でIdleに向かうRuntimeには「最後の有意活動＋既定 **15分**」をDeadlineとして記録し待機。Busy/状態不明/一部失敗なら既定 **300秒後**再確認。**1確認＝1 HTTP要求ではない**（Control PlaneへのCredential/状態照会、Scriptorium、K8s等を含み得る）。
4. Runtime identity refreshは有効期限の**90秒前**。Canary healthが必要な場合は保存済み予定・少なくとも5分の再確認基準がある。
5. Deadline到来時も、最後のステータスやActivityをそのまま停止許可とみなさない。現在のWriter/保存状態を再確認しControl Planeが安全な停止Operationを確定する。
6. **改善候補**: Activity/Job/Checkpointの**意味ある状態変化時だけ**Scriptoriumから認証付きイベントを通知し、既存のJournal Deadlineを再設定。忙しい状態を5分ごとに観測する経路を減らす。これは**提案**であり、未実装。通知が喪失しても停止側は現在状態を再検証し、安全側に失敗する。

### 3.6 リリース発見・昇格・保守CRON

1. `apps/control-plane/wrangler.toml`: `*/5 * * * *`（**288 Scheduled Invocation/日**）。
2. `worker.ts::scheduled` が毎回期限切れRuntime Git Credentialsを最大64件削除。Release Policyが構成されていると、`scheduled.ts` がCatalog Discovery（最大50件/ページ）とPromotion/Stable RolloutのWork進行を呼ぶ。
3. **既存イベント経路あり:** OperatorのRelease Admission後 `waitUntil(runStableReleaseWork(...))`、成功Build後、Canary health観測後に進行する。
4. **改善候補**: Credential purgeとReleaseの復旧スキャンの周期を分離。ただしCron分割を増やすだけではInvocation数は減らない。イベント優先にしたときの「通知喪失時にいつ再開すべきか」SLAを先に決める。
5. **注意**: Cronは公開HTTPログに`GET`として現れない。D1や外部通信の副作用は別。過去の6Kアクセスとの関連はPath別ログなしでは断定不可。

### 3.7 起動・Handoff・JWKS・アプリ本文

1. BrowserはGateway認証後、`<repository_id>.scriptorium.yohn.jp` へHandoff。稼働アプリ本文/UI/MCP通信は**Gateway Workerを通さず**直接Runtimeへ。
2. `*.scriptorium.yohn.jp` はDNS-only wildcard。k3s cert-manager/TraefikでTLS終端。DNSレコードはRuntimeごとに更新しない（この変更は前PRで導入）。
3. JWKS/Grant取得・Runtime Auth Probeは認可・Identity/Epochの検証目的。反復の発生源・更新/失効の要求期限を実測しないうちに共有キャッシュしない。
4. `Instance Access` のFallbackは停⽌時も到達可能でなければならない。閲覧リクエストを勝手に起動コマンドへ変換したり、POST本文を復元して再送しない。

## 4. 現行周期とコストの見積もり（実測ではない）

| 実行契機 | 既定 | 何もしていない時 | 主な変動因子 | 削減可否 |
| --- | --- | --- | --- | --- |
| Control Plane Scheduled | 5分・288回/日 | Scheduled 288/日 | Release work、Credential purge | **候補**。復旧SLA要確認 |
| Provisionerの空Claim | 300秒・約288 HTTP/日/worker | 常駐1 Workerなら約288 | レプリカ・再起動・通知・失敗 | **候補** |
| Build Workerの空Claim | 300秒・約288 HTTP/日/worker | 常駐1 Workerなら約288 | 同上 | **候補** |
| Provisioner Heartbeat | Work中10秒 | 0 | 並行Operationの長さ | **維持** |
| Build Heartbeat | Work中15秒 | 0 | Buildの長さ | **維持** |
| Idle状況確認 | 不明/Busy時300秒、通常期限駆動 | Runtimeがなければ原則0 | **Runtime数・状態** | **最優先候補** |
| Identity refresh | Expiryの90秒前 | Runtimeがなければ0 | Runtime/認証期限 | **要現状検証** |
| K8s収束確認 | 操作中2秒 | 0 | 起動/停止回数 | 原則維持 |
| Portal進捗画面 | 最大5回（1/2/4/8/16秒） | 0 | 操作中の画面数 | **候補** |
| Repository一覧 | 表示ごと最大N Binding RPC | 0 | **リポジトリ数** | **集約候補** |

**モデル上の無Work固定費**（1 Provisioner、1 Build Worker、1 CRON）: 約576外部HTTP/日＋288 Scheduled/日＝**864 Invocation相当/日**。Worker以外の内部HTTP、D1、DO、Auth、Release有効時の副作用、エラーリトライは含めない。CronとHTTPをCloudflareダッシュボードの同一カウンタと誤読しない。実際の常駐レプリカ数・本番環境変数・請求計上条件は未確認。

## 5. 再設計する順番（現状維持をデフォルト）

| 段階 | 監査する問い | 維持すべき契約 | 次に得るもの |
| --- | --- | --- | --- |
| A: 可視化 | 6Kのうち誰がどのPathをどの状態で呼んだか。CronとBindingは別計測できているか | Secret、個人情報、JWTのログ出力禁止 | 無Runtime/1Runtime/1画面の分解されたベースライン |
| B: Gateway Read Path | GitHub権限は維持し、N件のBinding照会と二重Dashboard取得を減らせるか | 現権限/Binding/世代チェック | 1ページ閲覧当たりRPC/DBのBefore-After |
| C: Idle/Runtime | どのBusy/Unknown状態が連続で5分再確認されるか。通知可能な変化は何か | 活動・checkpoint/quiesce/旧Writerの再検証 | 状態変化通知＋必要時の期限確認の小さな設計 |
| D: 空振りClaim | Work通知は本番で到着しているか。落ちた場合の許容復旧時間は | Durable Queue、失われた通知の回復 | 現行300秒からの変更要否 |
| E: Release/Cron | 毎回0件の処理と、本当に復旧に要る期限付きWorkは何か | Releaseの承認と再試行、Artifact不変性 | Cron頻度/責務の縮小案 |
| F: JWKS/Auth | 反復GETの発信者、kid/鍵更新/失効SLAは何か | 不正鍵・古いEpochを許可しない | 呼出元側で安全な再利用/無効化要否 |

**まず改善すべき実装は「何か新しいイベント機構」ではない。** 既存通知が使われていることを確認し、無Workの復旧照会・Runtime Busyの再確認・一覧N+1照会を独立して測り、各変更を小さく採用/棄却する。

## 6. 決定保留の項目と受入条件

- **本番値は未検証:** Release Policyの有効/無効、Build Worker/ProvisionerのReplica数、通知URL/Token、空Claimのレスポンス比率、JWKS取得元、Runtime数、Cloudflare Analyticsによる6Kの内訳。
- **SLAを先に選ぶ:** 通知喪失時の最大Work開始遅延、Runtimeの強制停止までの許容時間、短命キー失効の反映遅延。これらが決まらなければ新しいPolling周期は合理的に確定できない。
- **費用削減以外の指標:** 変更前後のInvocation・CPU・D1読取/書込・DO実行、通知到達率・作業開始遅延、Snapshot/Checkpoint復旧、単一Writer性。
- **明確に対象外:** 今回のドキュメントPRはAPI実装、CI変更、Cron頻度変更、本番デプロイ、スケジューラ/キューの新規採用を一切行わない。
- **個別の既知不整合:** `apps/provisioner/src/operation-client.ts::releaseRuntime` が `/internal/provisioner/reservations/release` を送る一方、Control Planeの処理ハンドラーは `/internal/provisioner/release`。通信削減のためにリトライ設定だけを変えず、経路契約として別途検証・修正する。

## 7. 調査根拠

- [Gateway Portal service](../../apps/gateway/src/services/portal-service.ts) — `listRepositories`、`getRepository`、`authorizedManagement`
- [Control Plane Worker/DO](../../apps/control-plane/src/worker.ts) — D1・Coordinator・Cron
- [Work notification sender](../../apps/control-plane/src/work-notifications.ts) と [scheduler](../../apps/control-plane/src/work-notification-scheduler.ts)
- [Build worker](../../packages/application/src/builds/worker.ts)、[config](../../apps/build-worker/src/config.ts)
- [Provisioner](../../apps/provisioner/src/worker.ts)、[Idle Controller](../../apps/provisioner/src/idle-controller.ts)、[Kubernetes adapter](../../apps/provisioner/src/kubernetes-lifecycle-adapter.ts)
- [Release scheduling](../../apps/control-plane/src/scheduled.ts) と [rollout events](../../apps/control-plane/src/rollout-composition.ts)
- [Portal progress](../../apps/gateway/src/ui/views/operations.ts)、[Instance Access](../../apps/instance-access/src/handler.ts)
