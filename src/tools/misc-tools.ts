import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

export function registerMiscTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "elytra-fly",
    "Start gliding with an equipped elytra (bot must be airborne and have an elytra equipped in the chest slot)",
    {},
    async () => {
      const bot = getBot();
      try {
        await bot.elytraFly();
        return factory.createResponse("Elytra gliding started");
      } catch (error) {
        return factory.createResponse(`Couldn't start elytra flight: ${(error as Error).message}`);
      }
    }
  );

  factory.registerTool(
    "write-book",
    "Write pages into a book and quill held in the bot's inventory",
    {
      slot: z.coerce.number().int().describe("Inventory slot number of the book and quill"),
      pages: z.array(z.string()).min(1).describe("Array of page contents, one string per page")
    },
    async ({ slot, pages }: { slot: number; pages: string[] }) => {
      const bot = getBot();
      await bot.writeBook(slot, pages);
      return factory.createResponse(`Wrote ${pages.length} page(s) into the book in slot ${slot}`);
    }
  );

  factory.registerTool(
    "update-sign",
    "Write text on a nearby sign",
    {
      x: z.coerce.number().describe("X coordinate of the sign"),
      y: z.coerce.number().describe("Y coordinate of the sign"),
      z: z.coerce.number().describe("Z coordinate of the sign"),
      text: z.string().describe("Text to write on the sign"),
      back: z.boolean().optional().describe("Write on the back side of the sign (default: false)")
    },
    async ({ x, y, z, text, back = false }: { x: number; y: number; z: number; text: string; back?: boolean }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || !block.name.includes('sign')) {
        return factory.createResponse(`No sign found at (${x}, ${y}, ${z})`);
      }

      bot.updateSign(block, text, back);
      return factory.createResponse(`Updated sign at (${x}, ${y}, ${z})`);
    }
  );
}
