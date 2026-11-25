//! 分帳計算：`parse_amount`、`format_money`、`split_evenly`、`summarize`（每位旅伴的結餘與建議轉帳）、
//! `EXPENSE_CATEGORIES` 與 `suggest_expense_category`。
//!
//! 移植自 `src/expense-model.js` 的 `parseAmount()`、`formatMoney()`、`splitEvenly()`、`summarizeLedger()` 與
//! `settleUp()`，以及 `src/expense-categories.js` 的 `EXPENSE_CATEGORIES` 與 `suggestExpenseCategory()`。金額一律是整數的
//! 分（`i64`）；支出與還款的金額在 `limits::AMOUNT_CENTS`（1–100,000,000 分，NT$0.01–1,000,000）之內，由命令的處理函式以
//! `check_amount_cents()` 檢查。結餘依 Trip_State 的旅伴計算，名字由呼叫端從旅伴取得：帳目提到的旅伴不能移除（需求 19.14、
//! I10），所以現行帳本另存的旅伴名字快照（`mergePeople()`）不移植。

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use unicode_normalization::UnicodeNormalization;

use crate::ids::PersonId;
use crate::ingredients::classify_ingredient;
use crate::limits::AMOUNT_CENTS;
use crate::model::{Category, ExpenseCategory, TripState};
use crate::text::trim_white;

// ── 金額 ──

/// `parse_amount()` 與 `check_amount_cents()` 拒絕金額的原因（需求 29.5）。`Display` 是給使用者看的訊息。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, thiserror::Error)]
pub enum AmountError {
    /// 去除前後的空白、開頭的幣別與結尾的「元」之後是空的。
    #[error("請輸入金額。")]
    Missing,
    /// 以「-」開頭，或換算後不到 1 分。
    #[error("金額必須大於 0。")]
    NotPositive,
    /// 小數超過兩位。
    #[error("金額最多到小數點後兩位（角、分）。")]
    TooPrecise,
    /// 超過 NT$1,000,000（100,000,000 分）。
    #[error("單筆金額最多 NT$1,000,000。")]
    TooLarge,
    /// 其他格式，例如「1,23」「1e3」「0x10」「١٢٣」。
    #[error("請輸入有效的金額，例如 350 或 120.5。")]
    Invalid,
}

/// 金額欄位的輸入換算成分（需求 29.5，現行 `parseAmount()` 的文字輸入）：
///
/// 1. 整段文字做 NFKC（全形的數字、「＄」「，」「．」與「－」成為半形），再經 Trim_White。
/// 2. 去除開頭的一個幣別「NT$」「NTD」「TWD」或「$」（英文字母不分大小寫）與它後面的空白，再去除結尾的一個「元」與它
///    前面的空白。
/// 3. 整數部分是每三位一個半形逗號的千分位（第一組 1–3 位、之後每組 3 位，例如「1,234.56」）時去除逗號。
/// 4. 剩下的文字是空的時為 `Missing`；以「-」開頭時為 `NotPositive`；是 1 位以上的 ASCII 數字，可以再接「.」與 0–2 位
///    數字時換算（「12.」為 1200 分）；整數部分是 0 位以上的數字、「.」之後是 3 位以上的數字時為 `TooPrecise`；其他都是
///    `Invalid`。
/// 5. 整數部分去掉前導的 0 之後超過 7 位時為 `TooLarge`；換算後以 `check_amount_cents()` 檢查，0 分為 `NotPositive`。
///
/// 例如「350」為 35000、「 NT$1,234.56 」為 123456、「１２０元」為 12000、「$ 99」為 9900；`format_money()` 的輸出換算回
/// 原本的分。空白依需求 29.5 是 Trim_White 的 Unicode White_Space，幣別之後與「元」之前的空白也是，所以 U+0085 算空白、
/// U+FEFF 不算，與現行 `trim()` 和 `\s` 的 JS_Whitespace 相反。現行也接受 JavaScript 的數字；這裡只有文字。
pub fn parse_amount(input: &str) -> Result<i64, AmountError> {
    let normalized: String = input.nfkc().collect();
    let mut text = trim_white(&normalized);
    if let Some(rest) = strip_currency(text) {
        text = rest.trim_start();
    }
    if let Some(rest) = text.strip_suffix('元') {
        text = rest.trim_end();
    }
    let ungrouped;
    if is_grouped(text) {
        ungrouped = text.replace(',', "");
        text = &ungrouped;
    }

    if text.is_empty() {
        return Err(AmountError::Missing);
    }
    if text.starts_with('-') {
        return Err(AmountError::NotPositive);
    }
    let (whole, fraction) = split_decimal(text);
    // 現行 /^(\d+)(?:\.(\d{0,2}))?$/
    let valid = !whole.is_empty()
        && is_digits(whole)
        && fraction.is_none_or(|fraction| fraction.len() <= 2 && is_digits(fraction));
    if !valid {
        // 現行 /^\d*\.\d{3,}$/
        let too_precise = is_digits(whole)
            && fraction.is_some_and(|fraction| fraction.len() >= 3 && is_digits(fraction));
        return Err(if too_precise {
            AmountError::TooPrecise
        } else {
            AmountError::Invalid
        });
    }
    // 現行 /^0+(?=\d)/：去掉前導的 0，至少留下一位
    let whole = match whole.trim_start_matches('0') {
        "" => "0",
        digits => digits,
    };
    if whole.len() > 7 {
        return Err(AmountError::TooLarge);
    }
    let fraction = fraction.unwrap_or_default();
    let fraction_cents = match fraction.len() {
        1 => digits_value(fraction) * 10,
        _ => digits_value(fraction),
    };
    check_amount_cents(digits_value(whole) * 100 + fraction_cents)
}

