import type { Bot } from 'mineflayer';

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

/**
 * Wraps bot.pathfinder.goto() with stuck-detection and a one-shot recovery jump.
 *
 * mineflayer-pathfinder has no built-in way to detect "stuck bumping into an
 * obstacle it can't dig through or jump over" - it just hangs silently with no
 * error and no path_reset event (see PrismarineJS/mineflayer-pathfinder#222).
 * This polls the bot's actual position periodically; if it hasn't moved
 * meaningfully for a few checks in a row, it tries one escape jump, and if
 * that doesn't help, gives up with a clear, actionable message instead of
 * hanging indefinitely.
 */
export async function gotoWithStuckRecovery(
  bot: Bot,
  goal: GotoGoal,
  options: GotoWithRecoveryOptions = {}
): Promise<GotoResult> {
  const {
    timeoutMs = 20000,
    stuckCheckIntervalMs = 2000,
    stuckDistanceThreshold = 0.5,
    maxStuckChecks = 3
  } = options;

  return new Promise<GotoResult>((resolve) => {
    let settled = false;
    let lastPos = bot.entity.position.clone();
    let stuckCount = 0;
    let jumpAttempted = false;

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
      const currentPos = bot.entity.position;
      const moved = currentPos.distanceTo(lastPos);

      if (moved < stuckDistanceThreshold) {
        stuckCount++;

        if (stuckCount === 1 && !jumpAttempted) {
          jumpAttempted = true;
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 250);
        }

        if (stuckCount >= maxStuckChecks) {
          finish({
            success: false,
            reason: 'stuck',
            message: `Bot appears stuck near (${Math.floor(currentPos.x)}, ${Math.floor(currentPos.y)}, ${Math.floor(currentPos.z)}) - likely blocked by something it can't break or jump over`
          });
        }
      } else {
        stuckCount = 0;
        jumpAttempted = false;
      }

      lastPos = currentPos.clone();
    }, stuckCheckIntervalMs);

    const timeoutHandle = setTimeout(() => {
      finish({ success: false, reason: 'timeout', message: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const gotoPromise = bot.pathfinder.goto(goal)
      .then(() => finish({ success: true }))
      .catch((error: Error) => finish({ success: false, reason: 'error', message: error.message }));
  });
}
