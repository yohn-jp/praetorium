# Praetorium — Three-VM Bootstrap履歴・残受入ゲート・Admin分離移行

> **Status:** 2026-10-24現在の**設計とゲート台帳**。2026-10-20の3VM構築は既に実施。旧「Runtime ServerからManagement Serverへ同一クラスタを移す」計画は**実施手順ではなく履歴**であり、現行の目標復旧手順として再利用しない。
> **Authority:** 最新オーナー指示 > [Epic #1](https://github.com/yohn-jp/praetorium/issues/1) / [docs/GOAL.md](../GOAL.md) / [Issue #31](https://github.com/yohn-jp/praetorium/issues/31) > [Management Architecture](MANAGEMENT-PLANE.md)と[Admin Architecture](ADMINISTRATION.md)。実装の受入は実機観測を必須とする。
> **Evidence cut:** [main@1930131e](https://github.com/yohn-jp/praetorium/tree/1930131e6858e5d9035abe1dcd82d4ae654c622d)。最新の記録済み3VM実測は**2026-10-20**（[THREE-VM-INFRA.md](../verification/THREE-VM-INFRA.md) / [FRESH-DEPLOYMENT.json](../verification/THREE-VM-FRESH-DEPLOYMENT.json)）。この時点以降のライブ状態は本書から推定しない。
> **Scope:** 設計と既存記録に基づく整理のみ。VM/Cloudflare/D1/DNS/Secret/イメージ/公開環境をこの文書の更新で変更しない。

## 1. 実施された3VM構成（旧文書の現状記述を上書き）

2026-10-20より前のTopologyはRuntime VM上のk3s ServerとBuilder上の独立BuildKitだった。実施後は次の**新規Bootstrap**に変わっている。旧Embedded-etcd datastoreとCAの継続、古いPod/Writer IDや未公開データの移行に成功したことを意味しない。

| 主体 | 2026-10-20実測（根拠） | 現行デザインの責務 |
| --- | --- | --- |
| Management VM | `manage.praetorium.vm`: `k3s.service` active、k3s Server Node Ready、管理Node taint。rootless Coordination/Tunnel active、k3s停止中のhealth検証と管理VM再起動後復帰を確認 | Cluster/Host管理、独立Coordination、VM横断read-only Observability |
| Runtime VM | `runtime.praetorium.vm`: 旧Server unit撤去、`k3s-agent.service` active、Runtime Node Ready、Scriptorium Pod Readyの観測 | k3s Agent、テナント実行、Ingress。Management Nodeにテナント配置しない |
| Builder VM | 独立rootless BuildKit + cache/cgroup/GCのサンプルを記録 | 信頼済みOCI artifact build。K3s Server/Agentや管理者SSHの代用にしない |
| Cloudflare | Management向けTunnel/VPC Serviceの作成、Coordinationへのlocalhost配送probeとControl Plane用Binding構成記録あり | Gateway/Control Plane/D1の既存権限と非公開Work通知、Admin専用read-only VPCを追加する目標 |
| Admin | `apps/gateway` がGatewayとAdmin両Originをホスト（2026-10-24 main確認） | 独立 `apps/admin` Workerで `admin.praetorium.yohn.jp` のみを担当 |

旧環境の破棄は**個別のオーナー承認に基づく過去の操作**であり、今後の一般的なテナントデータ破棄を承認するものではない。旧WriterへのQuiesce成功/旧Workの完全復元は主張しない。残された旧クラスターの暗号化バックアップは過去記録の扱いであり、現行クラスタの自動Rollback先ではない。

## 2. 検証済みと未確認を混ぜない

| 項目 | 記録された判定 | 根拠/残条件 |
| --- | --- | --- |
| Management k3s Server / Runtime Agentの役割 | **VERIFIED 2026-10-20** | Node label/UID、Host systemd、Agent URL、旧Server unit不在。FRESH-DEPLOYMENT |
| Management Tenant除外 | **VERIFIED 2026-10-20 topology** | management taint + runtime label。アプリ各種の新規Placementは個別の実Workload観測を要する |
| Coordinationのk3s停止時独立 | **VERIFIED BOUNDED** | k3s停止約1秒、rootless Quadlet/Tunnel継続。長時間障害soakではない |
| Management VM reboot recovery | **VERIFIED BOUNDED** | k3s/Coordination/Tunnel復帰、両Node Readyと既存Pod UIDを再観測 |
| VPC Service/Tunnelの資源/Config | **VERIFIED by config/deploy evidence** | 2026-10-20リソース作成と配備記録。現在のCloudflare live readback・外部Worker発通知成功は別 |
| Control Plane→VPC→Management→Worker実配送 | **NOT_CHECKED / full-path** | Source/Operation双方の本番通知、重複/欠落/再起動→再照合 |
| D1 Work/Releaseの安全な完全E2E | **NOT_CHECKED** | 実Release→BuildKit→署名Admission→Canary→Stable、G1–G9・Issue #31 |
| Admin独立Worker/Domain owner | **NOT_IMPLEMENTED at source cut** | Gateway Wrangler二つのcustom domain、`apps/admin` 未作成 |
| Admin 3VM observability | **NOT_IMPLEMENTED at source cut** | Observer/VPC/DTO/UIをこれから実装する |
| Cloudflare idle/active request実測 | **NOT_CHECKED** | Workers/D1/DOの実リクエスト/コスト。性能数値の推定不可 |

各検証の正確なTimestamp、CPU/Memory、UID、Secret漏洩を防いだ収集手順は[THREE-VM-INFRA.md](../verification/THREE-VM-INFRA.md)、[THREE-VM-CONTROL.md](../verification/THREE-VM-CONTROL.md)、[THREE-VM-ACCEPTANCE.md](../verification/THREE-VM-ACCEPTANCE.md)を参照。後者には**新規Bootstrap前の未完了ゲート表も残る**ため、必ず観測日時を合わせる。

## 3. 今後のMigration対象は「Server移設」ではない

旧文書のStage 0–8（Inventory→Backup→Management新設→Coordination→Datastore移設→Runtime Agent→Infra→通知→旧環境撤去）は、初期設計の**歴史的な代替ルート**だった。2026-10-20にはオーナー承認のfresh bootstrapが採用され、旧cluster/datastore継続の移行計画は実行しなかった。旧ルートを後追いで「全Stage PASS」としてはいけない。

残る作業は **いま稼働する新構成を前提とした運用とプロダクトの受入** である。

| 順序 | 作業 | 必須完了条件 |
| --- | --- | --- |
| 1. Live readback | 現行main、3VM systemd/Podman/k3s・Node/Pod、現行Cloudflare Workers/Tunnel/VPCの設定とorigin所有をread-only照合 | 現存Inventory・ソースcut・配備Digestが一致。2026-10-20の古い証拠を現時刻として表示しない |
| 2. Work delivery | 既存のD1永続要求→VPC/HTTPS hint→Coordination→Build Worker/Provisioner→claim/lease/reportを本番で検証 | 通知失敗・重複・順序違い・宛先停止・復旧後にWork欠落/二重実行がない。D1 fencing維持 |
| 3. Runtime/Build operational | 実Scriptorium/BuildKit・OCI・Releaseと元Workデータの安全性を検査 | [GOAL.md](../GOAL.md) G1–G9と[Issue #31](https://github.com/yohn-jp/praetorium/issues/31)の固定受入。UnverifiedとPASSを区別 |
| 4. Admin Worker split | [Admin Architecture](ADMINISTRATION.md) Gate A–C: 非公開Gateway Auth/Source Broker、新 `apps/admin`、service認証、custom domain切替 | Admin/Gateway Domain独立、セッション・CSRF・Service Binding・Source/Releaseと通常Gateway回帰。旧Gatewayへrollback可能 |
| 5. Read-only Observability | Admin Gate D–E: Management Observer・VPC・3VM Inventory/Host/Service/Dependencies・Desktop/Mobile | VM停止/部分障害/観測不能/stale、Failure Evidenceへの導線、Adminへのインフラ特権なし |
| 6. End-to-end operations | Admin Gate F: 実時間メトリクス/停止テスト/原状回復/コスト確認 | 最終Release cutに対する本番Worker/VM・ブラウザ結果、Rollback再演習、Idle常時Pollingコストの増加なし |

**独立タスクは並列に進められる。** ただし同じdomain route、認証契約、D1 migration、Worker config generatorの共有変更は単一の統合担当が所有する。ジョブ配送のQueues化をAdmin分離の前提にしない。

## 4. 変更不能なデータ・権限の境界

- D1がRepository Binding、Desired State、Build/Operation/Release、Auditの正本。k3s APIがPod/Node/Resourceの実状態の正本。GitHubが既に公開済みの原稿/権限の正本。Admin/Observerはこれらを複製して第二の正本にしない。
- 認証主体はGitHub OAuth/既存Gateway Session Storeのまま。Adminの独立Domainと独立WorkerはユーザーACLの独立実装を意味しない。Operator許可と一般Repository Adminを厳密に分ける。
- 最新のGeneration/Epoch、D1 CAS・Lease・Idempotency・署名/Artifact provenance、QuiesceとWriter absent evidenceを引き続き強制。古いNode/Pod UID、期限切れLease、Cloudflare通知ACKでは実行成功を確定しない。
- 動的Kubernetes resourceの所有はProvisioner、静的インフラ構成は既存のAnsible/Flux責務。Adminから任意 `kubectl`、systemd操作、BuildKit command、D1 UPDATEを行う経路を作らない。
- Build Worker→BuildKitのmTLS、Runtime Git credential、管理者用観測/Service Credentialは相互に分離し、それぞれの権限を狭くする。
- 旧環境の復元は現行クラスタのRollback操作ではない。現行クラスタに変更を伴う時は**その時点のDatastore/token/証明書とWork/Snapshotを取得して独立restoreで検証**する。

## 5. 通信・障害の受入マトリクス

| 障害/シナリオ | 期待動作 | 禁止される事象 |
| --- | --- | --- |
| Cloudflare通知が欠落 | D1の未処理Workを後続の再照合で回収。通知は実行権限でない | Work消失・永続滞留・再送による二重効果 |
| VPC/Tunnel Down | 管理者へUnavailable/stale表示、既存安全なfallback/recoveryに従う | 公開Management hostnameへの迂回・正本不整合 |
| Management k3s Server Down | Coordination/Observerは独立に起動しOS診断、Kubernetes操作は明示失敗 | k3s APIの通信失敗をWorker失敗/VM停止と同一視 |
| Management全停止 | 独立Admin UIで管理VMの観測不能と最後の取得時刻を表示（Auth Broker稼働時） | 偽Healthy・ブラウザのroot host credentials保持 |
| Runtime/Builder Down | Host別に障害表示、D1の未完了Workと実結果を分離 | Build成功/Writer absentを未観測で断定 |
| Gateway/Auth Broker Down | Adminはセッション認証不能ならfail closed、公開health等以外のデータを隠す | 認証抜き診断や第二ユーザーDBへの自動切替 |
| Control Plane/D1 Down | Canonical Release/Work操作を停止、観測可能なHost telemetryはそのまま別セクションで表示 | 失敗を空結果とする、直接D1書込 |
| Admin Worker Down | Gatewayの通常ユーザー/Scriptoriumは継続。break-glassは別入口 | Gatewayへ管理操作を無条件戻す |
| Browser失効/CSRF誤り | 明示的401/403・再ログイン、mutation副作用ゼロ | CSRF/Originバイパス、token漏えい |

Runtimeに2台目Agentを追加する際は、Managementのk3s Server/APIが単一点であること、Nodeの役割ラベル、Storage/PVC移動可能性、WorkloadのWriter排他、Ingress複数ノード、バックアップを別途検証する。**Agent増設はHA control-planeを意味しない。**

## 6. 実際に確認する証拠の最小セット

1. ソースmain HEAD、実デプロイWorkerのscript/version/hash、Gateway/Admin/Control Planeそれぞれのcustom domain所有者、設定生成物とCloudflare読戻し、operator allowlistとSecretの**名前**（値は出さない）。
2. 3VMのrole・Kernel・systemd/Podman/BuildKit/k3s/Node/Pod・Capacity、時刻付きCPU/Memory/Disk/GC、暗号化Datastoreバックアップ/復元可能性。read-only検証の実行時刻、環境、期待/実際。
3. 管理画面のGuest/非Admin/期限切れ/リプレイ/CSRF/正当Operator、Release/Source Retry、通常GatewayのOAuth、公開Scriptoriumの編集・Wake/Logoutの実操作。
4. VPC直接通知/HTTPS fallback/Build Worker・Provisioner停止→復旧/重複/古いAttemptの拒否、進捗と結果のD1 readback。
5. Browser desktop/mobile (320/375/390/430/1440)、最終観測時刻、サービス・ホストの部分故障、stable header、操作中のFocus/scroll維持、秘密情報非表示。
6. 新旧Cloudflare idle/active件数、D1 reads/writes/DO、Worker CPU、VM計測負荷とBrowserネットワーク。結果が欠けた項目はNOT_CHECKED。

本書は将来作業の完了判定を自動でPASSにしない。ライブ未確認の範囲はIssue/実行報告へ残し、設計と実装と本番の状態を一括して「完了」としない。

## 7. 履歴と参照

- 2026-10-20以前の旧移設計画: [旧Management Migration版](https://github.com/yohn-jp/praetorium/blob/1930131e6858e5d9035abe1dcd82d4ae654c622d/docs/architecture/MANAGEMENT-PLANE-MIGRATION.md)（当時の停止条件/Datastore別選択肢/Host構成。現在に適用しない）。
- 証拠: [THREE-VM-INFRA.md](../verification/THREE-VM-INFRA.md)、[THREE-VM-FRESH-DEPLOYMENT.json](../verification/THREE-VM-FRESH-DEPLOYMENT.json)、[THREE-VM-CONTROL.md](../verification/THREE-VM-CONTROL.md)、[THREE-VM-ACCEPTANCE.md](../verification/THREE-VM-ACCEPTANCE.md)。
- 固定設計: [MANAGEMENT-PLANE.md](MANAGEMENT-PLANE.md)、[ADMINISTRATION.md](ADMINISTRATION.md)。
- 製品受入: [GOAL.md](../GOAL.md)、[Issue #31](https://github.com/yohn-jp/praetorium/issues/31)、[Issue #26](https://github.com/yohn-jp/praetorium/issues/26)。
