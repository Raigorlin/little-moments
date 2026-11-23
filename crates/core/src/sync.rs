//! 同步模型（design 1.6、A5、A6）：`Change`、`ChangeSet`、`Broadcast`、`Viewer`、`Snapshot`、`Replica` 與
//! `overlay()`。
//!
//! 伺服器保證每趟旅行的 Change_Set 的 Seq 唯一、連續，同一則中每個 Slot 最多一筆，而且每筆的 Row_Version 等於 Seq。
//! 於是同一個 Slot 的所有變化版本互不相同，`Replica` 只保留版本最大的那一筆，結果與送達的順序和重複無關；水位線
//! 入口的整則忽略讓重送無害，墓碑讓亂序抵達的舊內容不會讓已刪除的列復活（Property 1）。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::apply::{apply, Ctx, Effect, Mode, NoDerivedIds};
use crate::command::Command;
use crate::ids::{CommandId, TripId, UserId};
use crate::model::{Entity, Role, Row, RowKey, Seq, Slot, TripState};
use crate::rules::Capabilities;

/// 一列的一次變化；`row` 是 `None` 時是刪除。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub entity: Entity,
    pub key: RowKey,
    /// 這次變化的 Row_Version，等於 Change_Set 的 Seq；刪除也有版本。
    pub version: Seq,
    pub row: Option<Row>,
}

impl Change {
    /// 變化的列。
    pub fn slot(&self) -> Slot {
        (self.entity, self.key)
    }

    /// 支出（含分攤旅伴）或還款的變化（Ledger_Rows）。
    pub fn is_ledger(&self) -> bool {
        matches!(self.entity, Entity::Expense | Entity::Settlement)
    }
}

/// `apply()` 的效果寫成 Seq 為 `seq` 的變化：每一列的 Row_Version 都是 `seq`（需求 7.17、8.4）。
pub fn changes(effects: &[Effect], seq: Seq) -> Vec<Change> {
    effects
        .iter()
        .map(|effect| match effect {
            Effect::Upsert(row) => {
                let (entity, key) = row.slot();
                Change {
                    entity,
                    key,
                    version: seq,
                    row: Some(row.clone().with_version(seq)),
                }
            }
            Effect::Delete((entity, key)) => Change {
                entity: *entity,
                key: *key,
                version: seq,
                row: None,
            },
        })
        .collect()
}

/// 一次有變化的提交（一個命令、刪除旅行或以邀請連結加入）的全部變化。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSet {
    pub trip: TripId,
    /// 這趟旅行的第幾次提交；從 1 開始、連續、不跳號。
    pub seq: Seq,
    pub command_id: CommandId,
    pub actor: UserId,
    pub committed_at_ms: i64,
    /// 每個 Slot 最多一筆；每筆的版本都是 `seq`。
    pub changes: Vec<Change>,
    #[serde(default)]
    pub trip_deleted: bool,
}

impl ChangeSet {
    /// 移除 Ledger_Rows（支出含分攤旅伴、還款，包括刪除）的變化，其餘欄位與 Seq 不變；只含 Ledger_Rows 的
    /// Change_Set 因此變成沒有任何變化，但仍保留它的 Seq（需求 6.12、6.13、12.15）。
    pub fn without_ledger(&self) -> ChangeSet {
        ChangeSet {
            changes: self
                .changes
                .iter()
                .filter(|change| !change.is_ledger())
                .cloned()
                .collect(),
            ..self.clone()
        }
    }

    /// 檢視者看不到 Ledger_Rows（`Viewer::hides_ledger()`）時回傳 `without_ledger()`，否則原樣回傳。
    pub fn for_viewer(self, hide_ledger: bool) -> ChangeSet {
        if hide_ledger {
            self.without_ledger()
        } else {
            self
        }
    }
}

/// Realtime 推送的 payload：一般是完整的 Change_Set；超過 65,536 位元組時只送 Seq（Thin_Notice），由客戶端補齊
/// （需求 10.2）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Broadcast {
    Full(ChangeSet),
    Thin { trip: TripId, seq: Seq, thin: bool },
}

