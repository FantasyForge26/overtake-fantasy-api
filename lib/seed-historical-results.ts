import 'dotenv/config';
import { connectDB } from './db';
import { Asset } from './models';
import { calculateOTFRating, calculatePitCrewScore } from './otf-calculator';

// ---------------------------------------------------------------------------
// Driver historical stats — Rounds 1–3 (Australia, China, Japan)
//
// Scoring: FINISH_POINTS[finish] + places gained * 0.75 − places lost * 0.25
//          + beat teammate (+10) + DNF penalty (−10)
//          DNS = did not start → 0 pts, race not counted toward racesCompleted
//
// Team pairings:
//   Red Bull:      Verstappen / Hadjar
//   Racing Bulls:  Lawson / Lindblad
//   McLaren:       Norris / Piastri
//   Mercedes:      Russell / Antonelli
//   Ferrari:       Leclerc / Hamilton
//   Aston Martin:  Alonso / Stroll
//   Williams:      Sainz / Albon
//   Audi:          Hulkenberg / Bortoleto
//   Haas:          Ocon / Bearman
//   Alpine:        Gasly / Colapinto
//   Cadillac:      Perez / Bottas
//
// Round 1 – Australia
//   Grid: Russell P1, Antonelli P2, Hadjar P3, Leclerc P4, Piastri DNS, Norris P6,
//         Hamilton P7, Lawson P8, Lindblad P9, Bortoleto P10, Bearman P12, Ocon P13,
//         Gasly P14, Albon P15, Colapinto P16, Alonso P17, Perez P18, Bottas P19,
//         Verstappen P20, Sainz P21, Stroll P22, Hulkenberg DNS
//   Finish: Russell P1, Antonelli P2, Leclerc P3, Hamilton P4, Norris P5, Verstappen P6,
//           Bearman P7, Lindblad P8, Bortoleto P9, Gasly P10, Ocon P11, Albon P12,
//           Lawson P13, Colapinto P14, Sainz P15, Perez P16,
//           Stroll DNF, Alonso DNF, Bottas DNF, Hadjar DNF, Piastri DNS, Hulkenberg DNS
//
// Round 2 – China
//   Grid: Antonelli P1, Russell P2, Hamilton P3, Leclerc P4, Gasly P7, Verstappen P8,
//         Bearman P9, Hadjar P10; unknown grid positions for Lawson/Lindblad/Sainz/
//         Colapinto/Hulkenberg/Bottas/Perez/Ocon/Stroll/Alonso (assumed = finish pos);
//         Piastri DNS, Norris DNS, Bortoleto DNS, Albon DNS
//   Finish: Antonelli P1, Russell P2, Hamilton P3, Leclerc P4, Bearman P5, Gasly P6,
//           Lawson P7, Hadjar P8, Sainz P9, Colapinto P10, Hulkenberg P11, Lindblad P12,
//           Bottas P13, Ocon P14, Perez P15,
//           Verstappen DNF, Alonso DNF, Stroll DNF, Piastri DNS, Norris DNS, Bortoleto DNS, Albon DNS
//
// Round 3 – Japan
//   Grid: Antonelli P1, Russell P2, Piastri P3, Leclerc P4, Norris P5, Hamilton P6,
//         Gasly P7, Hadjar P8, Bortoleto P9, Lindblad P10, Verstappen P11, Ocon P12,
//         Hulkenberg P13, Lawson P14, Colapinto P15, Sainz P16, Albon P17, Bearman P18,
//         Perez P19, Bottas P20, Alonso P21, Stroll P22
//   Finish: Antonelli P1, Piastri P2, Leclerc P3, Russell P4, Norris P5, Hamilton P6,
//           Gasly P7, Verstappen P8, Lawson P9, Ocon P10, Hulkenberg P11, Hadjar P12,
//           Bortoleto P13, Lindblad P14, Sainz P15, Colapinto P16, Perez P17, Alonso P18,
//           Bottas P19, Albon P20, Stroll DNF, Bearman DNF
// ---------------------------------------------------------------------------

interface DriverHistoricalStats {
  slug: string;
  r1: number; // 0 if DNS
  r2: number;
  r3: number;
  racesCompleted: number; // excludes DNS
  dnfCount: number;
}