/// 需求 29.2、29.3、29.5：支出與還款的金額必須在 `limits::AMOUNT_CENTS`（1–100,000,000 分）之內。小於 1 分時為
/// `NotPositive`（「金額必須大於 0。」），大於 100,000,000 分時為 `TooLarge`（「單筆金額最多 NT$1,000,000。」）；
/// 在範圍內時回傳原本的分。
pub fn check_amount_cents(cents: i64) -> Result<i64, AmountError> {
    if cents < *AMOUNT_CENTS.start() {
        Err(AmountError::NotPositive)
    } else if cents > *AMOUNT_CENTS.end() {
        Err(AmountError::TooLarge)
    } else {
        Ok(cents)
    }
}

/// 以分表示的金額換成顯示的文字（需求 29.5，現行 `formatMoney()`）：「NT$」加上每三位一個逗號的整數元，分不為 0 時再
/// 加上「.」與兩位數字，負數在最前面加「-」。例如 0 為「NT$0」、1 為「NT$0.01」、35000 為「NT$350」、123456 為
/// 「NT$1,234.56」、-12050 為「-NT$120.50」。任何 `i64` 都可以顯示；現行拒絕不是安全整數（絕對值超過 2^53 − 1）的值。
pub fn format_money(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}{}", unsigned_money(cents.unsigned_abs()))
}

/// `format_money()` 不含正負號的部分。
fn unsigned_money(cents: u64) -> String {
    let digits = (cents / 100).to_string();
    let mut text = String::from("NT$");
    for (i, digit) in digits.char_indices() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            text.push(',');
        }
        text.push(digit);
    }
    match cents % 100 {
        0 => text,
        fraction => format!("{text}.{fraction:02}"),
    }
}

/// 現行 `/^(?:NT\$|NTD|TWD|\$)/i`：開頭的一個幣別，英文字母不分大小寫；回傳幣別之後的文字。
fn strip_currency(text: &str) -> Option<&str> {
    ["NT$", "NTD", "TWD", "$"].into_iter().find_map(|currency| {
        let rest = text.get(currency.len()..)?;
        text[..currency.len()]
            .eq_ignore_ascii_case(currency)
            .then_some(rest)
    })
}

/// 現行 `/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/`：整數部分是每三位一個半形逗號的千分位，小數部分只有數字。小數的位數在這裡
/// 不限，超過兩位時之後以 `TooPrecise` 拒絕。
fn is_grouped(text: &str) -> bool {
    let (whole, fraction) = split_decimal(text);
    let groups: Vec<&str> = whole.split(',').collect();
    let Some((first, rest)) = groups.split_first() else {
        return false;
    };
    (1..=3).contains(&first.len())
        && is_digits(first)
        && !rest.is_empty()
        && rest
            .iter()
            .all(|group| group.len() == 3 && is_digits(group))
        && fraction.is_none_or(is_digits)
}

/// 以第一個「.」分成整數與小數部分；沒有「.」時沒有小數部分。
fn split_decimal(text: &str) -> (&str, Option<&str>) {
    match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    }
}

/// 只有 ASCII 數字 0–9（現行沒有 `u` 旗標的 `\d`）；空字串也是。
fn is_digits(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_digit())
}

/// ASCII 數字的值；只用於最多 7 位的數字。
fn digits_value(digits: &str) -> i64 {
    digits
        .bytes()
        .fold(0, |value, digit| value * 10 + i64::from(digit - b'0'))
}

// ── 平均分攤 ──

/// `split_evenly()` 的一項：一位分攤旅伴分到的金額（分）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Share {
    pub person: PersonId,
    pub amount_cents: i64,
}

/// 平均分攤一筆支出（需求 29.6，現行 `splitEvenly()`）：每位分攤旅伴先得到 ⌊金額 ÷ 人數⌋ 分，餘下的 r 分依旅伴 id
/// 遞增，各 1 分分給排在前面的 r 位。結果依旅伴 id 遞增、每位分攤旅伴一項，所以總和等於 `amount_cents`，任兩位最多相差
/// 1 分；`PersonId` 依 UUID 的位元組排序，與現行比較的小寫十六進位字串順序相同。例如 1000 分由 3 人分攤為 334、333、
/// 333，334 分給 id 最小的旅伴；1 分由 2 人分攤時，id 較大的旅伴分到 0 分。
///
/// 支出的驗證保證金額是 1–100,000,000 分、分攤旅伴有 1–100 位。超出這個範圍時不像現行丟出錯誤：`participants` 是空的時
/// 回傳空的清單，其他金額照同一個公式（向下取整）計算，總和仍等於 `amount_cents`。
pub fn split_evenly(amount_cents: i64, participants: &BTreeSet<PersonId>) -> Vec<Share> {
    // 集合的大小遠小於 i64::MAX
    let count = participants.len() as i64;
    if count == 0 {
        return Vec::new();
    }
    let base = amount_cents.div_euclid(count);
    let remainder = amount_cents.rem_euclid(count);
    participants
        .iter()
        .zip(0..)
        .map(|(&person, i)| Share {
            person,
            amount_cents: base + i64::from(i < remainder),
        })
        .collect()
}

