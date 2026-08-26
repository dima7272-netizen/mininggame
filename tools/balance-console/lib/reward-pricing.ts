import Decimal from 'decimal.js';
import type { SellItem } from './config-model';
import { exactNumber, stringifyExactJson } from './exact-json';

const readableMantissas = ['1', '1.2', '1.5', '2', '2.5', '3', '4', '5', '7'];

export function buildReadableRewardPrices(items: SellItem[], minimumPrice = '10'): SellItem[] {
  const sorted = [...items].sort((left, right) => {
    const priceDifference = new Decimal(left.sellPrice).comparedTo(right.sellPrice);
    return priceDifference || left.id.localeCompare(right.id);
  });
  const minimum = new Decimal(minimumPrice).ceil();
  const candidates = Array.from({ length: 101 }, (_, exponent) => (
    readableMantissas.map((mantissa) => new Decimal(mantissa).mul(new Decimal(10).pow(exponent)))
  )).flat().filter((candidate) => candidate.isInteger() && candidate.greaterThanOrEqualTo(minimum));

  let previous = new Decimal(0);
  return sorted.map((item) => {
    const original = Decimal.max(item.sellPrice, 1);
    const available = candidates.filter((candidate) => candidate.greaterThan(previous));
    if (available.length === 0) throw new Error(`Не удалось подобрать круглую цену для ${item.id}.`);
    const price = available.reduce((best, candidate) => {
      const bestDistance = best.greaterThanOrEqualTo(original) ? best.div(original) : original.div(best);
      const candidateDistance = candidate.greaterThanOrEqualTo(original) ? candidate.div(original) : original.div(candidate);
      return candidateDistance.lessThan(bestDistance) ? candidate : best;
    }, available[0]);
    previous = price;
    return { id: item.id, sellPrice: price.toFixed(0) };
  });
}

export function serializeReadableSellItems(
  settings: { minimumItemsPerRoom: string; maximumItemsPerRoom: string },
  items: SellItem[],
) {
  return stringifyExactJson({
    settings: {
      minimumItemsPerRoom: exactNumber(settings.minimumItemsPerRoom),
      maximumItemsPerRoom: exactNumber(settings.maximumItemsPerRoom),
    },
    items: items.map((item) => ({ id: item.id, sellPrice: exactNumber(item.sellPrice) })),
  });
}
