import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { RaceCalendar } from '../lib/models';

(async () => {
  await connectDB();

  // Most recent processed round (Canada = R7)
  const cals = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }).lean() as any[];
  const processed = cals.filter(c => (c.raceResults ?? []).length > 0);

  for (const cal of processed.slice(-2)) {
    console.log(`\n=== R${cal.round} ${cal.country} (isSprint=${cal.isSprint}) ===`);

    const principalResults = cal.principalResults ?? [];
    console.log(`  principalResults: ${principalResults.length} entries`);
    // Group by session to see if per-session breakdown exists
    const bySession: Record<string, number> = {};
    for (const r of principalResults) {
      const s = r.session ?? '(no session field)';
      bySession[s] = (bySession[s] ?? 0) + 1;
    }
    console.log(`    sessions present: ${JSON.stringify(bySession)}`);
    // Sample one principal's entries
    const sampleSlug = principalResults[0]?.principalSlug;
    if (sampleSlug) {
      const sample = principalResults.filter((r: any) => r.principalSlug === sampleSlug);
      console.log(`    sample "${sampleSlug}": ${sample.map((r: any) => `${r.session ?? '?'}=${r.points}`).join(', ')}`);
    }

    const puResults = cal.powerUnitResults ?? [];
    const puBySession: Record<string, number> = {};
    for (const r of puResults) {
      const s = r.session ?? '(no session field)';
      puBySession[s] = (puBySession[s] ?? 0) + 1;
    }
    console.log(`  powerUnitResults: ${puResults.length} entries, sessions: ${JSON.stringify(puBySession)}`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