// ── 結餘與建議轉帳 ──

/// 一位旅伴在帳本中的結餘（需求 29.7、29.11）；金額都是分。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Balance {
    pub person: PersonId,
    /// 已付：他付款的支出金額總和。
    pub paid_cents: i64,
    /// 分攤：`split_evenly()` 分給他的金額總和。
    pub share_cents: i64,
    /// 已還出：他作為付款人的還款總和。
    pub sent_cents: i64,
    /// 已收回：他作為收款人的還款總和。
    pub received_cents: i64,
    /// 淨額 = 已付 − 分攤 + 已還出 − 已收回；大於 0 是應收回，小於 0 是需補。
    pub net_cents: i64,
}

impl Balance {
    /// 還沒有任何帳目的結餘。
    fn zero(person: PersonId) -> Balance {
        Balance {
            person,
            paid_cents: 0,
            share_cents: 0,
            sent_cents: 0,
            received_cents: 0,
            net_cents: 0,
        }
    }

    /// 已付、分攤、已還出或已收回至少一項不為 0，也就是列在「誰該還誰」的旅伴（需求 29.11）。
    pub fn is_involved(&self) -> bool {
        [
            self.paid_cents,
            self.share_cents,
            self.sent_cents,
            self.received_cents,
        ]
        .iter()
        .any(|&cents| cents != 0)
    }

    /// 「誰該還誰」的淨額（需求 29.11）：大於 0 為「應收回 {淨額}」，小於 0 為「需補 {淨額的絕對值}」，等於 0 為「已結清」；
    /// 金額依 `format_money()`，例如「應收回 NT$600」「需補 NT$0.01」。
    pub fn net_label(&self) -> String {
        match self.net_cents.cmp(&0) {
            Ordering::Greater => format!("應收回 {}", format_money(self.net_cents)),
            Ordering::Less => format!("需補 {}", unsigned_money(self.net_cents.unsigned_abs())),
            Ordering::Equal => "已結清".to_owned(),
        }
    }

    /// 「誰該還誰」的明細（需求 29.11）：「已付 {金額} · 分攤 {金額}」，已還出不為 0 時加上「 · 已還出 {金額}」，已收回
    /// 不為 0 時再加上「 · 已收回 {金額}」，例如「已付 NT$0 · 分攤 NT$300 · 已還出 NT$300」。「·」是 U+00B7，前後各一個
    /// 半形空格；金額依 `format_money()`。
    pub fn detail_label(&self) -> String {
        let mut parts = vec![
            format!("已付 {}", format_money(self.paid_cents)),
            format!("分攤 {}", format_money(self.share_cents)),
        ];
        if self.sent_cents != 0 {
            parts.push(format!("已還出 {}", format_money(self.sent_cents)));
        }
        if self.received_cents != 0 {
            parts.push(format!("已收回 {}", format_money(self.received_cents)));
        }
        parts.join(" \u{b7} ")
    }
}

/// 一筆建議轉帳：`from` 轉 `amount_cents` 分給 `to`（需求 29.7）。按下「已還款」時，這三個值就是還款表單預填的付款人、
/// 收款人與金額（需求 29.11）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Transfer {
    pub from: PersonId,
    pub to: PersonId,
    pub amount_cents: i64,
}

/// `summarize()` 的結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerSummary {
    /// 支出金額的總和（需求 29.1 的總金額）。
    pub total_cents: i64,
    /// 還款金額的總和。
    pub total_settled_cents: i64,
    /// 每位旅伴的結餘，依旅伴的 Ordinal，包括四項都是 0 的旅伴；帳目提到、但不在旅伴中的 id 排在最後，依 id 遞增。
    pub balances: Vec<Balance>,
    /// 建議轉帳，依需求 29.7 產生的順序。
    pub transfers: Vec<Transfer>,
}

impl LedgerSummary {
    /// 「誰該還誰」列出的結餘（需求 29.11）：`balances` 中 `is_involved()` 的項目，依旅伴的 Ordinal。
    pub fn listed(&self) -> impl Iterator<Item = &Balance> {
        self.balances.iter().filter(|balance| balance.is_involved())
    }
}

