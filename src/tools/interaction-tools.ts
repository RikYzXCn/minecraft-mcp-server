import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

export function registerInteractionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "activate-block",
    "Right-click/use a block (e.g. open a door, pull a lever, press a button)",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }: { x: number; y: number; z: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block || block.name === 'air') {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }

      if (!bot.canSeeBlock(block) || bot.entity.position.distanceTo(blockPos) > 4) {
        const goal = new goals.GoalNear(x, y, z, 2);
        await bot.pathfinder.goto(goal);
      }

      await bot.lookAt(blockPos, true);
      await bot.activateBlock(block);
      return factory.createResponse(`Activated ${block.name} at (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "activate-entity",
    "Right-click/interact with a nearby entity (e.g. feed an animal, use a boat)",
    {
      type: z.string().describe("Type or name of entity to interact with"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type, maxDistance = 16 }: { type: string; maxDistance?: number }) => {
      const bot = getBot();
      const target = bot.nearestEntity((entity) => {
        const username = (entity as { username?: string }).username;
        return Boolean(
          (entity.name && entity.name.includes(type.toLowerCase())) ||
          (username && username.toLowerCase().includes(type.toLowerCase()))
        );
      });

      if (!target || bot.entity.position.distanceTo(target.position) > maxDistance) {
        return factory.createResponse(`No ${type} found within ${maxDistance} blocks`);
      }

      if (bot.entity.position.distanceTo(target.position) > 3) {
        const goal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2);
        await bot.pathfinder.goto(goal);
      }

      await bot.lookAt(target.position, true);
      await bot.activateEntity(target);

      const targetName = target.name || (target as { username?: string }).username || target.type;
      return factory.createResponse(`Activated ${targetName}`);
    }
  );

  factory.registerTool(
    "mount-entity",
    "Mount a nearby rideable entity (e.g. a horse, boat, or minecart)",
    {
      type: z.string().describe("Type or name of entity to mount"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type, maxDistance = 16 }: { type: string; maxDistance?: number }) => {
      const bot = getBot();
      const target = bot.nearestEntity((entity) => Boolean(entity.name && entity.name.includes(type.toLowerCase())));

      if (!target || bot.entity.position.distanceTo(target.position) > maxDistance) {
        return factory.createResponse(`No ${type} found within ${maxDistance} blocks`);
      }

      if (bot.entity.position.distanceTo(target.position) > 2) {
        const goal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
        await bot.pathfinder.goto(goal);
      }

      bot.mount(target);
      return factory.createResponse(`Mounted ${target.name}`);
    }
  );

  factory.registerTool(
    "dismount-entity",
    "Dismount from whatever the bot is currently riding",
    {},
    async () => {
      const bot = getBot();

      if (!bot.entity.vehicle) {
        return factory.createResponse("Bot is not currently mounted on anything");
      }

      bot.dismount();
      return factory.createResponse("Dismounted");
    }
  );

  factory.registerTool(
    "steer-vehicle",
    "Steer the vehicle the bot is currently riding (e.g. a boat or minecart)",
    {
      left: z.coerce.number().min(-1).max(1).describe("Left/right steering input, from -1 (left) to 1 (right)"),
      forward: z.coerce.number().min(-1).max(1).describe("Forward/back steering input, from -1 (back) to 1 (forward)")
    },
    async ({ left, forward }: { left: number; forward: number }) => {
      const bot = getBot();

      if (!bot.entity.vehicle) {
        return factory.createResponse("Bot is not currently mounted on a vehicle");
      }

      bot.moveVehicle(left, forward);
      return factory.createResponse(`Steering vehicle (left: ${left}, forward: ${forward})`);
    }
  );
}
