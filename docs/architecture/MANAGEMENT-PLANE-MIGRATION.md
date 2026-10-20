# Praetorium — Management VM移行・Coordination導入の検証計画

> **状態:** [目標アーキテクチャ](MANAGEMENT-PLANE.md)に伴う移行設計。**本番操作用の実行手順や実施許可ではない**。現行main（確認時 `7194bb43275ccb7295b8f7e7f577450ea91aeabe`）からの段階移行のゲートのみを定義する。Ansible Role・Podman Quadlet・k3s移行コードはこのPRでは作成しない。
>
> **現状:** Runtime VM上にk3s Server + Provisioner / Build Worker Pod + Scriptorium、別Builder VMにrootless BuildKit。新Management VM、Server→Agent切替、VPC経路は未適用。

## 1. 移行の不変条件

1. GitHub repository ID、既存D1 Binding/Desired State、Runtime Epoch/Generation、OCI Digest、公開Scriptorium Originは変更しない。新VMを建てることを論理アプリ移行や新規Repositoryに見せない。
2. Gitにpush済みでないScriptoriumの仕事、待機中Checkpoint、PVCとアプリ内部データを破棄しない。**新ノードがReadyでも旧Writer死亡の証明ではない**。
3. Existing k3s cluster ID、CA、クラスタDatastore、Server/Agent joining token、cert-managerの鍵/SecretとTraefikのルーティングを追跡する。変更後の識別一致を検証するまで既存Serverを削除しない。
4. 未確認のDatastore形式（SQLite/embedded etcd/external）に対し、`k3s server`を`agent`に切り替えるだけの汎用的な移行手順を作らない。**最初に方式を発見し、実際の復元をリハーサルする**。
5. Management VMがk3s Serverを稼働しているかどうかとは独立してCoordinationがsystemdで起動できる。k3s依存のPod/IngressをCoordinationの唯一の保守入口にしない。
6. 旧Claim/Heartbeat/Report経路を無効化するまでは**新Coordinatorで同一Workを二重実行しない**。shadow観測は副作用なし。
7. 本番DNS・Proxmox設定・Secret回転・既存Work削除・新VM作成・旧VM解体はPRのマージで許可される操作ではない。

## 2. フェーズとゲート

| 順番 | 作業（実装時） | 事前/完了ゲート | 失敗時 |
| --- | --- | --- | --- |
| 0: Inventory | Runtime/BuilderのOS、現k3sのバージョン/Datastore/cluster ID、join token/CA、API SAN、Node、Static Add-on、PVC/StorageClass、Ingress、Secret、各System PodとWork状態を採取 | 稼働している実物に対する読み取り物証と対応するcommit SHAがある | **STOP**。仮定のまま移行方法を選ばない |
| 1: Backup | クラスタDatastore、token/CA/証明書、K8s manifest/Volume、D1の既存正本、重要Persistent Dataを切り分け、オフホストへ保護コピー | **別環境で復元を実証**。復元したクラスタID/Secret/Node/manifestと必要なPVC復旧性を確認 | **STOP**。バックアップファイルの存在だけでは不合格 |
| 2: Host provisioning | 新Management VMをオペレーターが準備。Ansible common/management roleによってsystemd、ネットワーク、K3s binary/config、監視、管理ユーザー等を構成 | Hypervisor非依存、再実行で非破壊収束、Cluster/token mismatchを拒否。まだ既存Serverは維持 | 新VMだけ停止し旧系継続 |
| 3: Coordination bootstrap | 管理用専用UID、rootless Podman、Quadlet、user systemd linger、Health/readiness、ログ、Digest pinning。既存Workの**read-only shadow**観測だけ | K3s停止中にQuadletが起動でき、不要なroot権限・cluster-admin資格情報を持たない | Coordinationのみ停止 |
| 4: Server migration | **確認したDatastoreに応じた個別移行**でk3s ServerをManagementへ移す。移行前のAPI/Pod状態をfreezeするかは安全契約に従う | 新Management ServerのAPI/Datastore/CA・Token/Cluster ID/Network設定が一致し、実Pod/Secret/CRD/Volumeが期待どおり | 旧Serverの復旧/戻し手順で停止。独立Serverを二重稼働させない |
| 5: Runtime as Agent | 旧Runtime VMをAgentにし、Management Serverを既定APIへ。後に2台目Agentを追加できるラベル/配置を構成 | Runtime Node Ready、正規の既存PVCと全Writerを保護。管理NodeにTenant Podが誤配置されない | Workload移動禁止。必要なら旧Server構成へ戻す |
| 6: Infra reconciling | Traefik/Flux/cert-manager/Ingress/Certificateの設定と所有者、k3s Server移設後のPrivate API接続、Caddy公開パススルーを照合 | Scriptorium公開Host/証明書/Handoff/停止FallbackとK3s ClusterIP/NetworkPolicyが正常。Static applyが二重所有でない | 公開移行を停止、旧Ingress/証明書/ルーティングを保護 |
| 7: Transport cutover | Workers VPC Serviceと認証済みManagement受信APIを検証。CoordinationからWorker/Provisioner/Builderへの指示、結果返却、未配達Work回収を実装 | 通知失敗・重複・再接続・再起動でWork欠落も二重実行も起きず、D1フェンス・GitHub権限は維持 | 現行の唯一のActive実行経路へ戻す |
| 8: Decommission legacy | 旧公開内部Webhook/Claim再試行を段階的に削減、不要なSecretや古いホストロールを計画的に撤去 | 実ログで旧経路の利用が0、コスト/復旧時間とBackout手順を確認 | 残存利用があれば削除延期 |

