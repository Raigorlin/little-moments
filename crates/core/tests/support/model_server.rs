//! `ModelServer`（任務 9.3）：以 `apply(Mode::Commit)` 依序執行一串（身分, 命令），並與 design A1 的 `execute()` 一樣
//! 指定 Seq、Row_Version 與 Ordinal（新列依 `Outcome::created` 的順序，從 `next_ordinal` 起），記錄每個 Seq 的
//! Change_Set 與 Snapshot。規則與合併因此可以在不連資料庫的情況下測試。
//!
//! - [`arb_script()`]：一份起始狀態（`arb_valid_state()`）與 0–40 個（身分, 命令）。身分來自
//!   `arb_sender_caps()`；命令由 `arb_command()` 依起始狀態產生，所以後面的命令可能指向已被前面的命令刪除的列。
//!   被拒絕或沒有變化的命令不產生 Change_Set，大約四分之一的命令有變化。
//! - [`arb_delivery_plan()`]：把 Change_Set 1..=n 排列、重複，並在任意位置插入任意 Seq（0..=n）的 Snapshot。Seq 大於
//!   這些 Snapshot 中最大 Seq 的每個 Change_Set 至少送達一次；不大於它的 Change_Set 可能完全沒有送達，因為它們已經
//!   包含在那份 Snapshot 中（需求 12.12；[`DeliveryPlan::schedule()`]）。
//! - [`Delivery::for_unbound_admin()`] 與 [`unbound_admin_snapshot()`]：Unbound_Admin 收到的內容，不含 Ledger_Rows
//!   （需求 6.12、6.13）。
//!
//! 起始狀態的每一列以 Row_Version 0 寫入，Head 為 0，就像剛建立的旅行（需求 8.4）；`arb_state()` 原本的版本號是
//! 隨意的，留著會讓 Seq 1 之後的變化看起來比既有的列舊。

use std::collections::BTreeMap;

use lm_core::apply::{apply, Ctx, Effect, Mode};
use lm_core::command::Command;
use lm_core::ids::{CommandId, PersonId, TripId};
use lm_core::model::{Entity, Role, Row, Seq, Slot, TripState};
use lm_core::rules::capabilities;
use lm_core::sync::{Change, ChangeSet, Snapshot, Viewer};
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::Index;
use uuid::Uuid;

use super::commands::{
    actor, arb_command, arb_sender_caps, arb_valid_state, ctx_of, owner, CommitIds,
};

/// 起始狀態與依序執行的（身分, 命令）。
#[derive(Clone, Debug)]
pub struct Script {
    pub initial: TripState,
    pub steps: Vec<(Ctx, Command)>,
}

/// 一份起始狀態與 0–40 個（身分, 命令）。
pub fn arb_script() -> impl Strategy<Value = Script> {
    arb_valid_state().prop_flat_map(|initial| {
        let step = (arb_sender_caps(&initial), arb_command(&initial))
            .prop_map(|(caps, command)| (ctx_of(caps), command));
        (Just(initial), vec(step, 0..=40)).prop_map(|(initial, steps)| Script { initial, steps })
    })
}

/// Snapshot 的檢視者：Trip_Owner，綁定 `state` 中第一位綁定帳號的旅伴；沒有綁定帳號的旅伴時仍給一個 Bound_Person，
/// 使 Snapshot 一定包含 Ledger_Rows（與 Change_Set 相同的檢視範圍）。
fn owner_viewer(state: &TripState) -> Viewer {
    let me = state
        .people_by_ordinal()
        .find(|person| person.bound)
        .map_or(PersonId(Uuid::nil()), |person| person.id);
    Viewer {
        user: owner(),
        username: "owner".to_owned(),
        display_name: "主辦人".to_owned(),
        role: Role::Member,
        caps: capabilities(owner(), owner(), Role::Member, Some(me)),
    }
}

/// 支出（含分攤旅伴）或還款（Ledger_Rows）。
pub fn is_ledger_row(row: &Row) -> bool {
    matches!(row.slot().0, Entity::Expense | Entity::Settlement)
}

/// `state` 去掉 Ledger_Rows：Unbound_Admin 看到的 Trip_State（需求 6.12）。
pub fn without_ledger_rows(state: &TripState) -> TripState {
    let mut state = state.clone();
    state.expenses.clear();
    state.settlements.clear();
    state
}

