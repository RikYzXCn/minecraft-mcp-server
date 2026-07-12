import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

const CHEST_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel']);

export function registerContainerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "open-chest",
    "List the contents of a nearby chest without taking anything",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }: { x: number; y: number; z: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || !CHEST_BLOCKS.has(block.name)) {
        return factory.createResponse(`No chest found at (${x}, ${y}, ${z})`);
      }

      const chest = await bot.openChest(block);
      try {
        const items = chest.containerItems();
        if (items.length === 0) {
          return factory.createResponse(`Chest at (${x}, ${y}, ${z}) is empty`);
        }
        const list = items.map((item) => `- ${item.name} (x${item.count})`).join('\n');
        return factory.createResponse(`Chest at (${x}, ${y}, ${z}) contains:\n${list}`);
      } finally {
        chest.close();
      }
    }
  );

  factory.registerTool(
    "chest-deposit",
    "Deposit an item from the bot's inventory into a nearby chest",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      itemName: z.string().describe("Name of the item to deposit"),
      count: z.coerce.number().int().positive().optional().describe("Amount to deposit (default: entire stack)")
    },
    async ({ x, y, z, itemName, count }: { x: number; y: number; z: number; itemName: string; count?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || !CHEST_BLOCKS.has(block.name)) {
        return factory.createResponse(`No chest found at (${x}, ${y}, ${z})`);
      }

      const item = bot.inventory.items().find((item) => item.name.includes(itemName.toLowerCase()));
      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      const resolvedCount = count ? Math.min(count, item.count) : item.count;

      const chest = await bot.openChest(block);
      try {
        await chest.deposit(item.type, item.metadata ?? null, resolvedCount);
        return factory.createResponse(`Deposited ${resolvedCount} ${item.name} into chest at (${x}, ${y}, ${z})`);
      } finally {
        chest.close();
      }
    }
  );

  factory.registerTool(
    "chest-withdraw",
    "Withdraw an item from a nearby chest into the bot's inventory",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      itemName: z.string().describe("Name of the item to withdraw"),
      count: z.coerce.number().int().positive().optional().describe("Amount to withdraw (default: 1)")
    },
    async ({ x, y, z, itemName, count = 1 }: { x: number; y: number; z: number; itemName: string; count?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || !CHEST_BLOCKS.has(block.name)) {
        return factory.createResponse(`No chest found at (${x}, ${y}, ${z})`);
      }

      const mcData = minecraftData(bot.version);
      const itemData = mcData.itemsByName[itemName.toLowerCase()];
      if (!itemData) {
        return factory.createResponse(`Unknown item type: ${itemName}`);
      }

      const chest = await bot.openChest(block);
      try {
        const available = chest.containerItems().find((item) => item.type === itemData.id);
        if (!available) {
          return factory.createResponse(`Chest at (${x}, ${y}, ${z}) doesn't contain any ${itemName}`);
        }

        const resolvedCount = Math.min(count, available.count);
        await chest.withdraw(itemData.id, null, resolvedCount);
        return factory.createResponse(`Withdrew ${resolvedCount} ${itemName} from chest at (${x}, ${y}, ${z})`);
      } finally {
        chest.close();
      }
    }
  );

  factory.registerTool(
    "open-dispenser",
    "Withdraw an item from a nearby dispenser into the bot's inventory",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      itemName: z.string().describe("Name of the item to withdraw"),
      count: z.coerce.number().int().positive().optional().describe("Amount to withdraw (default: 1)")
    },
    async ({ x, y, z, itemName, count = 1 }: { x: number; y: number; z: number; itemName: string; count?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || block.name !== 'dispenser') {
        return factory.createResponse(`No dispenser found at (${x}, ${y}, ${z})`);
      }

      const mcData = minecraftData(bot.version);
      const itemData = mcData.itemsByName[itemName.toLowerCase()];
      if (!itemData) {
        return factory.createResponse(`Unknown item type: ${itemName}`);
      }

      const dispenser = await bot.openDispenser(block);
      try {
        const available = dispenser.containerItems().find((item) => item.type === itemData.id);
        if (!available) {
          return factory.createResponse(`Dispenser at (${x}, ${y}, ${z}) doesn't contain any ${itemName}`);
        }

        const resolvedCount = Math.min(count, available.count);
        await dispenser.withdraw(itemData.id, null, resolvedCount);
        return factory.createResponse(`Withdrew ${resolvedCount} ${itemName} from dispenser at (${x}, ${y}, ${z})`);
      } finally {
        dispenser.close();
      }
    }
  );

  factory.registerTool(
    "enchant-item",
    "Put a held item on a nearby enchantment table and apply an available enchantment",
    {
      x: z.coerce.number().describe("X coordinate of the enchantment table"),
      y: z.coerce.number().describe("Y coordinate of the enchantment table"),
      z: z.coerce.number().describe("Z coordinate of the enchantment table"),
      itemName: z.string().describe("Name of the item in inventory to enchant"),
      choice: z.coerce.number().int().min(0).max(2).optional().describe("Which of the 3 enchantment options to pick (0, 1, or 2). Default: 0")
    },
    async ({ x, y, z, itemName, choice = 0 }: { x: number; y: number; z: number; itemName: string; choice?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || block.name !== 'enchanting_table') {
        return factory.createResponse(`No enchantment table found at (${x}, ${y}, ${z})`);
      }

      const item = bot.inventory.items().find((item) => item.name.includes(itemName.toLowerCase()));
      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      const lapis = bot.inventory.items().find((item) => item.name === 'lapis_lazuli');
      if (!lapis) {
        return factory.createResponse("No lapis lazuli in inventory (required to enchant)");
      }

      const table = await bot.openEnchantmentTable(block);
      try {
        await table.putTargetItem(item);
        await table.putLapis(lapis);

        if (!table.enchantments || table.enchantments.length === 0) {
          return factory.createResponse("No enchantment options available for this item");
        }

        const enchanted = await table.enchant(choice);
        return factory.createResponse(`Enchanted ${enchanted.name} using option ${choice}`);
      } finally {
        table.close();
      }
    }
  );

  factory.registerTool(
    "anvil-rename-item",
    "Rename a held item using a nearby anvil",
    {
      x: z.coerce.number().describe("X coordinate of the anvil"),
      y: z.coerce.number().describe("Y coordinate of the anvil"),
      z: z.coerce.number().describe("Z coordinate of the anvil"),
      itemName: z.string().describe("Name of the item in inventory to rename"),
      newName: z.string().describe("New name to give the item")
    },
    async ({ x, y, z, itemName, newName }: { x: number; y: number; z: number; itemName: string; newName: string }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));

      if (!block || block.name !== 'anvil') {
        return factory.createResponse(`No anvil found at (${x}, ${y}, ${z})`);
      }

      const item = bot.inventory.items().find((item) => item.name.includes(itemName.toLowerCase()));
      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      const anvil = await bot.openAnvil(block);
      await anvil.rename(item, newName);
      return factory.createResponse(`Renamed ${item.name} to "${newName}"`);
    }
  );
}