impl Broadcast {
    /// 推送的 Seq。
    pub fn seq(&self) -> Seq {
        match self {
            Broadcast::Full(changeset) => changeset.seq,
            Broadcast::Thin { seq, .. } => *seq,
        }
    }
}

/// 讀取 Snapshot 的人。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewer {
    pub user: UserId,
    pub username: String,
    /// 帳號的顯示名稱（app.profiles.display_name），不是旅伴名稱。
    pub display_name: String,
    pub role: Role,
    pub caps: Capabilities,
}

impl Viewer {
    /// 沒有 Bound_Person 的檢視者（Unbound_Admin）看不到 Ledger_Rows（需求 6.12、6.13、6.18）。
    pub fn hides_ledger(&self) -> bool {
        self.caps.me.is_none()
    }
}

/// 某個 Seq 當下的完整狀態（伺服器在同一個 REPEATABLE READ 交易內讀出），包括 Trip_Card。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub trip: TripId,
    pub seq: Seq,
    pub viewer: Viewer,
    pub rows: Vec<Row>,
}

impl TripState {
    /// 由每一列組成 Trip_State；沒有 Trip_Card 時是 `None`。
    pub fn from_rows<'a>(rows: impl IntoIterator<Item = &'a Row>) -> Option<TripState> {
        let rows: Vec<&Row> = rows.into_iter().collect();
        let card = rows.iter().find_map(|row| match row {
            Row::Card(card) => Some(card.clone()),
            _ => None,
        })?;
        let mut state = TripState::new(card);
        for row in rows {
            state.put(row.clone());
        }
        Some(state)
    }

    /// 每一列，依 Slot 遞增。
    pub fn rows(&self) -> Vec<Row> {
        self.slots().filter_map(|slot| self.get(slot)).collect()
    }
}

/// `Replica::apply_changeset()` 與 `apply_snapshot()` 的結果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// 內容真的改變的列（畫面只更新這些，需求 14.1），每個 Slot 一次。
    pub changed: Vec<Slot>,
    /// 已反映過的 Change_Set（重複，或不大於水位線），整則忽略。
    pub duplicate: bool,
    /// 套用之後第一段缺少的 Seq（含頭尾），需要補齊（需求 12.3）；整則忽略時也回報。
    pub gap: Option<(Seq, Seq)>,
    pub trip_deleted: bool,
}

/// 客戶端已確認的狀態（design A5）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replica {
    pub state: TripState,
    /// 亂序期間被刪除的列與刪除的版本；不大於水位線即丟棄。
    tombstones: BTreeMap<Slot, Seq>,
    /// 不大於水位線的 Change_Set 都已反映在 `state`。
    pub watermark: Seq,
    /// 已套用、但前面還有缺號的 Seq。
    ahead: BTreeSet<Seq>,
}

impl Replica {
    /// 由 Snapshot 建立，水位線是 Snapshot 的 Seq；Snapshot 沒有 Trip_Card 時是 `None`。
    pub fn from_snapshot(snapshot: &Snapshot) -> Option<Replica> {
        Some(Replica {
            state: TripState::from_rows(&snapshot.rows)?,
            tombstones: BTreeMap::new(),
            watermark: snapshot.seq,
            ahead: BTreeSet::new(),
        })
    }

    /// `slot` 目前的版本：現有列的 Row_Version，或刪除它的版本；都沒有時為 0。
    pub fn version_of(&self, slot: Slot) -> Seq {
        self.state
            .get(slot)
            .map(|row| row.version())
            .or_else(|| self.tombstones.get(&slot).copied())
            .unwrap_or(0)
    }

