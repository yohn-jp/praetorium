# Verification documents — 実証記録の索引

各レポートは**対応するコミット・Artifact Digest・実行環境・操作の範囲だけ**を証明する。[Epic #1](https://github.com/yohn-jp/praetorium/issues/1)の製品要件を、テストコードやレポート名で上書きしない。アーキテクチャの全体像は[システム地図](../architecture/SYSTEM.md)、実装と要件の差分は[設計監査](../architecture/REVIEW.md)。

最新の公開稼働状況は [Hosted進捗記録](HOSTED-PROGRESS-20261018.md#latest-operational-result--public-editor-and-github-save-2026-10-18) を参照。実ログイン・編集画面・GitHub保存まで確認済み。保存待ち時間、再読み込み後の保持、G1–G9全体の受入は未完了。

| 分類 | 代表ファイル | 読み方 |
| --- | --- | --- |
| **Ubuntuホスト** | [UBUNTU-2604-20261017.md](UBUNTU-2604-20261017.md) | Runtime/Buildゲスト、rootless mTLS BuildKit、汎用OCI、再起動。**HostedアプリのE2Eではない** |
| **Hosted統合** | [HOSTED-ACCEPTANCE-a669f5c.json](HOSTED-ACCEPTANCE-a669f5c.json)、[HOSTED-INTEGRATION-RUNBOOK.md](HOSTED-INTEGRATION-RUNBOOK.md)、[HOSTED-CAMPAIGN-2026-10-17.md](HOSTED-CAMPAIGN-2026-10-17.md) | 実行済みとBLOCKEDの分類、環境準備、Producer切り出し |
| **Producer/OCI** | [HOSTED-ARTIFACTS-008d5c4.json](HOSTED-ARTIFACTS-008d5c4.json)、[PLATFORM-SERVICE-IMAGES.md](PLATFORM-SERVICE-IMAGES.md)、`PRODUCER-*.md` | Image/Artifactの実物検証、署名Admission・実製品テストの不足を区別 |
| **K8s/Network/Isolation** | [OWNED-KUBERNETES.md](OWNED-KUBERNETES.md)、[KUBERNETES-ISOLATION.md](KUBERNETES-ISOLATION.md)、[RUNTIME-NETWORK-ADMISSION.md](RUNTIME-NETWORK-ADMISSION.md)、[TRAEFIK-RUNTIME-WATCH.md](TRAEFIK-RUNTIME-WATCH.md) | 実リソースか静的renderか、テスト専用clusterか本番かを区別 |
| **認証・Browser** | [GITHUB-ACCESS.md](GITHUB-ACCESS.md)、[BROWSER-ENTRY.md](BROWSER-ENTRY.md)、[RUNTIME-CREDENTIALS-PARTIAL.md](RUNTIME-CREDENTIALS-PARTIAL.md) | ワイヤ/fixtureの合格は実GitHubユーザーの権限・Scriptorium動作証明とは別 |
| **復旧/レガシー** | [PRODUCER-RECOVERY.md](PRODUCER-RECOVERY.md)、[LEGACY-METADATA-PARTIAL.md](LEGACY-METADATA-PARTIAL.md) | Source/cutとオフライン対象資産を確認 |
| **歴史的総括** | [FINAL.md](FINAL.md)、[ACCEPTANCE.md](ACCEPTANCE.md)、[ACCEPTANCE.json](ACCEPTANCE.json)、`DELIVERY-*.md` | **過去時点の報告**。`FINAL`という名でも今の本番合格ではない |
| **原始証跡** | [evidence/](evidence/) | 実ログ/Manifest/Digest/SHA256SUMS。元データを保持する |

受入レベルは、**実装済み**・**ローカル検証済み**・**実Hosted統合認証済み**・**本番配備済み**の4つに分ける。`BLOCKED`、`NOT_CHECKED`、実行時SKIPをPASSへ変換しない。

新しいレポートには最低限、Git commit、Scriptorium source SHA、OCI digest、クラスタ/Cloudflareの所有者が明確な環境ID、実行したコマンド、外部副作用、各ゲートの成功・失敗・未実行を記録する。失敗した過去のファイルを上書きして成功記録へ変えない。