これらのゲートは**実装/導入フェーズごとに独立承認**する。すべて一度に動かす「一括移行」は採らない。

## 3. K3s Datastore別の判断（方式を決める前の調査）

| 実際に見つかったDatastore | 選択肢の扱い | 必須確認 |
| --- | --- | --- |
| Single Server SQLite | 古いServerから新Managementへ復元を伴う計画移行、または事前にEtcdへ移行したうえでServer参加を検討。**SQLiteを保持したまま別のServerを通常joinさせるとは想定しない** | shutdown/backup/restore整合、tokenとCA、同一Datastoreへ二重writer不可 |
| Embedded etcd | K3s公式手順に沿ってServer参加・member更新・退役を検討。HAとは別に一時的なmulti-serverを要する可能性 | Peer member、quorum、Network/Token一致、旧Serverの退役条件 |
| 外部DB | 外部Datastoreの権限・Endpointとバックアップを別途検証 | 同一クラスタ/CAの再接続、DBとk3s versionの整合 |

**禁止:** `k3s-uninstall.sh`やデータディレクトリ消去で手早くAgent化したことにする、Cluster-IDだけ合わせた独立クラスタを作って旧クラスタに接続済みとみなす、古いServerで残存するWriterの確認を飛ばす。

公式: [K3s Architecture](https://docs.k3s.io/architecture)、[Backup/Restore](https://docs.k3s.io/datastore/backup-restore)、[Server/Agent Token](https://docs.k3s.io/cli/token)。

## 4. Ansibleが提供すべき検証とインターフェース

- 同一Playbookは既存Linux VM、Proxmox guest、VMware guest、ベアメタルの**共通ホストロール**として動くこと。新規VM作成は入力条件であり変更対象外。
- `management` roleはピン留めk3s Server version、private bind/SAN、systemd、datastore/Token backupとhealth、管理ポート許可を持つ。rootless Podmanの要件は`coordination` roleに分離する。
- `runtime` roleはK3s Serverを起動せず、保護Token/EndpointでAgent join。Node role Labelと管理NodeのTaint/Runtime nodeAffinityが合うこと。
- `builder` roleはrootless BuildKitと既存mTLS/キャッシュ/リソース限界を維持し、K3s admin権限を渡さない。
- Ansible/OSの二重管理を避ける。既存NixOS Role利用時の設定権威は別に固定し、Ubuntu/Debian系への収束と同じセキュリティ契約を満たす。
- 結果に変更対象、実施/非実施、失敗時の残存状態、source version、host identityを記録する。資格情報や個人データはログ禁止。

## 5. Coordination Protocolの受入条件

### 5.1 Delivery

- D1にcommit済みのWorkだけを配送する。受領ACKと実行成功ACKを別に管理する。
- 通知の損失、ネットワーク断、Coordinator再起動でWorkが失われず、復帰後に未処理Workを再取得できる。
- Dispatcher重複や再送が発生しても`idempotencyKey`・`operationId`・`attempt`・`leaseEpoch`等の既存フェンスが有効。
- Public Control Planeが自発的にPrivate Management VMへ通信する時の第1候補はVPC Service。別のVMがWorker間Service Bindingを直接使用できると誤認しない。

### 5.2 Execution

- Build Worker/Provisionerが独立した認証主体で、任意の指示をK3s adminやBuildKit権限として実行しない。事前AdmissionとArtifact immutable identityを照合する。
- 長時間BuildのCPU/HeartbeatはVM側RPCに寄せる余地があるが、Cloudflare D1の状態確定とWriter排他は維持。
- Coordinatorがクラッシュした時点で、すでに発生した外部副作用をなかったことにしない。未知の結果は観測/照合してから再試行する。

### 5.3 Results

- VM側からの結果返却には、短い応答、認証済みoutbound callback、または再接続を伴う双方向経路のいずれかが必要。**採用方式は未確定。**
- 結果受信Workerはリポジトリの現行Epoch/Generationと署名/証拠を照合してD1に確定。通知元を信じて認可やWriter不在を省略しない。
- VPCのBindingは公開API露出削減に効くが、それだけでWorker InvocationやD1 query数が減るとは主張しない。

## 6. 非機能受入と撤退条件

| ケース | 実際に試すこと | 不合格 |
| --- | --- | --- |
| Management VM再起動 | rootless Quadletがログイン不要で再起動、k3s Server/APIとCoordinationの起動関係が循環しない | Kubernetesが停止したためCoordinationまで起動不能 |
| k3s API停止 | Coordinator healthは応答、K3s操作は明示失敗、OperatorがSSH/Ansibleから診断可能 | Pod内UIやAPI経由以外に復旧入口がない |
| Runtime Node 1→2台 | k3s Agent join後、2台で対象Workloadを適切にスケジュール。PVC移動可否を確認 | Agent追加でWriter二重化/PVC損失 |
| Builder切断 | Workは確定状態を保持し再試行、終了済み部分結果を成功扱いしない | ビルドが永久未解決/二重公開 |
| VPC/Tunnel断 | private ingress閉塞を検出し、復帰後Workを回収 | インターネット公開に逃がす/Work消失 |
| Cloudflare D1断 | Coordinatorは第二のDesired Stateを書かず、未報告Workの確定を保留 | 誤って成功扱い/再配布 |
| HTTPS/TLS | `*.scriptorium.yohn.jp`へのBrowser SNIがcert-manager/Traefikまで保たれる | Caddyが再度独自TLS終端/誤HostでHandoff不能 |
| アイドル負荷 | 無Work/Runtime 0、Runtime 1/N、Build中、ブラウザ操作のWorkers Requests/Scheduled/D1を分けて測定 | 固定リクエスト増・コストだけで改善を宣言 |

## 7. 制限・承認待ち

本PRでは移行対象VMの実数/OS、K3s Datastore種別、ライブPVC/Workload、通信VPCアカウント権限、Server endpoint、RPO/RTO、Ansible初期Roleの完全な受入値を確定していない。これらは**適用前の証拠とオーナー判断が必要**。この計画だけを根拠に変更を実行することは認めない。

最初の実装タスクは**読み取り専用のホスト現況調査とDatastore/Token/PVCの復旧演習**であり、Coordination VMのリリースやK3s Server移設をいきなり行うことではない。
