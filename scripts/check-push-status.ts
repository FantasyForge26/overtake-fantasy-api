/**
 * check-push-status.ts
 *
 * Diagnostic script that prints the most recent notifications with their
 * Expo push delivery tickets. Useful for verifying end-to-end push delivery
 * after deploying the new push observability code (lib/push.ts).
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/check-push-status.ts
 *
 *   # show only the user's own notifications
 *   MONGODB_URI=... USER_ID=<id> npx tsx scripts/check-push-status.ts
 *
 *   # show last N notifications (default 10)
 *   MONGODB_URI=... LIMIT=20 npx tsx scripts/check-push-status.ts
 */

// Run with: npx tsx --env-file=.env.local scripts/check-push-status.ts
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Notification, PushToken } from '../lib/models';

const LIMIT   = Number(process.env.LIMIT ?? 10);
const USER_ID = process.env.USER_ID;

function fmtDate(d: Date | undefined | null): string {
  if (!d) return '       (never)       ';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19);
}

async function main() {
  await connectDB();

  // Token registration overview
  const totalTokens = await PushToken.countDocuments({});
  const userScopeTokens = USER_ID
    ? await PushToken.countDocuments({ userId: new mongoose.Types.ObjectId(USER_ID) })
    : null;

  console.log('=== Push registration ===');
  console.log(`  Total registered tokens (all users): ${totalTokens}`);
  if (USER_ID) console.log(`  Tokens for USER_ID=${USER_ID}: ${userScopeTokens}`);

  // Print all (userId, platform) pairs so the operator knows whose token is whose
  const allTokens = await PushToken.find({}).select('userId platform updatedAt token').lean() as any[];
  if (allTokens.length > 0) {
    console.log('  Token roster:');
    for (const t of allTokens) {
      const tokenPreview = (t.token ?? '').slice(0, 30);
      console.log(`    userId=${t.userId.toString()}  platform=${t.platform ?? '?'}  token=${tokenPreview}…`);
    }
  }
  console.log('');

  // Recent notifications
  const filter: any = USER_ID
    ? { userId: new mongoose.Types.ObjectId(USER_ID) }
    : {};

  const recent = await Notification.find(filter)
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .lean() as any[];

  console.log(`=== Last ${recent.length} notifications ${USER_ID ? '(scoped)' : '(all users)'} ===\n`);

  if (recent.length === 0) {
    console.log('  No notifications found.');
    await mongoose.disconnect();
    return;
  }

  for (const n of recent) {
    const tickets: any[] = n.pushTickets ?? [];
    const okCount  = tickets.filter(t => t.status === 'ok').length;
    const errCount = tickets.filter(t => t.status === 'error').length;
    const tag = !n.pushSentAt
      ? 'IN-APP ONLY (no push attempted — likely no tokens at send time, or pre-deploy notification)'
      : `push: ${okCount} ok / ${errCount} err  @ ${fmtDate(n.pushSentAt)}`;

    console.log(`  ${fmtDate(n.createdAt)}  [${(n.type ?? 'general').padEnd(15)}]  ${n.title ?? ''}`);
    console.log(`    ${tag}`);

    for (const t of tickets) {
      if (t.status === 'ok') {
        console.log(`      ok    ticket=${t.ticketId ?? '(none)'}  token=${(t.token ?? '').slice(0, 24)}…`);
      } else {
        console.log(`      ERR   code=${t.expoErrorCode ?? '?'}  token=${(t.token ?? '').slice(0, 24)}…  msg=${(t.expoMessage ?? '').slice(0, 80)}`);
      }
    }
    console.log('');
  }

  // 24h summary
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent24 = await Notification.find({ ...filter, createdAt: { $gte: since } }).lean() as any[];

  let okTotal = 0;
  let errTotal = 0;
  const errBreakdown: Record<string, number> = {};
  let pushedNotifs = 0;
  let inAppOnly = 0;

  for (const n of recent24) {
    if (!n.pushSentAt) {
      inAppOnly++;
      continue;
    }
    pushedNotifs++;
    for (const t of (n.pushTickets ?? [])) {
      if (t.status === 'ok') {
        okTotal++;
      } else {
        errTotal++;
        const code = t.expoErrorCode ?? 'UNKNOWN';
        errBreakdown[code] = (errBreakdown[code] ?? 0) + 1;
      }
    }
  }

  console.log(`=== Last 24h ${USER_ID ? '(scoped)' : '(all users)'} ===`);
  console.log(`  Notifications:        ${recent24.length}`);
  console.log(`    With push attempt:  ${pushedNotifs}`);
  console.log(`    In-app only:        ${inAppOnly}`);
  console.log(`  Tickets:              ${okTotal + errTotal}`);
  console.log(`    OK:                 ${okTotal}`);
  console.log(`    Error:              ${errTotal}`);
  if (errTotal > 0) {
    console.log('  Error breakdown:');
    for (const [code, count] of Object.entries(errBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${code.padEnd(28)} ${count}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
