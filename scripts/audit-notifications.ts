/**
 * audit-notifications.ts
 *
 * Reports on the current state of in-app notifications: total counts,
 * read vs unread, top users by volume, and the most recent mark-read
 * activity (last time any notification was marked read).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/audit-notifications.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Notification } from '../lib/models';

async function main() {
  await connectDB();

  const total  = await Notification.countDocuments({});
  const unread = await Notification.countDocuments({ read: false });
  const read   = await Notification.countDocuments({ read: true });

  console.log('=== Notification corpus ===');
  console.log(`  Total:  ${total}`);
  console.log(`  Unread: ${unread}`);
  console.log(`  Read:   ${read}`);
  console.log('');

  const byUser: any[] = await Notification.aggregate([
    {
      $group: {
        _id: '$userId',
        total:  { $sum: 1 },
        unread: { $sum: { $cond: [{ $eq: ['$read', false] }, 1, 0] } },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 10 },
  ]);

  console.log('=== Top 10 users by notification volume ===');
  for (const u of byUser) {
    const userId = u._id?.toString() ?? '(null)';
    console.log(`  ${userId}  total=${u.total}  unread=${u.unread}  read=${u.total - u.unread}`);
  }
  console.log('');

  // Find the most recent _id where read=true (newest mark-read activity).
  // ObjectId timestamp ≈ creation time, but updateOne doesn't change _id, so
  // we look at createdAt instead — best proxy we have without an updatedAt field.
  const newestRead = await Notification.findOne({ read: true })
    .sort({ createdAt: -1 })
    .select('createdAt userId')
    .lean() as any;

  console.log('=== Mark-read activity ===');
  if (!newestRead) {
    console.log('  No notifications have ever been marked read.');
    console.log('  → mobile app may not be calling /api/notifications/mark-read,');
    console.log('    or the user has never tapped the bell on a non-empty unread list.');
  } else {
    console.log(`  Most recent created+read notification: ${newestRead.createdAt} (user ${newestRead.userId})`);
    console.log('  Note: createdAt is creation time, not mark-read time. The schema');
    console.log('        has no updatedAt field, so we can\'t distinguish.');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
