import Decimal from 'decimal.js';
import type { ConfigTextMap } from './config-model';
import {
  asArray,
  asNumberText,
  asObject,
  asString,
  exactNumber,
  parseExactJson,
  stringifyExactJson,
  type ExactJson,
} from './exact-json';
import { originalRewardHierarchyItemIds, rewardHierarchyItemIds } from './reward-groups';

export function arrangeRewardsByGameHierarchy(configs: ConfigTextMap): ConfigTextMap {
  const source = configs.SellItems;
  if (!source) return configs;

  const root = asObject(parseExactJson(source), 'SellItems');
  const items = asArray(root.items, 'SellItems.items');
  const itemById = new Map<string, Record<string, ExactJson>>();
  const prices: string[] = [];

  for (const value of items) {
    const item = asObject(value, 'SellItems item');
    const id = asString(item.id, 'SellItems.id');
    if (itemById.has(id)) return configs;
    itemById.set(id, item);
    prices.push(asNumberText(item.sellPrice, `SellItems.${id}.sellPrice`));
  }

  const hierarchy = itemById.size === rewardHierarchyItemIds.length
    ? rewardHierarchyItemIds
    : itemById.size === originalRewardHierarchyItemIds.length
      ? originalRewardHierarchyItemIds
      : null;
  if (!hierarchy || hierarchy.some((itemId) => !itemById.has(itemId))) {
    return configs;
  }

  prices.sort((left, right) => new Decimal(left).comparedTo(right));
  const arrangedItems = hierarchy.map((itemId, index) => ({
    ...itemById.get(itemId)!,
    sellPrice: exactNumber(prices[index]),
  }));
  const nextSellItems = stringifyExactJson({ ...root, items: arrangedItems });

  return nextSellItems === source ? configs : { ...configs, SellItems: nextSellItems };
}