/// 帳本的結餘與建議轉帳（需求 29.7，現行 `summarizeLedger()`）。每位旅伴的淨額 = 已付（他付款的支出金額總和）− 分攤
/// （`split_evenly()` 分給他的金額總和）+ 已還出（他作為付款人的還款總和）− 已收回（他作為收款人的還款總和）；每筆支出都有
/// 分攤旅伴時（需求 29.2 保證），所有旅伴淨額的總和為 0。
///
/// 建議轉帳：淨額小於 0 與大於 0 的旅伴各自依淨額的絕對值由大到小排列（相同時依旅伴 id 遞增），從兩邊的第一位開始，
/// 每次由目前的欠款者轉給目前的應收者兩人剩餘金額中較小的金額，剩餘為 0 的一方換成下一位；建議轉帳全部記成還款之後，
/// 每位旅伴的淨額都是 0。例如 A 付款 NT$2 由 A、B 分攤，B 還給 A NT$1.50 之後，建議轉帳為 A → B NT$0.50。
///
/// 結餘依旅伴的 Ordinal 排列，包括沒有任何帳目的旅伴。帳目提到、但不在旅伴中的 id 只在不滿足 I10 的狀態出現；它們與
/// 現行的歷史旅伴一樣排在最後、依 id 遞增，所以淨額的總和仍為 0。支出與還款的金額在 `limits::AMOUNT_CENTS` 之內、各最多
/// 1,000 筆時，總和不會溢位。
pub fn summarize(state: &TripState) -> LedgerSummary {
    let mut tallies = BTreeMap::new();
    let mut total_cents = 0;
    for expense in state.expenses.values() {
        total_cents += expense.amount_cents;
        tally(&mut tallies, expense.payer).paid_cents += expense.amount_cents;
        for share in split_evenly(expense.amount_cents, &expense.participants) {
            tally(&mut tallies, share.person).share_cents += share.amount_cents;
        }
    }
    let mut total_settled_cents = 0;
    for settlement in state.settlements.values() {
        total_settled_cents += settlement.amount_cents;
        tally(&mut tallies, settlement.from).sent_cents += settlement.amount_cents;
        tally(&mut tallies, settlement.to).received_cents += settlement.amount_cents;
    }

    // 旅伴依 Ordinal；留在 tallies 的是帳目提到、但不在旅伴中的 id，依 id 遞增
    let mut balances: Vec<Balance> = state
        .people_by_ordinal()
        .map(|person| {
            tallies
                .remove(&person.id)
                .unwrap_or_else(|| Balance::zero(person.id))
        })
        .collect();
    balances.extend(tallies.into_values());
    for balance in &mut balances {
        balance.net_cents =
            balance.paid_cents - balance.share_cents + balance.sent_cents - balance.received_cents;
    }
    let transfers = settle_up(&balances);
    LedgerSummary {
        total_cents,
        total_settled_cents,
        balances,
        transfers,
    }
}

/// `person` 的結餘；第一次提到時從 0 開始。
fn tally(tallies: &mut BTreeMap<PersonId, Balance>, person: PersonId) -> &mut Balance {
    tallies
        .entry(person)
        .or_insert_with(|| Balance::zero(person))
}

/// 建議轉帳中的一位欠款者或應收者，與他還沒有轉出或收回的金額。
struct Party {
    person: PersonId,
    left: i64,
}

/// 建議轉帳（現行 `settleUp()`），見 `summarize()`。
///
/// 迴圈不變式：已產生的轉帳金額總和等於欠款者已清償的金額總和，也等於應收者已收回的金額總和。淨額的總和為 0 時，兩邊在
/// 同一次轉帳之後一起用完。
fn settle_up(balances: &[Balance]) -> Vec<Transfer> {
    let mut debtors = parties(balances, Ordering::Less);
    let mut creditors = parties(balances, Ordering::Greater);
    let mut transfers = Vec::new();
    let (mut d, mut c) = (0, 0);
    while let (Some(debtor), Some(creditor)) = (debtors.get_mut(d), creditors.get_mut(c)) {
        let amount_cents = debtor.left.min(creditor.left);
        transfers.push(Transfer {
            from: debtor.person,
            to: creditor.person,
            amount_cents,
        });
        debtor.left -= amount_cents;
        creditor.left -= amount_cents;
        if debtor.left == 0 {
            d += 1;
        }
        if creditor.left == 0 {
            c += 1;
        }
    }
    transfers
}

/// 淨額與 0 比較為 `sign` 的旅伴（欠款者是 `Less`，應收者是 `Greater`）與淨額的絕對值，依絕對值由大到小、相同時依旅伴
/// id 遞增。
fn parties(balances: &[Balance], sign: Ordering) -> Vec<Party> {
    let mut parties: Vec<Party> = balances
        .iter()
        .filter(|balance| balance.net_cents.cmp(&0) == sign)
        .map(|balance| Party {
            person: balance.person,
            left: balance.net_cents.abs(),
        })
        .collect();
    parties.sort_by(|a, b| b.left.cmp(&a.left).then(a.person.cmp(&b.person)));
    parties
}

// ── 支出分類 ──

/// 支出分類（現行 `EXPENSE_CATEGORIES`，18 種），依支出表單的選項順序：食材、交通、住宿、其他、11 種「食材／{採買分類}」
/// （依 `SHOPPING_CATEGORIES` 的順序）、露營耗材、露營裝備、日用品。與 `ExpenseCategory::ALL` 相同。
pub const EXPENSE_CATEGORIES: &[ExpenseCategory] = ExpenseCategory::ALL;

/// `suggest_expense_category()` 依序檢查的詞與分類：現行 `suggestExpenseCategory()` 的五個 regex，詞以「|」分隔，
/// 每個詞只比對是否出現在標題中。
const CATEGORY_WORDS: [(&str, ExpenseCategory); 5] = [
    ("木炭|瓦斯|火種|燃料|點火", ExpenseCategory::CampingSupplies),
    (
        "帳篷|天幕|睡袋|睡墊|營燈|營柱|營釘|營繩|行軍床|折疊椅|卡式爐",
        ExpenseCategory::CampingGear,
    ),
    (
        "衛生紙|濕紙巾|垃圾袋|洗碗精|海綿|牙刷|牙膏|毛巾|防蚊",
        ExpenseCategory::Household,
    ),
    (
        "停車|過路|高速公路|油錢|汽油|柴油|車票|計程車",
        ExpenseCategory::Transport,
    ),
    ("營位費|住宿|房費|營地費", ExpenseCategory::Lodging),
];

