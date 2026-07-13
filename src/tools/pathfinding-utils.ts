import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

type GotoGoal = Parameters<Bot['pathfinder']['goto']>[0];

export interface GotoWithRecoveryOptions {
  timeoutMs?: number;
  stuckCheckIntervalMs?: number;
  stuckDistanceThreshold?: number;
  maxStuckChecks?: number;
}

export interface GotoResult {
  success: boolean;
  reason?: 'timeout' | 'stuck' | 'error';
  message?: string;
}

const SCAFFOLD_ITEM_NAMES = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone'];

/**
 * Waits until the bot's vertical velocity is near zero - the apex of a jump.
 * Real players (and this technique) place a block underneath their feet at
 * this exact moment to "fast tower" upward reliably, since the bot is
 * momentarily stationary vertically.
 */
function waitForJumpApex(bot: Bot, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      bot.removeListener('physicsTick', check);
      clearTimeout(timeoutHandle);
      resolve();
    };

    const check = (): void => {
      if (Math.abs(bot.entity.velocity.y) < 0.02) {
        finish();
      }
    };

    const timeoutHandle = setTimeout(finish, timeoutMs);
    bot.on('physicsTick', check);
  });
}

/**
 * Checks the blocks directly above the bot's head and digs any that are in
 * the way. A blocked ceiling is a common reason a jump silently fails to gain
 * height, so this clears the way before attempting to jump or tower up.
 */
async function clearHeadspace(bot: Bot): Promise<void> {
  for (const yOffset of [1, 2]) {
    const pos = bot.entity.position.offset(0, yOffset, 0);
    const block = bot.blockAt(pos);

    if (block && block.name !== 'air' && block.diggable) {
      try {
        const toolBot = bot as unknown as { tool?: { equipForBlock: (b: typeof block, opts: { requireHarvest: boolean }) => Promise<void> } };
        if (toolBot.tool) {
          await toolBot.tool.equipForBlock(block, { requireHarvest: false }).catch(() => undefined);
        }
        await bot.dig(block);
      } catch {
        // If it can't be cleared (e.g. no suitable tool), let later steps fail naturally
      }
    }
  }
}

function findScaffoldItem(bot: Bot) {
  const items = bot.inventory.items();
  for (const name of SCAFFOLD_ITEM_NAMES) {
    const item = items.find((i) => i.name === name);
    if (item) return item;
  }
  return null;
}

/**
 * Attempt 1: jump forward for a short burst. Clears most single-block-high
 * obstacles (stairs, fence gates, slabs) the same way a player would just
 * hop over them while walking.
 */
async function tryJumpForward(bot: Bot): Promise<void> {
  await clearHeadspace(bot);
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  bot.setControlState('jump', false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  bot.setControlState('forward', false);
}

/**
 * Attempt 2 (escalation): "fast tower" - jump, wait for the exact apex of the
 * jump, then place a scaffold block directly beneath the bot's feet. This is
 * how real players climb straight up quickly, and is used here when simply
 * jumping forward wasn't enough (e.g. the bot needs to climb rather than
 * step over).
 */
async function tryFastTower(bot: Bot): Promise<boolean> {
  const scaffoldItem = findScaffoldItem(bot);
  if (!scaffoldItem) return false;

  try {
    await bot.equip(scaffoldItem, 'hand');
    bot.setControlState('jump', true);
    await waitForJumpApex(bot);
    const belowFeet = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (belowFeet) {
      await bot.placeBlock(belowFeet, new Vec3(0, 1, 0)).catch(() => undefined);
    }
    return true;
  } finally {
    bot.setControlState('jump', false);
  }
}

/**
 * Wraps bot.pathfinder.goto() with active un-stuck recovery.
 *
 * mineflayer-pathfinder has no built-in way to recover when it silently
 * stops in front of an obstacle it can't dig through or jump over on its own
 * (see PrismarineJS/mineflayer-pathfinder#222 - no error, no path_reset
 * event, it just stops). Rather than only detecting this and giving up, this
 * escalates through the same techniques a real player would use:
 *   1. Clear headspace + jump forward (handles most 1-block obstacles)
 *   2. Fast-tower: jump at the apex, place a block underfoot (handles cases
 *      that need climbing rather than stepping over)
 * Only if both fail repeatedly does it give up and report a clear reason,
 * instead of hanging silently forever.
 *
 * bot.pathfinder.isMining()/isBuilding() are checked before any of this so
 * legitimate multi-second actions (digging through a wall, placing
 * scaffolding as part of the planned path) are never mistaken for "stuck".
 */
export async function gotoWithStuckRecovery(
  bot: Bot,
  goal: GotoGoal,
  options: GotoWithRecoveryOptions = {}
): Promise<GotoResult> {
  const {
    timeoutMs = 30000,
    stuckCheckIntervalMs = 3000,
    stuckDistanceThreshold = 0.5,
    maxStuckChecks = 4
  } = options;

  return new Promise<GotoResult>((resolve) => {
    let settled = false;
    let lastPos = bot.entity.position.clone();
    let stuckCount = 0;
    let recoveryInProgress = false;

    const finish = (result: GotoResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(checkInterval);
      clearTimeout(timeoutHandle);
      bot.pathfinder.stop();
      gotoPromise.catch(() => undefined);
      resolve(result);
    };

    const checkInterval = setInterval(() => {
      if (recoveryInProgress) return;

      const legitimatelyBusy = bot.pathfinder.isMining() || bot.pathfinder.isBuilding();
      if (legitimatelyBusy) {
        stuckCount = 0;
        lastPos = bot.entity.position.clone();
        return;
      }

      const currentPos = bot.entity.position;
      const moved = currentPos.distanceTo(lastPos);

      if (moved >= stuckDistanceThreshold) {
        stuckCount = 0;
        lastPos = currentPos.clone();
        return;
      }

      stuckCount++;
      lastPos = currentPos.clone();

      if (stuckCount >= maxStuckChecks) {
        finish({
          success: false,
          reason: 'stuck',
          message: `Bot appears stuck near (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)}) after trying to jump over and tower past the obstacle - it may need a different route or manual help`
        });
        return;
      }

      recoveryInProgress = true;
      const recovery = stuckCount === 1
        ? tryJumpForward(bot)
        : tryFastTower(bot).then(() => undefined);

      recovery
        .catch(() => undefined)
        .finally(() => {
          recoveryInProgress = false;
        });
    }, stuckCheckIntervalMs);

    const timeoutHandle = setTimeout(() => {
      finish({ success: false, reason: 'timeout', message: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const gotoPromise = bot.pathfinder.goto(goal)
      .then(() => finish({ success: true }))
      .catch((error: Error) => finish({ success: false, reason: 'error', message: error.message }));
  });
}
