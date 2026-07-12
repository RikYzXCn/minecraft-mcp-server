import { z } from "zod";
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';

type Entity = ReturnType<Bot['nearestEntity']>;

export function registerCombatTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "attack-entity",
    "Find and attack the nearest entity of a specific type (e.g. a mob or player)",
    {
      type: z.string().describe("Type or name of entity to attack (e.g. 'zombie', 'skeleton', a player's username)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type, maxDistance = 16 }: { type: string; maxDistance?: number }) => {
      const bot = getBot();

      const entityFilter = (entity: NonNullable<Entity>) => {
        if (entity === bot.entity) return false;
        const username = (entity as { username?: string }).username;
        return Boolean(
          (entity.name && entity.name.includes(type.toLowerCase())) ||
          (username && username.toLowerCase().includes(type.toLowerCase()))
        );
      };

      const target = bot.nearestEntity(entityFilter);

      if (!target || bot.entity.position.distanceTo(target.position) > maxDistance) {
        return factory.createResponse(`No ${type} found within ${maxDistance} blocks`);
      }

      if (bot.entity.position.distanceTo(target.position) > 3) {
        const goal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2);
        await bot.pathfinder.goto(goal);
      }

      await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.75 : 1, 0), true);
      bot.attack(target);

      const targetName = target.name || (target as { username?: string }).username || target.type;
      return factory.createResponse(`Attacked ${targetName} at (${Math.floor(target.position.x)}, ${Math.floor(target.position.y)}, ${Math.floor(target.position.z)})`);
    }
  );
}
