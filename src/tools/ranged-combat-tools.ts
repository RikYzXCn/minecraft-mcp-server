import { z } from "zod";
import type { Bot } from 'mineflayer';
import { Weapons } from 'minecrafthawkeye';
import { ToolFactory } from '../tool-factory.js';

type Entity = ReturnType<Bot['nearestEntity']>;

const WEAPON_NAMES = Object.values(Weapons) as string[];

export function registerRangedCombatTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "start-bow-autoaim",
    "Find the nearest entity of a given type and continuously auto-aim and fire a ranged weapon (bow, crossbow, trident, etc.) at it until stopped or the target dies/flees",
    {
      type: z.string().describe("Type or name of entity to target (e.g. 'zombie', 'skeleton', a player's username)"),
      weapon: z.enum(WEAPON_NAMES as [string, ...string[]]).optional().describe("Ranged weapon to use (default: 'bow')"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type, weapon = 'bow', maxDistance = 16 }: { type: string; weapon?: string; maxDistance?: number }) => {
      const bot = getBot();

      const entityFilter = (entity: NonNullable<Entity>) => {
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

      const weaponItem = bot.inventory.items().find((item) => item.name === weapon);
      if (!weaponItem) {
        return factory.createResponse(`No ${weapon} found in inventory`);
      }

      await bot.equip(weaponItem, 'hand');
      bot.hawkEye.autoAttack(target, weapon as Weapons);

      const targetName = target.name || (target as { username?: string }).username || target.type;
      return factory.createResponse(`Auto-aiming ${weapon} at ${targetName}. Use stop-bow-autoaim to cancel.`);
    }
  );

  factory.registerTool(
    "stop-bow-autoaim",
    "Stop any currently active bow/ranged-weapon auto-aim",
    {},
    async () => {
      const bot = getBot();
      bot.hawkEye.stop();
      return factory.createResponse("Stopped auto-aiming");
    }
  );
}