/// 模型伺服器：依序執行命令，記錄每個 Seq 的 Change_Set 與狀態。
#[derive(Clone, Debug)]
pub struct ModelServer {
    trip: TripId,
    /// Seq 0..=Head 的狀態。
    states: Vec<TripState>,
    /// Seq 1..=Head 的 Change_Set。
    changesets: Vec<ChangeSet>,
    next_ordinal: u64,
    ids: CommitIds,
}

impl ModelServer {
    /// 以 `initial` 作為 Seq 0 的狀態：每一列的 Row_Version 是 0。
    pub fn new(initial: &TripState) -> ModelServer {
        let rows: Vec<Row> = initial
            .rows()
            .into_iter()
            .map(|row| row.with_version(0))
            .collect();
        let state = TripState::from_rows(&rows).expect("狀態有 Trip_Card");
        ModelServer {
            trip: state.card.id,
            next_ordinal: state.max_ordinal() + 1,
            states: vec![state],
            changesets: Vec::new(),
            ids: CommitIds::default(),
        }
    }

    /// 依序執行 `script` 的每一步。
    pub fn run(script: &Script) -> ModelServer {
        let mut server = ModelServer::new(&script.initial);
        for (ctx, command) in &script.steps {
            server.commit(ctx, command);
        }
        server
    }

    /// 目前的 Head。
    pub fn head(&self) -> Seq {
        self.changesets.len() as Seq
    }

    /// 目前的狀態。
    pub fn state(&self) -> &TripState {
        self.states.last().expect("至少有 Seq 0 的狀態")
    }

    /// Seq `seq` 的 Change_Set（1..=Head）。
    pub fn changeset(&self, seq: Seq) -> &ChangeSet {
        &self.changesets[seq as usize - 1]
    }

    /// Seq 1..=Head 的 Change_Set。
    pub fn changesets(&self) -> &[ChangeSet] {
        &self.changesets
    }

    /// Seq `seq`（0..=Head）當下的狀態。
    pub fn state_at(&self, seq: Seq) -> &TripState {
        &self.states[seq as usize]
    }

    /// Seq `seq` 當下的 Snapshot，檢視者是 Trip_Owner（看得到 Ledger_Rows）。
    pub fn snapshot_at(&self, seq: Seq) -> Snapshot {
        let state = self.state_at(seq);
        Snapshot {
            trip: self.trip,
            seq,
            viewer: owner_viewer(state),
            rows: state.rows(),
        }
    }

    /// 以 `ctx` 執行 `command`（design A1 的 `execute()`）：成功而且有變化時取得下一個 Seq，回傳它的 Change_Set；
    /// 被拒絕或沒有變化時不使用新的 Seq。
    pub fn commit(&mut self, ctx: &Ctx, command: &Command) -> Option<&ChangeSet> {
        let state = self.state().clone();
        let outcome = apply(&state, ctx, Mode::Commit, &mut self.ids, command).ok()?;
        if outcome.is_noop() {
            return None;
        }
        let seq = self.head() + 1;
        let ordinals: BTreeMap<Slot, u64> = outcome
            .created
            .iter()
            .zip(self.next_ordinal..)
            .map(|(slot, ordinal)| (*slot, ordinal))
            .collect();
        self.next_ordinal += outcome.created.len() as u64;
        let changes: Vec<Change> = outcome
            .effects()
            .into_iter()
            .map(|effect| match effect {
                Effect::Upsert(row) => {
                    let (entity, key) = row.slot();
                    let row = match ordinals.get(&(entity, key)) {
                        Some(&ordinal) => row.with_ordinal(ordinal),
                        None => row,
                    };
                    Change {
                        entity,
                        key,
                        version: seq,
                        row: Some(row.with_version(seq)),
                    }
                }
                Effect::Delete((entity, key)) => Change {
                    entity,
                    key,
                    version: seq,
                    row: None,
                },
            })
            .collect();
        let mut next = state;
        for change in &changes {
            match &change.row {
                Some(row) => next.put(row.clone()),
                None => {
                    next.remove(change.slot());
                }
            }
        }
        self.states.push(next);
        self.changesets.push(ChangeSet {
            trip: self.trip,
            seq,
            command_id: CommandId(Uuid::from_u128(u128::from(seq))),
            actor: ctx.actor,
            committed_at_ms: 1_795_000_000_000 + seq as i64,
            changes,
            trip_deleted: false,
        });
        self.changesets.last()
    }
}