const driverStats: DriverHistoricalStats[] = [
  // Mercedes
  // Russell: R1 finish=1 grid=1 tmmt=2: 25+0+10=35 | R2 finish=2 grid=2 tmmt=1: 23.75+0+0=23.75 | R3 finish=4 grid=2 tmmt=1: 21.25+(−2*0.25)+0=20.75
  { slug: 'george-russell',    r1: 35.00,  r2: 23.75,  r3: 20.75,  racesCompleted: 3, dnfCount: 0 },
  // Antonelli: R1 finish=2 grid=2 tmmt=1: 23.75+0+0=23.75 | R2 finish=1 grid=1 tmmt=2: 25+0+10=35 | R3 finish=1 grid=1 tmmt=4: 25+0+10=35
  { slug: 'kimi-antonelli',    r1: 23.75,  r2: 35.00,  r3: 35.00,  racesCompleted: 3, dnfCount: 0 },
  // Ferrari
  // Leclerc: R1 finish=3 grid=4 tmmt=4: 22.5+(1*0.75)+10=33.25 | R2 finish=4 grid=4 tmmt=3: 21.25+0+0=21.25 | R3 finish=3 grid=4 tmmt=6: 22.5+(1*0.75)+10=33.25
  { slug: 'charles-leclerc',   r1: 33.25,  r2: 21.25,  r3: 33.25,  racesCompleted: 3, dnfCount: 0 },
  // Hamilton: R1 finish=4 grid=7 tmmt=3: 21.25+(3*0.75)+0=23.5 | R2 finish=3 grid=3 tmmt=4: 22.5+0+10=32.5 | R3 finish=6 grid=6 tmmt=3: 18.75+0+0=18.75
  { slug: 'lewis-hamilton',    r1: 23.50,  r2: 32.50,  r3: 18.75,  racesCompleted: 3, dnfCount: 0 },
  // McLaren
  // Norris: R1 finish=5 grid=6 tmmt(Piastri DNS→22): 20+(1*0.75)+10=30.75 | R2 DNS | R3 finish=5 grid=5 tmmt=2: 20+0+0=20
  { slug: 'lando-norris',      r1: 30.75,  r2:  0.00,  r3: 20.00,  racesCompleted: 2, dnfCount: 0 },
  // Piastri: R1 DNS | R2 DNS | R3 finish=2 grid=3 tmmt=5: 23.75+(1*0.75)+10=34.5
  { slug: 'oscar-piastri',     r1:  0.00,  r2:  0.00,  r3: 34.50,  racesCompleted: 1, dnfCount: 0 },
  // Red Bull
  // Verstappen: R1 finish=6 grid=20 tmmt(Hadjar DNF→20): 18.75+(14*0.75)+10=39.25
  //             R2 DNF grid=8 tmmt=8: 1.25+(−12*0.25)+0−10=−11.75
  //             R3 finish=8 grid=11 tmmt=12: 16.25+(3*0.75)+10=28.5
  { slug: 'max-verstappen',    r1: 39.25,  r2: -11.75, r3: 28.50,  racesCompleted: 3, dnfCount: 1 },
  // Hadjar: R1 DNF grid=3 tmmt=6: 1.25+(−17*0.25)+0−10=−13
  //         R2 finish=8 grid=10 tmmt(Verstappen DNF→20): 16.25+(2*0.75)+10=27.75
  //         R3 finish=12 grid=8 tmmt=8: 11.25+(−4*0.25)+0=10.25
  { slug: 'isack-hadjar',      r1: -13.00, r2: 27.75,  r3: 10.25,  racesCompleted: 3, dnfCount: 1 },
  // Racing Bulls
  // Lawson: R1 finish=13 grid=8 tmmt=8: 10+(−5*0.25)+0=8.75
  //         R2 finish=7 grid=7(unknown→finish) tmmt=12: 17.5+0+10=27.5
  //         R3 finish=9 grid=14 tmmt=14: 15+(5*0.75)+10=28.75
  { slug: 'liam-lawson',       r1:  8.75,  r2: 27.50,  r3: 28.75,  racesCompleted: 3, dnfCount: 0 },
  // Lindblad: R1 finish=8 grid=9 tmmt=13: 16.25+(1*0.75)+10=27
  //           R2 finish=12 grid=12(unknown→finish) tmmt=7: 11.25+0+0=11.25
  //           R3 finish=14 grid=10 tmmt=9: 8.75+(−4*0.25)+0=7.75
  { slug: 'arvid-lindblad',    r1: 27.00,  r2: 11.25,  r3:  7.75,  racesCompleted: 3, dnfCount: 0 },
  // Haas
  // Bearman: R1 finish=7 grid=12 tmmt=11: 17.5+(5*0.75)+10=31.25
  //          R2 finish=5 grid=9 tmmt=14: 20+(4*0.75)+10=33
  //          R3 DNF grid=18 tmmt=10: 1.25+(−2*0.25)+0−10=−9.25
  { slug: 'oliver-bearman',    r1: 31.25,  r2: 33.00,  r3: -9.25,  racesCompleted: 3, dnfCount: 1 },
  // Ocon: R1 finish=11 grid=13 tmmt=7: 12.5+(2*0.75)+0=14
  //       R2 finish=14 grid=14(unknown→finish) tmmt=5: 8.75+0+0=8.75
  //       R3 finish=10 grid=12 tmmt(Bearman DNF→20): 13.75+(2*0.75)+10=25.25
  { slug: 'esteban-ocon',      r1: 14.00,  r2:  8.75,  r3: 25.25,  racesCompleted: 3, dnfCount: 0 },
  // Alpine
  // Gasly: R1 finish=10 grid=14 tmmt=14: 13.75+(4*0.75)+10=26.75
  //        R2 finish=6 grid=7 tmmt=10: 18.75+(1*0.75)+10=29.5
  //        R3 finish=7 grid=7 tmmt=16: 17.5+0+10=27.5
  { slug: 'pierre-gasly',      r1: 26.75,  r2: 29.50,  r3: 27.50,  racesCompleted: 3, dnfCount: 0 },
  // Colapinto: R1 finish=14 grid=16 tmmt=10: 8.75+(2*0.75)+0=10.25
  //            R2 finish=10 grid=10(unknown→finish) tmmt=6: 13.75+0+0=13.75
  //            R3 finish=16 grid=15 tmmt=7: 6.25+(−1*0.25)+0=6
  { slug: 'franco-colapinto',  r1: 10.25,  r2: 13.75,  r3:  6.00,  racesCompleted: 3, dnfCount: 0 },
  // Williams
  // Sainz: R1 finish=15 grid=21 tmmt=12: 7.5+(6*0.75)+0=12
  //        R2 finish=9 grid=9(unknown→finish) tmmt(Albon DNS→22): 15+0+10=25
  //        R3 finish=15 grid=16 tmmt=20: 7.5+(1*0.75)+10=18.25
  { slug: 'carlos-sainz',      r1: 12.00,  r2: 25.00,  r3: 18.25,  racesCompleted: 3, dnfCount: 0 },
  // Albon: R1 finish=12 grid=15 tmmt=15: 11.25+(3*0.75)+10=23.5 | R2 DNS | R3 finish=20 grid=17 tmmt=15: 1.25+(−3*0.25)+0=0.5
  { slug: 'alex-albon',        r1: 23.50,  r2:  0.00,  r3:  0.50,  racesCompleted: 2, dnfCount: 0 },
  // Audi
  // Hulkenberg: R1 DNS | R2 finish=11 grid=11(unknown→finish) tmmt(Bortoleto DNS→22): 12.5+0+10=22.5 | R3 finish=11 grid=13 tmmt=13: 12.5+(2*0.75)+10=24
  { slug: 'nico-hulkenberg',   r1:  0.00,  r2: 22.50,  r3: 24.00,  racesCompleted: 2, dnfCount: 0 },
  // Bortoleto: R1 finish=9 grid=10 tmmt(Hulkenberg DNS→22): 15+(1*0.75)+10=25.75 | R2 DNS | R3 finish=13 grid=9 tmmt=11: 10+(−4*0.25)+0=9
  { slug: 'gabriel-bortoleto', r1: 25.75,  r2:  0.00,  r3:  9.00,  racesCompleted: 2, dnfCount: 0 },
  // Cadillac
  // Perez: R1 finish=16 grid=18 tmmt(Bottas DNF→20): 6.25+(2*0.75)+10=17.75
  //        R2 finish=15 grid=15(unknown→finish) tmmt=13: 7.5+0+0=7.5
  //        R3 finish=17 grid=19 tmmt=19: 5+(2*0.75)+10=16.5
  { slug: 'sergio-perez',      r1: 17.75,  r2:  7.50,  r3: 16.50,  racesCompleted: 3, dnfCount: 0 },
  // Bottas: R1 DNF grid=19 tmmt=16: 1.25+(−1*0.25)+0−10=−9
  //         R2 finish=13 grid=13(unknown→finish) tmmt=15: 10+0+10=20
  //         R3 finish=19 grid=20 tmmt=17: 2.5+(1*0.75)+0=3.25
  { slug: 'valtteri-bottas',   r1: -9.00,  r2: 20.00,  r3:  3.25,  racesCompleted: 3, dnfCount: 1 },
  // Aston Martin
  // Alonso: R1 DNF grid=17 tmmt(Stroll DNF→20): 1.25+(−3*0.25)+0−10=−9.5
  //         R2 DNF grid=20(unknown→dnf pos) tmmt(Stroll DNF→20): 1.25+0+0−10=−8.75
  //         R3 finish=18 grid=21 tmmt(Stroll DNF→20): 3.75+(3*0.75)+10=16
  { slug: 'fernando-alonso',   r1: -9.50,  r2: -8.75,  r3: 16.00,  racesCompleted: 3, dnfCount: 2 },
  // Stroll: R1 DNF grid=22 tmmt(Alonso DNF→20): 1.25+(2*0.75)+0−10=−7.25
  //         R2 DNF grid=20(unknown→dnf pos) tmmt(Alonso DNF→20): 1.25+0+0−10=−8.75
  //         R3 DNF grid=22 tmmt(Alonso)=18: 1.25+(2*0.75)+0−10=−7.25
  { slug: 'lance-stroll',      r1: -7.25,  r2: -8.75,  r3: -7.25,  racesCompleted: 3, dnfCount: 3 },
];

