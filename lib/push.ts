import * as Sentry from '@sentry/nextjs';
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

/**
 * One ticket per outgoing message. Mirrors Expo's response shape so we can
 * persist it to the Notification doc for observability.
 */
export interface PushTicket {
  token:         string;
  ticketId?:     string;
  status:        'ok' | 'error';
  expoErrorCode?: string;
  expoMessage?:  string;
}

/**
 * Sends one or more PushMessages to Expo's /push/send endpoint and returns
 * a normalized PushTicket[] with one entry per input message (in order).
 *
 * On network or HTTP failure we mark every ticket as status='error' with
 * expoErrorCode='TRANSPORT_FAILURE' so callers can persist the failure.
 *
 * Per-message Expo errors (DeviceNotRegistered, MessageRateExceeded, etc.)
 * are surfaced via expoErrorCode/expoMessage. The caller decides what to do.
 */
async function sendExpoMessages(messages: PushMessage[]): Promise<PushTicket[]> {
  if (messages.length === 0) return [];

  let resp: Response;
  try {
    resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('[push] Expo push transport error:', err);
    Sentry.captureMessage('expo push failure', {
      level: 'warning',
      extra: { stage: 'transport', error: err instanceof Error ? err.message : String(err), messageCount: messages.length },
    });
    return messages.map(m => ({
      token: m.to,
      status: 'error' as const,
      expoErrorCode: 'TRANSPORT_FAILURE',
      expoMessage: err instanceof Error ? err.message : String(err),
    }));
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`[push] Expo HTTP ${resp.status}: ${text.slice(0, 500)}`);
    Sentry.captureMessage('expo push failure', {
      level: 'warning',
      extra: { stage: 'http', status: resp.status, body: text.slice(0, 500), messageCount: messages.length },
    });
    return messages.map(m => ({
      token: m.to,
      status: 'error' as const,
      expoErrorCode: `HTTP_${resp.status}`,
      expoMessage: text.slice(0, 200),
    }));
  }

  let body: any;
  try {
    body = await resp.json();
  } catch (err) {
    console.error('[push] Expo response parse error:', err);
    Sentry.captureMessage('expo push failure', {
      level: 'warning',
      extra: { stage: 'parse', error: err instanceof Error ? err.message : String(err), messageCount: messages.length },
    });
    return messages.map(m => ({
      token: m.to,
      status: 'error' as const,
      expoErrorCode: 'PARSE_FAILURE',
      expoMessage: err instanceof Error ? err.message : String(err),
    }));
  }

  // Expo returns { data: PushTicketResponse[] } — one per input message in order.
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  return messages.map((m, i) => {
    const t = data[i];
    if (!t) {
      return {
        token: m.to,
        status: 'error',
        expoErrorCode: 'MISSING_TICKET',
        expoMessage: 'Expo returned fewer tickets than messages sent',
      };
    }
    if (t.status === 'ok') {
      return {
        token:    m.to,
        ticketId: t.id,
        status:   'ok',
      };
    }
    return {
      token:         m.to,
      ticketId:      t.id,
      status:        'error',
      expoErrorCode: t.details?.error ?? t.message ?? 'UNKNOWN',
      expoMessage:   t.message ?? '',
    };
  });
}

/**
 * Removes push tokens that Expo reports as no longer valid. Called after each
 * push attempt; idempotent and safe to invoke even when there are no errors.
 */
async function cleanupInvalidTokens(tickets: PushTicket[]): Promise<void> {
  const dead = tickets.filter(t => t.status === 'error' && t.expoErrorCode === 'DeviceNotRegistered');
  if (dead.length === 0) return;
  try {
    await PushToken.deleteMany({ token: { $in: dead.map(t => t.token) } });
    console.log(`[push] Cleaned up ${dead.length} DeviceNotRegistered tokens`);
  } catch (err) {
    console.error('[push] cleanupInvalidTokens failed:', err);
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

  // Save in-app notification first so we can attach push observability to it
  const notification = await Notification.create({
    userId, type, title, body, data, createdAt: new Date(),
  });

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map(t => ({
    to: t.token,
    title,
    body,
    sound: 'default',
    ...(data && { data }),
  }));

  const tickets = await sendExpoMessages(messages);
  await cleanupInvalidTokens(tickets);

  await Notification.updateOne(
    { _id: notification._id },
    { $set: { pushSentAt: new Date(), pushTickets: tickets } },
  ).catch(err => console.error('[push] failed to persist tickets:', err));
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

  // Save in-app notifications for all users; capture inserted docs so we can
  // attach per-user push tickets afterward.
  const inserted = await Notification.insertMany(
    userIds.map(userId => ({ userId, type, title, body, data, createdAt: new Date() })),
    { ordered: false },
  ).catch(() => [] as any[]);

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map(t => ({
    to: t.token,
    title,
    body,
    sound: 'default',
    ...(data && { data }),
  }));

  const tickets = await sendExpoMessages(messages);
  await cleanupInvalidTokens(tickets);

  // Group tickets by token, then map to userId via the original tokens query
  const tokenToUserId = new Map<string, string>();
  for (const t of tokens) tokenToUserId.set(t.token, t.userId.toString());

  const ticketsByUser = new Map<string, PushTicket[]>();
  for (const ticket of tickets) {
    const uid = tokenToUserId.get(ticket.token);
    if (!uid) continue;
    const arr = ticketsByUser.get(uid) ?? [];
    arr.push(ticket);
    ticketsByUser.set(uid, arr);
  }

  // Persist per-notification tickets
  const sentAt = new Date();
  await Promise.all(
    (inserted as any[]).map(n => {
      const userId = n.userId?.toString();
      const userTickets = userId ? ticketsByUser.get(userId) ?? [] : [];
      return Notification.updateOne(
        { _id: n._id },
        { $set: { pushSentAt: sentAt, pushTickets: userTickets } },
      ).catch(err => console.error('[push] failed to persist tickets:', err));
    }),
  );
}
