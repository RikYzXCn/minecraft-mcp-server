import { z } from "zod";
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';
import { gotoWithStuckRecovery } from './pathfinding-utils.js';

const MAX_COLLECT_COUNT = 64;

export function registerCollectTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "collect-block",
    "Automatically find, path to, mine (with the best available tool), and pick up nearby blocks of a given type. Handles the whole travel+tool+dig+pickup sequence in one call.",
    {
      blockType: z.string().describe("Type of block to collect (e.g. 'oak_log', 'iron_ore')"),
      count: z.coerce.number().int().positive().optional().describe("How many blocks to collect (default: 1; capped at 64)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 32)")
    },
    async ({ blockType, count = 1, maxDistance = 32 }: { blockType: string; count?: number; maxDistance?: number }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blockData = mcData.blocksByName[blockType];

      if (!blockData) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const normalizedCount = Math.min(count, MAX_COLLECT_COUNT);
      const positions = bot.findBlocks({
        matching: blockData.id,
        maxDistance,
        count: normalizedCount
      });

      if (positions.length === 0) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      const blocks = positions
        .map((pos) => bot.blockAt(pos))
        .filter((block): block is NonNullable<typeof block> => block !== null);

      // Pre-navigate to the closest target using the same state-machine
      // recovery as move-to-position/move-in-direction. mineflayer-collectblock
      // pathfinds internally too, but with a single unguarded goto() call and
      // no stuck-recovery of its own - doing the approach ourselves first
      // means any obstacle gets the full replan/jump/tower treatment, and the
      // remaining distance collectBlock has to cover on its own is minimal.
      const closest = blocks.reduce((a, b) =>
        bot.entity.position.distanceTo(a.position) <= bot.entity.position.distanceTo(b.position) ? a : b
      );
      const approachGoal = new goals.GoalLookAtBlock(closest.position, bot.world);
      const approachResult = await gotoWithStuckRecovery(bot, approachGoal, { timeoutMs: 20000 });

      if (!approachResult.success) {
        return factory.createResponse(`Couldn't get close enough to ${blockType}: ${approachResult.message}`);
      }

      try {
        await bot.collectBlock.collect(blocks, { ignoreNoPath: true });
        return factory.createResponse(`Collected ${blocks.length} ${blockType}`);
      } catch (error) {
        return factory.createResponse(`Collection stopped early: ${(error as Error).message}`);
      }
    }
  );
}
