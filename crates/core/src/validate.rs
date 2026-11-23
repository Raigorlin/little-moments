//! `validate::state(state, mode)`：跨列的不變式 I1–I12（design「不變式」，需求 9.2–9.13；`Mode::Predict` 不檢查
//! I9），以及 `Violation::into_rejection()`（需求 9.16）。
//!
//! 處理函式在寫入之前就以各需求的訊息拒絕違反的命令；這裡是 `apply()` 的最後一道檢查，處理函式的疏漏在這裡變成
//! 拒絕，不會寫入。

use std::collections::BTreeSet;

use crate::apply::Mode;
use crate::command::{
    Rejection, CANNOT_DEPART, DUPLICATE_NAME, IN_USE, LIMIT_REACHED, PERSON_LOCKED, ROUTE_EXISTS,
    VALIDATION_FAILED, VALIDATION_FAILED_MESSAGE,
};
use crate::ingredients::{ingredient_key, parse_ingredients};
use crate::limits::{
    ACTIVITIES_MAX, EXPENSES_MAX, EXPENSE_PARTICIPANTS, GEAR_ITEMS_MAX, MEALS_MAX, PEOPLE_MAX,
    PLACES_MAX, ROUTE_STOPS, SETTLEMENTS_MAX, SHOPPING_ITEMS_MAX,
};
use crate::model::{Entity, GearScope, ItemSource, Participation, PlaceRef, Route, TripState};
use crate::rules::can_depart;
use crate::text::{participant_key, place_key, trim_white};

