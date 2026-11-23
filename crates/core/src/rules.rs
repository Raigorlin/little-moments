//! 權限與個人清單：`Capabilities`、`capabilities()`、`authorize()`（Permission_Table，design 1.4），以及
//! `my_gear()`、`can_depart()`、`unassigned_gear()`、Gear_Progress 與 Packing_Progress。
//!
//! 移植自現行 `server/accounts.js` 的 `capabilities()`、`denyCollaboratorRemovals()`、`guardCollaborator()`，以及
//! `src/model.js` 的 `myGear()`、`readyCount()`、`unassigned()`、`canDepart()` 與 `progress()` 的裝備部分。

use serde::{Deserialize, Serialize};

use crate::command::{
    Command, Rejection, DENY_LEDGER_REMOVAL, DENY_OTHER_PERSON, DENY_PACKING, DENY_REMOVAL,
    TRIP_NOT_FOUND,
};
use crate::ids::{PersonId, UserId};
use crate::model::{GearItem, GearScope, Role, TripState};

/// 一位 Account 對一趟旅行能做什麼（現行 `capabilities()`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// Trip_Member 或 Admin：可以開啟旅行並送出 Command；否則一律 404「找不到這趟旅行。」。
    pub can_edit: bool,
    /// Trip_Manager（Trip_Owner 或 Admin）：可以刪除既有項目。
    pub can_manage: bool,
    /// 可以建立邀請連結。
    pub can_invite: bool,
    /// 這個 Account 在這趟旅行綁定的旅伴（Bound_Person）。
    pub me: Option<PersonId>,
}

impl Capabilities {
    /// 不是這趟旅行的成員，也不是 Admin。
    pub const NONE: Capabilities = Capabilities {
        can_edit: false,
        can_manage: false,
        can_invite: false,
        me: None,
    };

    /// 沒有 Bound_Person 的 Admin（Unbound_Admin）。
    pub fn is_unbound_admin(&self) -> bool {
        self.can_manage && self.me.is_none()
    }
}

/// 現行 `capabilities()`：Trip_Owner 或 Admin 可以管理；有 Bound_Person 的成員可以編輯與邀請。`me` 是 `actor` 在這趟
/// 旅行綁定的旅伴，不是成員時是 `None`。
pub fn capabilities(
    owner: UserId,
    actor: UserId,
    role: Role,
    me: Option<PersonId>,
) -> Capabilities {
    let manage = owner == actor || role == Role::Admin;
    Capabilities {
        can_edit: manage || me.is_some(),
        can_manage: manage,
        can_invite: manage || me.is_some(),
        me,
    }
}

/// 一個命令需要的權限（Permission_Table）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Right {
    /// Trip_Member 或 Admin。
    Edit,
    /// Trip_Manager：移除旅伴，刪除車輛、料理、採買品項或裝備。
    Manage,
    /// 只能是自己的 Bound_Person：打包與出發確認。
    SelfOnly(PersonId),
    /// 有 Bound_Person：新增或修改帳目。
    LedgerEdit,
    /// 有 Bound_Person 的 Trip_Manager：刪除帳目。
    LedgerManage,
}

/// `cmd` 需要的權限。
pub fn required_right(cmd: &Command) -> Right {
    use Command::*;
    match cmd {
        RemovePerson { .. }
        | RemoveVehicle { .. }
        | RemoveMeal { .. }
        | RemoveShoppingItem { .. }
        | RemoveGear { .. } => Right::Manage,
        SetGearPacked { person, .. } | SetDeparted { person, .. } => Right::SelfOnly(*person),
        AddExpense { .. }
        | UpdateExpense { .. }
        | AddSettlement { .. }
        | UpdateSettlement { .. } => Right::LedgerEdit,
        RemoveExpense { .. } | RemoveSettlement { .. } => Right::LedgerManage,
        _ => Right::Edit,
    }
}

/// 依 Permission_Table 判斷 `caps` 能不能執行 `cmd`（需求 6.4–6.11）。在找目標的列、驗證輸入與判斷有沒有變化之前
/// 執行，所以被拒絕的命令即使指向不存在的項目，也得到這裡的 403 或 404。只讀 `state` 中旅伴是否綁定帳號。
pub fn authorize(state: &TripState, caps: &Capabilities, cmd: &Command) -> Result<(), Rejection> {
    if !caps.can_edit {
        return Err(Rejection::not_found(TRIP_NOT_FOUND));
    }
    let right = required_right(cmd);
    let allowed = match right {
        Right::Edit => true,
        Right::Manage => caps.can_manage,
        Right::SelfOnly(person) => caps.me == Some(person),
        Right::LedgerEdit => caps.me.is_some(),
        Right::LedgerManage => caps.me.is_some() && caps.can_manage,
    };
    if !allowed {
        return Err(match right {
            Right::Manage => Rejection::forbidden(DENY_REMOVAL),
            Right::SelfOnly(_) => Rejection::forbidden(DENY_PACKING),
            Right::LedgerEdit | Right::LedgerManage if caps.me.is_none() => {
                Rejection::not_found(TRIP_NOT_FOUND)
            }
            _ => Rejection::forbidden(DENY_LEDGER_REMOVAL),
        });
    }
    if let Command::UpdatePerson { id, .. } = cmd {
        let other_bound =
            state.people.get(id).is_some_and(|person| person.bound) && caps.me != Some(*id);
        if other_bound && !caps.can_manage {
            return Err(Rejection::forbidden(DENY_OTHER_PERSON));
        }
    }
    Ok(())
}

