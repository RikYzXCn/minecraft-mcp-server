import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

export function registerStatusTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-bot-status",
    "Get the bot's current health, hunger, oxygen, and experience",
    {},
    async () => {
      const bot = getBot();
      const status = [
        `Health: ${bot.health}/20`,
        `Food: ${bot.food}/20 (saturation: ${bot.foodSaturation.toFixed(1)})`,
        `Oxygen: ${bot.oxygenLevel}/20`,
        `Experience: level ${bot.experience.level} (${bot.experience.points} points, ${(bot.experience.progress * 100).toFixed(0)}% to next level)`,
        `Sleeping: ${bot.isSleeping}`
      ].join('\n');

      return factory.createResponse(status);
    }
  );

  factory.registerTool(
    "get-world-info",
    "Get the current time of day, weather, dimension, and difficulty",
    {},
    async () => {
      const bot = getBot();
      const info = [
        `Time: ${bot.time.isDay ? 'Day' : 'Night'} (age: ${bot.time.age})`,
        `Weather: ${bot.isRaining ? 'Raining' : 'Clear'}`,
        `Dimension: ${bot.game.dimension}`,
        `Difficulty: ${bot.game.difficulty}`,
        `Game mode: ${bot.game.gameMode}`
      ].join('\n');

      return factory.createResponse(info);
    }
  );
}
