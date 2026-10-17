# Praetorium — 要件との乖離・設計負債・決定待ち

> **種別:** 要件ベースの設計監査台帳。ここにある「提案」は未承認であり、初期製品要件にない仕様を追加しない。  
> **検査対象:** `yohn-jp/praetorium@ecabf265693e395c40bfcf9be8279c1baf4740ff`  
> **要件基準:** [Epic #1](https://github.com/yohn-jp/praetorium/issues/1)、最新の明示的なオーナー指示（**CI許可**を含む）。  
> **用語:** **事象**＝ソースで確認済み、**問題**＝元の受入契約との衝突または測定可能な無駄、**提案**＝変更案、**要判断**＝仕様選択が必要。  
> 各主体の役割は[SYSTEM.md](SYSTEM.md)、HTTP/状態遷移は[EXECUTION.md](EXECUTION.md)。

## 1. 確定した事象と修正対象

### A-01 / P0 — Provisionerが空のOperationを毎2秒取得する

- **事象:** `apps/provisioner/src/worker.ts:63–66,390–408` は未処理がなくても`claimNext()`を繰り返す。`apps/provisioner/src/operation-client.ts`はCloudflare Control Plane HTTPへ転送。
- **なぜ問題か:** ユーザー操作・Build・状態遷移がなくても約129.6万回/30日/Podの空振りHTTP要求を作る。リソースの使用目的は**仕事の発見**であり、初期要件はこの頻度を指定しない。D1のCAS/リースは別責務。
- **必要な是正:** 作業登録時の通知または限定的な待ち受けを主経路とし、通知欠落・VM再起動時の未処理Operation回収だけを補償経路に残す。実装手段（webhook、long poll、Queue、専用接続など）はまだ選ばない。
- **受入:** 休止時のCloudflare通信件数、同時登録/二重通知、ネットワーク断→復帰、worker再起動、lost lease時の旧Writer遮断を実測する。

### A-02 / P0 — Build Workerが空のBuildを毎1秒取得する

- **事象:** `packages/application/src/builds/worker.ts:96–119`、`apps/build-worker/src/config.ts` 既定`PRAETORIUM_BUILD_IDLE_DELAY_MS=1000`。`apps/build-worker/src/http-client.ts`がControl Planeの`/internal/builds/claim`へアクセス。
- **なぜ問題か:** 約259.2万回/30日/Podの空振り通信。BuildKit自体のGC・イメージ構築とは無関係。
- **必要な是正:** D1のBuild登録・受入をトリガーにworkを発見する。Build Key共有/claim/attempt/heartbeatの所有権安全性は維持。Build VMを追加する必要はない。
- **受入:** 同じBuildInputから一つの結果、キャンセル/failed build/late reportの正しい処理、空振りCloudflare通信の削減。

### A-03 / P0 — Idle・Runtime Identity・Hosted受入検査が1分ループへ結合

- **事象:** `apps/provisioner/src/idle-controller.ts:240–450` は60秒ごとにD1の候補ページを取得し、K8s status、認証付きScriptorium Statusを検査、Runtime Identityを更新。`recordHealthSample()`で`authProbe.verifyObserved()`（実UI/API/MCP/不正Grant/永続性検査）を実行しD1にHealth Evidenceを保存しうる。
- **なぜ問題か:** Idle期限の判定はScriptoriumの活動時刻と期限に基づくのに、全体スキャンとフル受入試験を起動契機にしている。Cloudflare D1照会とCredential発行が候補数に依存して増える。Probeは初回のHosted受入・更新後の検証に正当性があるが、通常時の毎分再実行を正当化しない。
- **必要な是正:** ①活動期限検知、②停止権限確認・Quiesce、③Runtime Identity更新、④適合性/Health evidenceの取得を別のTriggerへ分ける。期限の永続化先（Scriptorium、VM supervisor、D1フィールド）は再起動・通知欠落を踏まえて決める。
- **受入:** 15分Idle条件、活動中ジョブ/未公開変更/不明な永続性で停止しない、VM/Pod再起動後の停止判断、期限が来るまでCloudflareへ全件照会しない、受入検査は所定イベントに限られる。

### A-04 / P0 — Runtime Identity更新は現状Idle監視に依存する

- **事象:** `apps/control-plane/src/runtime-identity-routes.ts`はJWTのTTLを300秒として発行。`apps/provisioner/src/kubernetes-lifecycle-adapter.ts:356–430`には期限更新処理があり、`idle-controller.ts:337–345`もこの処理を呼ぶ。
- **なぜ問題か:** A-03のIdleループを単純に停止させると、長時間動いているRuntimeのIdentity更新が途絶え、必要時のGitHub credential brokerが使えなくなる可能性がある。これは周期通信削減と独立した可用性問題。
- **必要な是正:** 有効期限に基づく**必要なRuntimeのIdentityだけ**の更新と、Epoch/Binding無効化時の停止を明示し、Idle・Acceptanceに依存させない。
- **受入:** 5分超の連続使用・Git fetch/push、失効/権限剥奪、新旧Epochの競合、Control Plane到達不可、VM再起動後の更新経路。

### A-05 / P1 — Cronが不要なD1の読み書きを継続し、未設定Releaseで失敗する

- **事象:** `apps/control-plane/src/worker.ts:308–315` が5分ごとにCredential期限切れ回収、GC計画、Release進行を結合。`cache-maintenance.ts`の計画は`advisoryOnly=true`で実際の削除を行わず、毎回`audit_events`へINSERT。`RELEASE_POLICY_JSON`等がなければ例外を投げる。
- **なぜ問題か:** オプション機能の未設定がCronをerrorにし、保守の周期起動と実際の副作用に整合がない。動的なOCI削除ではない監査レコードを継続追加する。
- **必要な是正:** 期限切れcredential回収、Cache GC判断、Releaseワークフローを独立に起動。ポリシー未設定は明示した未有効状態とし、関連しない処理をエラーに巻き込まない。GCの計画と実行を明確化し、意味のない重複監査は生成しない。
- **受入:** Release無効時も他の保守が成立、同一入力時に無意味な監査増殖なし、既存参照中Artifactを削除しない、再試行/期限処理が欠落しない。

### A-06 / P1 — Release候補の探索は外部の発見処理ではなくD1の再走査

- **事象:** `packages/application/src/releases/discovery.ts` は`release_candidates`の既存行をcheckpoint付きでページ走査する。登録元はOperatorの`POST /v1/operator/releases`（`apps/control-plane/src/releases/operator-admission.ts`）。
- **なぜ問題か:** 候補登録時点で仕事が発生したことを知っている。5分間隔の全候補探索は主Triggerとして必須ではない。Canaryの健康窓とretryAtは別途「期限到来」を扱えばよい。
- **必要な是正:** Admission・Build結果・Canary期日・Rollout進行を明確な状態遷移イベントに分解し、期限/失敗の補償だけを分離。
- **受入:** 認可済みリリース登録→Canary→Stable/Pinnedの合意済み動作、5/10分の遅延や失敗後の復帰、二重実行・重複昇格なし。

### A-07 / P1 — Gatewayがリクエスト毎に鍵・KV初期化を行う

- **事象:** `apps/gateway/src/worker.ts`はすべてのHTTPリクエストで`createGatewayContext`を呼び、`apps/gateway/src/context.ts:222–267`で署名秘密鍵をimport、`GATEWAY_KV`から公開鍵Registryをgetする。
- **なぜ問題か:** `/healthz`等の鍵検証を要しない処理にも初期化I/Oがかかり、CloudflareのKV read/CPUと障害の影響範囲が広がる。
- **必要な是正:** 静的構成の検証と要求依存リソースを分離し、公開鍵の更新・失効反映時間を定義した上で安全にキャッシュまたは遅延初期化する。
- **受入:** Healthと静的リソースが無関係なKV障害で落ちないこと、Signer rotation/revocation動作、意図しない署名鍵の再利用・権限上昇なし。

### A-08 / P1 — KV Rate Limiterを強制上限とみなせない

- **事象:** `apps/gateway/src/adapters/rate-limiter-kv.ts`は`get→count+1→put`で更新し、ソースコメントでも非原子的であることを認める。
- **なぜ問題か:** 同時多数のリクエストが同じ旧値を読めるため、単純な「1件だけ取りこぼす」とは限らない。資源起動や認証周辺の**課金・濫用上限**としての保証にならない。
- **必要な是正:** 目的別にbest-effort抑制と厳格な負荷上限を区別。必要な部分だけ原子的な資源上限/DO/別の予約制御に委ねる。
- **受入:** 同時Wake/認証リクエストでの上限、許可判断のフェンスとD1側の重複抑止、Cloudflare消費の測定。

### A-09 / P1 — 静的Deploymentの管理経路が複数ある

- **事象:** `infrastructure/flux/platform.yaml`は`suspend: true`かつ`prune: true`、`scripts/deploy-k3s.mjs`はKubernetesリソースへ直接`kubectl apply`する。Flux ControllerとHelmは別途インストール。
- **なぜ問題か:** いずれのツールが静的platform manifestの継続的な管理者かが不明瞭。将来`suspend`を解除すると差分やPruneの扱いに不整合が生じうる。
- **必要な是正:** Static resourceの適用正本を1つに固定する。Dynamic tenant workloadはProvisioner所有のまま分離し、削除を行う前に所有権を確認。
- **受入:** 実環境を壊さずにcontroller/Secret/Platformの更新とrollback、反映後のdiffと不要Pruneの否定を検証。

### A-10 / P1 — 実Hosted経路は未合格

- **事象:** `docs/verification/HOSTED-ACCEPTANCE-a669f5c.json`では`workers-d1-do`以外の固定受入カテゴリはBLOCKED。`docs/verification/UBUNTU-2604-20261017.md`は2VMのhost/rootless BuildKitを実証するが、Hosted login→実Scriptoriumの保存・停止・復旧までの試験ではない。
- **なぜ問題か:** ホストがReadyでもProductの入口、Provider間の認証、TLS公開終端、実作業データの保全は別。
- **必要な是正:** 新設する実装の前に、既存経路の所有資格・Secret・Artifact・HTTPS/DNS/Ingressを接続し、初期Epicの7つの実受入分類を実行。
- **受入:** GitHub access、BuildKit/Registry、Kubernetes isolation、Browser entry、Producer recovery、Stable rollout、Workers/D1/DOを同一改訂・成果物で実証し、未実行は未実行と報告。

## 2. 「悪い実装」と断定しない境界（維持または要判断）

| 対象 | 現在の根拠 | 判断 |
| --- | --- | --- |
| D1の世代・CAS・冪等キー | 同一Repositoryの一つのWriter、リトライ・競合防止 | **維持**。変更通知の導入とは独立 |
| Operation/Buildの短時間Lease/Heartbeat | ワーカー停止/二重報告の防止 | **維持**。ただし空振りWork検索のためにHeartbeatは不要 |
| Quiesce/Writer census/credential retirement | 未公開原稿・古いGit Writerを守る初期要件 | **維持**。K8s Pod ReadyやLease expiryでは代替不可 |
| OCI Digest/署名/Closure/Smoke | 任意の不正ビルドや壊れたModule closureを拒否 | **維持** |
| KubernetesのLiveness/Readiness | コンテナの死活をK8sが扱う | **維持**。Control Planeによる周期的な「死活管理」は不要 |
| RepositoryCoordinator DO | D1 CASに加えて一部変更要求を同一Repoで直列化 | **要判断**。DOに永続正本はなく、必要性・対象API・コストを再検証する |
| UserAuthState/EphemeralCode DO | 原子的なセッション/one-use consume/token refresh | **必要性の根拠がある**。DOという製品名だけを理由に除去しない |
| 公開JWK Registry用KV | 読み取り中心の公開情報 | **維持候補**。再読込頻度と失効契約を再評価 |
| Instance Access fallbackと同一origin | 停止中URLからの起動・Cookie・API retry | **維持**。通常の原稿本文をWorkersへ戻さない |
| CI / GitHub Actions | **最新のユーザー指示で許可** | **違反ではない**。Release公開や本番適用は別権限で扱う |
| 独立Build VM＋K3s Runtime VM | Runtime管理資格とrootless BuildKitの隔離 | **現行ホストの事実**。再設計要求なしに統合しない |

## 3. 仕様決定がないため作れない「正解」

**以下は未決定として残す。実装便利のために新設した要件へ格上げしない。**

| 決定テーマ | 既に必要と確定している契約 | 選択が必要な内容 |
| --- | --- | --- |
| Work取得 | D1がOperation/Build正本、世代/Lease/結果報告が有効 | VMへどう通知するか。接続断とVM再起動からの復帰、最悪遅延、Cloudflare通信量 |
| Idle停止 | 15分の有意活動なし、Quiesce・pending工作・Writer確認 | タイマー保管場所、再起動時の期限復元、イベントの認証、D1 CAS更新のタイミング |
| Runtime Identity | Repository/Epochに拘束、期限失効・撤回の反映 | 長時間稼働中の更新主体とネットワーク断時の扱い |
| Release進行 | 明示的Operator受入、canary、Stable/Pinned制約 | 入力時の進行、Canary健康窓の期日通知、遅延再試行、補償頻度 |
| DO Coordinator | 既存D1 CAS、同一Repoの一意性 | 永続DO保存がない現実を踏まえDOを残す必要があるか |
| Runtime Policy | K8s既存のLiveness/Readiness + Scriptoriumの意味的状態 | 継続観測と変更時の受入証拠をどう分離するか |
| Cloudflareコスト | VM内の常駐は利用可能、Cloudflareは使用従量が別 | アイドル時許容リクエスト数、最大スケール、監査/メトリクスの集約と測定基準 |
| GitOps/運用 | 動的RuntimeはProvisioner、静的Manifestは承認済みInput | Static Fluxとdeploy CLIどちらが最終的に反映を管理するか |
| 公開HTTPS | Stable origin、直接bookmark、API/MCP | 実際のTLS終端・複数ラベルのWildcardとネットワーク到達性 |

## 4. 既存資料の扱い

- [SYSTEM.md](SYSTEM.md) は**現状に基づく責務台帳**、[EXECUTION.md](EXECUTION.md) は**動作トレース**、この文書は**差分台帳**。どれもEpic #1の上位権威ではない。
- [PLATFORM.md](PLATFORM.md) は移行開始時の**設計案と当時の契約説明**、[SCRIPTORIUM-CONTRACT.md](SCRIPTORIUM-CONTRACT.md) はProducer側との詳細ワイヤ契約・歴史を保存する。
- [migration/PLAN.md](../migration/PLAN.md) はT00–T15の**実装計画の歴史**であり、将来の変更を強制するプロダクト要件ではない。
- [verification](../verification/)はコミット・環境に拘束された**物証**。`FINAL.md`などの名称だけで最新の合格を表さない。
- 現在の多数のDocを削除・統合コピーして参照や物証を失うことはしない。入口を[docs/README.md](../README.md)へ固定し、歴史資料の正本性を下げる。

## 5. 修正の順序（提案。未実装）

1. **Control Planeへの不要なCloudflareリクエスト発生源を列挙・実測**。特にBuild/Operation空振り、Idle候補走査、Status発行、毎分Probe、Cron監査。まず副作用と回数のベースラインを取得する。
2. **実行契機を分割**。通知/期限/権限検証/受入検査/GC/復旧は同一ループに入れない。D1を正本、K8sを実状態として維持。
3. **既存の安全フェンスを保持したまま通信を切る**。Operation・Build・Writerの二重化を再現する回帰試験が通ることを確認。
4. **Staticデプロイの単一管理方式と公開TLS経路を確定**。Hostedのエンドツーエンド実証を妨げる未設定を明示的に解消。
5. **Hostedを実データで受入**。更新・停止・再起動・Git保存・ブラウザ復旧まで同じ記録上で評価し、結果を現行mainのコミットに紐づける。

**CIの検証実行は最新のオーナー指示で許可されている。** 本監査文書の作成はコード変更・本番Cloudflare/K8s適用・リリース公開を新たに許可するものではない。受入条件と検証環境を固定した後、最小変更単位で修正する。
