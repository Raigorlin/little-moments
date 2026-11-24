//! 隨 App 提供的靜態插畫（需求 32.5）。
//!
//! `assets/art/` 的 SVG 由一次性的 `scripts/export-art.mjs` 從現行的 `src/art.js` 與 `src/dish-art.js` 輸出並提交進
//! Repository，這裡以 `include_str!` 嵌入，所以建置與執行都不需要 JavaScript。內容是靜態的、不含使用者文字，
//! 是需求 32.6 中唯一可以用 `inner_html` 放進畫面的 HTML（另一種是介面圖示）。
use lm_core::ids::MealId;
use lm_core::model::{CoverKind, DishKind};

/// `illustration()` 的插畫種類。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Illustration {
    Camp,
    Travel,
    Lake,
    Forest,
    Beach,
    Sunrise,
    Meal,
    Market,
    Night,
}

impl Illustration {
    /// 插畫的 SVG（`<svg class="illustration illustration--<kind>">`）。
    pub const fn svg(self) -> &'static str {
        match self {
            Self::Camp => include_str!("../assets/art/camp.svg"),
            Self::Travel => include_str!("../assets/art/travel.svg"),
            Self::Lake => include_str!("../assets/art/lake.svg"),
            Self::Forest => include_str!("../assets/art/forest.svg"),
            Self::Beach => include_str!("../assets/art/beach.svg"),
            Self::Sunrise => include_str!("../assets/art/sunrise.svg"),
            Self::Meal => include_str!("../assets/art/meal.svg"),
            Self::Market => include_str!("../assets/art/market.svg"),
            Self::Night => include_str!("../assets/art/night.svg"),
        }
    }

    /// 旅行封面使用的插畫：與封面同名，只有 mountain 使用 travel。
    pub const fn for_cover(cover: CoverKind) -> Self {
        match cover {
            CoverKind::Camp => Self::Camp,
            CoverKind::Mountain => Self::Travel,
            CoverKind::Lake => Self::Lake,
            CoverKind::Night => Self::Night,
            CoverKind::Forest => Self::Forest,
            CoverKind::Beach => Self::Beach,
            CoverKind::Sunrise => Self::Sunrise,
        }
    }
}

/// 把隨 App 提供的靜態 SVG 放進畫面（不包外層元素，`<svg>` 是父元素的直接子元素）。
///
/// 這是 lm-web 唯一以 HTML 插入內容的地方（需求 32.6）：參數是 `&'static str`，只能傳入本模組嵌入的檔案或其他
/// 編譯時就固定的字串，使用者文字與伺服器傳來的文字無法經過這裡。
pub fn static_svg(svg: &'static str) -> leptos::tachys::html::InertElement {
    leptos::tachys::html::InertElement::new(svg.trim())
}

/// `logo()` 的 SVG（頁首的品牌標誌）。
pub const LOGO: &str = include_str!("../assets/art/logo.svg");

/// 介面圖示 `icon('info')`（`src/accounts-ui.js` 的 `icons.info`），用在 `.notice` 的提示。
pub const ICON_INFO: &str = r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></svg>"#;

/// 通用餐盤的變化：依 `src/dish-art.js` 的 `GENERIC_DISHES` 順序，第 i 項是 `custom-<i>.svg`。
const CUSTOM_VARIATIONS: [(&str, &str); 7] = [
    ("hotpot", include_str!("../assets/art/custom-0.svg")),
    ("bbq", include_str!("../assets/art/custom-1.svg")),
    ("toast", include_str!("../assets/art/custom-2.svg")),
    ("curry", include_str!("../assets/art/custom-3.svg")),
    ("pasta", include_str!("../assets/art/custom-4.svg")),
    ("breakfast", include_str!("../assets/art/custom-5.svg")),
    ("salad", include_str!("../assets/art/custom-6.svg")),
];

/// 一道料理要顯示的插圖。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DishArt {
    /// 料理的插圖種類。
    pub kind: DishKind,
    /// custom 料理選出的變化（例如 `"curry"`）；其他種類是 `None`。
    pub variation: Option<&'static str>,
    /// 插圖的 SVG（`<svg class="dish-illustration__svg">`）。
    pub svg: &'static str,
}

impl DishArt {
    /// 料理的插圖。custom 依料理 id 的固定雜湊選出變化（`custom_variation()`），
    /// 使同一道料理在每次重繪、重新載入與每台裝置上都是同一張圖（需求 24.6）。
    pub fn new(kind: DishKind, meal_id: MealId) -> Self {
        let svg = match kind {
            DishKind::Hotpot => include_str!("../assets/art/hotpot.svg"),
            DishKind::Bbq => include_str!("../assets/art/bbq.svg"),
            DishKind::Toast => include_str!("../assets/art/toast.svg"),
            DishKind::Curry => include_str!("../assets/art/curry.svg"),
            DishKind::Pasta => include_str!("../assets/art/pasta.svg"),
            DishKind::Breakfast => include_str!("../assets/art/breakfast.svg"),
            DishKind::Salad => include_str!("../assets/art/salad.svg"),
            DishKind::Custom => {
                let (variation, svg) = CUSTOM_VARIATIONS[custom_variation(meal_id)];
                return Self {
                    kind,
                    variation: Some(variation),
                    svg,
                };
            }
        };
        Self {
            kind,
            variation: None,
            svg,
        }
    }

    /// 與現行 `dishIllustration(kind)` 相同結構的 HTML：外層 `<span>` 帶有樣式表使用的 class 與 data 屬性，
    /// 包著插圖的 SVG。所有內容都是靜態字串，不含使用者文字。
    pub fn html(&self) -> String {
        let kind = self.kind.as_str();
        let variation = self
            .variation
            .map(|name| format!(" data-dish-variation=\"{name}\""))
            .unwrap_or_default();
        format!(
            "<span class=\"dish-illustration dish-illustration--{kind}\" data-dish-kind=\"{kind}\"{variation} style=\"display:block\">{}</span>",
            self.svg.trim_end()
        )
    }
}

/// custom 料理使用的變化（0–6）：料理 id 的 16 個位元組以 32 位元 FNV-1a 雜湊後除以 7 的餘數。
/// 只依 id 的位元組計算，所以在原生目標與 wasm32 上、每次載入都得到相同的結果。
pub fn custom_variation(meal_id: MealId) -> usize {
    let hash = meal_id
        .0
        .as_bytes()
        .iter()
        .fold(0x811c_9dc5_u32, |hash, byte| {
            (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
        });
    (hash % CUSTOM_VARIATIONS.len() as u32) as usize
}
