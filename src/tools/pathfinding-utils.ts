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

// ---------------------------------------------------------------------------
// State machine states for the recovery escalation. Each "stuck" episode
// walks forward through these states one at a time; a successful move at any
// point exits immediately. This only governs what happens AFTER a normal
// bot.pathfinder.goto() attempt has already stalled - see runSingleAttempt.
// ---------------------------------------------------------------------------
type RecoveryState = 'REPLAN' | 'JUMP' | 'TOWER' | 'GIVE_UP';

function nextRecoveryState(state: RecoveryState): RecoveryState {
  switch (state) {
    case 'REPLAN': return 'JUMP';
    case 'JUMP': return 'TOWER';
    case 'TOWER': return 'GIVE_UP';
    case 'GIVE_UP': return 'GIVE_UP';
  }
}

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

/** JUMP state: hop forward. Clears most single-block-high obstacles. */
async function runJumpState(bot: Bot): Promise<void> {
  await clearHeadspace(bot);
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  bot.setControlState('jump', false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  bot.setControlState('forward', false);
}

/** TOWER state: fast-tower - jump at the apex, place a block underfoot. */
async function runTowerState(bot: Bot): Promise<void> {
  const scaffoldItem = findScaffoldItem(bot);
  if (!scaffoldItem) return;

  try {
    await bot.equip(scaffoldItem, 'hand');
    bot.setControlState('jump', true);
    await waitForJumpApex(bot);
    const belowFeet = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (belowFeet) {
      await bot.placeBlock(belowFeet, new Vec3(0, 1, 0)).catch(() => undefined);
    }
  } finally {
    bot.setControlState('jump', false);
  }
}

/**
 * Runs a single bot.pathfinder.goto() attempt (the PATHFIND state) and
 * resolves as soon as it either succeeds, errors, or appears stuck (no real
 * movement for maxStuckChecksPerAttempt consecutive checks).
 */
function runPathfindState(
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
 * Moves the bot to a goal with a state-machine-driven recovery escalation.
 *
 * Flow:
 *   PATHFIND  -- normal bot.pathfinder.goto(). A* already knows how to turn
 *                and route around obstacles; most calls finish here.
 *   (if stuck, no error/event fired by pathfinder itself - see
 *    PrismarineJS/mineflayer-pathfinder#222 - so we detect it ourselves by
 *    polling real position)
 *   REPLAN    -- stop and re-run PATHFIND. Gives A* a fresh chance to pick a
 *                different, possibly turning/detouring route.
 *   JUMP      -- still stuck at the same spot -> clear headspace, hop
 *                forward. Handles small obstacles no detour clears.
 *   TOWER     -- still stuck -> fast-tower (jump at apex + place a block
 *                underfoot). For obstacles that need climbing.
 *   GIVE_UP   -- all of the above failed -> return a clear reason instead of
 *                hanging silently forever.
 *
 * Note: this only handles the PATHFIND/REPLAN/JUMP/TOWER escalation itself.
 * Ground-Y correction for AI-supplied coordinates (snapping to real
 * standable terrain) happens one layer up, via findNearestStandableY in
 * coordinate-utils.ts, before a goal is ever built and passed in here - that
 * keeps this function goal-agnostic so it works equally well with GoalNear
 * (raw coordinates) or GoalLookAtBlock (a real block, e.g. for collect-block).
 *
 * bot.pathfinder.isMining()/isBuilding() are checked during PATHFIND so
 * legitimate multi-second actions (digging, placing scaffolding as part of
 * the planned path) are never mistaken for "stuck".
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
  let recoveryState: RecoveryState = 'REPLAN';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) {
      return { success: false, reason: 'timeout', message: `Timed out after ${timeoutMs}ms` };
    }

    const result = await runPathfindState(
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

    if (recoveryState === 'GIVE_UP') {
      return {
        success: false,
        reason: 'stuck',
        message: `Still stuck after re-planning, jumping, and towering - likely needs a different route or manual help (${result.message ?? ''})`
      };
    }

    if (recoveryState === 'JUMP') {
      await runJumpState(bot).catch(() => undefined);
    } else if (recoveryState === 'TOWER') {
      await runTowerState(bot).catch(() => undefined);
    }
    // recoveryState === 'REPLAN' -> no maneuver, just loop back to PATHFIND

    recoveryState = nextRecoveryState(recoveryState);
  }

  return { success: false, reason: 'stuck', message: 'Gave up after repeated attempts' };
}
