import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

export function registerItemTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "drop-item",
    "Drop an item from the bot's inventory onto the ground",
    {
      itemName: z.string().describe("Name of the item to drop"),
      count: z.coerce.number().int().positive().optional().describe("Number of items to drop (default: drops the entire stack)")
    },
    async ({ itemName, count }: { itemName: string; count?: number }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) => item.name.includes(itemName.toLowerCase()));

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      if (!count || count >= item.count) {
        await bot.tossStack(item);
        return factory.createResponse(`Dropped all ${item.count} ${item.name}`);
      }

      await bot.toss(item.type, item.metadata ?? null, count);
      return factory.createResponse(`Dropped ${count} ${item.name}`);
    }
  );
}
