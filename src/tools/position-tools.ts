import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

type Direction = 'forward' | 'back' | 'left' | 'right';

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      range: z.coerce.number().finite().optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)")
    },
    async ({ x, y, z, range = 1, timeoutMs }: { x: number; y: number; z: number; range?: number; timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const goal = new goals.GoalNear(x, y, z, range);
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let timeoutPromise: Promise<never> | null = null;
      let timedOut = false;

      if (timeoutMs !== undefined) {
        timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Move timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
      }

      const gotoPromise = bot.pathfinder.goto(goal);

      try {
        if (timeoutPromise) {
          await Promise.race([gotoPromise, timeoutPromise]);
        } else {
          await gotoPromise;
        }
        return factory.createResponse(`Successfully moved to position near (${x}, ${y}, ${z})`);
      } catch (error) {
        if (timedOut) {
          throw new Error(`Move timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (timedOut) {
          bot.pathfinder.stop();
          gotoPromise.catch(() => {});
        }
      }
    }
  );

  factory.registerTool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      await bot.lookAt(new Vec3(x, y, z), true);
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump",
    {},
    async () => {
      const bot = getBot();
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      return factory.createResponse("Successfully jumped");
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot a short distance in a direction relative to where it's currently facing (forward/back/left/right). Automatically jumps over obstacles and routes around obstructions using pathfinding.",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move, relative to the bot's current facing direction"),
      distance: z.coerce.number().positive().optional().describe("Distance to move in blocks (default: 5)"),
      timeoutMs: z.coerce.number().int().positive().optional().describe("Timeout in ms before giving up (default: 10000)")
    },
    async ({ direction, distance = 5, timeoutMs = 10000 }: { direction: Direction; distance?: number; timeoutMs?: number }) => {
      const bot = getBot();
      const yaw = bot.entity.yaw;

      const angleOffsets: Record<Direction, number> = {
        forward: 0,
        back: Math.PI,
        left: Math.PI / 2,
        right: -Math.PI / 2
      };

      const angle = yaw + angleOffsets[direction];
      const dx = -Math.sin(angle) * distance;
      const dz = Math.cos(angle) * distance;

      const start = bot.entity.position;
      const target = start.offset(dx, 0, dz);
      const goal = new goals.GoalNear(target.x, target.y, target.z, 1);

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const gotoPromise = bot.pathfinder.goto(goal);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Move timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        await Promise.race([gotoPromise, timeoutPromise]);
        return factory.createResponse(`Moved ${direction} (~${distance} blocks)`);
      } catch (error) {
        if (timedOut) {
          return factory.createResponse(`Couldn't fully move ${direction}: timed out after ${timeoutMs}ms (may be blocked or the path is too complex)`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (timedOut) {
          bot.pathfinder.stop();
          gotoPromise.catch(() => undefined);
        }
      }
    }
  );
}