// ── 裝備與出發 ──

/// `person` 的 My_Gear（現行 `myGear()`）：所有個人裝備，加上他負責的共用裝備，依 Ordinal。
pub fn my_gear(state: &TripState, person: PersonId) -> impl Iterator<Item = &GearItem> {
    state
        .gear_by_ordinal()
        .filter(move |gear| gear.scope == GearScope::Personal || gear.assignee == Some(person))
}

/// 負責人待分配的共用裝備（現行 `unassigned()`），依 Ordinal。
pub fn unassigned_gear(state: &TripState) -> impl Iterator<Item = &GearItem> {
    state
        .gear_by_ordinal()
        .filter(|gear| gear.scope == GearScope::Shared && gear.assignee.is_none())
}

/// Can_Depart（現行 `canDepart()`）：`person` 的 My_Gear 都已打包，而且沒有負責人待分配的共用裝備。
pub fn can_depart(state: &TripState, person: PersonId) -> bool {
    my_gear(state, person).all(|gear| gear.packed_by.contains(&person))
        && unassigned_gear(state).next().is_none()
}

/// 進度：`done / total`。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// Gear_Progress（現行 `progress()` 的裝備部分）：total 是個人裝備數乘以旅伴人數，再加上共用裝備數；done 是每個
/// 個人裝備已打包的旅伴數的總和，再加上負責人已打包的共用裝備數。待分配的共用裝備計入 total、不計入 done。
pub fn gear_progress(state: &TripState) -> Progress {
    let people = state.people.len();
    state
        .gear
        .values()
        .fold(Progress::default(), |progress, gear| match gear.scope {
            GearScope::Personal => Progress {
                done: progress.done + gear.packed_by.len(),
                total: progress.total + people,
            },
            GearScope::Shared => Progress {
                done: progress.done
                    + usize::from(gear.assignee.is_some_and(|a| gear.packed_by.contains(&a))),
                total: progress.total + 1,
            },
        })
}

/// Packing_Progress（現行 `readyCount()` 與出發清單的進度條）：`person` 的 My_Gear 中已打包的項數與 My_Gear 的項數。
pub fn packing_progress(state: &TripState, person: PersonId) -> Progress {
    my_gear(state, person).fold(Progress::default(), |progress, gear| Progress {
        done: progress.done + usize::from(gear.packed_by.contains(&person)),
        total: progress.total + 1,
    })
}

impl Progress {
    /// 百分比：done 除以 total 與 1 中較大者，乘以 100 後四捨五入到整數（現行 `Math.round()`）；0 / 0 為 0%。
    pub fn percent(&self) -> usize {
        let total = self.total.max(1);
        (self.done * 200 + total) / (total * 2)
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    fn user(n: u128) -> UserId {
        UserId(Uuid::from_u128(n))
    }

    #[test]
    fn capabilities_follow_the_current_rules() {
        let me = Some(PersonId(Uuid::from_u128(9)));
        let owner = capabilities(user(1), user(1), Role::Member, me);
        assert_eq!(
            (owner.can_edit, owner.can_manage, owner.can_invite),
            (true, true, true)
        );
        let collaborator = capabilities(user(1), user(2), Role::Member, me);
        assert_eq!(
            (
                collaborator.can_edit,
                collaborator.can_manage,
                collaborator.can_invite
            ),
            (true, false, true)
        );
        let admin = capabilities(user(1), user(3), Role::Admin, None);
        assert!(admin.can_edit && admin.can_manage && admin.is_unbound_admin());
        assert_eq!(
            capabilities(user(1), user(4), Role::Member, None),
            Capabilities::NONE
        );
    }

    #[test]
    fn percent_rounds_half_up() {
        for (done, total, percent) in [
            (0, 0, 0),
            (1, 3, 33),
            (2, 3, 67),
            (1, 2, 50),
            (1, 8, 13),
            (3, 3, 100),
        ] {
            assert_eq!(
                Progress { done, total }.percent(),
                percent,
                "{done}/{total}"
            );
        }
    }
}
