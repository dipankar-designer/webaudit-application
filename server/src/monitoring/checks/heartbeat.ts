// Heartbeat (cron) monitors: the customer's job requests a private URL; silence is an alert.

import type { CheckRunner } from '../types.js';

export const heartbeatCheck: CheckRunner = async ({ monitor }) => {
  const expectedEvery = monitor.interval_seconds;
  const grace = monitor.heartbeat_grace_seconds;
  if (!monitor.last_heartbeat_at) return { status: 'not_assessed', summary: 'Waiting for the first ping' };
  const ageS = Math.round((Date.now() - Date.parse(monitor.last_heartbeat_at)) / 1000);
  const detail = { lastPingAt: monitor.last_heartbeat_at, secondsSincePing: ageS, expectedEverySeconds: expectedEvery, graceSeconds: grace };
  if (ageS > expectedEvery + grace)
    return { status: 'down', severity: 'p2', summary: `No ping for ${formatAge(ageS)} (expected every ${formatAge(expectedEvery)}, grace ${formatAge(grace)})`, detail };
  return { status: 'up', summary: `Last ping ${formatAge(ageS)} ago`, detail };
};

function formatAge(s: number): string {
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
