import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

export function registerVillagerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-villager-trades",
    "Open the nearest villager and list its available trades",
    {
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ maxDistance = 16 }: { maxDistance?: number }) => {
      const bot = getBot();
      const villagerEntity = bot.nearestEntity((entity) => entity.name === 'villager');

      if (!villagerEntity || bot.entity.position.distanceTo(villagerEntity.position) > maxDistance) {
        return factory.createResponse(`No villager found within ${maxDistance} blocks`);
      }

      const villager = await bot.openVillager(villagerEntity);
      try {
        if (villager.trades.length === 0) {
          return factory.createResponse("This villager has no trades available");
        }

        const list = villager.trades.map((trade, i) => {
          const input2 = trade.hasItem2 && trade.inputItem2 ? ` + ${trade.inputItem2.count} ${trade.inputItem2.name}` : '';
          const disabled = trade.tradeDisabled ? ' (out of stock)' : '';
          return `${i}. ${trade.inputItem1.count} ${trade.inputItem1.name}${input2} -> ${trade.outputItem.count} ${trade.outputItem.name}${disabled}`;
        }).join('\n');

        return factory.createResponse(`Villager trades:\n${list}`);
      } finally {
        villager.close();
      }
    }
  );

  factory.registerTool(
    "trade-with-villager",
    "Trade with the nearest villager using one of its available trade slots",
    {
      tradeIndex: z.coerce.number().int().min(0).describe("Index of the trade to use (see list-villager-trades)"),
      times: z.coerce.number().int().positive().optional().describe("How many times to repeat this trade (default: 1)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ tradeIndex, times = 1, maxDistance = 16 }: { tradeIndex: number; times?: number; maxDistance?: number }) => {
      const bot = getBot();
      const villagerEntity = bot.nearestEntity((entity) => entity.name === 'villager');

      if (!villagerEntity || bot.entity.position.distanceTo(villagerEntity.position) > maxDistance) {
        return factory.createResponse(`No villager found within ${maxDistance} blocks`);
      }

      const villager = await bot.openVillager(villagerEntity);
      try {
        const trade = villager.trades[tradeIndex];
        if (!trade) {
          return factory.createResponse(`No trade at index ${tradeIndex}. This villager has ${villager.trades.length} trade(s).`);
        }
        if (trade.tradeDisabled) {
          return factory.createResponse(`Trade ${tradeIndex} (${trade.outputItem.name}) is out of stock`);
        }

        await bot.trade(villager, tradeIndex, times);
        return factory.createResponse(`Traded for ${times}x ${trade.outputItem.name}`);
      } finally {
        villager.close();
      }
    }
  );
}