/// 違反的不變式；`Display` 說明是哪一條，供記錄與測試使用。
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Violation {
    /// I1：引用不存在的列（`what` 說明是哪一種引用）。
    #[error("I1：{what}引用不存在的列")]
    DanglingReference { what: &'static str },
    /// I2：兩位旅伴的 Participant_Key 相同。
    #[error("I2：旅伴同名")]
    DuplicatePerson,
    /// I2：兩個地點的 Place_Key 相同，或地點與非空白的旅行目的地同名。
    #[error("I2：地點同名")]
    DuplicatePlace,
    /// I3：同一台車同一天有兩條路線。
    #[error("I3：同一台車同一天有兩條路線")]
    SecondRoute,
    /// I3：路線超過 6 個停靠點。
    #[error("I3：路線超過 6 個停靠點")]
    TooManyStops,
    /// I3：停靠點 id 重複。
    #[error("I3：停靠點 id 重複")]
    DuplicateStop,
    /// I4：旅行目的地是空白，仍有路線使用 Destination_Place。
    #[error("I4：旅行目的地是空白，仍有路線使用它")]
    BlankDestinationInUse,
    /// I5：活動、料理、路線或每日設定的日期不在旅行範圍內。
    #[error("I5：{what}的日期不在旅行範圍內")]
    OutOfRange { what: &'static str },
    /// I6：駕駛也是乘客。
    #[error("I6：駕駛也是乘客")]
    DriverIsPassenger,
    /// I6：乘客人數加 1 超過座位數。
    #[error("I6：乘客加上駕駛超過座位數")]
    TooManyPassengers,
    /// I7：個人裝備有負責人。
    #[error("I7：個人裝備有負責人")]
    PersonalGearAssigned,
    /// I7：共用裝備的打包勾選不只負責人。
    #[error("I7：共用裝備的打包勾選不只負責人")]
    SharedGearPackedByOthers,
    /// I8：出發確認的旅伴不滿足 Can_Depart。
    #[error("I8：出發確認的旅伴不滿足 Can_Depart")]
    CannotDepart,
    /// I9：料理需要的食材沒有品項涵蓋。
    #[error("I9：料理需要的食材沒有品項涵蓋")]
    UncoveredIngredient,
    /// I9：未買的 Meal_Item 沒有連動料理。
    #[error("I9：未買的 Meal_Item 沒有連動料理")]
    OrphanMealItem,
    /// I9：採買品項連動不存在的料理。
    #[error("I9：採買品項連動不存在的料理")]
    MissingMeal,
    /// I10：帳目引用不存在的旅伴。
    #[error("I10：帳目引用不存在的旅伴")]
    LedgerPerson,
    /// I10：還款的付款人與收款人相同。
    #[error("I10：還款的付款人與收款人相同")]
    SelfSettlement,
    /// I11：活動的指定旅伴或指定車輛是空集合。
    #[error("I11：活動的指定集合是空的")]
    EmptyParticipation,
    /// I12：一種列的數量超過上限。
    #[error("I12：{entity:?} 超過上限")]
    TooMany { entity: Entity },
    /// I12：支出的分攤旅伴不是 1–100 位。
    #[error("I12：支出的分攤旅伴不是 1–100 位")]
    ParticipantCount,
}

impl Violation {
    /// 需求 9.16：違反的條件有對應的拒絕規則時，回應那條規則的狀態與訊息；否則 409「資料驗證未通過，沒有儲存。」。
    /// 權限的拒絕在 `authorize()`，早於這裡。
    pub fn into_rejection(self) -> Rejection {
        let conflict = |code, message: &str| Rejection::conflict(code, message);
        match self {
            // 需求 19.6
            Violation::DuplicatePerson => conflict(
                DUPLICATE_NAME,
                "這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。",
            ),
            // 需求 21.1
            Violation::DuplicatePlace => conflict(DUPLICATE_NAME, "已有同名地點"),
            // 需求 22.4
            Violation::SecondRoute => {
                conflict(ROUTE_EXISTS, "這台車這一天已有路線，請選擇其他車。")
            }
            // 需求 22.7
            Violation::TooManyStops => Rejection::invalid("stops", "每台車最多 6 個停靠點"),
            // 需求 18.4
            Violation::BlankDestinationInUse => {
                conflict(IN_USE, "仍有路線或停靠點使用旅行目的地，不能把目的地清空。")
            }
            // 需求 20.2
            Violation::DriverIsPassenger => {
                Rejection::invalid("passengers", "駕駛不能同時是乘客。")
            }
            Violation::TooManyPassengers => {
                Rejection::invalid("passengers", "乘客加上駕駛不能超過座位數。")
            }
            // 需求 27.2
            Violation::PersonalGearAssigned => {
                Rejection::invalid("assignee", "個人裝備每人各帶一份，不能指定負責人。")
            }
            // 需求 28.3
            Violation::CannotDepart => Rejection::invalid("departed", CANNOT_DEPART),
            // 需求 19.14：處理函式檢查之後，帳目引用不存在的旅伴只會來自移除仍有帳目的旅伴
            Violation::LedgerPerson => conflict(
                PERSON_LOCKED,
                "這位旅伴仍有支出或還款紀錄。請先在分帳記帳修改或刪除這些帳目，再移除旅伴。",
            ),
            // 需求 29.3
            Violation::SelfSettlement => Rejection::invalid("to", "付款人與收款人不能是同一位。"),
            Violation::TooMany { entity } => match limit_message(entity) {
                Some(message) => conflict(LIMIT_REACHED, message),
                None => conflict(VALIDATION_FAILED, VALIDATION_FAILED_MESSAGE),
            },
            Violation::DanglingReference { .. }
            | Violation::DuplicateStop
            | Violation::OutOfRange { .. }
            | Violation::SharedGearPackedByOthers
            | Violation::UncoveredIngredient
            | Violation::OrphanMealItem
            | Violation::MissingMeal
            | Violation::EmptyParticipation
            | Violation::ParticipantCount => conflict(VALIDATION_FAILED, VALIDATION_FAILED_MESSAGE),
        }
    }
}

/// 各種列超過上限時的訊息（需求 19.7、21.2、23.5、24.7、25.15、27.3、29.4）。
pub fn limit_message(entity: Entity) -> Option<&'static str> {
    Some(match entity {
        Entity::Person => "小隊最多 100 位旅伴，目前已額滿。",
        Entity::Place => "地點最多 100 個",
        Entity::Activity => "活動最多 1,000 筆，請先刪除不需要的活動。",
        Entity::Meal => "料理最多 1,000 道，請先刪除不需要的料理。",
        Entity::Shopping => "採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。",
        Entity::Gear => "裝備最多 1000 項，目前已額滿。",
        Entity::Expense => "支出最多 1000 筆。",
        Entity::Settlement => "還款紀錄最多 1000 筆。",
        _ => return None,
    })
}

/// 依序檢查 I1–I12，回傳第一個違反的不變式；`Mode::Predict` 不檢查 I9（前端預測不執行採買同步）。
pub fn state(s: &TripState, mode: Mode) -> Result<(), Violation> {
    references(s)?;
    unique_names(s)?;
    routes(s)?;
    destination(s)?;
    dates(s)?;
    vehicles(s)?;
    gear(s)?;
    departures(s)?;
    if mode == Mode::Commit {
        shopping(s)?;
    }
    ledger(s)?;
    participation(s)?;
    counts(s)
}

/// I1：旅伴、車輛、地點、路線與採買品項的引用都指向存在的列（料理的連動在 I9，帳目的旅伴在 I10）。
fn references(s: &TripState) -> Result<(), Violation> {
    let person = |id: &_| s.people.contains_key(id);
    let place = |place: &PlaceRef| match place {
        PlaceRef::Destination => true,
        PlaceRef::Place(id) => s.places.contains_key(id),
    };
    let dangling = |what| Err(Violation::DanglingReference { what });
    for vehicle in s.vehicles.values() {
        if !vehicle.driver.iter().chain(&vehicle.passengers).all(person) {
            return dangling("車輛的駕駛或乘客");
        }
    }
    for route in s.routes.values() {
        if !s.vehicles.contains_key(&route.vehicle) {
            return dangling("路線的車輛");
        }
        if !route_places(route).all(|p| place(&p)) {
            return dangling("路線的地點");
        }
    }
    for setting in s.day_settings.values() {
        if setting.place.is_some_and(|id| !s.places.contains_key(&id)) {
            return dangling("每日設定的地點");
        }
    }
    for activity in s.activities.values() {
        let ok = match &activity.who {
            Participation::Everyone => true,
            Participation::People(ids) => ids.iter().all(person),
            Participation::Vehicles(ids) => ids.iter().all(|id| s.vehicles.contains_key(id)),
        };
        if !ok {
            return dangling("活動的參加者");
        }
    }
    if !s.meals.values().all(|meal| meal.cook.iter().all(person)) {
        return dangling("料理的負責人");
    }
    if !s
        .shopping
        .values()
        .all(|item| item.assignee.iter().all(person))
    {
        return dangling("採買品項的負責人");
    }
    for item in s.gear.values() {
        if !item.assignee.iter().chain(&item.packed_by).all(person) {
            return dangling("裝備的負責人或打包勾選");
        }
    }
    if !s.departures.keys().all(person) {
        return dangling("出發確認");
    }
    let unlinked = s.expenses.values().any(|expense| {
        expense
            .shopping_item
            .is_some_and(|id| !s.shopping.contains_key(&id))
    });
    if unlinked {
        return dangling("支出連結的採買品項");
    }
    Ok(())
}

/// 路線的起點、終點與停靠點。
fn route_places(route: &Route) -> impl Iterator<Item = PlaceRef> + '_ {
    [route.from, route.to]
        .into_iter()
        .chain(route.stops.iter().map(|stop| stop.place))
}

