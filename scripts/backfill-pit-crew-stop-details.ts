/**
 * backfill-pit-crew-stop-details.ts
 *
 * Writes per-round stop detail fields to RaceCalendar.pitCrewResults entries:
 *   stopCount, avgStopTime, fastestStop, wasOverallFastest
 *
 * Sourced from OpenF1 /pit data for all processed rounds.
 * Rounds processed: R1 Australia (1279), R2 China (1280), R3 Japan (1281), R6 Miami (1284)
 *
 * Valid stops: pit_duration between 1.5s and 60s.
 * Idempotent — re-runs overwrite the same values.
 *
 * Usage:
 *   DRY_RUN=1 npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-pit-crew-stop-details.ts
 *
 *   # live:
 *   npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-pit-crew-stop-details.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, RaceCalendar } from '../lib/models';
import { fetchSessions, fetchPitStops } from '../lib/scoring/openf1';

const DRY_RUN = process.env.DRY_RUN === '1';

const ROUNDS = [
  { round: 1, meetingKey: 1279, name: 'Australia' },
  { round: 2, meetingKey: 1280, name: 'China'     },
  { round: 3, meetingKey: 1281, name: 'Japan'     },
  { round: 6, meetingKey: 1284, name: 'Miami'     },
];

const MIN_STOP_S = 1.5;
const MAX_STOP_S = 60;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

async function main() {
  console.log(`=== backfill-pit-crew-stop-details ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  await connectDB();

  // Load all 2026 pit crew assets once — we need carNumber → pitCrewSlug
  const pitCrewAssets = await Asset.find({ season: 2026, assetType: 'pitCrew', isActive: true }).lean() as any[];
  console.log(`Loaded ${pitCrewAssets.length} active 2026 pit crew assets\n`);

  // Build carNumber → asset map
  const assetByCarNum = new Map<number, any>();
  for (const asset of pitCrewAssets) {
    if (asset.carNumber) assetByCarNum.set(asset.carNumber, asset);
  }

  for (const { round, meetingKey, name } of ROUNDS) {
    console.log(`\nR${round} ${name} (meetingKey=${meetingKey})`);

    // Find race session key
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

    const validStops = rawStops.filter(
      (p: any) => p.pit_duration != null && p.pit_duration >= MIN_STOP_S && p.pit_duration <= MAX_STOP_S,
    );
    console.log(`  Raw stops: ${rawStops.length}  Valid: ${validStops.length}`);

    // Group by driver_number → list of stop durations
    const stopsByCarNum = new Map<number, number[]>();
    for (const p of validStops) {
      const carNum: number = p.driver_number;
      const dur = round2(p.pit_duration);
      const arr = stopsByCarNum.get(carNum) ?? [];
      arr.push(dur);
      stopsByCarNum.set(carNum, arr);
    }

    // Overall fastest single stop this race
    let overallFastest = Infinity;
    for (const stops of stopsByCarNum.values()) {
      const fastest = Math.min(...stops);
      if (fastest < overallFastest) overallFastest = fastest;
    }
    if (overallFastest < Infinity) {
      console.log(`  Overall fastest stop: ${overallFastest}s`);
    }

    // Load the RaceCalendar doc for this round
    const cal = await RaceCalendar.findOne({ season: 2026, round });
    if (!cal) {
      console.warn(`  No RaceCalendar doc for round ${round} — skipping`);
      await sleep(2000);
      continue;
    }

    const pitCrewResults: any[] = (cal as any).pitCrewResults ?? [];
    let updatedCount = 0;

    for (const entry of pitCrewResults) {
      const slug: string = entry.pitCrewSlug;
      const asset = pitCrewAssets.find((a: any) => a.slug === slug);
      if (!asset) {
        console.warn(`  SKIP ${slug} — no matching asset`);
        continue;
      }

      const carNum: number = asset.carNumber;
      if (!carNum) {
        console.warn(`  SKIP ${slug} — no carNumber`);
        continue;
      }

      const stops = stopsByCarNum.get(carNum);
      if (!stops || stops.length === 0) {
        console.log(`  ${slug.padEnd(32)} carNum=${carNum}  no stops this round — skipping`);
        continue;
      }

      const stopCount = stops.length;
      const avgStopTime = round2(stops.reduce((a, b) => a + b, 0) / stops.length);
      const fastestStop = round2(Math.min(...stops));
      const wasOverallFastest = fastestStop === overallFastest;

      console.log(
        `  ${slug.padEnd(32)} carNum=${carNum}  stops=${stopCount}` +
        `  avg=${avgStopTime}s  fastest=${fastestStop}s  overallFastest=${wasOverallFastest}`,
      );

      if (!DRY_RUN) {
        entry.stopCount         = stopCount;
        entry.avgStopTime       = avgStopTime;
        entry.fastestStop       = fastestStop;
        entry.wasOverallFastest = wasOverallFastest;
        updatedCount++;
      }
    }

    if (!DRY_RUN && updatedCount > 0) {
      (cal as any).pitCrewResults = pitCrewResults;
      await (cal as any).save();
      console.log(`  Saved ${updatedCount} updated entries to RaceCalendar R${round}`);
    }

    await sleep(2000);
  }

  console.log('\n=== Done ===');
  if (DRY_RUN) console.log('DRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