    /// 套用一則 Change_Set（design A5）：重複或不大於水位線的整則忽略；每一列只採用版本比目前新的變化；刪除留下
    /// 墓碑直到不大於水位線；推進水位線並回報第一段缺號（需求 12.3、12.10–12.12）。
    ///
    /// 整則忽略時狀態完全不變，但仍回報目前的缺號：一次合併多則時，最後一則是重複的也不會蓋掉前面發現的缺號。
    pub fn apply_changeset(&mut self, cs: &ChangeSet) -> ApplyReport {
        let mut report = ApplyReport::default();
        if cs.seq <= self.watermark || self.ahead.contains(&cs.seq) {
            report.duplicate = true;
            report.gap = self.gap();
            return report;
        }
        for change in &cs.changes {
            let slot = change.slot();
            if change.version <= self.version_of(slot) {
                // 已有較新的版本（亂序抵達）
                continue;
            }
            let before = self.state.get(slot);
            match &change.row {
                Some(row) => {
                    self.state.put(row.clone());
                    self.tombstones.remove(&slot);
                }
                None => {
                    self.state.remove(slot);
                    self.tombstones.insert(slot, change.version);
                }
            }
            if self.state.get(slot) != before {
                report.changed.push(slot);
            }
        }
        report.trip_deleted = cs.trip_deleted;
        self.ahead.insert(cs.seq);
        self.advance();
        report.gap = self.gap();
        report
    }

    /// 套用一份 Snapshot（design A5）：本地有、Snapshot 沒有、版本不大於 Snapshot 的 Seq 的列視為已刪除；Snapshot 中
    /// 的列比本地新才採用；水位線至少是 Snapshot 的 Seq。讀取 Snapshot 不影響 Pending_Command（需求 12.14）。
    /// Seq 不大於水位線的 Snapshot 整份忽略，與 `apply_changeset()` 一樣仍回報目前的缺號。
    pub fn apply_snapshot(&mut self, snapshot: &Snapshot) -> ApplyReport {
        let mut report = ApplyReport::default();
        if snapshot.seq <= self.watermark {
            report.duplicate = true;
            report.gap = self.gap();
            return report;
        }
        let in_snapshot: BTreeSet<Slot> = snapshot.rows.iter().map(Row::slot).collect();
        let stale: Vec<Slot> = self
            .state
            .slots()
            .filter(|slot| !in_snapshot.contains(slot) && self.version_of(*slot) <= snapshot.seq)
            .collect();
        for slot in stale {
            if self.state.remove(slot).is_some() {
                report.changed.push(slot);
            }
        }
        for row in &snapshot.rows {
            let slot = row.slot();
            if row.version() > self.version_of(slot) {
                let before = self.state.get(slot);
                self.state.put(row.clone());
                self.tombstones.remove(&slot);
                if self.state.get(slot) != before {
                    report.changed.push(slot);
                }
            }
        }
        self.watermark = snapshot.seq;
        self.ahead.retain(|&seq| seq > snapshot.seq);
        self.advance();
        report.gap = self.gap();
        report
    }

    /// 連續的 Seq 推進水位線；版本不大於水位線的墓碑可以丟掉（之後會套用的變化，版本都大於水位線）。
    fn advance(&mut self) {
        while self.ahead.remove(&(self.watermark + 1)) {
            self.watermark += 1;
        }
        let watermark = self.watermark;
        self.tombstones.retain(|_, version| *version > watermark);
    }

    /// 第一段缺號：水位線之後到第一個已套用的 Seq 之前。
    fn gap(&self) -> Option<(Seq, Seq)> {
        self.ahead
            .first()
            .map(|&first| (self.watermark + 1, first - 1))
    }
}

/// 尚未得到伺服器回應的本地命令。
#[derive(Clone, Debug, PartialEq)]
pub struct PendingCmd {
    pub id: CommandId,
    pub command: Command,
}

/// 畫面看到的狀態（Optimistic_View，design A6）：已確認狀態依序疊上仍在等待的命令的主要效果，每個命令在前一個的
/// 結果上以 `Mode::Predict` 重新套用；不成立的命令暫時不顯示，但仍留在佇列中依序送出，以伺服器回應為準
/// （需求 13.6、13.7）。預測的新列帶著暫時的 Ordinal，排在同一種列的最後（需求 7.18）。
pub fn overlay(confirmed: &TripState, pending: &[PendingCmd], ctx: &Ctx) -> TripState {
    let mut view = confirmed.clone();
    for op in pending {
        if let Ok(outcome) = apply(&view, ctx, Mode::Predict, &mut NoDerivedIds, &op.command) {
            view.apply_effects(&outcome.primary);
        }
    }
    view
}
