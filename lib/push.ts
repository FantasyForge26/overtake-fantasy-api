import { PushToken, Notification } from './models';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushData {
  screen?: string;
  leagueId?: string;
  [key: string]: any;
}

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: PushData;
  sound?: 'default';
}

async function sendExpoMessages(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('[push] Expo push send error:', err);
  }
}

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: PushData,
  type: 'draft_turn' | 'draft_reminder' | 'league_invite' | 'general' = 'general',
): Promise<void> {
  const tokens = await PushToken.find({ userId }).lean() as any[];

  // Save in-app notification regardless of push tokens
  await Notification.create({ userId, type, title, body, data, createdAt: new Date() });

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map(t => ({
    to: t.token,
    title,
    body,
    sound: 'default',
    ...(data && { data }),
  }));

  await sendExpoMessages(messages);
}

export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: PushData,
  type: 'draft_turn' | 'draft_reminder' | 'league_invite' | 'general' = 'general',
): Promise<void> {
  if (userIds.length === 0) return;

  const tokens = await PushToken.find({ userId: { $in: userIds } }).lean() as any[];

  // Save in-app notifications for all users
  await Notification.insertMany(
    userIds.map(userId => ({ userId, type, title, body, data, createdAt: new Date() })),
    { ordered: false },
  ).catch(() => {}); // ignore dup key errors

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map(t => ({
    to: t.token,
    title,
    body,
    sound: 'default',
    ...(data && { data }),
  }));

  await sendExpoMessages(messages);
}
