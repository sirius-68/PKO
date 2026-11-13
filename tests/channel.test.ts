/**
 * The 24/7 channel logic (src/shared/channel.ts): time zones, the weekly
 * programme plan, replays at the right offset and the wall-clock rotation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { airings, onNow, upNext, nextAiring, zoned, tzOffset, wall, dayMatches, rotation, SOURCES, type ChannelInput } from '../src/shared/channel.ts';

const B = (id: string, duration: number | null, hoursAgo: number) => ({ id, title: id, video: `${id}.mp4`, url: null, poster: null, duration, publishedAt: new Date(Date.UTC(2026, 10, 10) - hoursAgo * 3600e3).toISOString() });
const base = (over: Partial<ChannelInput> = {}): ChannelInput => ({
  live: { onAir: false, channel24: true, timezone: 'Africa/Douala' },
  broadcasts: [B('rock', 53 * 60, 1), B('douala', 176 * 60, 2), B('heaven', 60 * 60, 3), B('noLength', null, 0)],
  schedule: [
    { id: 'sun', days: 'Sundays', time: '09:00', end: '12:00', title: 'Sunday Service', source: SOURCES.live },
    { id: 'mid', days: 'Weekdays', time: '12:00', end: '12:15', title: 'Midday Word', source: SOURCES.rotation },
    { id: 'rock', days: 'Every day', time: '18:30', title: 'Christ the Rock', source: SOURCES.replay, broadcast: 'rock' },
    { id: 'pray', days: 'Every day', time: '21:00', end: '22:30', title: 'Prayer line', source: SOURCES.live },
  ],
  ...over,
});
// Douala is UTC+1 all year. 2026-11-15 is a Sunday.
const douala = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 1, m));

describe('time zones', () => {
  test('wall clock and offsets', () => {
    assert.equal(tzOffset(new Date(Date.UTC(2026, 10, 15, 12)), 'Africa/Douala'), 3600e3);
    assert.equal(tzOffset(new Date(Date.UTC(2026, 6, 1, 12)), 'Europe/London'), 3600e3);
    assert.equal(tzOffset(new Date(Date.UTC(2026, 0, 1, 12)), 'Europe/London'), 0);
    const w = wall(douala(15, 9, 30), 'Africa/Douala');
    assert.deepEqual([w.d, w.dow, w.mins], [15, 7, 570]);
  });
  test('zoned() handles daylight saving (New York, 8 March 2026)', () => {
    assert.equal(zoned(2026, 3, 7, 9 * 60, 'America/New_York').toISOString(), '2026-03-07T14:00:00.000Z');
    assert.equal(zoned(2026, 3, 8, 9 * 60, 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  });
  test('day rules', () => {
    assert.ok(dayMatches('Every day', 3) && dayMatches(null, 7));
    assert.ok(dayMatches('Weekdays', 5) && !dayMatches('Weekdays', 6));
    assert.ok(dayMatches('Weekends', 7) && !dayMatches('Weekends', 1));
    assert.ok(dayMatches('Sundays', 7) && !dayMatches('Sundays', 6) && dayMatches('Mondays', 1));
  });
});

describe('programme plan', () => {
  test('airings on a Sunday, with implicit end times', () => {
    const list = airings(base(), douala(15, 0), douala(16, 0));
    assert.deepEqual(list.map((a) => a.slot.id), ['sun', 'rock', 'pray']); // no Midday Word at weekends
    const rock = list.find((a) => a.slot.id === 'rock')!;
    assert.equal(rock.start.toISOString(), douala(15, 18, 30).toISOString());
    assert.equal((rock.end.getTime() - rock.start.getTime()) / 60e3, 53, 'a replay runs its own length');
  });
  test('a live slot without an end runs two hours, or until the next programme', () => {
    const input = base({ schedule: [{ id: 'a', time: '10:00', title: 'A' }, { id: 'b', time: '11:00', title: 'B' }] });
    const [a, b] = airings(input, douala(16, 9), douala(16, 14));
    assert.equal((a.end.getTime() - a.start.getTime()) / 60e3, 60);
    assert.equal((b.end.getTime() - b.start.getTime()) / 60e3, 120);
  });
  test('an end time before the start runs past midnight', () => {
    const input = base({ schedule: [{ id: 'n', time: '23:00', end: '01:00', title: 'Night vigil' }] });
    const a = airings(input, douala(16, 22), douala(17, 3)).find((x) => x.start >= douala(16, 22))!;
    assert.equal(a.end.toISOString(), douala(17, 1).toISOString());
    assert.equal(onNow(input, douala(17, 0, 30)).airing?.slot.id, 'n');
  });
  test('up next lists the coming programmes in order', () => {
    const n = upNext(base(), douala(16, 11, 0), 3); // Monday
    assert.deepEqual(n.map((a) => a.slot.id), ['mid', 'rock', 'pray']);
    assert.equal(nextAiring(base(), 'sun', douala(16, 11))?.start.toISOString(), douala(22, 9).toISOString());
  });
});

describe('what is on', () => {
  test('studio live wins over everything', () => {
    const n = onNow(base({ live: { onAir: true, channel24: true, timezone: 'Africa/Douala' } }), douala(15, 9, 30));
    assert.equal(n.kind, 'live');
    assert.equal(n.airing?.slot.id, 'sun');
  });
  test('channel switched off: off air between programmes', () => {
    const n = onNow(base({ live: { onAir: false, channel24: false, timezone: 'Africa/Douala' } }), douala(16, 15));
    assert.equal(n.kind, 'off');
    assert.equal(n.until?.toISOString(), douala(16, 18, 30).toISOString());
  });
  test('a scheduled replay plays from where it would be', () => {
    const n = onNow(base(), douala(16, 18, 40));
    assert.equal(n.kind, 'replay');
    assert.equal(n.video?.id, 'rock');
    assert.equal(Math.round(n.offset), 600);
    assert.equal(n.until?.toISOString(), douala(16, 19, 23).toISOString());
  });
  test('rotation: same answer for everyone, moves with the clock, skips unknown lengths', () => {
    const t = douala(16, 15, 7);
    const a = onNow(base(), t), b = onNow(base(), new Date(t));
    assert.equal(a.kind, 'rotation');
    assert.deepEqual([a.video?.id, Math.round(a.offset)], [b.video?.id, Math.round(b.offset)]);
    assert.ok(a.video!.duration! > a.offset);
    const later = onNow(base(), new Date(t.getTime() + 60e3));
    if (later.video?.id === a.video?.id) assert.equal(Math.round(later.offset - a.offset), 60);
    assert.ok(!rotation(base().broadcasts).some((v) => v.id === 'noLength'));
    // walking the clock visits every playable message
    const seen = new Set<string>();
    for (let m = 0; m < 6 * 60; m += 5) seen.add(onNow(base(), new Date(t.getTime() + m * 60e3)).video!.id);
    assert.deepEqual([...seen].sort(), ['douala', 'heaven', 'rock']);
  });
  test('a live slot without the studio on air falls back to rotation', () => {
    const n = onNow(base(), douala(16, 21, 15));
    assert.equal(n.kind, 'rotation');
    assert.equal(n.airing?.slot.id, 'pray');
  });
  test('nothing playable: off air', () => {
    assert.equal(onNow(base({ broadcasts: [] }), douala(16, 15)).kind, 'off');
  });
  test('an unknown time zone falls back to UTC instead of crashing', () => {
    const n = onNow(base({ live: { onAir: false, channel24: true, timezone: 'Mars/Olympus' } }), new Date(Date.UTC(2026, 10, 16, 18, 40)));
    assert.equal(n.kind, 'replay');
  });
});
