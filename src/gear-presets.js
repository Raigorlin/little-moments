// Suggestions only. Choosing one fills the form; it never edits a trip until Save.
export const PERSONAL_GEAR_GROUPS = Object.freeze([
  { label: '睡眠與遮蔽', items: [
    { name: '帳篷', quantity: '1 頂' },
    { name: '行軍床', quantity: '1 張' },
    { name: '折疊床', quantity: '1 張' },
    { name: '充氣床墊', quantity: '1 張' },
    { name: '睡墊', quantity: '1 張' },
    { name: '睡袋', quantity: '1 個' },
    { name: '棉被', quantity: '1 件' },
    { name: '枕頭', quantity: '1 個' },
    { name: '防潮墊', quantity: '1 張' }
  ] },
  { label: '穿著與盥洗', items: [
    { name: '保暖外套', quantity: '1 件' },
    { name: '換洗衣物', quantity: '1 組' },
    { name: '雨衣', quantity: '1 件' },
    { name: '毛巾', quantity: '1 條' },
    { name: '盥洗用品', quantity: '1 組' },
    { name: '拖鞋', quantity: '1 雙' }
  ] },
  { label: '隨身用品', items: [
    { name: '頭燈', quantity: '1 個' },
    { name: '行動電源', quantity: '1 個' },
    { name: '個人餐具', quantity: '1 組' },
    { name: '水壺', quantity: '1 個' }
  ] }
]);

export const PERSONAL_GEAR_PRESETS = Object.freeze(PERSONAL_GEAR_GROUPS.flatMap(group => group.items));
export const personalGearPreset = name => PERSONAL_GEAR_PRESETS.find(item => item.name === name) || null;
