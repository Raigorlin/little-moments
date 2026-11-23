//! Property 19 的屬性測試（任務 10.5；需求 16.6、16.7、16.18、33.5、33.6）：頭像顏色由帳號 id 決定，文字對比至少 4.5:1。
//!
//! 輸入是 `arb_user_id()` 的帳號 id u 與 `arb_display_name()` 的兩個顯示名稱。檢查：
//!
//! - `avatar_color(u)` 是 `AVATAR_PALETTE` 中的一色；重複呼叫、以 u 的 16 個位元組重建 `UserId`，或由 UUID 文字形式
//!   解析回來之後再呼叫，結果都相同。
//! - 文字色與底色的對比不低於 4.5:1，而且文字色是 `readable_text_on(底色)`，也就是 INK 與白色中對比較高的那一個。
//! - 顏色不受顯示名稱影響：u 以兩個不同的顯示名稱編輯時，`editor_stacks()` 的頭像顏色都等於 `avatar_color(u)`。
//!
//! 不同的 u 可能得到相同的顏色（色盤只有 12 色），所以辨識靠頭像上的字與無障礙名稱。固定 id 的色盤索引由
//! `presence_avatar.rs` 的 golden 測試鎖定。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_avatar_color.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::ids::UserId;
use lm_core::model::{Entity, RowKey};
use lm_core::presence::{
    avatar_color, contrast_ratio, editor_stacks, readable_text_on, EditTarget, PresenceMeta,
    AVATAR_PALETTE,
};
use proptest::prelude::*;
use uuid::Uuid;

use support::presence::{arb_display_name, arb_user_id};

// Feature: rust-supabase-rewrite, Property 19: 頭像顏色由帳號 id 決定，文字對比至少 4.5:1
proptest! {
    /// *For any* `arb_user_id()` 產生的帳號 id u：`avatar_color(u)` 是 `AVATAR_PALETTE` 中的一色；重複呼叫，或以 `u`
    /// 的 16 個位元組重建 `UserId` 後再呼叫，結果都相同；文字色與底色的對比 `contrast_ratio(text, background) ≥ 4.5`，
    /// 而且 `text == readable_text_on(background)`。
    ///
    /// **Validates: Requirements 16.6, 16.7, 16.18**
    #[test]
    fn avatar_color_depends_only_on_the_account_id(
        user in arb_user_id(),
        first in arb_display_name(),
        second in arb_display_name(),
    ) {
        let color = avatar_color(user);
        prop_assert!(AVATAR_PALETTE.contains(&color), "{:?} 不在色盤中", color);
        prop_assert_eq!(avatar_color(user), color);
        prop_assert_eq!(avatar_color(UserId(Uuid::from_bytes(*user.0.as_bytes()))), color);
        let parsed = Uuid::parse_str(&user.to_string()).expect("UUID 文字形式可以解析");
        prop_assert_eq!(avatar_color(UserId(parsed)), color);

        let ratio = contrast_ratio(color.text, color.background);
        prop_assert!(ratio >= 4.5, "{} 與 {} 的對比只有 {}", color.text.hex(), color.background.hex(), ratio);
        prop_assert_eq!(color.text, readable_text_on(color.background));

        // 檢視者是另一個帳號，所以 u 一定出現在堆疊中
        let target = EditTarget { entity: Entity::Meal, key: RowKey::Id(Uuid::from_u128(1)) };
        let viewer = if user.0.is_nil() { Uuid::from_bytes([0xff; 16]) } else { Uuid::nil() };
        for name in [&first.name, &second.name] {
            let meta = PresenceMeta {
                user,
                display_name: name.clone(),
                person: None,
                editing: Some(target),
            };
            let stacks = editor_stacks([&meta], UserId(viewer));
            prop_assert_eq!(stacks[&target].shown[0].color, color, "顯示名稱 {:?}", name);
        }
    }
}