/// 送達的一個事件。
#[derive(Clone, Debug)]
pub enum Delivery {
    Change(ChangeSet),
    Snapshot(Snapshot),
}

impl Delivery {
    /// Unbound_Admin 收到的同一個事件：Change_Set 移除 Ledger_Rows 的變化、保留 Seq；Snapshot 見
    /// [`unbound_admin_snapshot()`]（需求 6.12、6.13）。
    pub fn for_unbound_admin(self) -> Delivery {
        match self {
            Delivery::Change(cs) => Delivery::Change(cs.for_viewer(true)),
            Delivery::Snapshot(snapshot) => Delivery::Snapshot(unbound_admin_snapshot(snapshot)),
        }
    }
}

/// Unbound_Admin 讀到的同一份 Snapshot：不含 Ledger_Rows，檢視者是沒有 Bound_Person 的 Admin（需求 6.12、12.8）。
pub fn unbound_admin_snapshot(snapshot: Snapshot) -> Snapshot {
    Snapshot {
        viewer: Viewer {
            user: actor(),
            username: "admin".to_owned(),
            display_name: "管理員".to_owned(),
            role: Role::Admin,
            caps: capabilities(owner(), actor(), Role::Admin, None),
        },
        rows: snapshot
            .rows
            .into_iter()
            .filter(|row| !is_ledger_row(row))
            .collect(),
        ..snapshot
    }
}

/// Change_Set 與 Snapshot 的送達方式；實際的 Seq 由 `schedule()` 依伺服器的 Head 決定。
#[derive(Clone, Debug)]
pub struct DeliveryPlan {
    /// 第 k 個 Change_Set（Seq k + 1）以 `order[k % len]` 的鍵排序；旗標為假、而且已包含在插入的 Snapshot 中
    /// （Seq 不大於它們的最大 Seq）時不送達。
    order: Vec<(u32, bool)>,
    /// 重複送達：（要重複的 Change_Set，在 1..=Head 中選, 插入的位置）。
    repeats: Vec<(Index, Index)>,
    /// 插入的 Snapshot：（Seq，在 0..=Head 中選, 插入的位置）。
    snapshots: Vec<(Index, Index)>,
}

/// 任意的排列、0–6 次重複與 0–3 個 Snapshot。
pub fn arb_delivery_plan() -> impl Strategy<Value = DeliveryPlan> {
    (
        vec((any::<u32>(), any::<bool>()), 1..=32),
        vec((any::<Index>(), any::<Index>()), 0..=6),
        vec((any::<Index>(), any::<Index>()), 0..=3),
    )
        .prop_map(|(order, repeats, snapshots)| DeliveryPlan {
            order,
            repeats,
            snapshots,
        })
}

impl DeliveryPlan {
    /// `server` 的 Change_Set 1..=Head 依這個計畫送達：Seq 大於插入的 Snapshot 中最大 Seq 的每個 Change_Set 至少
    /// 送達一次，其餘的可能沒有送達；重複與 Snapshot 插在任意位置。
    pub fn schedule(&self, server: &ModelServer) -> Vec<Delivery> {
        let head = server.head();
        let snapshots: Vec<(Seq, Index)> = self
            .snapshots
            .iter()
            .map(|(which, at)| (which.index(head as usize + 1) as Seq, *at))
            .collect();
        let covered = snapshots.iter().map(|(seq, _)| *seq).max().unwrap_or(0);
        let key = |seq: Seq| self.order[(seq as usize - 1) % self.order.len()];
        let mut seqs: Vec<Seq> = (1..=head)
            .filter(|&seq| seq > covered || key(seq).1)
            .collect();
        seqs.sort_by_key(|&seq| (key(seq).0, seq));
        let mut events: Vec<Delivery> = seqs
            .iter()
            .map(|&seq| Delivery::Change(server.changeset(seq).clone()))
            .collect();
        if head > 0 {
            for (which, at) in &self.repeats {
                let seq = which.index(head as usize) as Seq + 1;
                let position = at.index(events.len() + 1);
                events.insert(position, Delivery::Change(server.changeset(seq).clone()));
            }
        }
        for (seq, at) in snapshots {
            let position = at.index(events.len() + 1);
            events.insert(position, Delivery::Snapshot(server.snapshot_at(seq)));
        }
        events
    }
}
