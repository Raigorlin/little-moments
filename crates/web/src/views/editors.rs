//! 編輯者頭像 `<EditorAvatars>`（design 4.5、A13；需求 16）。
//!
//! - 每張卡片或每一列以自己的 `Memo` 從 [`TripHandle::editors`](crate::sync::engine::TripHandle::editors) 取出這個
//!   Edit_Target 的 Editor_Stack；只有這一組改變時才更新這裡的 DOM，卡片或列的其他內容與其他卡片都不變（需求 16.17）。
//! - 頭像與「+N」是不接受焦點的 `role="img"` 元素；無障礙名稱與滑鼠提示來自 LM_Core（需求 16.11、16.12），名稱與
//!   Avatar_Initial 以文字節點或屬性輸出，Leptos 會跳脫（需求 16.15、32.6）。不放進任何 live region（需求 15.14）。
//! - 樣式在 `styles/presence.css`：沒有動畫或轉場（需求 16.16）；頭像的底色與文字色以 inline style 套用 Avatar_Palette
//!   （需求 16.8、32.8）。
use leptos::prelude::*;
use lm_core::model::Slot;
use lm_core::presence::{EditorAvatar, EditorStack};

use crate::pages::trip::use_trip;
use crate::views::forms::edit_target;

/// Editor_Stack 的大小（需求 16.3）：卡片（包括 Trip_Page 的旅行標題列）直徑 28px，清單中的列 24px。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AvatarSize {
    #[default]
    Card,
    Row,
}

/// 這個 Edit_Target 的 Editor_Stack；沒有其他 Account 在編輯時不輸出任何元素（需求 16.1）。
///
/// 屬性名稱是 `item` 而不是 `slot`：`view!` 把 `slot` 屬性當作 Leptos 的 `#[slot]` 標記，`<EditorAvatars slot />` 放在
/// HTML 元素中時會整個被略過。
#[component]
pub fn EditorAvatars(item: Slot, #[prop(optional)] size: AvatarSize) -> impl IntoView {
    let handle = use_trip().handle;
    let target = edit_target(item);
    // 自己的 Memo：其他對象的 Editor_Stack 改變時不通知這裡（需求 16.17）
    let stack = Memo::new(move |_| handle.editors.with(|editors| editors.get(&target).cloned()));
    let class = match size {
        AvatarSize::Card => "editor-stack",
        AvatarSize::Row => "editor-stack editor-stack-row",
    };
    move || stack.get().map(|stack| stack_view(class, stack))
}

/// 由左到右依帳號 id 遞增的頭像，「+N」在最右邊（需求 16.2、16.9）。
fn stack_view(class: &'static str, stack: EditorStack) -> impl IntoView {
    let more = stack
        .overflow_label()
        .zip(stack.overflow_tooltip())
        .map(|(label, tooltip)| {
            view! {
                <span class="editor-avatar editor-avatar-more" role="img" aria-label=label title=tooltip>
                    {format!("+{}", stack.hidden.len())}
                </span>
            }
        });
    let avatars = stack.shown.into_iter().map(avatar_view).collect_view();
    // 採買品項的名稱在勾選框的 label 中：按到頭像時不切換已買（label 的啟動行為在 click 被取消時不發生）
    view! {
        <span class=class on:click=|event| event.prevent_default()>
            {avatars}
            {more}
        </span>
    }
}

fn avatar_view(avatar: EditorAvatar) -> impl IntoView {
    let style = format!(
        "background-color:{};color:{}",
        avatar.color.background.hex(),
        avatar.color.text.hex()
    );
    view! {
        <span class="editor-avatar" role="img" aria-label=avatar.label() title=avatar.tooltip() style=style>
            {avatar.initial.as_str().to_owned()}
        </span>
    }
}
