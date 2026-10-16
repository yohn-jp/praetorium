/goal

# Praetorium — Complete Platform Migration

Coordinator: Sol
Workers: Luna / subagents。独立作業は人数の人工的な上限なく並列化する。
Target: https://github.com/yohn-jp/praetorium
Read-only source: https://github.com/yohn-jp/arcadia-platform
Producer: https://github.com/yohn-jp/scriptorium（既存の並行開発担当を維持）
Authority: Praetorium Epic #1
Planning branch: docs/1-platform-migration-plan

## Goal

合意済みの認証・repository単位のinstance・アドオン選択・構成別OCIビルドを実装し、Arcadia Platformの必要な既存機能を責務ごとのproviderパッケージへ移行する。
ログイン→repository選択→新規/既存instance解決→ビルド/起動→接続→UIから再構成/再デプロイまで完成させる。
設計、雛形、APIだけ、fixtureだけで終わらず、検証済み成果をPraetorium mainへcommit・pushする。

## Canonical plan

最初に最新main・Issue #1・planning branch/PRと以下を読む。未反映の計画は取り込む。重複実装しない。
- docs/architecture/PLATFORM.md
- docs/architecture/SCRIPTORIUM-CONTRACT.md
- docs/migration/PLAN.md
- docs/migration/COVERAGE.json

T00〜T15の固定キャンペーンを一括で実行する。合意済み設計の再承認要求、3件ずつ等の人工的な分割、各Wave末尾での停止は禁止。
確認済みtarget: a062b67aa028894422f68ed54717109f583871f9
source: b96a03a8734bfff2e5b965e6966007c45a2c7dc9
producer: 5ee8f0f0f0b9ee63b4920f2a73f3d76baa2cef1a
実行開始時に更新を確認し、関連差分だけ整合する。sourceの古いREADMEより実際のentry pointを優先する。

## Fixed boundaries

repository_id→instance_id。ユーザーはGitHub Appユーザー認証と現在のrepository権限で認可する。独自ACLやユーザー別の重複instanceは作らない。
ScriptoriumのGit操作はrepository限定のApp installation token。App鍵・user token・GHCR公開資格情報を混同しない。
Gatewayが認証と起動/接続を調停し、通常の作品本文はWorkersを経由させない。停止中のinstance直URLにもwake導線を用意し、API/MCPの書込みを自動再送しない。

アドオン選択とリソース割当はPraetorium。実装/依存/ビルドレシピはScriptorium。
承認済みRuntime Base/Build Kitとimmutable入力からBuildKit workerで構成別にビルドし、同構成は共有OCIキャッシュを再利用する。
作品データ・Git tokenをビルドに入れない。起動時npm install、任意Dockerfile、任意外部プラグイン、モジュール別コンテナ群は禁止。

TypeScript/Node、pnpm/Turbo、Workers/D1/DO、Nix/K3s/Fluxを再利用し、GitHub/GHCR/BuildKit/Kubernetes/Scriptoriumの実装を明示的provider境界へ分離する。
根拠のない全面言語変更・別の汎用PaaS・新規執筆機能は作らない。

一時cloneと論理instanceの寿命を分離する。未push checkpoint・処理中・状態不明なら自動破棄しない。lease期限だけで旧writer消滅を推測しない。
新イメージのビルド/検証が終わるまで現行instanceを維持し、stable/pinnedと同一digestの再デプロイを区別する。

## Execution

今回もSolによるPraetorium mainへの直接commit・pushを許可する。各Issueのbranch/PRは不要。
Solが共有契約、root manifest/lockfile、D1 migration、統合を一元管理する。workerは独立領域と確定したproducer checkpointを使い、意味のある単位でcommitして返す。
Solは完成までコミットを保留せず継続的にmainへ統合・pushする。force-push、履歴削除、他者の作業破棄は禁止。

T01で実在するproducer契約をpreflightし、S01〜S05の状態を固定する。
Scriptoriumは並行作業中なのでmain/worktreeを勝手に変更しない。必要なproducer修正はSCRIPTORIUM-CONTRACT.mdの明確なhandoffとして既存担当へ渡す。
提供側が未完了でも独立したPlatform作業は続ける。互換shim・static token・fixtureを本物として扱って不足を隠さない。

既存route/runtime/infra/recoveryをCOVERAGE.jsonへ対応付け、担当範囲のhandlerを展開してtarget/proofを記録する。移動やrenameだけで完了扱いしない。
旧PVC、未push履歴、秘密情報を勝手に移行/削除しない。公開してよいソースと通知事項だけを移植する。

## Verification and limits

CI/GitHub Actions・組織テンプレート同期/追加/実行・Inariは禁止。Build Serviceは製品機能として実装する。
ローカル型検査・必要なテスト・build・実Worker/D1/DO・BuildKit/registry・Kubernetes・ブラウザ・実Scriptorium artifactを計画どおり検証する。
本番Cloudflare/D1/DNS/K3s/NixOS適用、鍵変更、公開package/release、旧データ削除は別途許可なしに実施しない。明示された所有下のdisposable test環境で検証する。

レビューは実装担当と別のread-only reviewerへ割り当てる。Solは根拠ある指摘を担当へ修正させ、必要な再検証を行う。
外部権限・producer・実行環境が不足する場合は、該当gateのみBLOCKED/NOT_CHECKEDとして原因・試行・最小解除条件を記録し、他の固定タスクと成果保存を続ける。未検証を成功としない。

## Stop

成功条件はEpic #1、T00〜T15、coverageと実producer接続の受入条件を満たし、独立レビューを解消して、全成果がmainへcommit・pushされていること。
最終報告: main HEAD、各task/coverage、producer契約とartifact digest、実行した検証、計測結果、deploy/preflight手順、残る外部blocker。
実装完了・統合検証完了・デプロイ可能・本番デプロイ済みを区別する。固定キャンペーン外の探索や機能追加で終了を先延ばししない。
