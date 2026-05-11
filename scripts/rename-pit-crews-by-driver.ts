/**
 * rename-pit-crews-by-driver.ts
 *
 * Renames every active 2026 pit crew asset so that the "(Car NN)" suffix is
 * replaced with the last name of the driver who uses that car number.
 *
 *   "Mercedes Pit Crew (Car 12)" → "Mercedes Pit Crew Antonelli"
 *   "Ferrari Pit Crew (Car 44)"  → "Ferrari Pit Crew Hamilton"
 *
 * Mapping is derived from the live driver assets, so this stays correct even
 * if a driver's car number changes — just re-run.
 *
 * If no driver is found for a car number, the script leaves the asset alone
 * and logs a warning.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env.local scripts/rename-pit-crews-by-driver.ts
 *   npx tsx --env-file=.env.local scripts/rename-pit-crews-by-driver.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset } from '../lib/models';

const DRY_RUN = process.env.DRY_RUN === '1';

function lastNameOf(fullName: string): string {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

async function main() {
  console.log(`=== rename-pit-crews-by-driver ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);
  await connectDB();

  const drivers = await Asset.find({
    season: 2026,
    assetType: 'driver',
    isActive: true,
  }).select('name lastName teamSlug carNumber').lean() as any[];

  // carNumber → lastName
  const lastNameByCar = new Map<number, string>();
  for (const d of drivers) {
    if (d.carNumber == null) continue;
    const last = d.lastName?.trim() || lastNameOf(d.name);
    if (!last) continue;
    lastNameByCar.set(d.carNumber, last);
  }
  console.log(`Built carNumber→lastName map (${lastNameByCar.size} entries)\n`);

  const pitCrews = await Asset.find({
    season: 2026,
    assetType: 'pitCrew',
    isActive: true,
  }).select('name slug teamSlug carNumber').lean() as any[];

  let updated = 0;
  let unchanged = 0;
  let missingDriver = 0;

  for (const pc of pitCrews) {
    const carNum = pc.carNumber;
    const lastName = carNum != null ? lastNameByCar.get(carNum) : null;
    if (!lastName) {
      console.log(`  [skip] ${pc.name.padEnd(45)} car=${carNum ?? '?'}  no driver found`);
      missingDriver++;
      continue;
    }

    // Strip everything from the first "(" onwards (incl. "(Car NN)" suffix
    // with whatever surrounding whitespace), then append " <LastName>".
    const base = pc.name.replace(/\s*\(.*$/, '').trim();
    const newName = `${base} ${lastName}`;

    if (newName === pc.name) {
      unchanged++;
      continue;
    }

    console.log(`  ${pc.name.padEnd(45)} → ${newName}`);

    if (!DRY_RUN) {
      await Asset.updateOne({ _id: pc._id }, { $set: { name: newName } });
    }
    updated++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Total pit crews:      ${pitCrews.length}`);
  console.log(`  Renamed:              ${DRY_RUN ? '(dry run — would rename)' : ''} ${updated}`);
  console.log(`  Unchanged:            ${unchanged}`);
  console.log(`  Skipped (no driver):  ${missingDriver}`);

  if (DRY_RUN) console.log('\nDRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