// ---------------------------------------------------------------------------
// Pit crew historical stats — stop times per car per round
//
// null = DNS or no recorded stop data (race not counted toward racesCompleted)
// Stop times in seconds. fastestStopOverall winners:
//   R1 Australia: mercedes-pit-crew-63 (Russell, 2.17s)
//   R2 China:     ferrari-pit-crew-44  (Hamilton, 2.29s)
//   R3 Japan:     ferrari-pit-crew-44  (Hamilton, 2.00s)
// ---------------------------------------------------------------------------

interface PitRaceData {
  stopTimes: number[];
  fastestStopOverall: boolean;
}

interface PitCrewHistoricalStats {
  slug: string;
  r1: PitRaceData | null;
  r2: PitRaceData | null;
  r3: PitRaceData | null;
}

const pitCrewStats: PitCrewHistoricalStats[] = [
  // Mercedes
  {
    slug: 'mercedes-pit-crew-63', // Russell
    r1: { stopTimes: [2.17, 2.49], fastestStopOverall: true },
    r2: { stopTimes: [3.25],       fastestStopOverall: false },
    r3: { stopTimes: [2.43],       fastestStopOverall: false },
  },
  {
    slug: 'mercedes-pit-crew-12', // Antonelli (R1 stop data unavailable)
    r1: null,
    r2: { stopTimes: [2.87], fastestStopOverall: false },
    r3: { stopTimes: [2.40], fastestStopOverall: false },
  },
  // Ferrari
  {
    slug: 'ferrari-pit-crew-16', // Leclerc
    r1: { stopTimes: [2.22, 3.40], fastestStopOverall: false },
    r2: { stopTimes: [3.40],       fastestStopOverall: false },
    r3: { stopTimes: [2.13, 2.95], fastestStopOverall: false },
  },
  {
    slug: 'ferrari-pit-crew-44', // Hamilton
    r1: { stopTimes: [2.26, 2.96], fastestStopOverall: false },
    r2: { stopTimes: [2.29],       fastestStopOverall: true  },
    r3: { stopTimes: [2.00, 2.95], fastestStopOverall: true  },
  },
  // Red Bull
  {
    slug: 'red-bull-pit-crew-3', // Verstappen
    r1: { stopTimes: [2.24, 2.40], fastestStopOverall: false },
    r2: { stopTimes: [3.32],       fastestStopOverall: false },
    r3: { stopTimes: [3.36],       fastestStopOverall: false },
  },
  {
    slug: 'red-bull-pit-crew-6', // Hadjar (R1 DNF — no stops recorded)
    r1: null,
    r2: { stopTimes: [2.58, 5.64], fastestStopOverall: false },
    r3: { stopTimes: [2.80],       fastestStopOverall: false },
  },
  // Racing Bulls
  {
    slug: 'racing-bulls-pit-crew-30', // Lawson
    r1: { stopTimes: [2.59, 3.11], fastestStopOverall: false },
    r2: { stopTimes: [2.34],       fastestStopOverall: false },
    r3: { stopTimes: [2.79],       fastestStopOverall: false },
  },
  {
    slug: 'racing-bulls-pit-crew-41', // Lindblad
    r1: { stopTimes: [2.42, 3.26], fastestStopOverall: false },
    r2: { stopTimes: [2.86],       fastestStopOverall: false },
    r3: { stopTimes: [4.78],       fastestStopOverall: false },
  },
  // McLaren
  {
    slug: 'mclaren-pit-crew-1', // Norris (R2 DNS)
    r1: { stopTimes: [2.52, 2.98], fastestStopOverall: false },
    r2: null,
    r3: { stopTimes: [2.59], fastestStopOverall: false },
  },
  {
    slug: 'mclaren-pit-crew-81', // Piastri (R1 DNS, R2 DNS)
    r1: null,
    r2: null,
    r3: { stopTimes: [2.49], fastestStopOverall: false },
  },
  // Williams
  {
    slug: 'williams-pit-crew-23', // Albon (R2 DNS)
    r1: { stopTimes: [2.63, 2.74],       fastestStopOverall: false },
    r2: null,
    r3: { stopTimes: [2.47, 2.90, 3.38], fastestStopOverall: false },
  },
  {
    slug: 'williams-pit-crew-55', // Sainz
    r1: { stopTimes: [4.14, 8.07, 19.14], fastestStopOverall: false },
    r2: { stopTimes: [2.89],              fastestStopOverall: false },
    r3: { stopTimes: [3.34],              fastestStopOverall: false },
  },
  // Haas
  {
    slug: 'haas-pit-crew-31', // Ocon
    r1: { stopTimes: [2.88],        fastestStopOverall: false },
    r2: { stopTimes: [5.74, 26.93], fastestStopOverall: false },
    r3: { stopTimes: [3.46],        fastestStopOverall: false },
  },
  {
    slug: 'haas-pit-crew-87', // Bearman (R3 DNF but stops recorded)
    r1: { stopTimes: [3.26], fastestStopOverall: false },
    r2: { stopTimes: [2.86], fastestStopOverall: false },
    r3: { stopTimes: [4.19], fastestStopOverall: false },
  },
  // Audi
  {
    slug: 'audi-pit-crew-27', // Hulkenberg (R1 DNS)
    r1: null,
    r2: { stopTimes: [16.16], fastestStopOverall: false },
    r3: { stopTimes: [2.41],  fastestStopOverall: false },
  },
  {
    slug: 'audi-pit-crew-5', // Bortoleto (R2 DNS)
    r1: { stopTimes: [2.88, 6.08], fastestStopOverall: false },
    r2: null,
    r3: { stopTimes: [2.67], fastestStopOverall: false },
  },
  // Alpine
  {
    slug: 'alpine-pit-crew-10', // Gasly
    r1: { stopTimes: [3.05], fastestStopOverall: false },
    r2: { stopTimes: [2.82], fastestStopOverall: false },
    r3: { stopTimes: [3.59], fastestStopOverall: false },
  },
  {
    slug: 'alpine-pit-crew-43', // Colapinto
    r1: { stopTimes: [2.92, 12.51], fastestStopOverall: false },
    r2: { stopTimes: [2.54],        fastestStopOverall: false },
    r3: { stopTimes: [3.00],        fastestStopOverall: false },
  },
  // Cadillac
  {
    slug: 'cadillac-pit-crew-11', // Perez
    r1: { stopTimes: [3.11, 5.52], fastestStopOverall: false },
    r2: { stopTimes: [5.58],       fastestStopOverall: false },
    r3: { stopTimes: [6.28],       fastestStopOverall: false },
  },
  {
    slug: 'cadillac-pit-crew-77', // Bottas
    r1: { stopTimes: [12.57], fastestStopOverall: false },
    r2: { stopTimes: [7.35],  fastestStopOverall: false },
    r3: { stopTimes: [4.04],  fastestStopOverall: false },
  },
  // Aston Martin
  {
    slug: 'aston-martin-pit-crew-14', // Alonso
    r1: { stopTimes: [10.19],       fastestStopOverall: false },
    r2: { stopTimes: [2.99],        fastestStopOverall: false },
    r3: { stopTimes: [2.95, 4.38],  fastestStopOverall: false },
  },
  {
    slug: 'aston-martin-pit-crew-18', // Stroll (R2 DNF — no stops recorded)
    r1: { stopTimes: [5.71, 16.52, 17.07], fastestStopOverall: false },
    r2: null,
    r3: { stopTimes: [2.74, 4.26], fastestStopOverall: false },
  },
];

