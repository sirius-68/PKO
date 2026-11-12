/**
 * Seeds an empty database with the ministry's starter content (ported from the
 * original single-file prototype) and the bundled photos/videos. Safe to run twice:
 * it only seeds when there is no content yet.
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Deps } from './app.ts';
import { createItem, saveLive, saveSettings } from './content.ts';
import { createAdmin } from './auth.ts';

const SEED_MEDIA = resolve(import.meta.dirname, '../seed/media');
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export function seed(d: Deps, opts: { adminEmail?: string; adminPassword?: string; adminName?: string } = {}): { seeded: boolean; adminCreated: boolean } {
  const { db, media } = d;
  let adminCreated = false;
  const hasAdmin = (db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n > 0;
  if (!hasAdmin && opts.adminEmail && opts.adminPassword) {
    createAdmin(db, opts.adminEmail, opts.adminName || 'Media team', opts.adminPassword);
    adminCreated = true;
  }
  const hasContent = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n > 0;
  if (hasContent) return { seeded: false, adminCreated };

  // media: copy bundled files into the media dir with stable ids
  const M: Record<string, string> = {};
  for (const f of readdirSync(SEED_MEDIA)) {
    const id = 'seed_' + f;
    const dest = join(media.dir, id);
    if (!existsSync(dest)) copyFileSync(join(SEED_MEDIA, f), dest);
    media.register(id, f);
    M[f.replace(/\.\w+$/, '')] = id;
  }
  const ex = media.exists;
  const add = (col: string, data: Record<string, unknown>, h = 0) => createItem(db, col, { ...data, publishedAt: ago(h) }, ex);

  saveSettings(db, {
    aboutVerse: 'All thy works shall praise thee, O LORD; and thy saints shall bless thee. They shall speak of the glory of thy kingdom, and talk of thy power; to make known to the sons of men his mighty acts, and the glorious majesty of his kingdom.',
    aboutVerseRef: 'Psalm 145:10–12 (KJV)', logo: M.logo, leaderPhoto: M.p_white,
  }, ex);
  saveLive(db, { onAir: true, title: 'The Anointing of Jesus', ref: 'Luke 4:14-21', video: M.v_anoint, poster: M.f_anoint }, ex);

  const posts: [string, string, string, string, string, string[], number][] = [
    ['Light that does not flicker', 'Morning Word', 'p_teal', 'center 30%', 'And was transfigured before them: and his face did shine as the sun, and his raiment was white as the light.|Matthew 17:2', [
      'Peter, James and John climbed the mountain expecting another ordinary prayer meeting. What they met was a light that came from the inside out. Jesus did not borrow His glory from the sun; the sun was simply the nearest picture they had for it.',
      'Many of us live by reflected light. We shine when the week is good, when the bills are paid, when someone speaks well of us. Then a cloud passes and the brightness goes with it. That is borrowed light, and borrowed light always flickers.',
      'The light God wants to grow in you does not depend on the weather around you. It is kindled in prayer, fed by the Word and protected by obedience. Today, before you check your phone, give the first ten minutes to Him.',
      'Carry this into your day: I will not live on reflected light. The One who shone on the mountain lives in me.'], 6],
    ['Six days later', 'Teaching', 'p_navy1', 'center 25%', 'And after six days Jesus taketh Peter, James, and John his brother, and bringeth them up into an high mountain apart.|Matthew 17:1', [
      'Before the mountain there were six days. Six days of walking, of waiting, of ordinary bread and ordinary roads. Scripture does not tell us much about them, and that is the point. Glory is often prepared in days nobody writes about.',
      'If you are in your six days, do not despise them. God is not late. He is preparing the climb, choosing the company and setting the time.'], 26],
    ['Staying on the mountain is not the assignment', 'Teaching', 'p_dubai', 'center 30%', 'Lord, it is good for us to be here: if thou wilt, let us make here three tabernacles.|Matthew 17:4', [
      'Peter wanted to build tents and stay. Who can blame him? But the mountain was a meeting place, not a dwelling place. The boy who needed deliverance was at the bottom of the hill.',
      'Every encounter with God comes with a descent. You are lifted so that you can carry something back down.'], 24 * 7],
    ['Hear ye him', 'Prophetic', 'p_white', 'center 20%', 'This is my beloved Son, in whom I am well pleased; hear ye him.|Matthew 17:5', [
      'When the cloud came, the instruction was simple: hear Him. Not Moses first, not Elijah first, not our plans first. Him.',
      'This season, the Lord is calling His people back to listening. Before you speak to the situation, let Him speak to you.'], 24 * 11],
    ['Jesus only', 'Morning Word', 'p_pray', 'center 20%', 'And when they had lifted up their eyes, they saw no man, save Jesus only.|Matthew 17:8', [
      'When the vision ended, the disciples were not left empty. They were left with Jesus. When the lights of the service go off and the music stops, He remains.',
      'Lift your eyes today and look past every other voice. What remains is enough.'], 24 * 13],
    ['Arise, shine', 'Prophetic', 'p_sing', 'center 35%', 'Arise, shine; for thy light is come, and the glory of the LORD is risen upon thee.|Isaiah 60:1', [
      'Notice the order: the light comes first, then the command to shine. God never asks you to produce what He has not first provided.',
      'Your part is to arise. Get up from the place of discouragement and let what He put in you be seen.'], 24 * 17],
  ];
  const blogParas: string[] = [];
  for (const [title, flair, img, pos, vr, body, h] of posts) {
    const [verse, ref] = vr.split('|');
    add('posts', { title, flair, image: M[img], imagePos: pos, verse, ref, body }, h);
    blogParas.push(...body);
  }

  add('broadcasts', { title: 'Douala Ndogbong crusade', ref: 'Hebrews 9:19', category: 'Crusades', video: M.v_douala, poster: M.f_douala }, 24 * 20);
  add('broadcasts', { title: 'Heaven’s Gate: prophetic ministration', ref: 'Ministration', category: 'Ministration', video: M.v_heaven, poster: M.f_heaven }, 24 * 7);
  add('broadcasts', { title: 'Christ the Rock', ref: '1 Corinthians 10:3-4', category: 'Teachings', video: M.v_rock, poster: M.f_rock }, 24 * 4);

  const sample = (desc: string) => [
    { title: 'Introduction', body: [desc, 'This sample chapter is starter content. Replace it from the creator dashboard with the book’s real text, or attach the PDF edition.'] },
    { title: 'The light that came from within', body: blogParas.slice(0, 6) },
  ];
  const books: [string, string, string, number, number, string][] = [
    ['The Mountain of Transfiguration', 'p_dubai', 'center 30%', 248, 2024, 'A walk up the mountain with Peter, James and John, and what it means for believers today to be changed from glory to glory.'],
    ['Garments of Light', 'p_white', 'center 30%', 186, 2023, 'On holiness, identity and the righteousness God clothes His children with.'],
    ['A Voice from the Cloud', 'p_teal', '42% center', 204, 2022, 'Learning to hear God clearly in a noisy season, with prayer exercises at the end of every chapter.'],
    ['The Prophetic Prayer Manual', 'p_pray', 'center 25%', 312, 2025, 'Thirty days of guided prayer, scripture declarations and journal prompts.'],
    ['Seasons of Glory', 'p_navy2', 'center 25%', 172, 2021, 'Why God works in seasons, and how to stay faithful in each one.'],
    ['The Altar Within', 'p_preach', '55% center', 156, 2020, 'Building a private place of worship that no crowd can give and no crisis can take away.'],
  ];
  for (const [title, img, pos, pages, year, description] of books) add('books', { title, image: M[img], imagePos: pos, pages, year, description, chapters: sample(description) });

  const albums: [string, number, string, string, string, [string, number][], number][] = [
    ['Live at Transfiguration Night', 2024, 'f_crowd2', 'center', 'Transfiguration Choir (Live)', [['Opening Praise Medley', 534], ['Worthy Is the Lamb', 318], ['We Lift Our Eyes', 287], ['Transfiguration Night', 402]], 24 * 300],
    ['Midnight Altar', 2025, 'p_navy1', 'center 30%', 'Transfiguration Choir', [['Midnight Altar', 412], ['Fire on the Mountain', 265], ['Arise and Shine', 247], ['Breathe on Me', 330], ['Holy Ground', 296]], 24 * 120],
    ['Glory on the Mountain', 2026, 'p_sing', '58% center', 'Prophet Kevin & Transfiguration Choir', [['Garments of Light', 283], ['Glory on the Mountain', 341], ['Hear Ye Him', 256], ['Six Days Later', 219], ['Jesus Only', 302], ['From Glory to Glory', 388]], 72],
  ];
  for (const [title, year, img, pos, artist, tracks, h] of albums) add('albums', { title, year, image: M[img], imagePos: pos, artist, tracks: tracks.map(([t, dur]) => ({ title: t, duration: dur })) }, h);

  const events: [string, string, string, string, string | null, string, string][] = [
    ['2026-11-13', 'Transfiguration Night', '21:00 – 04:00', 'Main auditorium and Transfiguration TV', 'p_sing', '58% center', 'An all-night service of worship, the Word and prophetic prayer. Come with your prayer points and expectation.'],
    ['2026-11-15', 'Sunday Encounter Service', '09:00 – 12:00', 'Main auditorium', 'p_navy1', 'center 25%', 'Our weekly gathering. Children’s church runs in the east hall.'],
    ['2026-11-18', 'Midweek Bible Study', '18:30 – 20:00', 'Fellowship hall and online', 'p_pray', 'center 25%', 'We continue through the Gospel of Matthew. Bring your Bible and a notebook.'],
    ['2026-11-22', 'Sunday Encounter Service', '09:00 – 12:00', 'Main auditorium', 'p_navy2', 'center 25%', 'Our weekly gathering. Children’s church runs in the east hall.'],
    ['2026-11-26', 'Prophetic Encounter Conference', 'Thu 26 – Sat 28 Nov', 'Main auditorium', 'f_crowd2', 'center', 'Three days of teaching, impartation and worship with guest ministers. Registration is free.'],
    ['2026-11-29', 'Sunday Encounter Service', '09:00 – 12:00', 'Main auditorium', 'p_navy1', 'center 25%', 'Our weekly gathering.'],
    ['2026-12-05', 'Youth Fire Camp', '08:00 – 18:00', 'Church grounds', null, 'center', 'A day of games, worship and the Word for ages 13 to 25.'],
    ['2026-12-20', 'Carols by Candlelight', '18:00 – 20:30', 'Main auditorium', null, 'center', 'The Transfiguration Choir leads an evening of carols. Bring a friend.'],
    ['2026-12-31', 'Crossover Service', '21:00 – 01:00', 'Main auditorium and Transfiguration TV', 'p_preach', '55% center', 'Cross into 2027 in worship and prophetic declarations.'],
  ];
  for (const [date, title, time, place, img, pos, description] of events) add('events', { date, title, time, place, image: img ? M[img] : null, imagePos: pos, description }, 48);

  const testi: [string, string, string, string, string, string[], number][] = [
    ['The Fon family', 'Yaoundé', 'Our son came home', 'He left home at 17. At 21 he walked back through our door.', '', ['A family’s story of four years of prayer and one phone call.'], 24 * 14],
    ['Brother Samuel T.', 'Accra', 'Set free from a habit I hid for ten years', 'I am writing this so someone else knows freedom is possible.', '', ['For ten years I hid it from everyone, even my wife. During the midnight prayer line I finally confessed and asked for help.', 'It has been four months. I am free, and my home is at peace.'], 24 * 7],
    ['Sister Mirabel A.', 'Buea', 'From closing my shop to opening a second one', 'In January I was ready to close. In October I opened a second branch.', '', ['Mirabel shares how she followed the counsel from the Prophet’s teaching on faithfulness in small things.'], 24 * 4],
    ['Daniel K.', 'London', 'My visa was approved after it was refused twice', 'The third application went through in nine days.', '', ['I had been refused twice and was ready to give up. During Transfiguration Night I wrote my request and brought it to the altar online.', 'Nine days after I applied again, it was approved. God changed the outcome.'], 48],
    ['Emeka & Joy O.', 'Lagos', 'Our twins arrived safely', 'After seven years of waiting, we held our twins.', '', ['We joined the prayer line every Friday for a year. Today we came back to say thank you, holding two babies.'], 24],
    ['Grace N.', 'Douala', 'Healed after three years of back pain', 'I stood up from my seat during the Sunday service without the pain I had carried for three years.', '', ['For three years I could not sit for more than twenty minutes. Doctors gave me exercises and painkillers, and I did everything they said.', 'On Sunday the Prophet prayed for everyone watching who had pain in their back. I put my hand where it hurt and said Amen. When I stood up at the end of the service, the pain was gone.', 'I give God all the glory.'], 3],
  ];
  for (const [name, place, title, quote, , body, h] of testi) add('testimonies', { name, place, title, quote, body }, h);

  const photos: [string, string, string][] = [
    ['f_crowd2', 'Services', 'Hands raised in praise'], ['w_redseat', 'Crusade nights', 'Front row, crusade night'], ['p_navy2', 'Services', 'Sunday service'],
    ['w_redwalk', 'Crusade nights', 'Crusade night'], ['p_teal', 'Portraits', 'Prophet Kevin'], ['w_yellow', 'Services', 'Standing in worship'],
    ['p_car', 'Crusade nights', 'Arriving for the night service'], ['f_crowd1', 'Services', 'The congregation in worship'], ['p_white', 'Portraits', 'Prophet Kevin'],
    ['w_redcar', 'Crusade nights', 'Arriving for the crusade'], ['p_pray', 'Services', 'A moment of prayer'], ['p_preach', 'Crusade nights', 'Preaching under the canopy'],
    ['p_dubai', 'Dubai Prophetic Visitation', 'Day 2, morning session'], ['w_green', 'Services', 'Taking notes during the Word'], ['p_sing', 'Crusade nights', 'Worship on the crusade stage'],
    ['p_navy1', 'Services', 'At the altar, Sunday service'],
  ];
  photos.forEach(([img, album, caption], i) => add('photos', { image: M[img], album, caption }, 30 - i));

  const sched: [string, string, string][] = [['12:00', 'Midday Word', '15 minutes in the Scriptures'], ['18:30', 'Christ the Rock', 'Replay with live chat'], ['21:00', 'Midnight prayer line', 'Bring your prayer points']];
  for (const [time, title, subtitle] of sched) add('schedule', { time, title, subtitle });

  return { seeded: true, adminCreated };
}
