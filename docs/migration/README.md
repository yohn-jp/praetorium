# Migration documents — 履歴・証跡の索引

**現在のシステム全体像は[docs/architecture/SYSTEM.md](../architecture/SYSTEM.md)**、状態遷移は[EXECUTION.md](../architecture/EXECUTION.md)、実装との不整合は[REVIEW.md](../architecture/REVIEW.md)。このディレクトリは「実装キャンペーンの履歴」であり、新たな製品要件の正本ではない。製品要件は[初期Epic #1](https://github.com/yohn-jp/praetorium/issues/1)と最新のオーナー指示。

| ファイル／範囲 | 意味 | 取り扱い |
| --- | --- | --- |
| [PLAN.md](PLAN.md)、[SOL-GOAL.md](SOL-GOAL.md) | 移行作業のT00–T15、当時の担当・順序・前提 | **歴史的作業計画**。書かれている方式を現在の正解としない |
| [COVERAGE.json](COVERAGE.json)、[SOURCE-HANDLERS.json](SOURCE-HANDLERS.json) | Arcadia→Praetoriumの移行漏れを照合する証跡 | Scope/Source IDの台帳。実行結果とは異なる |
| [task-status.json](task-status.json)、[PRODUCER-STATUS.json](PRODUCER-STATUS.json) | タスク別・Producer別の記録 | **記載された改訂・環境に対するスナップショット** |
| [BASELINE.json](BASELINE.json)、[PROVENANCE.md](PROVENANCE.md) | 元コードとベースラインの来歴 | 不変の履歴 |
| [tasks/](tasks/) | 各Taskの設計・分担・過去の実装証拠 | 最新のシステム境界の主文書として読まない |

閲覧順は**Epic #1 → SYSTEM → EXECUTION → REVIEW → 必要なTask/証拠**。履歴文書の中に実装完了宣言があっても、現在のmainでのHosted実環境合格を意味しない。CIは最新指示により許可されているため、昔の「No GitHub Actions」を現在の禁止事項として扱わない。
