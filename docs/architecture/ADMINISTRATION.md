# Praetorium — Admin Plane / Infrastructure Operations Architecture

> **Status: ACCEPTED TARGET DESIGN (2026-10-24).** オーナー合意を実装の設計正本として固定する。本書をコミットしても Worker分離・監視API・本番DNS変更が実装またはデプロイされたことにはならない。
> **Authority:** 最新のオーナー指示 > [Epic #1](https://github.com/yohn-jp/praetorium/issues/1)・該当Issue（既存Release Consoleは[#26](https://github.com/yohn-jp/praetorium/issues/26)、診断は[#41](https://github.com/yohn-jp/praetorium/issues/41)） > 本設計 > 実装。Hosted G1–G9とSource→Stableの受入条件を変更しない。
> **Reference cut:** `main@1930131e6858e5d9035abe1dcd82d4ae654c622d`。構成の観測証拠は [THREE-VM-INFRA.md](../verification/THREE-VM-INFRA.md)、[THREE-VM-FRESH-DEPLOYMENT.json](../verification/THREE-VM-FRESH-DEPLOYMENT.json)、[THREE-VM-CONTROL.md](../verification/THREE-VM-CONTROL.md)。稼働証拠は記載された観測時点に限る。
> **Companions:** [MANAGEMENT-PLANE.md](MANAGEMENT-PLANE.md)（物理/実行責務）、[MANAGEMENT-PLANE-MIGRATION.md](MANAGEMENT-PLANE-MIGRATION.md)（履歴と残ゲート）、[SYSTEM.md](SYSTEM.md)（旧コードの主体台帳）、[Operator Console UX](../design/OPERATOR-CONSOLE-DIAGNOSTICS-UX-PLAN.md)（既存Desktop/Mobile体験）。

## 1. 決定・目的・非目標

Praetorium Adminは、運営者が **Platform → VM → Service → Work/Release → Evidence** を辿り、障害の所在と次の安全な操作をブラウザで判断できる単一の運用入口とする。メトリクスの寄せ集めや、新しいオーケストレータではない。

**固定決定:**

1. `https://praetorium.yohn.jp` は一般利用者用 **Gateway Worker**、`https://admin.praetorium.yohn.jp` は独立した **Admin Worker** に割り当てる。二つのcustom domainをGateway Workerへ同居させない。モノレポ内では `apps/admin` を独立したBuild/Deploy単位にする。
2. Management VMはホスト/k3s/Coordination/VM横断観測の集約点とする。Runtime VMはk3s Agentとテナント実行、Builder VMは独立rootless BuildKitという既存の3VM配置を維持する。**テナントの実行やBuildKitをManagement VMへ移設しない。**
3. GitHub OAuth・Session/DO・トークン保管の正本は **Gateway** の既存実装に維持し、Admin Worker用に第二のユーザーDBや長命OAuthトークンストアを作らない。Admin Workerには管理者用UI/APIと明確に制限した運用データの統合のみを置く。
4. GitHub Releaseの同一性確認、Operator Admission/Retry、D1のBuild/Operation/Release/監査の正本、Quiesce/Writer不在/Lease/Epoch/CASのフェンスを維持する。Admin画面はこれらの既存の契約を迂回しない。
5. Infraの観測は **read-onlyなManagement Observability境界** に集約し、Coordinationの既存Work通知権限やホスト特権をそのままAdminへ渡さない。
6. Workers VPC/Tunnel経由の内部サービスはホスト名をインターネットへ公開しない。Cloudflare Queues採用、追加VM、別Control Plane、全量監視基盤、汎用リモートShell、VM強制再起動は**この決定の範囲外**とする。

目標の管理対象はManagement/Runtime/Builder、k3sとScriptorium Workload、BuildKit/Build Worker、Coordination、Cloudflare Worker/D1/DO/KV、GHCR、Release/Build/Operation、ネットワークと依存関係。表示対象であることは書き込み権限付与を意味しない。

## 2. 現行観測と完成形の区別

| 対象 | 現行コード/観測で確認済み | 固定した完成形（未実装） |
| --- | --- | --- |
| 3VM | 2026-10-20、新規BootstrapでManagement k3s Server・Runtime Agent・Builder BuildKitを確認。Coordination/Tunnelはk3s停止中も稼働、Management再起動後に復帰 | 各VMの状態をAdminから収集・区別して表示 |
| Browser Admin | `apps/gateway/src/admin/*` のUI/Session。Gateway WranglerにGateway/Admin両ドメイン | `apps/admin` の単独Worker、Admin domainはここだけ |
| Admin identity | Gateway OAuth・DO・one-use admin handoff、GitHub数値IDのoperator allowlist、host-only Admin Cookie | Gatewayの非公開Auth Broker経由で同じ正本を使用 |
| Source/Release | AdminがGatewayのControl Plane Service BindingとGitHubユーザートークン処理を利用 | Admin UI独立、GitHubトークン処理はGateway Broker、操作の正本はControl Plane |
| Coordination | `apps/coordination` はwork hintのrelay。Management VPC ServiceはWork通知用 | **別のread-only観測境界**を提供。既存relayを任意コマンドAPIにしない |
| Infra monitoring | 一部Headlamp、ホスト/Builder/Control Plane個別の検証記録が存在 | Adminの統合Inventory/Health/Diagnostics/依存関係 |
| Hosted受入 | 2026-10-20の3VM証拠・2026-10-23のIssue #41局所検証は存在。G1–G9全面合格の証明ではない | 監視画面の完成とHosted E2E合格を別々に判定 |

現行稼働がこのcutから変わったかどうかは別途ライブ観測で確定する。未検証の状態を「Healthy」「導入済み」に置き換えない。

## 3. 論理境界と通信

~~~mermaid
flowchart TB
    B[Browser / Operator]
    U[Browser / Repository user]
    A[Admin Worker<br/>admin.praetorium.yohn.jp]
    G[Gateway Worker<br/>praetorium.yohn.jp]
    CP[Control Plane Worker / D1]
    GH[GitHub OAuth / Releases]
    GA[Gateway Admin Identity + Source Broker<br/>private service-binding RPC]
    subgraph M[Management VM]
        OB[Read-only Observability Adapter<br/>rootless, k3s-independent]
        CO[Coordination<br/>rootless Podman Quadlet]
        KS[k3s Server / scoped Kubernetes API]
    end
    subgraph R[Runtime VM]
        KA[k3s Agent]
        SR[Scriptorium + Instance Access + Traefik]
    end
    subgraph X[Builder VM]
        BK[rootless BuildKit]
        HE[private host observations]
    end
    B -->|HTTPS| A
    U -->|HTTPS| G
    A -->|service binding RPC: auth and verified GitHub source| GA
    GA -->|Gateway-owned DO/session and token vault| G
    G --> GH
    A -->|authenticated, operator-scoped service binding| CP
    A -->|separate VPC binding: read-only| OB
    CP -->|existing VPC work notification| CO
    OB -->|read-only host + scoped API| KS
    OB -->|private host metrics| KA
    OB -->|private host metrics, bounded status| HE
    CO -->|existing authenticated execution hint| KS
    KS --> KA
    KA --> SR
    SR -->|private BuildKit usage is not a UI responsibility| BK
    U -.->|direct tenant HTTPS origin; not proxied by Admin/Gateway| SR
~~~

この図は**目標通信契約**であり、本番観測ではない。BuilderのBuildKit実行は既存Build Worker経路を維持し、図中のObserverがBuildKitの実行コマンドを発行するわけではない。Service Bindingは秘密鍵/永続正本の移転手段ではない。

| 主体 | 所有してよいもの | 所有・実行してはならないもの |
| --- | --- | --- |
| Gateway Worker | GitHub OAuth、User Session/DO、手渡しコード、GitHubユーザートークン、Scoped Identity/Source Broker | Admin UI、VM/K8s/BuildKitの任意管理API |
| **Admin Worker** | Admin UI・表示状態・CSRF/Origin検証、認証済みの読み取り集約、既存Operator操作の入口 | 第二の認証DB、GitHub token、Kubeconfig/SSH鍵、BuildKit root権限、D1 Desired State |
| Control Plane Worker / D1 | Release/Build/Operation/Instance論理正本、Admission/CAS/Lease/Audit | VMのホスト権限、観測不能な状態の健康判定 |
| Management Observer | 限定されたホスト・systemd・Podman・k3sの観測結果、時刻付きスナップショット | 任意Shell、起動停止・書込K8s権限、Work claim/結果確定、長期の独立状態DB |
| Coordination | 既存の通知relay、認証済みwork-hint | プラットフォームDesired State、管理者のフリーフォーム操作 |
| Runtime/Builder | 実Pod/実ビルド・cgroup/ディスク/GCの観測 | Admin権限の付与、コンテナ権限のブラウザへの直結 |

## 4. Admin認証・GitHub Release Broker

### 4.1 固定したセッションフロー

1. Adminへの未認証アクセスは、Adminの公開HTMLや詳細を返さず、既存Gatewayの `/_admin/entry` に遷移する。GatewayがGitHub OAuthを完了し、現時点の数値GitHub user IDとoperator allowlistを確認する。一般Repository admin権限はoperator権限にならない。
2. Gatewayが現行の `EPHEMERAL_CODES` DOに **60秒・一回限り・Admin originをaudienceとする**handoffを保存し、ブラウザからAdmin originの `POST /_admin/handoff` へform POSTさせる。コードをURL query/fragment/ログに書かない。
3. Admin Workerはmethod/content-type/最大body/origin/audienceを検査したうえで、**非公開のnamed WorkerEntrypoint RPC** を持つGateway Identity Brokerへhandoffを渡す。Gateway側のみが既存DOで原子的にconsumeし、元Gateway sessionの有効性・失効・GitHub user ID・operator allowlistを検証する。
4. Brokerが**既存Session Storeに作成した短命Admin session**のopaque cookie値とCSRF材料を、Admin WorkerのService Binding RPC応答として返す。Admin WorkerはAdmin hostname限定のSecure/HttpOnly/SameSite cookieを設定する。Gateway cookieをAdminへ転送・共有しない。Admin session TTLは現行上限1時間と元Gateway session残存期間の短いほうを超えない。
5. 以後Adminの**各read/mutation**でBrokerが既存Session Storeを参照し、現在の失効・有効期限・数値ID allowlistを検証する。Admin Workerは検証済みOperator actorしか下流へ渡さず、GETはno-store、POSTにはOrigin・CSRF・Content-Type・サイズ上限、変更系にrevision/idempotencyを要求する。
6. LogoutはBrokerを通じて当該Admin sessionを失効させ、Admin host cookieのみを消す。Gatewayの一般ユーザーSessionを不用意にログアウトさせない。短命のSession検証キャッシュで失効を遅延させない。

**Brokerは公開fetchルートではなく、専用named Service Binding RPCに限定する。** Gateway Workerに新しいパブリックOperator APIを増やさない。ブラウザへのサービス認証Secret/OAuth token/長命credential露出、クロスドメインCookie共有、Access等の第二のIdPの無断導入を禁止する。独立WorkerがGateway Service Bindingに依存することは明示的な可用性上のトレードオフである（後述）。

### 4.2 Operator業務操作の信頼連鎖

- Release選択/明示Retryは、Gatewayに残す**最小限のGitHub Source Broker RPC**で、許可されたsource ID、GitHub Release ID、published tag、現在のcommit SHAをユーザートークンで再検証する。Admin WorkerにGitHubトークンを戻さない。
- Admin Worker→Control PlaneのOperator APIは**新しい専用・用途限定のservice credential**で認証する。Gatewayと同じ汎用service credentialや `RELEASE_OPERATOR_TOKEN` をAdminに複製しない。Control Planeも操作ごとに許可されたOperator actorとAPIを検証する。認証成功だけでPayloadを受け入れない。
- Control Planeは `/v1/operator/releases`、Source Build、既存Retry/Status、監査の**既存正規実装**を使い、署名/Registry/Producer/Immutable identity、revision/CAS、Canary→Stable順序を省略しない。
- 演算結果は `accepted/queued`、`executing`、`admitted`、`failed`、`unknown` を区別し、Adminへの202やBrokerへのACKを実ジョブ成功と解釈しない。
- `PRAETORIUM_ADMIN_GITHUB_USER_IDS` 等のoperator allowlistは**既存デプロイInventoryの単一正本から必要なWorkerへ投影**する。Admin Workerだけのハードコードや、Gateway/Control Plane間で別々の手修正を許可しない。

## 5. Management Observabilityの内部API

新しい汎用管理Planeや第二のD1を作らない。Management VM上にread-onlyの観測Adapterをrootless systemd/Podmanサービスとして配置する。**k3s停止時にも起動可能**とし、既存CoordinationのWork relayとはプロセス/秘密情報/ネットワーク権限を分ける。Host exporter等の既存OS標準・k3s/Kubernetes API・BuildKit周辺の読み取り機構を再利用する。

- Cloudflare Admin Workerからは**観測専用Workers VPC Service Binding**へ送信する。既存 `COORDINATION_SERVICE`（Work通知向け）を再利用した管理者向け任意RPCは設けない。VPCと通信Credentialの両方で限定する。
- ObserverはManagementホストのsystemd/k3s/Coordination/Tunnelと、RuntimeのNode/Pod/Service/Readiness、BuilderのOS/BuildKit daemon/cache/disk/cgroupを**スコープ付き読み取り専用経路**で収集する。各VMのプロセス実行資格情報をAdmin Workerへ渡さない。
- k3s APIは専用read-only RBAC主体を使う。Pod内環境変数/Secret/exec/port-forward/Pod削除を許可しない。Builder監視ではBuildKitの実行能力を持つソケットやmTLSクライアント資格情報をブラウザ経路へ流さず、privileged APIではなくホスト側の制限付き統計射影を優先する。
- Runtime/Builderからの観測エージェント導入を必須条件にはしない。安全な既存観測経路で取得できない項目は `not_collected` と表示し、追加Exporterが必要ならその範囲と資格情報を実装時に明示する。
- 独立したread-only `/healthz` と `/readyz` はObserver自身のプロセス/設定を検査する。k3s・Builderの全正常性をObserverのReadiness条件にしない。
- 管理VM自体が停止した際はObserverも応答しない。Admin WorkerがVPC到達失敗/Timeoutを表示し、障害診断の入口を失わない。**Management停止の原因診断や復旧操作は別経路のSSH/Ansible/console** を維持する。
- Cloudflare Workers/D1/DO/KVの稼働・使用量は、必要に応じてCloudflareの既存read-only APIから取る。管理者Tokenは最小スコープでサーバ側にのみ保持する。D1への管理用直接SQL書換は設けない。

### 5.1 Read-only API契約（Admin Worker外向き）

URLはAdmin Worker内の画面/API境界の固定契約。Observerとの具体的なWire Protocolは別の、上限付きVersioned DTOで実装する。

| メソッド・パス | 用途・出典 | 変更権限 |
| --- | --- | --- |
| `GET /api/admin/v1/overview` | 運用上の緊急項目、既存Release/Build/Workの権威ある集約 | なし |
| `GET /api/admin/v1/infrastructure/hosts` | 管理対象VM Inventory + 役割 + 最終観測 | なし |
| `GET /api/admin/v1/infrastructure/hosts/:id` | CPU/Memory/Disk/Boot・システム障害 | なし |
| `GET /api/admin/v1/infrastructure/hosts/:id/services` | systemd/Quadlet/Podman/k3s/BuildKitの状態 | なし |
| `GET /api/admin/v1/infrastructure/dependencies` | Cloudflare→Management→Runtime/Builder、証明書/接続の状態 | なし |
| `GET /api/admin/v1/work`、`GET /api/admin/v1/work/:id` | Canonical D1 Build/Source/Operation・Attempt・監査・診断への参照 | なし |
| 既存のRelease/Source POST API | 現行Operator Admission/Retryの正規操作（厳密に認可） | Canonical Control Planeのみ |

`host id` は任意のアドレスでなく**静的Inventory内の安定ID**。入力文字列でSSH先/URL/ポート/コマンドを指定できるAPIは作らない。GETは認証されたOperatorのみ、no-store、同一origin CORS、bounded payloadとページングを必須とする。未認証404/401/403、依存先未到達503等は明示し、成功レスポンスへ空配列を偽装しない。

### 5.2 観測DTO・鮮度・状態モデル

~~~json
{
  "schemaVersion": 1,
  "inventoryId": "management",
  "role": "management",
  "observedAt": "2026-10-24T00:00:00Z",
  "receivedAt": "2026-10-24T00:00:01Z",
  "state": "healthy",
  "freshness": "fresh",
  "sources": [{"provider": "systemd", "status": "ok"}],
  "cpu": {"usedPercent": 23.1},
  "memory": {"usedBytes": 1073741824, "totalBytes": 4294967296},
  "disk": {"usedBytes": 2147483648, "totalBytes": 8589934592},
  "reasons": []
}
~~~

**サンプル値であり本番観測ではない。** これを参考に型付きSchemaを実装し、数値・単位・UTCタイムスタンプ・provider・収集失敗の理由を明示する。リソース値は取得できなければ `null` + reason とし、0/100%で埋めない。

- Host自体の状態は `healthy | degraded | unavailable | unknown`。別軸の鮮度は `fresh | stale | absent`。管理者操作の実行状態やk3s Pod Readyをホスト生存の代用にしない。
- `healthy` は該当コンポーネントの**明示した必須チェック**が全て成功し、観測がfreshのときだけ使う。非必須サービス障害は `degraded`、通信不能は `unavailable`、未接続・判定不能・未計測は `unknown`。未収集情報を緑色にしない。
- 実装時の初期上限: Observerスナップショット短期キャッシュ最大30秒、時刻90秒超でstale、300秒超/初回欠測でabsent。個々の取得は上限付きタイムアウト、全体失敗で成功した別セクションまで隠さない。ロール間で値の更新時刻が異なることを常に表示する。
- Browser表示の更新は可視画面の操作に紐づけ、閉じた画面で高頻度Pollingしない。更新失敗時は最後の値を**staleと明示**して表示できるが、fresh扱いを禁止する。
- 時系列の長期保存や秒単位の全VM高頻度収集は初期必須要件ではない。必要なら既存監視製品を評価し、別途容量/保持期間/コスト契約を決める。D1の論理正本に生メトリクスを大量INSERTしない。
- source/attemptの失敗診断は既存D1とIssue #41の**秘密情報を除いたbounded evidence・30日保持**を再利用する。古い未保存の失敗原因は `not recorded` とする。

## 6. 運用UI情報設計（Desktop / Mobileを別構成）

共通のデータ契約・認可・操作だけを共有し、狭いDesktopの縮小版をMobileと呼ばない。既存のforest/ivory design tokens、Issue #26/#41で確立したRelease/Build/Retryの操作動線と、各実装のテスト契約を保持する。

**Desktop:** 左の常設ナビゲーション `Overview / Infrastructure / Runtime / Builder / Releases / Builds / Audit`。最上位は「プラットフォームとして使えるか」「利用者に影響する障害」「安全に対処する次の動作」。InfrastructureではManagement/Runtime/Builderをカードまたは密度のある表で並べ、選択ホストの詳細を同じ文脈で表示する。リソースの値、最後に観測した時刻、systemd/K8s/BuildKitの元データへ段階的に掘れる。

**Mobile:** 下部タブは高頻度タスクを優先（`Overview / Jobs / Infrastructure / More`）。単一画面内のタスクを一つに絞り、VMは縦カード、詳細は別ページ/フルスクリーン、戻るとスクロール・フィルタ保持。誤操作しやすい管理Mutationをスワイプや長押しだけで発火させない。320/375/390/430pxのタップ領域・文字・ナビゲーションを検証する。

**双方共通:** Header高さ固定。通知はレイアウトを押し下げないtoast/適切なLive Region。失敗を示す状態色は状態テキスト・原因と併用。遷移中はAuthoritative ID、時刻、attempt/leaseと次の確認手段を示す。状態取得失敗を「ジョブ失敗」としない。失効セッションで操作を繰り返さず再認証へ誘導。手動Refreshができ、楽観的な成功表示・架空のETA・自動Retryは禁止。

### 6.1 MVPで最初に揃える管理者パス

1. Adminログイン → Overviewで全体Statusと警告理由を読む。
2. Infrastructure → 任意の3VM → CPU/Memory/Disk・稼働/観測時刻とサービス一覧を読む。
3. ManagementのCoordination/Cloudflare Tunnel/k3s Server、RuntimeのNode/Pod、BuilderのBuildKit/GCをそれぞれ確認する。
4. BuildsでSource/Compositionの実行・過去Attempt・失敗コード・Evidenceを特定し、正規のRetry APIが許可する場合だけ再実行する。
5. ReleaseのCanary/Stableと実際のDeployment/Readyを対照し、Issue/障害に必要なIDを収集する。緊急復旧で必要なら明示的にbreak-glass運用へ移る。

## 7. 障害時の動作契約

| 故障箇所 | Adminの動作 | 禁止する誤表示/副作用 |
| --- | --- | --- |
| Admin Worker自体 | 独立した `/healthz` が障害を表す。Gateway/テナントの稼働に波及させない | GatewayにAdmin HTMLを自動的に復活させる未認可fallback |
| Gateway/Auth Broker | 既存の有効なAdmin Sessionでも認証検証不可なら**fail closed**。一般的なエラー/再試行表示のみ | 未検証Cookieで運用データを開く、別ユーザーDBを自動起動 |
| Control Plane/D1 | Release/Workは `unavailable`。既に取得済みのVM観測は鮮度を明記して独立表示 | Releaseの空配列や正常表示、D1直接書換 |
| Management VM / VPC | Infrastructureを `unavailable`、最終観測はstale。Control Plane上のWork情報は表示を維持 | Coordinationを止めた状態で新しいインフラ状態を推定 |
| k3s Server停止 | Observerが生存すればHost/Systemdとk3s API失敗を別々に表示 | k3s Node unknownをVM deadと断定、Adminにcluster-adminを追加 |
| Runtime VM/Builder停止 | 該当VMの最後の到達・観測時刻と依存Workへの影響を示す | 操作を勝手に再実行、Build successを捏造 |
| Cloudflare analytics APIのみ失敗 | Workers使用量セクションを限定的にunknown、他を保持 | UI全画面を503にする |
| 確認不能な状態 / 古い診断 | `unknown` / `not recorded` + 出典・時刻・安全な確認手段 | 推測した原因や「Healthy」の緑表示 |

Admin UIは**閲覧・正規操作の入口**であって、障害時の唯一の復旧手段ではない。SSH/Ansible/console、独立なクレデンシャル復旧、K3s Datastore backupの保守経路は残す。

## 8. ネットワーク・秘密情報・ログ境界

- 公開許可はGateway / Admin /既存のScriptorium originに限定。Control Planeの既存公開APIの露出削減は別件として扱い、Management Observer/Coordination/Builder/k3s APIに管理用公開hostnameを設けない。
- Admin WorkerはGitHub App秘密鍵、OAuth refresh token、Gateway DO暗号鍵、Runtime Git broker token、`RELEASE_OPERATOR_TOKEN`、Kubeconfig、BuildKit mTLS秘密鍵、SSH秘密鍵を保持しない。Admin専用の用途限定Credentialは最小権限・独立ローテーションとする。
- Service Bindingがあっても、Adminへの外部入力がすべて信頼されるわけではない。内部RPCの呼出元とOperator actorを明示的に検査し、Origin/CSRF/セッション確認を省略しない。
- Host観測APIは固定IDに対するread-only allowlistであり、任意URL取得・任意コマンド・任意ログ全文・ファイルパス指定を公開しない。読み取るプロセスの環境変数やSecretを丸ごと返さない。
- ログ・監査には `requestId, actorId, operationId, source, observedAt, status, canonical error code` のみを必要に応じて記録する。Cookie、CSRF値、handoff code、トークン、機密なBuild出力を含めない。設定変更は必ず元の主体の既存Audit契約に従う。

## 9. 実装順序とロールアウトの受入ゲート

**この設計文書PR自体はコード・本番変更を含まない。** 将来の実装は各ゲートで独立に検証し、既存の認証/Release契約を破壊しない。

| Gate | 実装対象 | 合格条件 |
| --- | --- | --- |
| A — 接合面 | Gatewayに非公開Admin Identity/Source Brokerを明示的に切り出す（同じDO/トークンVault）。Admin側の型付きDTOを確定 | 既存admin-originの手渡し・セッション/CSRF・Published Release・Retryが後方互換。公開の管理APIが増えない |
| B — Worker分離 | `apps/admin`、独立Workerデプロイ定義、既存Desktop/Mobile/診断UIを移す。Control PlaneにはAdmin用途限定サービス認証を追加 | Anonymous/非Admin/失効/横取り/replay/CSRFを拒否。定義済みOperator操作のみ通る。Gateway通常UIの回帰ゼロ |
| C — Domain切替 | 別Workerを独立環境で検証後、`admin.praetorium.yohn.jp` のcustom domainを **GatewayからAdminへ単一ownerで切り替え**。GatewayからAdmin route/handlerと不要なAdmin varsを撤去 | 同一hostnameに二重Workerを残さない。実OAuth・Set-Cookie・CSRF・CSP・real origin・read-only/Mutation smoke。失敗時はdomainのownerを元に戻す |
| D — 観測基盤 | Management Observer、Hostの最小権限観測、別のAdmin VPC service、型付きRead API | 3VM Inventoryとホスト/サービスの成功・故障・部分故障・staleが区別できる。k3s停止中もHost診断可能。無認証API拒否 |
| E — 管理体験 | Overview/Infrastructure/Runtime/Builder/Release/Build/Audit、Mobile別構成とE2E | 3VM別の状態・時刻、失敗Workへの診断遷移、正規Retry、320–1440px、ネットワーク断と復旧、画面非変位を実ブラウザで検証 |
| F — 運用検証 | Cloudflare呼出/CPU・D1/DO・VM metrics・Manager再起動・ダウンタイム・rollback | Idle時に1s/2sの新しいCloudflareループを追加していない。実測値と新旧deploy切替・本番状態を記録 |

**追加の非機能受入:** Admin Worker停止でGateway通常ユーザー導線は継続する。Management/k3s/Builder/Cloudflare APIをそれぞれ故障させても観測可能な他のセクションは表示する。Operator権限の失効・GitHubトークン失効・Gateway停止時はfail closed。Service Binding/Worker name/Secret/Allowlist/custom domainはInventory→生成設定→Cloudflare readbackまで一致する。HTTPステータスだけで成功とせず、実ブラウザ・実ホストの観測証拠で判定する。

### 9.1 本番切替と巻戻し

- 新Admin Workerは、最初に本番domainを占有しない検証用origin/previewで認証・UI・正規APIを確認する。検証用URLを公衆アクセス可能な無認証管理APIとして残さない。
- 同じDeployの前提検査で既存Gatewayのadmin route、セッションCookie/DO、Control Planeのサービス認証、Work状態、Allowlist、Secret参照、Gatewayの一般ユーザー疎通を記録する。
- Custom domainはひとつのWorkerだけに割り当て、切替直後の実ブラウザでGateway OAuth→Admin POST handoff→一覧→限定Mutationのnegative/positiveを実測する。管理者だけでなく、一般利用者のGateway→Instance originも確認する。
- 失敗時はAdmin domainを**旧Gateway版へ再割当**し、旧Gateway deployを復旧する。既存Session DOのデータを消去・再生成しない。実Sessionの互換性がないときは明示的に再ログインさせ、セッションが移行成功したと偽らない。
- 本番適用/公開、Secretローテーション、VM権限変更、Headlamp権限拡張はこの文書の作成やPRマージだけでは承認されない。

## 10. Headlampと既存Operator Consoleの位置づけ

Headlampは `infrastructure/kubernetes/addons/headlamp/` にある**独立したk3s専門管理UI**。従来の `ClusterIP`/port-forward・RBAC・制限付きServiceAccountの防御を保持し、Admin Workerの代わりや内部K8s APIプロキシにはしない。Headlampへ誘導する場合も、別認証・最小権限を尊重する。通常のScriptorium lifecycleは必ずProvisionerによる正規APIで操作し、HeadlampのPod削除等で代用しない。

Issue #26のRelease ConsoleとIssue #41のSource Build診断は**既存実装資産**として、新Workerへ外形・挙動を維持して移す。Admin可視化の導入を理由にSource→Stable、MCP/Wake、安全なWriter Lifecycleの受入条件を下げない。

過去のHeadlamp導入・非公開運用手順の履歴は [2026-10-21以前の旧文書](https://github.com/yohn-jp/praetorium/blob/1930131e6858e5d9035abe1dcd82d4ae654c622d/docs/architecture/ADMINISTRATION.md) と [Headlamp addon](../../infrastructure/kubernetes/addons/headlamp/) に保存する。かつての「Admin Consoleは将来構想のみ」という節は**本書の決定により上書きされる**。

## 11. 残課題と採用しない推論

- Cloudflare Queuesによるwork hint配送は**未採用**。現行のVPC通知、既存のHTTPS fallback、D1のclaim/lease/reconcileはこの分離では変更しない。Queuesは配送耐障害性の改善根拠が出た時点で、独立した変更として比較する。
- AdminログインはGatewayの認証Brokerに依存するため、Gateway全面障害中の管理者データ閲覧を保証しない。独立Workerの価値はデプロイ/運用UI/認可境界の分離、Management停止時の切り分けであり、完全な認証独立ではない。
- 長期メトリクス、alert通知、VM強制再起動、任意K8s mutation、一般公開Headlamp、マルチクラスタHAは固定要件に含めない。運用上必要になればauthorityと独立受入条件を定める。
- 本書の固定した完成形は、**実装済み・CI PASS・本番PASSと異なる**。実際の完了判定は上述のGateと `docs/GOAL.md` のG1–G9を満たす証拠による。
