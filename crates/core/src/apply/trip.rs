//! 旅行：`UpdateTrip`（需求 18），以及建立旅行用的 `new_trip_card()` 與 `creator_name()`（需求 17.3、17.5）。

use crate::command::{
    Input, Rejection, TripDraft, TripPatch, DUPLICATE_NAME, IN_USE, SHORTEN_BLOCKED,
};
use crate::dates::{retime_by_day_index, shorten_blocked_message};
use crate::ids::TripId;
use crate::itinerary::{destination_conflict, DestinationConflict};
use crate::limits::{
    TRIP_DESCRIPTION_CHARS, TRIP_DESTINATION_CHARS, TRIP_NOTE_CHARS, TRIP_TITLE_CHARS,
};
use crate::model::{CoverKind, TripCard, TripState, TripStatus};
use crate::text::{char_count, trim_white};
use crate::time::date_range;

use super::common::fits;
use super::people::checked_name;

/// 旅行資料含有 U+0000（需求 8.12、17.5）。
const UNSTORABLE_TRIP: &str = "旅行資料含有不允許的字元。";

/// 以現行 `validateTripCard()` 的順序檢查 Trip_Card 的文字與日期（需求 17.5）：名稱、目的地、起訖日期、介紹與
/// 小叮嚀，再檢查四段文字不含 U+0000。文字已經過 Trim_White。
fn check_card(card: &TripCard) -> Result<(), Rejection> {
    if !fits(&card.title, TRIP_TITLE_CHARS) {
        return Err(Rejection::invalid(
            "title",
            "請填寫旅行名稱（最多 100 個字）。",
        ));
    }
    if !fits(&card.destination, TRIP_DESTINATION_CHARS) {
        return Err(Rejection::invalid("destination", "地點最多 100 個字。"));
    }
    // date_range() 在結束日早於開始日，或超過 31 天時是空的（limits::TRIP_DAYS）
    if date_range(card.start, card.end).is_empty() {
        return Err(Rejection::invalid(
            "dates",
            "結束日不能早於開始日，而且一趟旅行最多 31 天。",
        ));
    }
    if !fits(&card.description, TRIP_DESCRIPTION_CHARS) || !fits(&card.note, TRIP_NOTE_CHARS) {
        let field = if char_count(&card.description) > *TRIP_DESCRIPTION_CHARS.end() {
            "description"
        } else {
            "note"
        };
        return Err(Rejection::invalid(field, "介紹與備註各最多 1000 個字。"));
    }
    let texts = [
        &card.title,
        &card.destination,
        &card.description,
        &card.note,
    ];
    if texts.iter().any(|text| text.contains('\0')) {
        return Err(Rejection::invalid("title", UNSTORABLE_TRIP));
    }
    Ok(())
}

/// 封面：七種之一（需求 17.5）。
fn cover(input: &Input<CoverKind>) -> Result<CoverKind, Rejection> {
    input
        .ok()
        .copied()
        .ok_or_else(|| Rejection::invalid("cover", "請選擇封面插畫。"))
}

/// 建立旅行的 Trip_Card（需求 17.3、17.5）：文字經 Trim_White，狀態為規劃中，Row_Version 為 0。
pub fn new_trip_card(id: TripId, draft: &TripDraft) -> Result<TripCard, Rejection> {
    let card = TripCard {
        id,
        title: trim_white(&draft.title).to_owned(),
        destination: trim_white(&draft.destination).to_owned(),
        start: draft.start,
        end: draft.end,
        description: trim_white(&draft.description).to_owned(),
        note: trim_white(&draft.note).to_owned(),
        cover: CoverKind::Camp,
        status: TripStatus::Planning,
        version: 0,
    };
    check_card(&card)?;
    Ok(TripCard {
        cover: cover(&draft.cover)?,
        ..card
    })
}

/// 建立者的旅伴名字（需求 17.3、17.5）：Display_Name 經 Participant_Name，並符合需求 19.2 至 19.4。
pub fn creator_name(display_name: &str) -> Result<String, Rejection> {
    checked_name(display_name)
}

/// `UpdateTrip`（需求 18）：只合併帶有的欄位，以合併後的旅行資料依名稱、目的地、起訖日期、介紹、小叮嚀、封面、
/// 狀態的順序檢查（400）；接著是目的地的衝突（409，需求 18.3、18.4）與縮短天數（409，需求 18.7）；改日期時依
/// `retime_by_day_index()` 搬動（需求 18.5–18.9）。
pub(super) fn update_trip(d: &mut TripState, patch: &TripPatch) -> Result<(), Rejection> {
    let mut card = d.card.clone();
    let trimmed = |text: &String| trim_white(text).to_owned();
    if let Some(title) = &patch.title {
        card.title = trimmed(title);
    }
    if let Some(destination) = &patch.destination {
        card.destination = trimmed(destination);
    }
    if let Some(dates) = patch.dates {
        card.start = dates.start;
        card.end = dates.end;
    }
    if let Some(description) = &patch.description {
        card.description = trimmed(description);
    }
    if let Some(note) = &patch.note {
        card.note = trimmed(note);
    }
    check_card(&card)?;
    if let Some(input) = &patch.cover {
        card.cover = cover(input)?;
    }
    if let Some(input) = &patch.status {
        card.status = input
            .ok()
            .copied()
            .ok_or_else(|| Rejection::invalid("status", "請選擇旅行狀態。"))?;
    }
    if let Some(conflict) = destination_conflict(d, &card.destination) {
        let code = match conflict {
            DestinationConflict::Duplicate { .. } => DUPLICATE_NAME,
            DestinationConflict::InUse => IN_USE,
        };
        return Err(Rejection::conflict(code, conflict.to_string()));
    }
    if (card.start, card.end) != (d.card.start, d.card.end) {
        retime_by_day_index(d, card.start, card.end).map_err(|blocked| {
            Rejection::conflict(SHORTEN_BLOCKED, shorten_blocked_message(&blocked))
        })?;
    }
    d.card = card;
    Ok(())
}
