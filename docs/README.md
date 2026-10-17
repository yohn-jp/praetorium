# Praetorium — ドキュメント入口

> 2026-10-18、`main ecabf265693e395c40bfcf9be8279c1baf4740ff`を基準に資料を分類。**製品要件の正本は[初期Epic #1](https://github.com/yohn-jp/praetorium/issues/1)と最新の明示的なオーナー指示**。このディレクトリの文章は製品要件や実環境の成功を自動的に追加・保証しない。後のユーザー指示により**CI実行は許可**されている。

## 最初に読む3文書

| 文書 | 何が分かるか | 種別 |
| --- | --- | --- |
| [システム全体像](architecture/SYSTEM.md) | Cloudflare Worker/D1/DO/KV、VM、K3s、BuildKit、Registry、Scriptorium、GitHub、CIの**存在目的・責務・正本・禁止境界** | 現行ソースから再構築した地図 |
| [動作経路・実行契機](architecture/EXECUTION.md) | ログイン→wake→handoff→保存、構成Build、Runtime停止/置換、Release、短命Credential、**ポーリング/Cloudflareコスト** | 現状の動作トレース |
| [設計監査・未決定事項](architecture/REVIEW.md) | 初期要件との乖離、確定した事象、変えるべき部分・維持すべき安全性・まだ決めていない設計 | 観測と提案を区別した監査 |

**重要:** 上の3文書は既存実装の「正しさ」を宣言する文書ではない。現行実装と、要件が求める動作の差分を読めるようにするための入口である。

## 役割別の資料

| 目的 | 読む資料 | 解釈上の注意 |
| --- | --- | --- |
| 初期受入要件 | [Epic #1](https://github.com/yohn-jp/praetorium/issues/1) | 最優先。CI禁止の旧記述は最新のユーザー指示で上書き済み |
| 旧アーキテクチャ草案 | [PLATFORM.md](architecture/PLATFORM.md) | 移行時の実装想定。新しいトポロジーの正本ではない |
| Producer ABI | [SCRIPTORIUM-CONTRACT.md](architecture/SCRIPTORIUM-CONTRACT.md) | Versioned contract・歴史的な実装差分を含む。現行稼働を単独で証明しない |
| デプロイ操作 | [再現可能デプロイ](deployment/REPRODUCIBLE-DEPLOYMENT.md)、[ホスト手順](deployment/UBUNTU-2404.md)、[deployment/README](deployment/README.md) | `--check`/`--apply`の境界と実運用Secrets、稼働実証は別 |
| 実Host・Runtime受入 | [検証記録の索引](verification/README.md) | 各レポートは観測したソースSHA/環境にだけ有効 |
| 移行の実装履歴 | [移行索引](migration/README.md)、[PLAN.md](migration/PLAN.md) | T00–T15タスクを現在のプロダクト要件と混同しない |
| オフライン旧データ復旧 | [recovery/README.md](recovery/README.md) | 通常Runtimeは旧PVC/未公開成果を削除しない |
| CI・開発ルール | [../AGENTS.md](../AGENTS.md)、[GitHub Actions](../.github/workflows/publish-services.yml) | CIは許可。公開・本番デプロイは別途承認 |

## 最新の検証範囲

- **VMホスト層:** [Ubuntu 26.04実機物証](verification/UBUNTU-2604-20261017.md)。2台のゲスト、K3s、rootless BuildKit、実OCI生成、キャッシュ、再起動後の復帰まで確認。
- **Hosted製品層:** [既存Hosted統合レポート](verification/HOSTED-ACCEPTANCE-a669f5c.json)は`workers-d1-do`以外の主要分類が`BLOCKED/NOT_CHECKED`。当該レポートは現在mainの全面合格を示さない。
- **公開適用:** Ubuntuホスト検証と、Cloudflare/K3s/Scriptoriumの全製品経路が本番で動くことは同義ではない。

## ドキュメントの信頼レベル

1. **Authority:** ユーザーの最新指示、初期Epic #1。要件・非要件を決める。
2. **Actual implementation:** 固定したcommitの実コード・マイグレーション・Manifest。何が実装されているかを示す（設計妥当性を保証しない）。
3. **Versioned producer contract:** 実際に認証・署名・ビルドの互換性判定に使うSchema/API。発行済みArtifactとの組合せで評価する。
4. **Design/audit:** `architecture/SYSTEM.md`、`EXECUTION.md`、`REVIEW.md`、旧`PLATFORM.md`。設計を説明・批判するが、認可や実行結果の証拠ではない。
5. **Campaign history/evidence:** `migration` と `verification`。過去の合意・中間結果を保存し、最新の事実として再利用する場合はSHAと環境を必ず再確認する。

## 既存資料を消さない理由

`docs/migration/tasks/*`、`docs/verification/*`には受入根拠、失敗記録、Source Revision、復旧証拠、過去のブロッカーが残っている。重複を理由に削除すると、後から正否を検証できなくなる。**一次の全体像は本索引から3文書へ集約**し、詳細な履歴は索引経由で辿れるようにする。修正が必要なときに古いレポートを上書きして成功を装わない。
