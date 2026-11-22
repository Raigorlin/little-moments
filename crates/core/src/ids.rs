//! UUID newtype（`TripId`、`PersonId` …）與由呼叫端提供新 id 的 `IdSource`。
//!
//! 每一種 id 各是一個型別，所以不會把旅伴的 id 當成車輛的 id 傳錯。線上格式與 `Display` 都是小寫、含連字號的
//! UUID 字串（`#[serde(transparent)]`），例如 `"3c51b8aa-0000-4000-8000-00000000000a"`。新列的 id 由用戶端產生
//! （design 1.3），採買同步新增的 Meal_Item 的 id 由呼叫端的 `IdSource` 提供；lm-core 不自己產生亂數 id，
//! 所以同一份輸入在原生目標與 wasm32 上得到相同的結果（需求 1.4）。

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_types {
    ($($(#[$meta:meta])* $name:ident,)+) => {$(
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl From<Uuid> for $name {
            fn from(id: Uuid) -> Self {
                Self(id)
            }
        }

        impl From<$name> for Uuid {
            fn from(id: $name) -> Self {
                id.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }
    )+};
}

id_types! {
    /// 帳號（Account）：Auth_Service 使用者的 id，也就是 `app.profiles.user_id`。
    UserId,
    /// 旅行；也是 Trip_Card 的列鍵。
    TripId,
    /// 旅伴（Person）；也是出發確認的列鍵。
    PersonId,
    /// 車輛。
    VehicleId,
    /// 地點清單中的地點。
    PlaceId,
    /// 路線。
    RouteId,
    /// 停靠點；在整趟旅行的所有路線中只出現一次。
    StopId,
    /// 活動。
    ActivityId,
    /// 料理。
    MealId,
    /// 採買品項。
    ShoppingId,
    /// 裝備。
    GearId,
    /// 支出。
    ExpenseId,
    /// 還款。
    SettlementId,
    /// Command_Id：LM_Web 為每個 Command 產生，用來辨識重送的 Command。
    CommandId,
    /// 一個用戶端（瀏覽器分頁），例如加入 Trip_Channel 時的 Presence_Key。
    ClientId,
}

/// 衍生列的新 id，由呼叫端提供：lm-server 產生隨機的 UUID，測試依序產生決定性的 id（需求 1.4）。
/// 前端預測不執行採買同步，所以不會呼叫。
pub trait IdSource {
    /// 採買同步新增的下一個 Meal_Item 的 id。
    fn shopping_id(&mut self) -> ShoppingId;
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3c51b8aa-0000-4000-8000-00000000000a";

    #[test]
    fn ids_are_lowercase_uuid_strings_on_the_wire() {
        let id = PersonId(Uuid::parse_str(ID).expect("有效的 UUID"));
        assert_eq!(serde_json::to_value(id).expect("可以序列化"), ID);
        assert_eq!(id.to_string(), ID);
        assert_eq!(
            serde_json::from_value::<PersonId>(serde_json::json!(ID)).expect("可以解析"),
            id
        );
        // 大寫的輸入也接受，輸出一律是小寫
        let upper: ShoppingId =
            serde_json::from_value(serde_json::json!(ID.to_uppercase())).expect("可以解析");
        assert_eq!(upper.to_string(), ID);
    }

    #[test]
    fn ids_reject_values_that_are_not_uuids() {
        for value in [
            serde_json::json!("p1"),
            serde_json::json!("2026-11-20"),
            serde_json::json!(1),
            serde_json::json!(null),
        ] {
            assert!(
                serde_json::from_value::<TripId>(value.clone()).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn ids_convert_to_and_from_uuid() {
        let uuid = Uuid::from_u128(42);
        let trip = TripId::from(uuid);
        assert_eq!(trip, TripId(uuid));
        assert_eq!(Uuid::from(trip), uuid);
    }
}
