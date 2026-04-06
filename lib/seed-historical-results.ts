import 'dotenv/config';
import { connectDB } from './db';
import { Asset, HistoricalSeason } from './models';
import { calculateOTFRating, calculatePitCrewScore, calculatePowerUnitScore, calculatePrincipalScore, calculateDriverQualifyingScore } from './otf-calculator';

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
  fastestStopRank: number;
  avgTimeRank: number;
}

interface PitCrewHistoricalStats {
  slug: string;
  r1: PitRaceData | null;
  r2: PitRaceData | null;
  r3: PitRaceData | null;
}

// Rankings computed per-race across all cars with recorded stops.
// fastestStopRank: rank by single best stop time (1 = fastest).
// avgTimeRank:     rank by average of all stop times (1 = lowest avg).
// null = DNS or no stop data recorded that race.
const pitCrewStats: PitCrewHistoricalStats[] = [
  // Mercedes
  {
    slug: 'mercedes-pit-crew-63', // Russell
    //   R1: fastest 2.17 (#1 of 18), avg 2.330 (#2 of 18)
    //   R2: fastest 3.25 (#11 of 17), avg 3.250 (#10 of 17)
    //   R3: fastest 2.43 (#5 of 22), avg 2.430 (#3 of 22)
    r1: { fastestStopRank:  1, avgTimeRank:  2 },
    r2: { fastestStopRank: 11, avgTimeRank: 10 },
    r3: { fastestStopRank:  5, avgTimeRank:  3 },
  },
  {
    slug: 'mercedes-pit-crew-12', // Antonelli (R1 stop data unavailable)
    //   R2: fastest 2.87 (#8 of 17), avg 2.870 (#7 of 17)
    //   R3: fastest 2.40 (#3 of 22), avg 2.400 (#1 of 22)
    r1: null,
    r2: { fastestStopRank:  8, avgTimeRank:  7 },
    r3: { fastestStopRank:  3, avgTimeRank:  1 },
  },
  // Ferrari
  {
    slug: 'ferrari-pit-crew-16', // Leclerc
    //   R1: fastest 2.22 (#2 of 18), avg 2.810 (#6 of 18)
    //   R2: fastest 3.40 (#13 of 17), avg 3.400 (#12 of 17)
    //   R3: fastest 2.13 (#2 of 22), avg 2.540 (#6 of 22)
    r1: { fastestStopRank:  2, avgTimeRank:  6 },
    r2: { fastestStopRank: 13, avgTimeRank: 12 },
    r3: { fastestStopRank:  2, avgTimeRank:  6 },
  },
  {
    slug: 'ferrari-pit-crew-44', // Hamilton
    //   R1: fastest 2.26 (#4 of 18), avg 2.610 (#3 of 18)
    //   R2: fastest 2.29 (#1 of 17), avg 2.290 (#1 of 17)
    //   R3: fastest 2.00 (#1 of 22), avg 2.475 (#4 of 22)
    r1: { fastestStopRank:  4, avgTimeRank:  3 },
    r2: { fastestStopRank:  1, avgTimeRank:  1 },
    r3: { fastestStopRank:  1, avgTimeRank:  4 },
  },
  // Red Bull
  {
    slug: 'red-bull-pit-crew-3', // Verstappen
    //   R1: fastest 2.24 (#3 of 18), avg 2.320 (#1 of 18)
    //   R2: fastest 3.32 (#12 of 17), avg 3.320 (#11 of 17)
    //   R3: fastest 3.36 (#16 of 22), avg 3.360 (#14 of 22)
    r1: { fastestStopRank:  3, avgTimeRank:  1 },
    r2: { fastestStopRank: 12, avgTimeRank: 11 },
    r3: { fastestStopRank: 16, avgTimeRank: 14 },
  },
  {
    slug: 'red-bull-pit-crew-6', // Hadjar (R1 DNF — no stops recorded)
    //   R2: fastest 2.58 (#4 of 17), avg 4.110 (#13 of 17)
    //   R3: fastest 2.80 (#12 of 22), avg 2.800 (#10 of 22)
    r1: null,
    r2: { fastestStopRank:  4, avgTimeRank: 13 },
    r3: { fastestStopRank: 12, avgTimeRank: 10 },
  },
  // Racing Bulls
  {
    slug: 'racing-bulls-pit-crew-30', // Lawson
    //   R1: fastest 2.59 (#7 of 18), avg 2.850 (#8 of 18)
    //   R2: fastest 2.34 (#2 of 17), avg 2.340 (#2 of 17)
    //   R3: fastest 2.79 (#11 of 22), avg 2.790 (#9 of 22)
    r1: { fastestStopRank:  7, avgTimeRank:  8 },
    r2: { fastestStopRank:  2, avgTimeRank:  2 },
    r3: { fastestStopRank: 11, avgTimeRank:  9 },
  },
  {
    slug: 'racing-bulls-pit-crew-41', // Lindblad
    //   R1: fastest 2.42 (#5 of 18), avg 2.840 (#7 of 18)
    //   R2: fastest 2.86 (#7 of 17, tie broken alpha), avg 2.860 (#6 of 17)
    //   R3: fastest 4.78 (#21 of 22), avg 4.780 (#21 of 22)
    r1: { fastestStopRank:  5, avgTimeRank:  7 },
    r2: { fastestStopRank:  7, avgTimeRank:  6 },
    r3: { fastestStopRank: 21, avgTimeRank: 21 },
  },
  // McLaren
  {
    slug: 'mclaren-pit-crew-1', // Norris (R2 DNS)
    //   R1: fastest 2.52 (#6 of 18), avg 2.750 (#5 of 18)
    //   R3: fastest 2.59 (#8 of 22), avg 2.590 (#7 of 22)
    r1: { fastestStopRank:  6, avgTimeRank:  5 },
    r2: null,
    r3: { fastestStopRank:  8, avgTimeRank:  7 },
  },
  {
    slug: 'mclaren-pit-crew-81', // Piastri (R1 DNS, R2 DNS)
    //   R3: fastest 2.49 (#7 of 22), avg 2.490 (#5 of 22)
    r1: null,
    r2: null,
    r3: { fastestStopRank:  7, avgTimeRank:  5 },
  },
  // Williams
  {
    slug: 'williams-pit-crew-23', // Albon (R2 DNS)
    //   R1: fastest 2.63 (#8 of 18), avg 2.685 (#4 of 18)
    //   R3: fastest 2.47 (#6 of 22), avg 2.917 (#11 of 22)
    r1: { fastestStopRank:  8, avgTimeRank:  4 },
    r2: null,
    r3: { fastestStopRank:  6, avgTimeRank: 11 },
  },
  {
    slug: 'williams-pit-crew-55', // Sainz
    //   R1: fastest 4.14 (#15 of 18), avg 10.450 (#16 of 18)
    //   R2: fastest 2.89 (#9 of 17), avg 2.890 (#8 of 17)
    //   R3: fastest 3.34 (#15 of 22), avg 3.340 (#13 of 22)
    r1: { fastestStopRank: 15, avgTimeRank: 16 },
    r2: { fastestStopRank:  9, avgTimeRank:  8 },
    r3: { fastestStopRank: 15, avgTimeRank: 13 },
  },
  // Haas
  {
    slug: 'haas-pit-crew-31', // Ocon
    //   R1: fastest 2.88 (#9 of 18, tie broken by avg), avg 2.880 (#9 of 18)
    //   R2: fastest 5.74 (#15 of 17), avg 16.335 (#17 of 17)
    //   R3: fastest 3.46 (#17 of 22), avg 3.460 (#15 of 22)
    r1: { fastestStopRank:  9, avgTimeRank:  9 },
    r2: { fastestStopRank: 15, avgTimeRank: 17 },
    r3: { fastestStopRank: 17, avgTimeRank: 15 },
  },
  {
    slug: 'haas-pit-crew-87', // Bearman (R3 DNF but stops recorded)
    //   R1: fastest 3.26 (#14 of 18), avg 3.260 (#11 of 18)
    //   R2: fastest 2.86 (#6 of 17, tie broken alpha), avg 2.860 (#5 of 17)
    //   R3: fastest 4.19 (#20 of 22), avg 4.190 (#20 of 22)
    r1: { fastestStopRank: 14, avgTimeRank: 11 },
    r2: { fastestStopRank:  6, avgTimeRank:  5 },
    r3: { fastestStopRank: 20, avgTimeRank: 20 },
  },
  // Audi
  {
    slug: 'audi-pit-crew-27', // Hulkenberg (R1 DNS)
    //   R2: fastest 16.16 (#17 of 17), avg 16.160 (#16 of 17)
    //   R3: fastest 2.41 (#4 of 22), avg 2.410 (#2 of 22)
    r1: null,
    r2: { fastestStopRank: 17, avgTimeRank: 16 },
    r3: { fastestStopRank:  4, avgTimeRank:  2 },
  },
  {
    slug: 'audi-pit-crew-5', // Bortoleto (R2 DNS)
    //   R1: fastest 2.88 (#10 of 18, tie broken by avg), avg 4.480 (#13 of 18)
    //   R3: fastest 2.67 (#9 of 22), avg 2.670 (#8 of 22)
    r1: { fastestStopRank: 10, avgTimeRank: 13 },
    r2: null,
    r3: { fastestStopRank:  9, avgTimeRank:  8 },
  },
  // Alpine
  {
    slug: 'alpine-pit-crew-10', // Gasly
    //   R1: fastest 3.05 (#12 of 18), avg 3.050 (#10 of 18)
    //   R2: fastest 2.82 (#5 of 17), avg 2.820 (#4 of 17)
    //   R3: fastest 3.59 (#18 of 22), avg 3.590 (#17 of 22)
    r1: { fastestStopRank: 12, avgTimeRank: 10 },
    r2: { fastestStopRank:  5, avgTimeRank:  4 },
    r3: { fastestStopRank: 18, avgTimeRank: 17 },
  },
  {
    slug: 'alpine-pit-crew-43', // Colapinto
    //   R1: fastest 2.92 (#11 of 18), avg 7.715 (#14 of 18)
    //   R2: fastest 2.54 (#3 of 17), avg 2.540 (#3 of 17)
    //   R3: fastest 3.00 (#14 of 22), avg 3.000 (#12 of 22)
    r1: { fastestStopRank: 11, avgTimeRank: 14 },
    r2: { fastestStopRank:  3, avgTimeRank:  3 },
    r3: { fastestStopRank: 14, avgTimeRank: 12 },
  },
  // Cadillac
  {
    slug: 'cadillac-pit-crew-11', // Perez
    //   R1: fastest 3.11 (#13 of 18), avg 4.315 (#12 of 18)
    //   R2: fastest 5.58 (#14 of 17), avg 5.580 (#14 of 17)
    //   R3: fastest 6.28 (#22 of 22), avg 6.280 (#22 of 22)
    r1: { fastestStopRank: 13, avgTimeRank: 12 },
    r2: { fastestStopRank: 14, avgTimeRank: 14 },
    r3: { fastestStopRank: 22, avgTimeRank: 22 },
  },
  {
    slug: 'cadillac-pit-crew-77', // Bottas
    //   R1: fastest 12.57 (#18 of 18), avg 12.570 (#17 of 18)
    //   R2: fastest 7.35 (#16 of 17), avg 7.350 (#15 of 17)
    //   R3: fastest 4.04 (#19 of 22), avg 4.040 (#19 of 22)
    r1: { fastestStopRank: 18, avgTimeRank: 17 },
    r2: { fastestStopRank: 16, avgTimeRank: 15 },
    r3: { fastestStopRank: 19, avgTimeRank: 19 },
  },
  // Aston Martin
  {
    slug: 'aston-martin-pit-crew-14', // Alonso
    //   R1: fastest 10.19 (#17 of 18), avg 10.190 (#15 of 18)
    //   R2: fastest 2.99 (#10 of 17), avg 2.990 (#9 of 17)
    //   R3: fastest 2.95 (#13 of 22), avg 3.665 (#18 of 22)
    r1: { fastestStopRank: 17, avgTimeRank: 15 },
    r2: { fastestStopRank: 10, avgTimeRank:  9 },
    r3: { fastestStopRank: 13, avgTimeRank: 18 },
  },
  {
    slug: 'aston-martin-pit-crew-18', // Stroll (R2 DNF — no stops recorded)
    //   R1: fastest 5.71 (#16 of 18), avg 13.100 (#18 of 18)
    //   R3: fastest 2.74 (#10 of 22), avg 3.500 (#16 of 22)
    r1: { fastestStopRank: 16, avgTimeRank: 18 },
    r2: null,
    r3: { fastestStopRank: 10, avgTimeRank: 16 },
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
      totalPoints += calculatePitCrewScore(rd.fastestStopRank ?? 20, rd.avgTimeRank ?? 20);
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
  // Power units — avg finish position per team per race → calculatePowerUnitScore
  // DNF/DNS treated as P20. racesCompleted = 3 for all (all teams entered all rounds).
  // ---------------------------------------------------------------------------
  console.log('\nUpdating power unit historical stats...');

  // avg finish position per team per round (pre-computed from race results above)
  const puStats: { slug: string; r1avg: number; r2avg: number; r3avg: number }[] = [
    // R1: avg(6,20)=13    R2: avg(20,8)=14    R3: avg(8,12)=10
    { slug: 'red-bull-pu',      r1avg: 13.0, r2avg: 14.0, r3avg: 10.0 },
    // R1: avg(13,8)=10.5  R2: avg(7,12)=9.5   R3: avg(9,14)=11.5
    { slug: 'racing-bulls-pu',  r1avg: 10.5, r2avg:  9.5, r3avg: 11.5 },
    // R1: avg(5,20)=12.5  R2: avg(20,20)=20   R3: avg(5,2)=3.5
    { slug: 'mclaren-pu',       r1avg: 12.5, r2avg: 20.0, r3avg:  3.5 },
    // R1: avg(1,2)=1.5    R2: avg(2,1)=1.5    R3: avg(4,1)=2.5
    { slug: 'mercedes-pu',      r1avg:  1.5, r2avg:  1.5, r3avg:  2.5 },
    // R1: avg(3,4)=3.5    R2: avg(4,3)=3.5    R3: avg(3,6)=4.5
    { slug: 'ferrari-pu',       r1avg:  3.5, r2avg:  3.5, r3avg:  4.5 },
    // R1: avg(20,20)=20   R2: avg(20,20)=20   R3: avg(18,20)=19
    { slug: 'aston-martin-pu',  r1avg: 20.0, r2avg: 20.0, r3avg: 19.0 },
    // R1: avg(15,12)=13.5 R2: avg(9,20)=14.5  R3: avg(15,20)=17.5
    { slug: 'williams-pu',      r1avg: 13.5, r2avg: 14.5, r3avg: 17.5 },
    // R1: avg(20,9)=14.5  R2: avg(11,20)=15.5 R3: avg(11,13)=12
    { slug: 'audi-pu',          r1avg: 14.5, r2avg: 15.5, r3avg: 12.0 },
    // R1: avg(7,11)=9     R2: avg(5,14)=9.5   R3: avg(20,10)=15
    { slug: 'haas-pu',          r1avg:  9.0, r2avg:  9.5, r3avg: 15.0 },
    // R1: avg(10,14)=12   R2: avg(6,10)=8     R3: avg(7,16)=11.5
    { slug: 'alpine-pu',        r1avg: 12.0, r2avg:  8.0, r3avg: 11.5 },
    // R1: avg(16,20)=18   R2: avg(15,13)=14   R3: avg(17,19)=18
    { slug: 'cadillac-pu',      r1avg: 18.0, r2avg: 14.0, r3avg: 18.0 },
  ];

  for (const pu of puStats) {
    const r1pts = calculatePowerUnitScore(pu.r1avg);
    const r2pts = calculatePowerUnitScore(pu.r2avg);
    const r3pts = calculatePowerUnitScore(pu.r3avg);
    const totalPoints      = Math.round((r1pts + r2pts + r3pts) * 100) / 100;
    const racesCompleted   = 3;
    const avgPointsPerRace = Math.round((totalPoints / racesCompleted) * 100) / 100;

    const asset = await Asset.findOne({ slug: pu.slug, assetType: 'powerUnit', season: 2026 });
    if (!asset) {
      console.warn(`  ⚠ Power unit not found: ${pu.slug}`);
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
    console.log(`  ✓ ${pu.slug}: r1=${r1pts} r2=${r2pts} r3=${r3pts} total=${totalPoints}, OTF ${asset.otfRating}`);
  }

  // ---------------------------------------------------------------------------
  // Principals — sum of both drivers' FINISH_POINTS per race
  // DNF/DNS treated as P20 (FINISH_POINTS[20] = 1.25).
  // ---------------------------------------------------------------------------
  console.log('\nUpdating principal historical stats...');

  // [slug, r1d1, r1d2, r2d1, r2d2, r3d1, r3d2]
  // Each pair is the two drivers' finish positions for that principal's team.
  const principalStats: {
    slug: string;
    r1: [number, number];
    r2: [number, number];
    r3: [number, number];
  }[] = [
    // Toto Wolff — Mercedes: Russell + Antonelli
    // R1: P1+P2  R2: P1+P2 (Antonelli, Russell)  R3: P4+P1 (Russell, Antonelli)
    { slug: 'toto-wolff',          r1: [1,  2], r2: [1,  2], r3: [4,  1] },
    // Fred Vasseur — Ferrari: Leclerc + Hamilton
    // R1: P3+P4  R2: P3+P4 (Hamilton, Leclerc)   R3: P3+P6
    { slug: 'fred-vasseur',        r1: [3,  4], r2: [3,  4], r3: [3,  6] },
    // Andrea Stella — McLaren: Norris + Piastri
    // R1: P5+P20(DNS)  R2: P20+P20(both DNS)   R3: P5+P2
    { slug: 'andrea-stella',       r1: [5, 20], r2: [20, 20], r3: [5,  2] },
    // Laurent Mekies — Red Bull: Verstappen + Hadjar
    // R1: P6+P20(DNF)  R2: P20(DNF)+P8   R3: P8+P12
    { slug: 'laurent-mekies',      r1: [6, 20], r2: [20, 8], r3: [8, 12] },
    // Ayao Komatsu — Haas: Bearman + Ocon
    // R1: P7+P11  R2: P5+P14   R3: P20(DNF)+P10
    { slug: 'ayao-komatsu',        r1: [7, 11], r2: [5, 14], r3: [20, 10] },
    // Alan Permane — Racing Bulls: Lawson + Lindblad
    // R1: P13+P8  R2: P7+P12   R3: P9+P14
    { slug: 'alan-permane',        r1: [13, 8], r2: [7, 12], r3: [9, 14] },
    // Jonathan Wheatley — Audi: Hulkenberg + Bortoleto
    // R1: P20(DNS)+P9  R2: P11+P20(DNS)  R3: P11+P13
    { slug: 'jonathan-wheatley',   r1: [20, 9], r2: [11, 20], r3: [11, 13] },
    // Flavio Briatore — Alpine: Gasly + Colapinto
    // R1: P10+P14  R2: P6+P10   R3: P7+P16
    { slug: 'flavio-briatore',     r1: [10, 14], r2: [6, 10], r3: [7, 16] },
    // James Vowles — Williams: Sainz + Albon
    // R1: P15+P12  R2: P9+P20(DNS)  R3: P15+P20
    { slug: 'james-vowles',        r1: [15, 12], r2: [9, 20], r3: [15, 20] },
    // Graeme Lowdon — Cadillac: Perez + Bottas
    // R1: P16+P20(DNF)  R2: P15+P13   R3: P17+P19
    { slug: 'graeme-lowdon',       r1: [16, 20], r2: [15, 13], r3: [17, 19] },
    // Adrian Newey — Aston Martin: Alonso + Stroll
    // R1: P20(DNF)+P20(DNF)  R2: P20(DNF)+P20(DNF)  R3: P18+P20(DNF)
    { slug: 'adrian-newey',        r1: [20, 20], r2: [20, 20], r3: [18, 20] },
  ];

  for (const ps of principalStats) {
    const r1pts = calculatePrincipalScore(ps.r1[0], ps.r1[1]);
    const r2pts = calculatePrincipalScore(ps.r2[0], ps.r2[1]);
    const r3pts = calculatePrincipalScore(ps.r3[0], ps.r3[1]);
    const totalPoints      = Math.round((r1pts + r2pts + r3pts) * 100) / 100;
    const racesCompleted   = 3;
    const avgPointsPerRace = Math.round((totalPoints / racesCompleted) * 100) / 100;

    const asset = await Asset.findOne({ slug: ps.slug, assetType: 'principal', season: 2026 });
    if (!asset) {
      console.warn(`  ⚠ Principal not found: ${ps.slug}`);
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
      age:              asset.age,
      teamStrength:     asset.teamStrength,
      dnfCount:         0,
    });

    await asset.save();
    console.log(`  ✓ ${ps.slug}: r1=${r1pts} r2=${r2pts} r3=${r3pts} total=${totalPoints}, OTF ${asset.otfRating}`);
  }

  // ---------------------------------------------------------------------------
  // Driver qualifying stats — Rounds 1–3
  // ---------------------------------------------------------------------------
  console.log('\nSeeding driver qualifying stats...');

  interface QualifyingRaceEntry {
    position:       number;
    round:          'Q1' | 'Q2' | 'Q3';
    beatenTeammate: boolean;
  }

  interface DriverQualifyingStats {
    slug:    string;
    races:   [QualifyingRaceEntry, QualifyingRaceEntry, QualifyingRaceEntry];
    q3Count: number;
    q2Count: number;
  }

  const driverQualifyingStats: DriverQualifyingStats[] = [
    {
      slug: 'george-russell', q3Count: 3, q2Count: 3,
      races: [
        { position: 3,  round: 'Q3', beatenTeammate: true  },
        { position: 4,  round: 'Q3', beatenTeammate: false },
        { position: 4,  round: 'Q3', beatenTeammate: false },
      ],
    },
    {
      slug: 'kimi-antonelli', q3Count: 3, q2Count: 3,
      races: [
        { position: 5,  round: 'Q3', beatenTeammate: false },
        { position: 2,  round: 'Q3', beatenTeammate: true  },
        { position: 2,  round: 'Q3', beatenTeammate: true  },
      ],
    },
    {
      slug: 'charles-leclerc', q3Count: 3, q2Count: 3,
      races: [
        { position: 4,  round: 'Q3', beatenTeammate: true  },
        { position: 6,  round: 'Q3', beatenTeammate: false },
        { position: 3,  round: 'Q3', beatenTeammate: true  },
      ],
    },
    {
      slug: 'lewis-hamilton', q3Count: 3, q2Count: 3,
      races: [
        { position: 10, round: 'Q3', beatenTeammate: false },
        { position: 3,  round: 'Q3', beatenTeammate: true  },
        { position: 8,  round: 'Q3', beatenTeammate: false },
      ],
    },
    {
      slug: 'lando-norris', q3Count: 3, q2Count: 3,
      races: [
        { position: 8,  round: 'Q3', beatenTeammate: false },
        { position: 8,  round: 'Q3', beatenTeammate: false },
        { position: 7,  round: 'Q3', beatenTeammate: false },
      ],
    },
    {
      slug: 'oscar-piastri', q3Count: 3, q2Count: 3,
      races: [
        { position: 6,  round: 'Q3', beatenTeammate: true  },
        { position: 5,  round: 'Q3', beatenTeammate: true  },
        { position: 5,  round: 'Q3', beatenTeammate: true  },
      ],
    },
    {
      slug: 'max-verstappen', q3Count: 1, q2Count: 2,
      races: [
        { position: 17, round: 'Q1', beatenTeammate: true  },
        { position: 6,  round: 'Q3', beatenTeammate: true  },
        { position: 11, round: 'Q2', beatenTeammate: false },
      ],
    },
    {
      slug: 'isack-hadjar', q3Count: 3, q2Count: 3,
      races: [
        { position: 1,  round: 'Q3', beatenTeammate: false },
        { position: 9,  round: 'Q3', beatenTeammate: false },
        { position: 6,  round: 'Q3', beatenTeammate: true  },
      ],
    },
    {
      slug: 'liam-lawson', q3Count: 1, q2Count: 3,
      races: [
        { position: 7,  round: 'Q3', beatenTeammate: false },
        { position: 13, round: 'Q2', beatenTeammate: true  },
        { position: 16, round: 'Q2', beatenTeammate: false },
      ],
    },
    {
      slug: 'arvid-lindblad', q3Count: 2, q2Count: 3,
      races: [
        { position: 11, round: 'Q2', beatenTeammate: true  },
        { position: 16, round: 'Q2', beatenTeammate: false },
        { position: 9,  round: 'Q3', beatenTeammate: true  },
      ],
    },
    {
      slug: 'oliver-bearman', q3Count: 1, q2Count: 2,
      races: [
        { position: 12, round: 'Q2', beatenTeammate: true  },
        { position: 8,  round: 'Q3', beatenTeammate: false },
        { position: 19, round: 'Q1', beatenTeammate: false },
      ],
    },
    {
      slug: 'esteban-ocon', q3Count: 0, q2Count: 3,
      races: [
        { position: 15, round: 'Q2', beatenTeammate: true  },
        { position: 15, round: 'Q2', beatenTeammate: true  },
        { position: 12, round: 'Q2', beatenTeammate: false },
      ],
    },
    {
      slug: 'pierre-gasly', q3Count: 2, q2Count: 3,
      races: [
        { position: 14, round: 'Q2', beatenTeammate: false },
        { position: 7,  round: 'Q3', beatenTeammate: false },
        { position: 1,  round: 'Q3', beatenTeammate: true  },
      ],
    },
    {
      slug: 'franco-colapinto', q3Count: 0, q2Count: 3,
      races: [
        { position: 16, round: 'Q2', beatenTeammate: false },
        { position: 14, round: 'Q2', beatenTeammate: false },
        { position: 14, round: 'Q2', beatenTeammate: true  },
      ],
    },
    {
      slug: 'carlos-sainz', q3Count: 0, q2Count: 0,
      races: [
        { position: 19, round: 'Q1', beatenTeammate: false },
        { position: 17, round: 'Q1', beatenTeammate: false },
        { position: 17, round: 'Q1', beatenTeammate: false },
      ],
    },
    {
      slug: 'alex-albon', q3Count: 0, q2Count: 1,
      races: [
        { position: 18, round: 'Q1', beatenTeammate: true  },
        { position: 20, round: 'Q1', beatenTeammate: true  },
        { position: 20, round: 'Q1', beatenTeammate: true  },
      ],
    },
    {
      slug: 'nico-hulkenberg', q3Count: 0, q2Count: 3,
      races: [
        { position: 14, round: 'Q2', beatenTeammate: true  },
        { position: 11, round: 'Q2', beatenTeammate: true  },
        { position: 15, round: 'Q2', beatenTeammate: true  },
      ],
    },
    {
      slug: 'gabriel-bortoleto', q3Count: 2, q2Count: 2,
      races: [
        { position: 9,  round: 'Q3', beatenTeammate: false },
        { position: 18, round: 'Q1', beatenTeammate: false },
        { position: 10, round: 'Q3', beatenTeammate: false },
      ],
    },
    {
      slug: 'sergio-perez', q3Count: 0, q2Count: 0,
      races: [
        { position: 20, round: 'Q1', beatenTeammate: false },
        { position: 19, round: 'Q1', beatenTeammate: false },
        { position: 18, round: 'Q1', beatenTeammate: false },
      ],
    },
    {
      slug: 'valtteri-bottas', q3Count: 0, q2Count: 0,
      races: [
        { position: 18, round: 'Q1', beatenTeammate: true  },
        { position: 18, round: 'Q1', beatenTeammate: false },
        { position: 21, round: 'Q1', beatenTeammate: false },
      ],
    },
    {
      slug: 'fernando-alonso', q3Count: 0, q2Count: 0,
      races: [
        { position: 16, round: 'Q1', beatenTeammate: true  },
        { position: 15, round: 'Q1', beatenTeammate: true  },
        { position: 19, round: 'Q1', beatenTeammate: true  },
      ],
    },
    {
      slug: 'lance-stroll', q3Count: 0, q2Count: 0,
      races: [
        { position: 20, round: 'Q1', beatenTeammate: false },
        { position: 20, round: 'Q1', beatenTeammate: false },
        { position: 22, round: 'Q1', beatenTeammate: false },
      ],
    },
  ];

  for (const dqs of driverQualifyingStats) {
    const asset = await Asset.findOne({ slug: dqs.slug, assetType: 'driver', season: 2026 });
    if (!asset) { console.warn(`  ⚠ driver not found: ${dqs.slug}`); continue; }

    let qualifyingPoints = 0;
    for (const race of dqs.races) {
      qualifyingPoints += calculateDriverQualifyingScore({
        qualifyingPosition:  race.position,
        qualifyingRound:     race.round,
        beatenTeammate:      race.beatenTeammate,
        didNotQualify:       false,
        dsqFromQualifying:   false,
      });
    }

    asset.qualifyingRaces    = 3;
    asset.q1Count            = 3; // all drivers entered Q1
    asset.q2Count            = dqs.q2Count;
    asset.q3Count            = dqs.q3Count;
    asset.totalPoints        = (asset.totalPoints ?? 0) + qualifyingPoints;
    asset.avgPointsPerRace   = asset.totalPoints / (asset.racesCompleted + asset.qualifyingRaces);
    asset.otfRating          = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted + asset.qualifyingRaces,
      avgPointsPerRace: asset.avgPointsPerRace,
      totalPoints:      asset.totalPoints,
      age:              asset.age,
      teamStrength:     asset.teamStrength,
      dnfCount:         asset.dnfCount ?? 0,
    });

    await asset.save();
    console.log(`  ✓ ${dqs.slug}: +${qualifyingPoints.toFixed(1)} qualifying pts → total=${asset.totalPoints.toFixed(1)}, OTF ${asset.otfRating}`);
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

  // ---------------------------------------------------------------------------
  // Recalculate OTF ratings using historicalSeasons data
  // ---------------------------------------------------------------------------
  console.log('\nRecalculating OTF ratings with historical season data...');

  const allDriverAssets = await Asset.find({ assetType: 'driver', season: 2026 });

  for (const asset of allDriverAssets) {
    const historicalDocs = await HistoricalSeason.find({ assetSlug: asset.slug }).lean() as any[];

    const historicalSeasons = historicalDocs.map((h: any) => ({
      season:           h.season,
      wins:             h.wins ?? 0,
      podiums:          h.podiums ?? 0,
      racesCompleted:   h.racesCompleted ?? 0,
      q3Count:          h.q3Count ?? 0,
      qualifyingRaces:  h.qualifyingRaces ?? 0,
      dnfCount:         h.dnfCount ?? 0,
      avgPointsPerRace: h.avgPointsPerRace ?? 0,
    }));

    const oldRating = asset.otfRating;
    asset.otfRating = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted ?? 0,
      avgPointsPerRace: asset.avgPointsPerRace ?? 0,
      totalPoints:      asset.totalPoints ?? 0,
      age:              asset.age,
      teamStrength:     asset.teamStrength ?? 50,
      dnfCount:         asset.dnfCount ?? 0,
      historicalSeasons,
    });

    await asset.save();
    console.log(`  ✓ ${asset.slug}: OTF updated from ${oldRating} to ${asset.otfRating}`);
  }

  console.log('\nDone.');
  process.exit(0);
}

seedHistoricalResults().catch((err) => {
  console.error(err);
  process.exit(1);
});
