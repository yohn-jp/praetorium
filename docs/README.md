# Praetorium — ドキュメント入口

> アーキテクチャは構成・責務・契約を記述し、日付・commit SHA・検証結果は別の検証記録に保管する。製品要件の正本は[初期Epic #1](https://github.com/yohn-jp/praetorium/issues/1)と最新の明示的なオーナー指示。

## 確定した管理アーキテクチャ

3VMの責務はManagement（k3s Server / Coordination / Observer）、Runtime（k3s Agent / Scriptorium）、Builder（rootless BuildKit）に分離する。実際の配置・再起動・復旧の合格状況は[検証記録](verification/README.md)を参照する。

**Admin独立Cloudflare Worker** と **Management中心のread-only Infrastructure Observability** を目標構成として固定した。現行Gateway内のAdmin UIとcustom domainは、実装時に独立Workerへ移す。設計決定と実装・本番完了を分けて扱う。

## 最初に読む文書

| 文書 | 役割 | 信頼レベル |
| --- | --- | --- |
| [Design and UX contract](design/UX-CONTRACT.md) | 利用者・運営者の情報設計、操作、Desktop/Mobile、受入シナリオ | **UI/UXの設計正本。実装済み・本番合格の報告ではない** |
| [3VM Management/Execution](architecture/MANAGEMENT-PLANE.md) | 物理VMと論理Planeの配置、実装と目標の責務境界 | 合意済みターゲット + 明示した観測 |
| [Admin Plane](architecture/ADMINISTRATION.md) | 独立Worker、認証、観測API、可視化、障害、セキュリティ、移行ゲート | **固定目標、未実装機能を含む** |
| [Migration/残受入](architecture/MANAGEMENT-PLANE-MIGRATION.md) | 移行実行条件、通知/Hosted/Adminの受入条件 | 実装ステータスは検証資料で管理 |
| [旧SYSTEM](architecture/SYSTEM.md) / [旧EXECUTION](architecture/EXECUTION.md) / [旧REVIEW](architecture/REVIEW.md) | 従来のコード・通信監査 | 旧実装の参考資料。現在のVM配置の根拠にしない |

## 役割別の資料

| 目的 | 読む資料 | 解釈上の注意 |
| --- | --- | --- |
| Management・Coordination・Executionの3VM構成 | [Management Plane Architecture](architecture/MANAGEMENT-PLANE.md)、[Migration Gates](architecture/MANAGEMENT-PLANE-MIGRATION.md) | 3VM責務が設計正本。実際のBootstrap結果・Work通知・Hosted受入は検証記録で判定 |
| アプリURL・DNS・画面状態遷移 | [Application Origins](architecture/APPLICATION-ORIGINS.md) | 合意済みの設計。現行DNS/TLSは実機証拠と照合 |
| 内部通信・周期・最適化候補 | [Internal Traffic Inventory](architecture/INTERNAL-TRAFFIC.md) | 現行コードのタイマー/通知/HTTPの根拠と、固定費・状態比例・ユーザー比例の区別。実測コストは別途計測 |
| 責務から見直す通信アーキテクチャ | [Traffic Responsibility Review](architecture/TRAFFIC-RESPONSIBILITIES.md) | Gateway／Control Plane／Build Worker／Provisioner／Runtimeの正本・起動契機・削減候補・決定保留を最初から整理 |
| 初期受入要件 | [Epic #1](https://github.com/yohn-jp/praetorium/issues/1) | 最優先。CI禁止の旧記述は最新のユーザー指示で上書き済み |
| レート制限移行の設計目標 | [Cloudflareネイティブ濫用抑制・KV撤去計画](architecture/RATE-LIMITING.md) | **PR #14でWorker側を実装中・未デプロイ**。WAFは別途手動設定、制約・段階移行を明記 |
| 旧アーキテクチャ草案 | [PLATFORM.md](architecture/PLATFORM.md) | 移行時の実装想定。新しいトポロジーの正本ではない |
| Producer ABI | [SCRIPTORIUM-CONTRACT.md](architecture/SCRIPTORIUM-CONTRACT.md) | Versioned contract・歴史的な実装差分を含む。現行稼働を単独で証明しない |
| プラットフォーム運用管理 | [管理者アーキテクチャ](architecture/ADMINISTRATION.md) | **独立Admin Workerの確定設計**。GatewayのAuth/DOを維持しread-only Management観測を統合。実装・本番での適用は別途検証 |
| デプロイ操作 | [再現可能デプロイ](deployment/REPRODUCIBLE-DEPLOYMENT.md)、[ホスト手順](deployment/UBUNTU-2404.md)、[deployment/README](deployment/README.md) | `--check`/`--apply`の境界と実運用Secrets、稼働実証は別 |
| 実Host・Runtime受入 | [検証記録の索引](verification/README.md) | 各レポートは観測したソースSHA/環境にだけ有効 |
| 移行の実装履歴 | [移行索引](migration/README.md)、[PLAN.md](migration/PLAN.md) | T00–T15タスクを現在のプロダクト要件と混同しない |
| オフライン旧データ復旧 | [recovery/README.md](recovery/README.md) | 通常Runtimeは旧PVC/未公開成果を削除しない |
| CI・開発ルール | [../AGENTS.md](../AGENTS.md)、[GitHub Actions](../.github/workflows/publish-services.yml) | CIは許可。公開・本番デプロイは別途承認 |

## 検証情報の所在

- **VMホスト層:** [3VM構成の検証記録](verification/THREE-VM-INFRA.md)に構築・障害・復帰の実測を保管する。
- **Hosted製品層:** [既存Hosted統合レポート](verification/HOSTED-ACCEPTANCE-a669f5c.json)は`workers-d1-do`以外の主要分類が`BLOCKED/NOT_CHECKED`。当該レポートは現在mainの全面合格を示さない。
- **公開適用:** Ubuntuホスト検証と、Cloudflare/K3s/Scriptoriumの全製品経路が本番で動くことは同義ではない。

## ドキュメントの信頼レベル

1. **Authority:** ユーザーの最新指示、初期Epic #1。要件・非要件を決める。
2. **Actual implementation:** 固定したcommitの実コード・マイグレーション・Manifest。何が実装されているかを示す（設計妥当性を保証しない）。
3. **Versioned producer contract:** 実際に認証・署名・ビルドの互換性判定に使うSchema/API。発行済みArtifactとの組合せで評価する。
4. **Design/audit:** `architecture/SYSTEM.md`、`EXECUTION.md`、`REVIEW.md`、旧`PLATFORM.md`。設計を説明・批判するが、認可や実行結果の証拠ではない。
5. **Campaign history/evidence:** `migration` と `verification`。過去の合意・中間結果を保存し、最新の事実として再利用する場合はSHAと環境を必ず再確認する。

## 既存資料を消さない理由

`docs/migration/tasks/*`、`docs/verification/*`には受入根拠、失敗記録、Source Revision、復旧証拠、過去のブロッカーが残っている。重複を理由に削除すると、後から正否を検証できなくなる。**一次の現在/目標は本索引からManagement・Admin・移行ゲート文書へ集約**し、詳細な履歴は索引経由で辿れるようにする。修正が必要なときに古いレポートを上書きして成功を装わない。
