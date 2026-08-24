-- 既存の「珠洲土木事務所等令和６年能登半島地震災害復旧工事」工程表（room='default'）を
-- 新しい工事一覧ページに表示させるための移行SQL。
--
-- これを実行しても ops テーブルのデータ（807件の操作履歴）は一切変更されません。
-- projects テーブルに「room='default'を一覧に表示する」ための1行を追加するだけです。
--
-- 実行前に schema.sql を先に実行しておいてください（projects テーブルがまだ無ければ作成されます）。

INSERT INTO projects (id, name, meta, created_at, updated_at)
VALUES (
  'default',
  '珠洲土木事務所等令和６年能登半島地震災害復旧工事（余裕期間対象工事）',
  '{"projectName":"珠洲土木事務所等令和６年能登半島地震災害復旧工事（余裕期間対象工事）","orderer":"石川県土木部営繕課","location":"珠洲市野々江町シの部３２番地ほか","supervisor":"【建築】㈱T.O.N.E. 【設備】豊原設備事務所  ","contractor":"株式会社 西中建設","contractDate":"2026-07-01","createdDate":"2026-08-05","startDate":"2026-06-22","endDate":"2028-03-05"}',
  1787460529736,
  1787460529736
);
