import { Vec3 } from 'vec3';

export function coerceCoordinates(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const coercedX = Number(x);
  const coercedY = Number(y);
  const coercedZ = Number(z);

  if (!Number.isFinite(coercedX) || !Number.isFinite(coercedY) || !Number.isFinite(coercedZ)) {
    throw new Error("x, y, and z must be valid numbers");
  }

  return { x: coercedX, y: coercedY, z: coercedZ };
}

interface GroundLookupBot {
  blockAt: (position: Vec3) => { boundingBox: string } | null;
}

/**
 * Given a target (x, hintY, z), searches up and down from hintY at that same
 * (x, z) column for the nearest position that's actually standable - i.e. an
 * empty space with solid ground directly beneath it. AI-supplied target
 * coordinates often have a plausible-looking but slightly wrong Y (e.g. it
 * doesn't know the exact terrain height), which sends the pathfinder toward
 * a point embedded in solid rock or floating in open air. Snapping to real
 * ground here fixes that without needing to dig or place anything.
 *
 * Returns the original (x, hintY, z) unchanged if no standable spot is found
 * within searchRange - better to attempt the original target than silently
 * substitute a wrong one.
 */
export function findNearestStandableY(
  bot: GroundLookupBot,
  x: number,
  z: number,
  hintY: number,
  searchRange = 8
): number {
  const flooredX = Math.floor(x);
  const flooredZ = Math.floor(z);

  for (let dy = 0; dy <= searchRange; dy++) {
    for (const candidateY of dy === 0 ? [hintY] : [hintY + dy, hintY - dy]) {
      const feet = bot.blockAt(new Vec3(flooredX, candidateY, flooredZ));
      const ground = bot.blockAt(new Vec3(flooredX, candidateY - 1, flooredZ));

      if (feet && ground && feet.boundingBox === 'empty' && ground.boundingBox === 'block') {
        return candidateY;
      }
    }
  }

  return hintY;
}
