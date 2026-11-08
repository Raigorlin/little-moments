import { SHOPPING_CATEGORIES, classifyIngredient } from './ingredients.js';

// The original categories remain valid; old ledgers are never reclassified on read.
export const EXPENSE_CATEGORIES = Object.freeze([
  '食材', '交通', '住宿', '其他',
  ...SHOPPING_CATEGORIES.map(category => `食材／${category}`),
  '露營耗材', '露營裝備', '日用品'
]);
export function suggestExpenseCategory(name = '') {
  const text = String(name).normalize('NFKC');
  if (/木炭|瓦斯|火種|燃料|點火/.test(text)) return '露營耗材';
  if (/帳篷|天幕|睡袋|睡墊|營燈|營柱|營釘|營繩|行軍床|折疊椅|卡式爐/.test(text)) return '露營裝備';
  if (/衛生紙|濕紙巾|垃圾袋|洗碗精|海綿|牙刷|牙膏|毛巾|防蚊/.test(text)) return '日用品';
  if (/停車|過路|高速公路|油錢|汽油|柴油|車票|計程車/.test(text)) return '交通';
  if (/營位費|住宿|房費|營地費/.test(text)) return '住宿';
  const category = classifyIngredient(text);
  return category === '其他' ? '其他' : `食材／${category}`;
}
