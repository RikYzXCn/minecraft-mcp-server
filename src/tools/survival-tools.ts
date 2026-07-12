import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';

export function registerSurvivalTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "eat-food",
    "Eat food from the bot's inventory to restore hunger",
    {
      foodName: z.string().optional().describe("Specific food item name to eat (default: automatically picks any available food)")
    },
    async ({ foodName }: { foodName?: string }) => {
      const bot = getBot();

      if (bot.food >= 20) {
        return factory.createResponse("Bot is already full (food level 20/20)");
      }

      const items = bot.inventory.items();
      const mcData = (bot as unknown as { registry: { foodsByName: Record<string, unknown> } }).registry;
      const food = foodName
        ? items.find((item) => item.name.includes(foodName.toLowerCase()))
        : items.find((item) => Boolean(mcData.foodsByName[item.name]));

      if (!food) {
        return factory.createResponse(`No food found${foodName ? ` matching '${foodName}'` : ''} in inventory`);
      }

      const previousHeldItem = bot.heldItem;
      await bot.equip(food, 'hand');
      await bot.consume();

      if (previousHeldItem && previousHeldItem.name !== food.name) {
        const stillHave = bot.inventory.items().find((item) => item.name === previousHeldItem.name);
        if (stillHave) {
          await bot.equip(stillHave, 'hand').catch(() => undefined);
        }
      }

      return factory.createResponse(`Ate ${food.name}. Food level is now ${bot.food}/20`);
    }
  );

  factory.registerTool(
    "sleep-in-bed",
    "Find the nearest bed and sleep in it (only works at night or during thunderstorms)",
    {
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance for a bed (default: 16)")
    },
    async ({ maxDistance = 16 }: { maxDistance?: number }) => {
      const bot = getBot();

      const bedBlock = bot.findBlock({
        matching: (block) => bot.isABed(block),
        maxDistance
      });

      if (!bedBlock) {
        return factory.createResponse(`No bed found within ${maxDistance} blocks`);
      }

      if (!bot.canSeeBlock(bedBlock) || bot.entity.position.distanceTo(bedBlock.position) > 2) {
        const goal = new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1);
        await bot.pathfinder.goto(goal);
      }

      try {
        await bot.sleep(bedBlock);
        return factory.createResponse(`Bot is now sleeping in the bed at (${bedBlock.position.x}, ${bedBlock.position.y}, ${bedBlock.position.z})`);
      } catch (error) {
        return factory.createResponse(`Couldn't sleep: ${(error as Error).message}`);
      }
    }
  );

  factory.registerTool(
    "wake-up",
    "Wake the bot up if it is currently sleeping",
    {},
    async () => {
      const bot = getBot();

      if (!bot.isSleeping) {
        return factory.createResponse("Bot is not currently sleeping");
      }

      await bot.wake();
      return factory.createResponse("Bot has woken up");
    }
  );

  factory.registerTool(
    "respawn",
    "Respawn the bot after death",
    {},
    async () => {
      const bot = getBot();
      bot.respawn();
      return factory.createResponse("Respawn requested");
    }
  );

  factory.registerTool(
    "go-fishing",
    "Cast a fishing rod and wait for a catch (requires a fishing rod equipped and standing near water)",
    {
      timeoutMs: z.coerce.number().int().positive().optional().describe("Maximum time to wait for a catch in ms (default: 60000)")
    },
    async ({ timeoutMs = 60000 }: { timeoutMs?: number }) => {
      const bot = getBot();

      const items = bot.inventory.items();
      const rod = items.find((item) => item.name === 'fishing_rod');

      if (!rod) {
        return factory.createResponse("No fishing rod found in inventory");
      }

      if (bot.heldItem?.name !== 'fishing_rod') {
        await bot.equip(rod, 'hand');
      }

      try {
        await Promise.race([
          bot.fish(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Fishing timed out after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);
        return factory.createResponse("Caught something while fishing!");
      } catch (error) {
        return factory.createResponse(`Fishing failed: ${(error as Error).message}`);
      }
    }
  );
}
