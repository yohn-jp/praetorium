# Praetorium — Management / Coordination / Execution 分離アーキテクチャ

> **Status:** 2026-10-20 オーナー合意済みの**目標アーキテクチャ**。本書の追加だけでは実装済み・移行済み・Hosted受入済みとはしない。
> **Source baseline:** [main@7194bb43275ccb7295b8f7e7f577450ea91aeabe](https://github.com/yohn-jp/praetorium/tree/7194bb43275ccb7295b8f7e7f577450ea91aeabe)。最新の明示的指示と[Epic #1](https://github.com/yohn-jp/praetorium/issues/1)が製品要件の上位正本。
> **Read alongside:** [SYSTEM.md](SYSTEM.md)（*現行実装*）、[EXECUTION.md](EXECUTION.md)（現行経路）、[INTERNAL-TRAFFIC.md](INTERNAL-TRAFFIC.md)（周期）、[ADMINISTRATION.md](ADMINISTRATION.md)（管理UI）。移行計画は[MANAGEMENT-PLANE-MIGRATION.md](MANAGEMENT-PLANE-MIGRATION.md)。

## 1. 何を解決するか

現行PraetoriumはRuntime VMがk3s **Server**とScriptorium実行を兼ね、Build WorkerとProvisionerもRuntimeクラスタ上のPodである。一方Builder VMには独立したrootless BuildKitがある。ホスト・k3s自体の故障から復旧するための管理主体が不明確で、Cloudflare Control Plane / D1とExecutionの間に実行調整・通信集約の責務が分散する。

目標は**3VMを責務で固定**し、Proxmoxを前提としないホスト構築、Runtime Agentの増設、k3s障害中でも起動する管理サービス、通知を主とする内部通信、既存のWriter安全性を同時に達成することである。

本書は**現在の実装を追認しない**。Cloudflareリクエスト削減量、Workers VPCの実接続、マルチノードのストレージ継続性、旧RuntimeのK3s Serverを安全に移す手順は未実証。

## 2. 確定済みの構成決定

| 決定 | 採用 | 明示的な非採用・範囲 |
| --- | --- | --- |
| ホスト役割 | **Management / Runtime / Builder** の3種。Runtimeは必要に応じて複数台 | Proxmoxへの固定、Managementへのテナント実行集約 |
| k3s Control Plane | **Management VM上のk3s Serverをホストのsystemdサービスとして稼働** | Managementのk3s ServerをPodmanコンテナ・k3s Podとして運用 |
| Runtime VM | **k3s Agent**。Runtimeを増設しても同じManagement Serverへ参加 | Runtime VMがServerを兼ね続ける構成 |
| Coordination Plane | **Management VMのk3s外**、**rootless Podman + Quadlet + user systemd** | k3s内Podとして起動、root権限コンテナやDocker Socketへの依存 |
| ホスト構築 | **AnsibleでOS/ホスト設定・ロールを収束**。Hypervisor固有処理は境界外 | Proxmox APIやVMware固有コードが製品の必須依存になる設計 |
| Builder VM | 既存の独立rootless BuildKitとキャッシュを維持 | Builderへのk3s Server/AgentやテナントWriter権限の付与 |
| コントロール正本 | GitHub権限・D1状態・既存のOperation/Build/Release契約は継続 | Coordination側に第二のDesired State正本を作ること |
| ネットワーク | 内部サービスは原則**非公開**。CloudflareからManagementへのプライベート通信を検討し、ホスト内の通信はローカルRPC | 内部Claim/Webhook/APIをドメイン単位で公開することを前提とする運用 |
| スコープ | アーキテクチャ定義と移行の受入条件まで | VM新設、Ansible Role追加、Quadlet実装、K3s移行、Secrets変更、WAF/DNS/Workers変更 |

**決定と未決定を区別する:** Work配送方式（WebSocket/HTTPS・再送）、Build Workerの最終配置、Provisionerのプロセス分割、k3s Serverの現在のDatastore種別、静的リソースのFlux/kubectl単独所有は**本書では製品契約として未確定**。設計候補と検証ゲートを後述する。

## 3. 目標トポロジー（物理VMと論理Planeを分ける）

~~~mermaid
flowchart TB
    User["Browser / GitHub user"]
    Cloud["Cloudflare: Gateway Worker / Control Plane Worker / D1"]
    User --> Cloud

    subgraph Management["Management VM — OS / systemdが所有"]
        K3S["k3s Server: API / Scheduler / Datastore (host systemd)"]
        Coord["Coordination Plane (rootless Podman Quadlet / user systemd)"]
        Tunnel["Private connector / cloudflared (host-managed, proposed)"]
        Coord -->|"Scoped Kubernetes API (private)"| K3S
        Tunnel --> Coord
    end

    Cloud -->|"Workers VPC Service binding (candidate)"| Tunnel

    subgraph Builder["Builder VM — 独立Linuxホスト"]
        BuildKit["rootless BuildKit + OCI cache"]
        BA["Build execution agent (target; placement gate)"] --> BuildKit
    end

    subgraph Runtime["Runtime VM #1 … #N — k3s Agent nodes"]
        Agent1["k3s Agent #1"]
        Agent2["k3s Agent #2 (future)"]
        App["Scriptorium Pods / Instance Access / Traefik"]
        Agent1 --> App
    end

    K3S -->|"control-plane connection"| Agent1
    K3S -->|"control-plane connection"| Agent2
    Coord <-->|"private scoped execution messages"| BA
    Coord <-->|"private scoped Provisioner operations"| K3S
    App <-->|"user work / Git credential broker"| User
~~~

概念図であり、`Agent #2`は将来の増設例で**設置済みではない**。`Coordination`は**独立したOSサービス**で、k3s APIが止まってもsystemd/Podmanは起動できる。ただしk3s APIに対する操作が可能とは限らない。Build execution agentの移設時期・実装方式は未確定。

### 3.1 プレーンと配置を混同しない

| 論理責務 | 目標の配置 | 状態の正本 / 機能 |
| --- | --- | --- |
| User / Public Control | Cloudflare Workers + DO + D1 | GitHub現在権限、セッション、承認済みDesired State、Build・Operation・Releaseの確定履歴 |
| Infrastructure Management | Management VMのホストsystemd、Ansible | k3s Server/クラスタAPI、ホスト構成、監視、再構築・復元の入口。**D1の代用ではない** |
| Execution Coordination | Management VM rootless Podman Quadlet | 配送、イベント受信、内部実行の仲介、期限・再試行のトリガー、正本への確認済み報告 |
| Runtime Execution | Runtime VM上のk3s Agent・Pod | 実Scriptorium Writer、Instance Access、Ingress、Runtimeの実観測 |
| Artifact Build | Builder VM上のrootless BuildKit | 承認済みArtifact生成とローカルキャッシュ。最終的なRelease Admissionは引き続きControl Plane |
| Provisioning | Coordination管理下の実行責務（最終プロセス/配置は別途設計） | Kubernetesへの適用、Quiesce、旧Writer不在証跡、予約・観測。**K3s管理とテナント管理の権限を混ぜない** |

Management VMのk3s Serverは通常kubelet/コンテナRuntimeも備える。**単にServerを移動するだけではRuntime Podが管理ノードに載らない保証はない**。管理ノードのTaint/Label、Runtime workloadのnodeAffinity/Topology Spread、Traefik等のSystem Podの配置許可、K3s ServiceLBを含むIngress経路を別途定義・検証する。

### 3.2 境界をまたぐデータフロー

~~~mermaid
sequenceDiagram
    actor User
    participant G as Gateway
    participant C as Control Plane / D1
    participant M as Management Coordinator
    participant X as Provisioner / Build executor
    participant K as k3s / BuildKit

    User->>G: authorized command
    G->>C: validated desired state + idempotency + generation
    C->>C: durable record first
    C->>M: private work hint / delivery request
    M->>C: acknowledge delivery (not execution success)
    M->>X: private execution instruction
    X->>K: bounded effect / observe
    K-->>X: actual outcome
    X-->>M: progress / evidence
    M-->>C: authenticated result synchronization
    C->>C: fenced outcome persisted to D1
~~~

**通知は権限移譲でも成果確定でもない。** 配送・実行権・結果反映の契約は別。Cloudflare WorkerからVMへのプライベート呼び出しができても、長時間処理を単一Worker `fetch()`の応答が返るまで待たない。

## 4. Management VMの起動・障害境界

| サービス | ランタイム / 管理元 | 起動依存 | k3s API異常時 |
| --- | --- | --- | --- |
| k3s Server | **ホストsystemd `k3s.service`** | ホスト、private network、datastore、トークン | 診断・再起動・復元はOS側から扱う |
| Coordination | **専用非root UIDのrootless Podman Quadlet `praetorium-coordination.container`** | network、user systemd、イメージとファイルベースSecret | サービス自体は稼働可能。K3s変更要求は失敗として記録・待機 |
| プライベート接続 | クラスタ非依存のhost-managed `cloudflared` 等（通信方式が決まってから） | 外向きネットワーク、限定Tunnel資格情報 | Cloudflareとの状態交換は継続可能 |
| Ansible | 管理端末/独立Operatorからロール収束 | SSH/private network、許可された保守操作 | kube-apiserverに依存せずOS/systemdを保守する。**勝手にノード初期化しない** |
| Flux/Helm/Traefik/cert-manager | k3s内の宣言的基盤 | Kubernetes APIが健全であること | k3s Serverの起動/復旧手段にはならない |

Podman Quadletのrootless unitは専用サービスユーザーのuser unitとして配置する。`/etc/containers/systemd/users/<UID>/` または対応するuser設定ディレクトリ、`loginctl enable-linger` によるboot時ユーザーManager、`systemctl --user` の管理を**Ansibleが明示的に設定・検証**。通常のsystem `User=`指定ではrootless Quadletにならない。

- `k3s.service` に対する `Requires=`/`After=` をCoordination Quadletに付けない。復旧対象への起動依存を作らない。
- Coordinationはホストroot、Podman Socket、cluster-admin kubeconfig、無制限hostPath、ホストsystemd DBusへの広範アクセスを得ない。
- Kubernetes操作に必要な最小スコープRBAC/短命資格情報だけを与える。k3s Serverが落ちた場合のhost-level緊急操作は**OperatorのAnsible/consoleを別経路**とし、後で限定管理Helperを採用するかは独立審査。
- プロセスとコンテナのヘルス、readiness、restart policy、journal/log、resource limits、cgroup v2、user namespace、image digest pinning、rollback用DigestはAnsibleの受入条件。
- Caddyや公開App向けTLSはこのVMのCoordinationと混同しない。公開アプリ証明書は既定どおりk3sのcert-manager/Traefikが所有する。

## 5. ハイパーバイザー非依存のAnsibleロール

VMの**作成/ディスクの割当**は外部プラットフォームの責務とする。Praetorium AnsibleはSSH等で到達できる**既存Linuxホスト**を構成する。Proxmox、VMware、ベアメタル等は同じrole inventoryに射影されるが、VM作成API、Proxmox Guest Agent、VMware固有デバイス名を必須のロール契約にしない。

想定構造（**このPRではディレクトリやPlaybookを作らない**）:

~~~text
infrastructure/ansible/
  inventories/<environment>/hosts.yml     # owner-managed, no secrets
  group_vars/{all,management,runtime,builder}.yml
  roles/
    common/               # identities, private network, logs, firewall
    management/           # k3s Server host unit, backup, health checks
    coordination/         # rootless Podman user, Quadlet, local credentials
    runtime/              # k3s Agent join, scheduling labels, edge eligibility
    builder/              # isolated rootless BuildKit, mTLS, storage bounds
~~~

- **Ansibleの担当:** パッケージのピン、ロール前提条件、OS権限、systemdユニット、private network ACL、公開しない管理ポート、K3s Server/Agentの参加、証明書参照、起動/再起動、非破壊な差分確認。
- **Ansibleではないもの:** D1のDesired State変更、テナントPodの任意削除、作業リポジトリGit履歴、Fluxが管理するK8sリソースの競合更新。
- **OS差分:** Ubuntu/Debian系はAnsibleモジュールでの実装を第一候補とする。既存NixOSの`infrastructure/nixos/modules/*`と二重に同じホスト宣言を支配しない。NixOS利用時のロール実装（既存NixモジュールをAnsibleから選択・適用する等）は事前に明示し、手順不一致を禁止。
- **Inventory最小データ:** ホストrole、管理IP、clusterId、K3s APIの安定アドレス/SAN、Runtime join先、各機能に許可するCIDR、BuilderのmTLS endpoint、OSディストリ、イメージDigest、権限主体とSecret**参照先**。
- **秘密:** Inventory/Repo/CIに生Secretを入れない。server/agent token、DB復元材料、Cloudflare Tunnel資格情報、Container Credentialはoperator-controlled protected files/Secretsに保存し、Ansible Vault等の採否は運用契約として別途定める。Playbook出力への漏洩禁止。
- **収束と破壊的操作:** `--check` 相当の差分・ホストID/clusterId検証を先行。既存のk3s datastore、PVC、etcd/SQLite、Token、証明書を単にロールが変わったという理由で削除しない。

## 6. 内部通信をどう再構成するか

### 6.1 公開境界とプライベート境界

- Browser→Gateway: Cloudflare Workerは公開のOAuth/Portal/制御要求を受ける。通常のScriptorium編集本文は引き続き公開アプリOrigin→k3sへ直接到達させる。
- Gateway→Control Plane: 既存Service Bindingを維持し、公開Control Planeの管理API露出を必要最小化する。
- Control Plane→Coordination: **Workers VPC Service Binding + Cloudflare Tunnel**を第一候補（管理サービスの特定Host/PortだけにBinding）。Cloudflare Tunnelは**別の独立ホスト管理サービス**で、k3s Podに依存しない。VPCは2026-10-20時点**Beta**なので機能/課金/SLAは導入前に再確認する。
- Coordination→k3s/Builder: Private subnet内の認証済みHTTP/RPC/gRPC等を選択。Loopback/Unix socketを利用できる同一ホストなら優先。k3s API/TLS・BuildKit mTLSを維持。
- Coordination→Control Plane: **VPC Bindingの逆方向としてVMがService Bindingを直接呼べるわけではない**。結果返却は短いRPCへの応答または独立した認証付き出口/双方向チャネルが必要。長時間処理は明示的な非同期契約とする。

**Workers VPC導入は通信の秘匿が主目的であり、Workersへの外部受信回数をそれだけで減らすものではない。** 配送/空振りClaim/Heartbeatを必要最小化した場合のInvocationの差分を実測する。

### 6.2 作業の正本・配送・完了を分ける

| ステージ | 正本/権限 | 通信契約の意図 |
| --- | --- | --- |
| 要求受入 | Control Planeが認証/署名/設定/CAS確認後D1へ永続化 | D1 commit前にVMへの実行指示を成功扱いにしない |
| 配送 | Control Planeの未処理WorkとCoordinatorの受領ACK | 配送は**at-least-once**を前提。重複送信をIdempotencyで吸収 |
| 実行所有 | 現行のD1 Lease/Generation/Runtime epochのフェンス | Coordinatorのローカルowner情報だけを永続正本としない |
| 実行 | ProvisionerまたはBuild Workerの適切に分離した権限 | k3sで副作用を行う前に現世代/Writerの条件を検証 |
| 完了 | Control Planeが結果とEvidenceをD1へ確定 | CoordinatorへのHTTP ACKやアプリのReadyだけでは成功にならない |
| 再起動/通知喪失 | 永続Work/Journalの再照合と再配送 | 待機中の定期HTTP空振りを減らしつつ**永久に未処理が残る状態を作らない** |

**設計候補（未確定）:** Control PlaneからプライベートRPCで配送、CoordinationからWork実行結果を認証済みの非同期チャネルで返却する。長時間接続が必要ならWebSocket/Hibernationも比較する。ただしWebSocketとVPCの同一方向配送・通信料金・再接続仕様は別々に確認。長いBuildの終了を単一Workerリクエストのレスポンス待ちにしない。

現行の空振りClaimは作業通知喪失時の保険である。新Coordinationで置き換える際は**永続再送/未処理再照合ができるまで撤去しない**。実行中Heartbeatは「VMが生きている」確認ではなくOwnership/Lease保護も担う。**ローカルRPC化してもD1側のEpochとWriter不在の証明を緩和しない**。

## 7. Runtime Nodeを増設する時の契約

1. 新Runtime VMにのみk3s **Agent**をインストール。Management VMの安定したprivate `server:6443`へ、保護されたAgent Tokenで参加させる。ノードの`praetorium.io/cluster-id`やrole Labelで別クラスタ誤参加を拒否。
2. Management VMはスケジューリングの制御主体として残し、通常のScriptorium tenant workloadはRuntimeロールのNodeへ配置する。Runtime #1/#2の容量/PlacementはKubernetesの実観測を使う。
3. 2台のAgentは**実行容量の拡張**であり、k3s ServerのHAではない。Management VMが停止すると新規スケジューリング/API操作は制約される。
4. **ストレージを別設計として明示:** local-path PVCは他Nodeへ移動できるとは限らない。NFS/CSI/外部ストレージ等の採否は、ReadWriteモード、排他Writer、PVC ID、バックアップ、実原稿のGit同期との境界を検証してから決める。
5. Ingressの複数Nodeに対する入口を安定化する。公開`*.scriptorium.yohn.jp`は既存のDNS-only `gateway.yohn.jp`とCaddy/TCPパススルーを維持するが、その後段のTraefik宛先がAgent 1台のIPに固定されていないか事前確認。負荷分散やLoadBalancer実装は個別決定。
6. Provisionerの単一Writer排他はNode数とは独立。新Agent追加/旧Agent停止だけでEditorの二重起動や既存PVC消去を許さない。

## 8. セキュリティ・ネットワークの最小権限

| 境界 | 要求 |
| --- | --- |
| 外部Browser → 公開アプリ | 正規Host/SNI、k3s cert-manager発行TLS、Host-only認証Cookie/Grant。Tenantは他Repositoryへアクセス不可 |
| Cloudflare → Coordination | 特定VPC Service/Host/Portへスコープ、Cloudflare Tunnelを使う場合は公開Ingressを作らずにプライベート到達。**VPC到達性自体は認可ではない**ため、相互のサービス資格情報や署名検証を維持 |
| Management → k3s API | 管理用private IP/Port、専用scoped kube identity、Kubernetes RBAC・Admission・audit、host root kubeconfigをPodmanにマウントしない |
| Coordination → Builder | 明示許可のRPCとBuildKitのmTLS。BuilderにはKubernetes admin権限を付けない |
| Runtime → GitHub/Platform | 既存のrepository/instance/epochに拘束した短命credential、Quiesce・Writer排他。RuntimeにManagement host管理権限を渡さない |
| Operator → Management host | private SSH/Console、Ansibleの最小権限、明示承認されたupgrade/restore操作のみ。Cloudflare認証情報をOSイメージやGitに埋め込まない |

## 9. 障害モデル

| 事象 | 必要な振舞い | 禁止事項 |
| --- | --- | --- |
| Management VM / k3s Server停止 | 既存のRuntime Podが直ちに失われたとは断定しない。新規API/スケジューリング不可を明示、OS/Datastoreの復旧ルートを保持 | 旧Writer不在と誤認して別Server/Runtimeを強行起動 |
| k3s Server API停止、Coordinationは稼働 | Coordinatorは継続して障害を検出・記録/報告。Kubernetes操作は停止/再試行状態 | Kubernetes APIが戻る前に操作成功とD1へ報告 |
| Coordination停止 | D1のWork正本は維持。再起動/再接続時に既存Workを安全に照合。停滞を可視化 | 再起動したからといって既存Workを二重実行 |
| Runtime Agent停止 | 影響Runtime/ PVC / Writerを特定、認可と書込フェンスに基づき復旧判断 | PVCや未pushデータを無視して別Nodeへ無条件再配置 |
| Builder停止 | Build Workは再試行可能な状態として保存し、Digest/Signatureを再検証 | 部分Buildを成功Artifactとみなす |
| Control Plane/D1不通 | Coordinator/k3sの生存とD1の確定を分離。D1への報告未反映は未確定 | 管理VM独自のDesired Stateを正本として先行確定 |
| Private Tunnel断 | 届かなかったWorkを復帰後に再配送。通信断によって無期限取りこぼしにしない | ACKなしの通知を「処理受領」とみなす |

## 10. 移行ゲート（具体手順は別文書）

[移行・検証計画](MANAGEMENT-PLANE-MIGRATION.md)に沿って、既存のRuntime ServerのDatastore/証明書/Token/PVC/Ingress状態を正確に確認してから、Management Serverを導入し、Runtime VMをAgentへ移す。**既存ServerをただAgentモードで再起動する手順は採用しない**。

一時的な2つ目のk3s Server、SQLiteの復元、etcdへの変換などは、現場のデータストア種別と実測に依存するため一律に確定しない。負荷分散・Certificate/Traefik・Flux適用・Storageも変更前後の実物証で検証する。

## 11. 未決定事項（勝手に仕様へ昇格させない）

- k3s Datastoreの実形式（SQLite/etcd/外部DB）、HA採用、バックアップ格納先、必要RPO/RTO。
- Coordinatorの最小API、Work再送・再接続のSLA、結果のD1同期経路、WebSocketとVPC Serviceの併用有無。
- Provisionerの実行モジュール分離と配置（ManagementのQuadlet化するか、管理側Podとして維持するか）。管理用Root権限を安易にコンテナへ流さない。
- Build Workerの配置（現状はRuntime k3s Pod。Builder VM側の実行Agentへの移行は別途移動/Secret/mTLSを設計）。
- Management ServerをAgentlessで稼働させるか、Taintで管理系のみ許すか、Kubernetesのsystem addon配置。
- Fluxとkubectlの静的リソース最終所有者。Ansibleはhostのownerであって、tenantリソースのownerにはしない。
- 外部の公開Ingress/Caddy転送先を複数Agentに対応させる方法、StorageのNode間可搬性、Agent脱退条件。

## 12. 検証・受入のレベル

- **Documentation complete:** 合意済みのホスト/実行方式、現行とのギャップ、認証・状態の正本、障害境界、移行条件がレビュー可能（このPRの範囲）。
- **Implementation complete:** Ansibleの指定host roleが非破壊に収束し、rootless Quadletがクラスタ停止時も独立起動、Management k3s ServerとRuntime Agent複数台を動作可能。
- **Migration safe:** 旧Server datastore/token/CAをバックアップし別環境で復旧を実証、全PVCとWorkの整合・Writerフェンス・Ingress/TLS/Fluxを検証、rollbackを確保。
- **Production accepted:** CloudflareからPrivate VPC経由で正規Work配送・結果確定が成立し、認証失敗・通知喪失・VM再起動・Runtime停止・旧Writer不在を実環境で観測。公開AppのHandoff/保存/復旧も実証。
- **Cost accepted:** ブラウザ無し/Runtimeゼロ/稼働Runtime複数/Build中でWorkers `fetch`・Scheduled・内部RPC・D1/DOを別計測し、従来比で効果を数値化。

CIや静的マニフェストのPASSは上記最後の3層の代わりにならない。

## 13. 参考資料

- [現行のアーキテクチャ](SYSTEM.md)、[現行Runtime/BuilderホストBootstrap](../deployment/REPRODUCIBLE-DEPLOYMENT.md)、[現行Bootstrapスクリプト](../../scripts/bootstrap-ubuntu.py)、[NixOS role](../../infrastructure/nixos/modules/runtime-host.nix)
- [現行のKubernetes静的Platform](../../infrastructure/kubernetes/base/kustomization.yaml)、[Provisioner RBAC](../../infrastructure/kubernetes/policies/provisioner-rbac.yaml)
- [K3s Servers/Agents](https://docs.k3s.io/architecture)、[K3s backup/restore](https://docs.k3s.io/datastore/backup-restore)、[K3s token](https://docs.k3s.io/cli/token)
- [Podman Quadlet / user unit](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
- [Cloudflare Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)（**Beta**）

**プロダクションの設計目的は「外部に公開する面を減らし、内部実行の責務を明確にし、Cloudflare空振りInvocationを削減する」こと。新しいプラットフォームや状態正本を際限なく増やすことではない。**