/// I2：旅伴的 Participant_Key 不重複；地點的 Place_Key 不重複，也不等於非空白旅行目的地的 Place_Key。
fn unique_names(s: &TripState) -> Result<(), Violation> {
    let mut names = BTreeSet::new();
    if !s
        .people
        .values()
        .all(|p| names.insert(participant_key(&p.name)))
    {
        return Err(Violation::DuplicatePerson);
    }
    let mut keys = BTreeSet::new();
    if !trim_white(&s.card.destination).is_empty() {
        keys.insert(place_key(&s.card.destination));
    }
    if !s.places.values().all(|p| keys.insert(place_key(&p.name))) {
        return Err(Violation::DuplicatePlace);
    }
    Ok(())
}

/// I3：每台車每天最多一條路線；每條路線最多 6 個停靠點；停靠點 id 在整趟旅行中唯一。
fn routes(s: &TripState) -> Result<(), Violation> {
    let mut days = BTreeSet::new();
    let mut stops = BTreeSet::new();
    for route in s.routes.values() {
        if !days.insert((route.vehicle, route.day)) {
            return Err(Violation::SecondRoute);
        }
        if route.stops.len() > *ROUTE_STOPS.end() {
            return Err(Violation::TooManyStops);
        }
        if !route.stops.iter().all(|stop| stops.insert(stop.id)) {
            return Err(Violation::DuplicateStop);
        }
    }
    Ok(())
}

/// I4：路線使用 Destination_Place 時，旅行目的地不是空白。
fn destination(s: &TripState) -> Result<(), Violation> {
    let blank = trim_white(&s.card.destination).is_empty();
    let used = s
        .routes
        .values()
        .any(|route| route_places(route).any(|p| p == PlaceRef::Destination));
    if blank && used {
        return Err(Violation::BlankDestinationInUse);
    }
    Ok(())
}

/// I5：活動、料理、路線與每日設定的日期都在旅行範圍內。
fn dates(s: &TripState) -> Result<(), Violation> {
    let inside = |day| s.card.start <= day && day <= s.card.end;
    let out = |what| Err(Violation::OutOfRange { what });
    if !s.activities.values().all(|a| inside(a.day)) {
        return out("活動");
    }
    if !s.meals.values().all(|m| inside(m.day)) {
        return out("料理");
    }
    if !s.routes.values().all(|r| inside(r.day)) {
        return out("路線");
    }
    if !s.day_settings.keys().all(|&day| inside(day)) {
        return out("每日設定");
    }
    Ok(())
}