/// 由支出標題建議支出分類（需求 29.8，現行 `suggestExpenseCategory()`）：標題經 NFKC 之後依序檢查，含有「木炭、瓦斯、
/// 火種、燃料、點火」任一詞時為露營耗材；含有「帳篷、天幕、睡袋、睡墊、營燈、營柱、營釘、營繩、行軍床、折疊椅、卡式爐」
/// 任一詞時為露營裝備；含有「衛生紙、濕紙巾、垃圾袋、洗碗精、海綿、牙刷、牙膏、毛巾、防蚊」任一詞時為日用品；含有
/// 「停車、過路、高速公路、油錢、汽油、柴油、車票、計程車」任一詞時為交通；含有「營位費、住宿、房費、營地費」任一詞時為
/// 住宿。都不含時，`classify_ingredient()` 把標題分到「其他」則為其他，分到其他採買分類 c 則為「食材／c」，所以不會建議
/// 「食材」本身。例如「卡式爐瓦斯罐」為露營耗材（先檢查）、「高速公路過路費」為交通、「雞腿」為「食材／肉類」、「冰塊」
/// 為其他。
pub fn suggest_expense_category(title: &str) -> ExpenseCategory {
    let text: String = title.nfkc().collect();
    let matched = CATEGORY_WORDS
        .iter()
        .find(|(words, _)| words.split('|').any(|word| text.contains(word)));
    if let Some(&(_, category)) = matched {
        return category;
    }
    match classify_ingredient(&text) {
        Category::Other => ExpenseCategory::Other,
        category => ExpenseCategory::Groceries(category),
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::ids::{ExpenseId, SettlementId, TripId};
    use crate::model::{Color, CoverKind, Date, Expense, Person, Settlement, TripCard, TripStatus};

    fn person(n: u128) -> PersonId {
        PersonId(Uuid::from_u128(n))
    }

    fn people<const N: usize>(ids: [u128; N]) -> BTreeSet<PersonId> {
        ids.map(person).into()
    }

    fn day() -> Date {
        crate::time::ymd(2026, 11, 20).expect("有效的日期")
    }

    /// 第 `ordinal` 個加入的旅伴，id 為 `n`。
    fn traveller(n: u128, ordinal: u64) -> Person {
        Person {
            id: person(n),
            name: format!("旅伴 {n}"),
            role: String::new(),
            color: Color::Coral,
            bound: false,
            ordinal,
            version: 0,
        }
    }

    fn expense<const N: usize>(
        n: u128,
        amount_cents: i64,
        payer: u128,
        participants: [u128; N],
    ) -> Expense {
        Expense {
            id: ExpenseId(Uuid::from_u128(1000 + n)),
            day: day(),
            title: format!("支出 {n}"),
            amount_cents,
            payer: person(payer),
            participants: people(participants),
            category: ExpenseCategory::Food,
            note: String::new(),
            shopping_item: None,
            ordinal: 1000 + n as u64,
            version: 0,
        }
    }

    fn settlement(n: u128, from: u128, to: u128, amount_cents: i64) -> Settlement {
        Settlement {
            id: SettlementId(Uuid::from_u128(2000 + n)),
            day: day(),
            from: person(from),
            to: person(to),
            amount_cents,
            note: String::new(),
            ordinal: 2000 + n as u64,
            version: 0,
        }
    }

    fn trip(
        people: Vec<Person>,
        expenses: Vec<Expense>,
        settlements: Vec<Settlement>,
    ) -> TripState {
        let mut state = TripState::new(TripCard {
            id: TripId(Uuid::from_u128(1)),
            title: "週末露營".to_owned(),
            destination: "湖邊營地".to_owned(),
            start: day(),
            end: day(),
            description: String::new(),
            note: String::new(),
            cover: CoverKind::Lake,
            status: TripStatus::Planning,
            version: 0,
            caption: String::new(),
            headline: String::new(),
        });
        state
            .people
            .extend(people.into_iter().map(|row| (row.id, row)));
        state
            .expenses
            .extend(expenses.into_iter().map(|row| (row.id, row)));
        state
            .settlements
            .extend(settlements.into_iter().map(|row| (row.id, row)));
        state
    }

    fn transfer(from: u128, to: u128, amount_cents: i64) -> Transfer {
        Transfer {
            from: person(from),
            to: person(to),
            amount_cents,
        }
    }

    #[test]
    fn parse_amount_accepts_the_formats_of_requirement_29_5() {
        for (input, cents) in [
            // 需求 29.5 的例子
            ("350", 35_000),
            (" NT$1,234.56 ", 123_456),
            ("１２０元", 12_000),
            ("12.", 1_200),
            ("120.5", 12_050),
            ("0.01", 1),
            ("$99", 9_900),
            ("1000000", 100_000_000),
            ("1,000,000.00", 100_000_000),
            // 幣別不分大小寫，只去除一個；幣別之後與「元」之前可以有空白
            ("ntd100", 10_000),
            ("Twd 7.5", 750),
            ("NT$ 1,234 元", 123_400),
            ("\u{3000}$\t88\u{3000}元\n", 8_800),
            // 全形的幣別、逗號與小數點在 NFKC 之後是半形
            ("ＮＴ＄１，２３４．５", 123_450),
            // 前導的 0
            ("007", 700),
            ("0,123", 12_300),
            ("0000001.5", 150),
        ] {
            assert_eq!(parse_amount(input), Ok(cents), "{input:?}");
        }
    }

    #[test]
    fn parse_amount_rejects_with_the_messages_of_requirement_29_5() {
        use AmountError::{Invalid, Missing, NotPositive, TooLarge, TooPrecise};
        for (input, error) in [
            ("", Missing),
            (" \u{3000}\n", Missing),
            ("NT$", Missing),
            ("元", Missing),
            ("$ 元", Missing),
            ("-5", NotPositive),
            ("-", NotPositive),
            ("NT$-1", NotPositive),
            ("－3", NotPositive),
            ("-1.234", NotPositive),
            ("0", NotPositive),
            ("0.00", NotPositive),
            ("000,000", NotPositive),
            ("1.234", TooPrecise),
            (".123", TooPrecise),
            ("1,234.567", TooPrecise),
            ("99999999.999", TooPrecise),
            ("1000000.01", TooLarge),
            ("2000000", TooLarge),
            ("99999999", TooLarge),
            ("10,000,000", TooLarge),
            // 需求 29.5 的其他格式
            ("1,23", Invalid),
            ("1e3", Invalid),
            ("0x10", Invalid),
            ("١٢٣", Invalid),
            ("abc", Invalid),
            ("12,345,6", Invalid),
            ("1,23.456", Invalid),
            (".5", Invalid),
            ("1.2.3", Invalid),
            ("+5", Invalid),
            ("1 000", Invalid),
            ("$$5", Invalid),
            ("5 元整", Invalid),
            ("350元元", Invalid),
        ] {
            assert_eq!(parse_amount(input), Err(error), "{input:?}");
        }
    }

    #[test]
    fn amount_errors_display_the_messages_of_requirement_29_5() {
        for (error, message) in [
            (AmountError::Missing, "請輸入金額。"),
            (AmountError::NotPositive, "金額必須大於 0。"),
            (
                AmountError::TooPrecise,
                "金額最多到小數點後兩位（角、分）。",
            ),
            (AmountError::TooLarge, "單筆金額最多 NT$1,000,000。"),
            (
                AmountError::Invalid,
                "請輸入有效的金額，例如 350 或 120.5。",
            ),
        ] {
            assert_eq!(error.to_string(), message);
        }
    }

    #[test]
    fn parse_amount_white_space_is_trim_white() {
        // Trim_White：U+0085 是 Unicode White_Space，U+FEFF 不是（現行 JavaScript 的 trim() 與 \s 正好相反）
        assert_eq!(parse_amount("\u{85}350\u{85}"), Ok(35_000));
        assert_eq!(parse_amount("NT$\u{85}350\u{85}元"), Ok(35_000));
        assert_eq!(parse_amount("\u{feff}350"), Err(AmountError::Invalid));
        assert_eq!(parse_amount("350\u{feff}元"), Err(AmountError::Invalid));
    }

    #[test]
    fn check_amount_cents_accepts_one_cent_to_one_million_dollars() {
        for cents in [1, 35_000, 100_000_000] {
            assert_eq!(check_amount_cents(cents), Ok(cents));
        }
        for cents in [0, -1, i64::MIN] {
            assert_eq!(check_amount_cents(cents), Err(AmountError::NotPositive));
        }
        for cents in [100_000_001, i64::MAX] {
            assert_eq!(check_amount_cents(cents), Err(AmountError::TooLarge));
        }
    }

    #[test]
    fn format_money_groups_thousands_and_shows_cents_only_when_present() {
        for (cents, text) in [
            // 需求 29.5 的例子
            (0, "NT$0"),
            (1, "NT$0.01"),
            (123_456, "NT$1,234.56"),
            (-12_050, "-NT$120.50"),
            (35_000, "NT$350"),
            (99_999, "NT$999.99"),
            (100_000, "NT$1,000"),
            (100_000_000, "NT$1,000,000"),
            (-1, "-NT$0.01"),
            (i64::MAX, "NT$92,233,720,368,547,758.07"),
            (i64::MIN, "-NT$92,233,720,368,547,758.08"),
        ] {
            assert_eq!(format_money(cents), text, "{cents}");
        }
    }

    #[test]
    fn parse_amount_reads_back_format_money() {
        for cents in [
            1,
            9,
            10,
            99,
            100,
            101,
            35_000,
            123_456,
            9_999_999,
            99_999_999,
            100_000_000,
        ] {
            assert_eq!(parse_amount(&format_money(cents)), Ok(cents), "{cents}");
        }
    }

    #[test]
    fn split_evenly_gives_the_remainder_to_the_smallest_ids() {
        // 需求 29.6 的例子：NT$10 由 3 人分攤，NT$0.01 由 2 人分攤；依 id 遞增，與輸入的順序無關
        let share = |n, amount_cents| Share {
            person: person(n),
            amount_cents,
        };
        assert_eq!(
            split_evenly(1_000, &people([3, 1, 2])),
            [share(1, 334), share(2, 333), share(3, 333)]
        );
        assert_eq!(split_evenly(1, &people([9, 8])), [share(8, 1), share(9, 0)]);
        assert_eq!(split_evenly(500, &people([5])), [share(5, 500)]);
    }

    #[test]
    fn person_ids_sort_like_their_lowercase_hex_strings() {
        let mut texts = [
            "a0000000-0000-4000-8000-000000000000",
            "0a000000-0000-4000-8000-000000000000",
            "09ffffff-ffff-4fff-bfff-ffffffffffff",
            "00000000-0000-4000-8000-000000000100",
            "00000000-0000-4000-8000-0000000000ff",
        ];
        let participants: BTreeSet<PersonId> = texts
            .iter()
            .map(|text| PersonId(Uuid::parse_str(text).expect("有效的 UUID")))
            .collect();
        texts.sort_unstable();
        let shares = split_evenly(7, &participants);
        let order: Vec<String> = shares
            .iter()
            .map(|share| share.person.to_string())
            .collect();
        assert_eq!(order, texts);
        let amounts: Vec<i64> = shares.iter().map(|share| share.amount_cents).collect();
        assert_eq!(amounts, [2, 2, 1, 1, 1]);
    }

    #[test]
    fn split_evenly_conserves_the_amount_for_every_group_size() {
        for n in 1..=13 {
            let participants: BTreeSet<PersonId> = (0..n).map(person).collect();
            for amount_cents in [1, 7, 99, 100, 101, 12_345, 99_999_999, 100_000_000] {
                let amounts: Vec<i64> = split_evenly(amount_cents, &participants)
                    .iter()
                    .map(|share| share.amount_cents)
                    .collect();
                assert_eq!(amounts.len(), participants.len());
                assert_eq!(
                    amounts.iter().sum::<i64>(),
                    amount_cents,
                    "{n} {amount_cents}"
                );
                let (min, max) = (amounts.iter().min(), amounts.iter().max());
                assert!(max.zip(min).is_some_and(|(max, min)| max - min <= 1));
            }
        }
    }

    #[test]
    fn split_evenly_outside_the_expense_rules_does_not_fail() {
        assert!(split_evenly(100, &BTreeSet::new()).is_empty());
        let amounts = |amount_cents| -> Vec<i64> {
            split_evenly(amount_cents, &people([1, 2]))
                .iter()
                .map(|share| share.amount_cents)
                .collect()
        };
        assert_eq!(amounts(0), [0, 0]);
        // 向下取整：⌊-1 ÷ 2⌋ = -1，餘 1 分給 id 較小的旅伴
        assert_eq!(amounts(-1), [0, -1]);
    }

    #[test]
    fn summarize_follows_the_example_of_requirement_29_7() {
        // A 付款 NT$2 由 A、B 分攤，B 還給 A NT$1.50 之後，建議轉帳為 A → B NT$0.50
        let (a, b) = (1, 2);
        let state = trip(
            vec![traveller(a, 1), traveller(b, 2)],
            vec![expense(1, 200, a, [a, b])],
            vec![settlement(1, b, a, 150)],
        );
        let summary = summarize(&state);
        assert_eq!(summary.total_cents, 200);
        assert_eq!(summary.total_settled_cents, 150);
        assert_eq!(
            summary.balances,
            [
                Balance {
                    person: person(a),
                    paid_cents: 200,
                    share_cents: 100,
                    sent_cents: 0,
                    received_cents: 150,
                    net_cents: -50,
                },
                Balance {
                    person: person(b),
                    paid_cents: 0,
                    share_cents: 100,
                    sent_cents: 150,
                    received_cents: 0,
                    net_cents: 50,
                },
            ]
        );
        assert_eq!(summary.transfers, [transfer(a, b, 50)]);
    }

    #[test]
    fn summarize_lists_people_by_ordinal_then_ids_that_are_not_people() {
        // 旅伴 3、1、2 依 Ordinal；5 與 9 不在旅伴中（不滿足 I10），依 id 排在最後
        let state = trip(
            vec![traveller(1, 2), traveller(3, 1), traveller(2, 3)],
            vec![expense(1, 300, 3, [3, 9, 5]), expense(2, 100, 1, [1])],
            Vec::new(),
        );
        let summary = summarize(&state);
        assert_eq!(summary.total_cents, 400);
        let order: Vec<PersonId> = summary.balances.iter().map(|b| b.person).collect();
        assert_eq!(order, [3, 1, 2, 5, 9].map(person));
        let nets: Vec<i64> = summary.balances.iter().map(|b| b.net_cents).collect();
        assert_eq!(nets, [200, 0, 0, -100, -100]);
        // 旅伴 1 已結清但有帳目，旅伴 2 沒有任何帳目
        let listed: Vec<PersonId> = summary.listed().map(|b| b.person).collect();
        assert_eq!(listed, [3, 1, 5, 9].map(person));
        assert_eq!(
            summary.transfers,
            [transfer(5, 3, 100), transfer(9, 3, 100)]
        );
    }

    #[test]
    fn transfers_pair_the_largest_debts_and_credits_with_ties_by_id() {
        // A 付 600 由 A、B、C 分攤；D 付 300 由 D、B、C 分攤：A +400、B −300、C −300、D +200
        let (a, b, c, d) = (1, 20, 10, 4);
        let state = trip(
            vec![
                traveller(a, 1),
                traveller(b, 2),
                traveller(c, 3),
                traveller(d, 4),
            ],
            vec![expense(1, 600, a, [a, b, c]), expense(2, 300, d, [d, b, c])],
            Vec::new(),
        );
        let summary = summarize(&state);
        let nets: Vec<i64> = summary.balances.iter().map(|b| b.net_cents).collect();
        assert_eq!(nets, [400, -300, -300, 200]);
        // B 與 C 欠款相同時依 id：C（10）在 B（20）之前，與 Ordinal 無關
        assert_eq!(
            summary.transfers,
            [
                transfer(c, a, 300),
                transfer(b, a, 100),
                transfer(b, d, 200)
            ]
        );
    }

    #[test]
    fn summarize_without_ledger_rows() {
        let summary = summarize(&trip(
            vec![traveller(2, 1), traveller(1, 2)],
            Vec::new(),
            Vec::new(),
        ));
        assert_eq!(summary.total_cents, 0);
        assert_eq!(summary.total_settled_cents, 0);
        assert_eq!(
            summary.balances,
            [Balance::zero(person(2)), Balance::zero(person(1))]
        );
        assert!(summary.transfers.is_empty());
        assert_eq!(summary.listed().count(), 0);

        let empty = summarize(&trip(Vec::new(), Vec::new(), Vec::new()));
        assert!(empty.balances.is_empty() && empty.transfers.is_empty());
    }

    #[test]
    fn balance_labels_follow_requirement_29_11() {
        // 旅伴 1 付 NT$900 由 1、2、3 分攤，旅伴 2 還給旅伴 1 NT$300
        let state = trip(
            vec![traveller(1, 1), traveller(2, 2), traveller(3, 3)],
            vec![expense(1, 90_000, 1, [1, 2, 3])],
            vec![settlement(1, 2, 1, 30_000)],
        );
        let labels: Vec<(String, String)> = summarize(&state)
            .listed()
            .map(|balance| (balance.net_label(), balance.detail_label()))
            .collect();
        let expected = [
            ("應收回 NT$300", "已付 NT$900 · 分攤 NT$300 · 已收回 NT$300"),
            ("已結清", "已付 NT$0 · 分攤 NT$300 · 已還出 NT$300"),
            ("需補 NT$300", "已付 NT$0 · 分攤 NT$300"),
        ]
        .map(|(net, detail)| (net.to_owned(), detail.to_owned()));
        assert_eq!(labels, expected);

        let both = Balance {
            person: person(1),
            paid_cents: 0,
            share_cents: 1,
            sent_cents: 100_000,
            received_cents: 1,
            net_cents: -1,
        };
        assert_eq!(both.net_label(), "需補 NT$0.01");
        assert_eq!(
            both.detail_label(),
            "已付 NT$0 \u{b7} 分攤 NT$0.01 \u{b7} 已還出 NT$1,000 \u{b7} 已收回 NT$0.01"
        );
    }

    #[test]
    fn expense_categories_are_the_18_values_in_order() {
        let names: Vec<&str> = EXPENSE_CATEGORIES
            .iter()
            .map(ExpenseCategory::as_str)
            .collect();
        assert_eq!(
            names,
            [
                "食材",
                "交通",
                "住宿",
                "其他",
                "食材／肉類",
                "食材／海鮮",
                "食材／蔬菜",
                "食材／水果",
                "食材／蛋奶",
                "食材／豆製品",
                "食材／主食",
                "食材／調味料",
                "食材／飲料",
                "食材／零食",
                "食材／其他",
                "露營耗材",
                "露營裝備",
                "日用品",
            ]
        );
    }

    #[test]
    fn suggest_expense_category_checks_the_words_in_order() {
        use ExpenseCategory::{CampingGear, CampingSupplies, Household, Lodging, Transport};
        for (title, category) in [
            ("木炭 2 包", CampingSupplies),
            ("點火槍", CampingSupplies),
            // 露營耗材在露營裝備之前檢查
            ("卡式爐瓦斯罐", CampingSupplies),
            ("卡式爐", CampingGear),
            ("租行軍床", CampingGear),
            ("濕紙巾", Household),
            ("防蚊液", Household),
            // 日用品在露營耗材之後
            ("垃圾袋與木炭", CampingSupplies),
            ("高速公路過路費", Transport),
            ("計程車", Transport),
            // 交通在住宿之前
            ("停車場住宿", Transport),
            ("營位費", Lodging),
            ("民宿房費", Lodging),
            ("營地費", Lodging),
            // NFKC：康熙部首「⽊」（U+2F4A）成為「木」
            ("\u{2f4a}炭", CampingSupplies),
        ] {
            assert_eq!(suggest_expense_category(title), category, "{title:?}");
        }
    }

    #[test]
    fn suggest_expense_category_falls_back_to_the_ingredient_classifier() {
        use ExpenseCategory::{Groceries, Other};
        for (title, category) in [
            ("雞腿", Groceries(Category::Meat)),
            ("高麗菜", Groceries(Category::Vegetables)),
            ("全麥吐司", Groceries(Category::Staples)),
            ("啤酒", Groceries(Category::Drinks)),
            ("鹽", Groceries(Category::Seasoning)),
            ("冰塊", Other),
            ("門票", Other),
            ("", Other),
            // 詞以 NFKC 之後的標題比對，中間有空白時不符合；Ingredient_Classifier 比對的鍵不含空白
            ("停 車", Other),
            ("雞 腿", Groceries(Category::Meat)),
        ] {
            assert_eq!(suggest_expense_category(title), category, "{title:?}");
        }
    }
}
