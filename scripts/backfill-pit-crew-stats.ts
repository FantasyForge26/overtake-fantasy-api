/**
 * backfill-pit-crew-stats.ts
 *
 * Computes and writes fastestStopCount + avgPitStopTime to each 2026
 * pit crew Asset doc, sourced from OpenF1 /pit data for all processed rounds.
 *
 * Rounds processed: R1 Australia (1279), R2 China (1280), R3 Japan (1281),
 *                   R6 Miami (1284)
 *
 * Valid stops: pit_duration between 1.5s and 60s (filters bogus/noise entries).
 * Same lower bound used: anything under 1.5s is a data glitch.
 * Upper bound 60s filters drive-through penalties and long tyre change issues
 * that OpenF1 sometimes logs as pit stops.
 *
 * Usage:
 *   DRY_RUN=1 npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-pit-crew-stats.ts
 *
 *   # live:
 *   npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-pit-crew-stats.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset } from '../lib/models';
import { fetchSessions, fetchPitStops } from '../lib/scoring/openf1';

const DRY_RUN = process.env.DRY_RUN === '1';

const ROUNDS = [
  { round: 1, meetingKey: 1279, name: 'Australia'  },
  { round: 2, meetingKey: 1280, name: 'China'       },
  { round: 3, meetingKey: 1281, name: 'Japan'       },
  { round: 6, meetingKey: 1284, name: 'Miami'       },
];

// Valid pit stop duration range — matches the filter in lib/scoring/openf1.ts
const MIN_STOP_S = 1.5;
const MAX_STOP_S = 60;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`=== backfill-pit-crew-stats ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  await connectDB();

  // carNumber → all valid stop durations across all processed rounds
  const allStopsByCarNum = new Map<number, number[]>();
  // carNumber → count of rounds where this car had the overall fastest stop
  const fastestWinsByCarNum = new Map<number, number>();

  for (const { round, meetingKey, name } of ROUNDS) {
    console.log(`\nR${round} ${name} (meetingKey=${meetingKey})`);

    // Find the race session key
    let sessions: any[];
    try {
      sessions = await fetchSessions(meetingKey);
    } catch (err: any) {
      console.error(`  ERROR fetching sessions: ${err.message}`);
      await sleep(3000);
      continue;
    }

    const raceSession = sessions.find((s: any) => s.session_name === 'Race');
    if (!raceSession) {
      console.warn(`  No Race session found — skipping`);
      await sleep(2000);
      continue;
    }

    const sessionKey: number = raceSession.session_key;
    console.log(`  Race session_key=${sessionKey}`);

    // Fetch pit stops
    let rawStops: any[];
    try {
      rawStops = await fetchPitStops(sessionKey);
    } catch (err: any) {
      console.error(`  ERROR fetching pit stops: ${err.message}`);
      await sleep(3000);
      continue;
    }

    // Filter valid stops
    const validStops = rawStops.filter(
      (p: any) => p.pit_duration != null && p.pit_duration >= MIN_STOP_S && p.pit_duration <= MAX_STOP_S,
    );
    console.log(`  Raw stops: ${rawStops.length}  Valid: ${validStops.length}`);

    // Group by driver_number → list of stop durations
    const stopsByCarNum = new Map<number, number[]>();
    for (const p of validStops) {
      const carNum: number = p.driver_number;
      const dur: number = Math.round(p.pit_duration * 100) / 100;
      const arr = stopsByCarNum.get(carNum) ?? [];
      arr.push(dur);
      stopsByCarNum.set(carNum, arr);
    }

    // Accumulate into season-level map
    for (const [carNum, stops] of stopsByCarNum) {
      const existing = allStopsByCarNum.get(carNum) ?? [];
      allStopsByCarNum.set(carNum, existing.concat(stops));
    }

    // Find overall fastest single stop this race
    let overallFastest = Infinity;
    for (const stops of stopsByCarNum.values()) {
      const fastest = Math.min(...stops);
      if (fastest < overallFastest) overallFastest = fastest;
    }

    // Which cars matched the fastest stop?
    if (overallFastest < Infinity) {
      for (const [carNum, stops] of stopsByCarNum) {
        if (Math.min(...stops) === overallFastest) {
          fastestWinsByCarNum.set(carNum, (fastestWinsByCarNum.get(carNum) ?? 0) + 1);
          console.log(`  Overall fastest: car #${carNum} at ${overallFastest}s`);
        }
      }
    }

    await sleep(2000); // be polite to OpenF1
  }

  // Load all 2026 pit crew assets
  const pitCrewAssets = await Asset.find({ season: 2026, assetType: 'pitCrew', isActive: true }).lean() as any[];
  console.log(`\n\nFound ${pitCrewAssets.length} 2026 active pit crew assets\n`);

  for (const asset of pitCrewAssets) {
    const carNum: number = asset.carNumber;
    if (!carNum) {
      console.warn(`  SKIP ${asset.slug} — no carNumber`);
      continue;
    }

    const stops = allStopsByCarNum.get(carNum) ?? [];
    const fastestStopCount = fastestWinsByCarNum.get(carNum) ?? 0;
    const avgPitStopTime = stops.length > 0
      ? Math.round((stops.reduce((a, b) => a + b, 0) / stops.length) * 100) / 100
      : null;

    console.log(
      `  ${asset.slug.padEnd(30)}  carNum=${carNum}  stops=${stops.length}` +
      `  avg=${avgPitStopTime ?? '—'}s  fastestWins=${fastestStopCount}`,
    );

    if (!DRY_RUN) {
      await Asset.updateOne(
        { _id: asset._id },
        { $set: { fastestStopCount, avgPitStopTime } },
      );
    }
  }

  console.log('\n=== Done ===');
  if (DRY_RUN) console.log('DRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