async function seedHistoricalResults() {
  await connectDB();

  // ---------------------------------------------------------------------------
  // Drivers
  // ---------------------------------------------------------------------------
  console.log('Updating driver historical stats...');

  for (const stats of driverStats) {
    const totalPoints = Math.round((stats.r1 + stats.r2 + stats.r3) * 100) / 100;
    const avgPointsPerRace = stats.racesCompleted > 0
      ? Math.round((totalPoints / stats.racesCompleted) * 100) / 100
      : 0;

    const asset = await Asset.findOne({ slug: stats.slug, assetType: 'driver', season: 2026 });
    if (!asset) {
      console.warn(`  ⚠ Driver not found: ${stats.slug}`);
      continue;
    }

    asset.totalPoints      = totalPoints;
    asset.avgPointsPerRace = avgPointsPerRace;
    asset.racesCompleted   = stats.racesCompleted;
    asset.dnfCount         = stats.dnfCount;
    asset.otfRating        = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted,
      avgPointsPerRace: asset.avgPointsPerRace,
      totalPoints:      asset.totalPoints,
      age:              asset.age,
      teamStrength:     asset.teamStrength,
      dnfCount:         asset.dnfCount,
    });

    await asset.save();
    console.log(`  ✓ ${stats.slug}: ${totalPoints} pts, avg ${avgPointsPerRace}, OTF ${asset.otfRating}`);
  }

  // ---------------------------------------------------------------------------
  // Pit crews
  // ---------------------------------------------------------------------------
  console.log('\nUpdating pit crew historical stats...');

  for (const pc of pitCrewStats) {
    const rounds: (PitRaceData | null)[] = [pc.r1, pc.r2, pc.r3];
    let totalPoints    = 0;
    let racesCompleted = 0;

    for (const rd of rounds) {
      if (!rd) continue; // DNS or no data
      racesCompleted++;
      totalPoints += calculatePitCrewScore(rd.stopTimes, rd.fastestStopOverall);
    }

    totalPoints      = Math.round(totalPoints * 100) / 100;
    const avgPointsPerRace = racesCompleted > 0
      ? Math.round((totalPoints / racesCompleted) * 100) / 100
      : 0;

    const asset = await Asset.findOne({ slug: pc.slug, assetType: 'pitCrew', season: 2026 });
    if (!asset) {
      console.warn(`  ⚠ Pit crew not found: ${pc.slug}`);
      continue;
    }

    asset.totalPoints      = totalPoints;
    asset.avgPointsPerRace = avgPointsPerRace;
    asset.racesCompleted   = racesCompleted;
    asset.dnfCount         = 0;
    asset.otfRating        = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted,
      avgPointsPerRace: asset.avgPointsPerRace,
      totalPoints:      asset.totalPoints,
      age:              undefined,
      teamStrength:     asset.teamStrength,
      dnfCount:         0,
    });

    await asset.save();
    console.log(`  ✓ ${pc.slug}: ${totalPoints} pts, avg ${avgPointsPerRace}, OTF ${asset.otfRating}`);
  }

  // ---------------------------------------------------------------------------
  // Fix Cadillac power unit: manufacturer should be Ferrari, not General Motors
  // ---------------------------------------------------------------------------
  console.log('\nFixing Cadillac power unit manufacturer...');
  const cadillacPU = await Asset.findOne({ slug: 'cadillac-pu', assetType: 'powerUnit', season: 2026 });
  if (cadillacPU) {
    cadillacPU.name         = 'Ferrari';
    cadillacPU.manufacturer = 'Ferrari';
    await cadillacPU.save();
    console.log('  ✓ cadillac-pu updated to Ferrari');
  } else {
    console.warn('  ⚠ cadillac-pu not found');
  }

  console.log('\nDone.');
  process.exit(0);
}

seedHistoricalResults().catch((err) => {
  console.error(err);
  process.exit(1);
});
