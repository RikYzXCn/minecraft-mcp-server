import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

type GotoGoal = Parameters<Bot['pathfinder']['goto']>[0];

export interface GotoWithRecoveryOptions {
  timeoutMs?: number;
  stuckCheckIntervalMs?: number;
  stuckDistanceThreshold?: number;
  maxStuckChecksPerAttempt?: number;
  maxAttempts?: number;
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
 * Jump forward for a short burst. Clears most single-block-high obstacles
 * (stairs, fence gates, slabs) the same way a player would just hop over
 * them while walking - used only when re-planning the path didn't help.
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
 * "Fast tower": jump, wait for the exact apex of the jump, then place a
 * scaffold block directly beneath the bot's feet. This is how real players
 * climb straight up quickly - used as a last resort when the obstacle needs
 * climbing rather than stepping over or going around.
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
 * Runs a single bot.pathfinder.goto() attempt and resolves as soon as it
 * either succeeds, errors, or appears stuck (no real movement for
 * maxStuckChecksPerAttempt consecutive checks). Does NOT attempt any
 * recovery itself - that's the caller's job between attempts.
 */
function runSingleAttempt(
  bot: Bot,
  goal: GotoGoal,
  attemptTimeoutMs: number,
  stuckCheckIntervalMs: number,
  stuckDistanceThreshold: number,
  maxStuckChecksPerAttempt: number
): Promise<GotoResult> {
  return new Promise<GotoResult>((resolve) => {
    let settled = false;
    let lastPos = bot.entity.position.clone();
    let stuckCount = 0;

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

      if (stuckCount >= maxStuckChecksPerAttempt) {
        finish({
          success: false,
          reason: 'stuck',
          message: `stuck near (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)})`
        });
      }
    }, stuckCheckIntervalMs);

    const timeoutHandle = setTimeout(() => {
      finish({ success: false, reason: 'timeout', message: `timed out after ${attemptTimeoutMs}ms` });
    }, attemptTimeoutMs);

    const gotoPromise = bot.pathfinder.goto(goal)
      .then(() => finish({ success: true }))
      .catch((error: Error) => finish({ success: false, reason: 'error', message: error.message }));
  });
}

/**
 * Wraps bot.pathfinder.goto() with escalating recovery for when it silently
 * stops in front of an obstacle instead of erroring (see
 * PrismarineJS/mineflayer-pathfinder#222).
 *
 * A* itself already knows how to turn and route around obstacles - it just
 * needs a chance to *replan*. So the escalation order is:
 *   1. Re-plan (stop + goto again) - lets A* naturally pick a different,
 *      possibly turning/detouring route if one exists. This is tried FIRST,
 *      before any physical maneuver, since going around is usually better
 *      than climbing over.
 *   2. Jump forward - handles small obstacles a fresh plan wouldn't route
 *      around (e.g. a single step where going around is pointless).
 *   3. Fast-tower (jump + place a block underfoot) - for obstacles that need
 *      climbing rather than stepping over or detouring around.
 * Only if all of these fail repeatedly does it give up with a clear reason.
 *
 * bot.pathfinder.isMining()/isBuilding() are checked so legitimate
 * multi-second actions (digging, placing scaffolding as part of the planned
 * path) are never mistaken for "stuck".
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
    maxStuckChecksPerAttempt = 2,
    maxAttempts = 4
  } = options;

  const overallDeadline = Date.now() + timeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) {
      return { success: false, reason: 'timeout', message: `Timed out after ${timeoutMs}ms` };
    }

    const result = await runSingleAttempt(
      bot,
      goal,
      remaining,
      stuckCheckIntervalMs,
      stuckDistanceThreshold,
      maxStuckChecksPerAttempt
    );

    if (result.success || result.reason !== 'stuck') {
      return result;
    }

    // Stuck - escalate recovery before the next attempt re-plans the path.
    // Attempt 1 -> just replan (no maneuver). Attempt 2 -> jump forward.
    // Attempt 3+ -> fast-tower.
    if (attempt === 2) {
      await tryJumpForward(bot).catch(() => undefined);
    } else if (attempt >= 3) {
      await tryFastTower(bot).catch(() => undefined);
    }

    if (attempt === maxAttempts) {
      return {
        success: false,
        reason: 'stuck',
        message: `Still stuck after re-planning, jumping, and towering - likely needs a different route or manual help (${result.message ?? ''})`
      };
    }
  }

  return { success: false, reason: 'stuck', message: 'Gave up after repeated attempts' };
}
