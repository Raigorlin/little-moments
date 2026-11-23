//! Property 18 的屬性測試（任務 10.4；需求 16.4、16.5、16.18、33.5、33.6）：頭像的字是修剪後顯示名稱的第一個字素叢集。
//!
//! 輸入是 `arb_display_name()` 的顯示名稱 n，令 t = `trim_white(n)`。檢查：
//!
//! - t 為空時 `avatar_initial(n)` 是 `Placeholder`，顯示「・」（U+30FB）。
//! - 否則是 `Grapheme(g)`：g 是 t 的非空前綴；g 本身只有一個字素叢集；g 是 t 的第一個擴充字素叢集，所以 t 去掉 g 之後
//!   剩下的部分不會再與 g 合成同一個叢集，g 與下一個叢集串接後仍是兩個叢集（emoji 序列、國旗、膚色修飾與組合字元
//!   不會被切開）。
//! - 由已知叢集組成的名稱，結果等於第一個被選的叢集，一個都沒選時為 `Placeholder`。
//! - 結果只依顯示名稱決定：重複呼叫得到相同的結果。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_avatar_initial.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::presence::{avatar_initial, AvatarInitial, AVATAR_PLACEHOLDER};
use lm_core::text::trim_white;
use proptest::prelude::*;
use unicode_segmentation::UnicodeSegmentation;

use support::presence::arb_display_name;

// Feature: rust-supabase-rewrite, Property 18: 頭像的字是修剪後顯示名稱的第一個字素叢集
proptest! {
    /// *For any* `arb_display_name()` 產生的顯示名稱 n，令 t = `trim_white(n)`：t 為空時，`avatar_initial(n)` 是
    /// `Placeholder`；否則 `avatar_initial(n)` 是 `Grapheme(g)`，g 恰好是 t 的第一個擴充字素叢集。由已知叢集組成的
    /// 名稱，結果等於第一個被選的叢集。
    ///
    /// **Validates: Requirements 16.4, 16.5, 16.18**
    #[test]
    fn avatar_initial_is_the_first_grapheme_of_the_trimmed_name(name in arb_display_name()) {
        let trimmed = trim_white(&name.name);
        let initial = avatar_initial(&name.name);
        match &initial {
            AvatarInitial::Placeholder => {
                prop_assert!(trimmed.is_empty(), "{:?} 修剪後是 {:?}，不是空的", name.name, trimmed);
                prop_assert_eq!(initial.as_str(), AVATAR_PLACEHOLDER);
            }
            AvatarInitial::Grapheme(g) => {
                prop_assert!(!g.is_empty());
                prop_assert!(trimmed.starts_with(g.as_str()), "{:?} 不是 {:?} 的前綴", g, trimmed);
                prop_assert_eq!(g.graphemes(true).count(), 1, "{:?} 不只一個叢集", g);
                prop_assert_eq!(trimmed.graphemes(true).next(), Some(g.as_str()));
                if let Some(next) = trimmed[g.len()..].graphemes(true).next() {
                    let joined = format!("{g}{next}");
                    prop_assert_eq!(joined.graphemes(true).count(), 2, "{:?} 與 {:?} 合成一個叢集", g, next);
                }
                prop_assert_eq!(initial.as_str(), g.as_str());
            }
        }
        if let Some(expected) = &name.expected {
            prop_assert_eq!(&initial, expected, "由已知叢集組成的 {:?}", name.name);
        }
        prop_assert_eq!(avatar_initial(&name.name), initial);
    }
}