/// I6：車輛的駕駛不在乘客中，乘客人數 + 1 ≤ 座位數。
fn vehicles(s: &TripState) -> Result<(), Violation> {
    for vehicle in s.vehicles.values() {
        if vehicle
            .driver
            .is_some_and(|d| vehicle.passengers.contains(&d))
        {
            return Err(Violation::DriverIsPassenger);
        }
        if vehicle.passengers.len() + 1 > usize::from(vehicle.seats) {
            return Err(Violation::TooManyPassengers);
        }
    }
    Ok(())
}

/// I7：個人裝備沒有負責人；共用裝備的打包勾選 ⊆ {負責人}。
fn gear(s: &TripState) -> Result<(), Violation> {
    for item in s.gear.values() {
        match item.scope {
            GearScope::Personal if item.assignee.is_some() => {
                return Err(Violation::PersonalGearAssigned)
            }
            GearScope::Shared if !item.packed_by.iter().all(|p| Some(*p) == item.assignee) => {
                return Err(Violation::SharedGearPackedByOthers)
            }
            _ => {}
        }
    }
    Ok(())
}

/// I8：每一筆出發確認的旅伴都滿足 Can_Depart。
fn departures(s: &TripState) -> Result<(), Violation> {
    if s.departures.keys().all(|&person| can_depart(s, person)) {
        Ok(())
    } else {
        Err(Violation::CannotDepart)
    }
}

/// I9（只在 `Mode::Commit`）：每個料理需要的食材鍵都被某個品項涵蓋；未買的 Meal_Item 連動至少一道料理；連動的料理
/// 都存在。
fn shopping(s: &TripState) -> Result<(), Violation> {
    let covered: BTreeSet<String> = s
        .shopping
        .values()
        .flat_map(|item| parse_ingredients(&item.name))
        .map(|name| ingredient_key(&name))
        .collect();
    let needed = s
        .meals
        .values()
        .flat_map(|meal| parse_ingredients(&meal.ingredients));
    for name in needed {
        if !covered.contains(&ingredient_key(&name)) {
            return Err(Violation::UncoveredIngredient);
        }
    }
    for item in s.shopping.values() {
        if item.source == ItemSource::Meal && !item.purchased && item.meal_ids.is_empty() {
            return Err(Violation::OrphanMealItem);
        }
        if !item.meal_ids.iter().all(|id| s.meals.contains_key(id)) {
            return Err(Violation::MissingMeal);
        }
    }
    Ok(())
}

/// I10：支出的付款人與分攤旅伴、還款的付款人與收款人都存在；還款的付款人與收款人不同。
fn ledger(s: &TripState) -> Result<(), Violation> {
    let person = |id: &_| s.people.contains_key(id);
    for expense in s.expenses.values() {
        if !person(&expense.payer) || !expense.participants.iter().all(person) {
            return Err(Violation::LedgerPerson);
        }
    }
    for settlement in s.settlements.values() {
        if !person(&settlement.from) || !person(&settlement.to) {
            return Err(Violation::LedgerPerson);
        }
        if settlement.from == settlement.to {
            return Err(Violation::SelfSettlement);
        }
    }
    Ok(())
}

/// I11：活動的參加者是全體、指定旅伴或指定車輛三者之一，指定的集合不是空的（`Participation` 無法同時指定旅伴與
/// 車輛）。
fn participation(s: &TripState) -> Result<(), Violation> {
    let empty = s.activities.values().any(|activity| match &activity.who {
        Participation::Everyone => false,
        Participation::People(ids) => ids.is_empty(),
        Participation::Vehicles(ids) => ids.is_empty(),
    });
    if empty {
        Err(Violation::EmptyParticipation)
    } else {
        Ok(())
    }
}

/// I12：各集合的數量不超過「列舉與上限」；每筆支出有 1–100 位分攤旅伴。
fn counts(s: &TripState) -> Result<(), Violation> {
    let limits: [(Entity, usize, usize); 8] = [
        (Entity::Person, s.people.len(), PEOPLE_MAX),
        (Entity::Place, s.places.len(), PLACES_MAX),
        (Entity::Activity, s.activities.len(), ACTIVITIES_MAX),
        (Entity::Meal, s.meals.len(), MEALS_MAX),
        (Entity::Shopping, s.shopping.len(), SHOPPING_ITEMS_MAX),
        (Entity::Gear, s.gear.len(), GEAR_ITEMS_MAX),
        (Entity::Expense, s.expenses.len(), EXPENSES_MAX),
        (Entity::Settlement, s.settlements.len(), SETTLEMENTS_MAX),
    ];
    if let Some(&(entity, _, _)) = limits.iter().find(|(_, count, max)| count > max) {
        return Err(Violation::TooMany { entity });
    }
    if !s
        .expenses
        .values()
        .all(|e| EXPENSE_PARTICIPANTS.contains(&e.participants.len()))
    {
        return Err(Violation::ParticipantCount);
    }
    Ok(())
}
