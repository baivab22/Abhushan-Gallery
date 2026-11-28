/**
 * Unit tests for the pure analytics date/source helpers.
 * Run with:  node scripts/test-analytics-time.js
 *
 * No database connection required.
 */

const assert = require("assert");
const {
  BUSINESS_TZ,
  getTimezoneOffsetMs,
  startOfDayInTz,
  resolveWindow,
  formatLabel,
  nextBucketKey,
  zeroFill,
  rollUpToFiveMinutes,
  classifySource
} = require("../utils/analyticsTime");

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
};

const at = (iso) => new Date(iso);

console.log(`\nAnalytics helpers — business timezone: ${BUSINESS_TZ}\n`);

// ── timezone offset ───────────────────────────────────────────────────────
console.log("timezone offset");
test("Kathmandu is UTC+05:45 (+345 minutes)", () => {
  assert.strictEqual(getTimezoneOffsetMs(at("2026-10-05T09:30:00Z"), "Asia/Kathmandu") / 60000, 345);
});

test("UTC reports zero offset", () => {
  assert.strictEqual(getTimezoneOffsetMs(at("2026-10-05T09:30:00Z"), "UTC"), 0);
});

test("offset respects DST (New York winter vs summer)", () => {
  const winter = getTimezoneOffsetMs(at("2026-01-15T12:00:00Z"), "America/New_York") / 60000;
  const summer = getTimezoneOffsetMs(at("2026-07-15T12:00:00Z"), "America/New_York") / 60000;
  assert.strictEqual(winter, -300, "EST should be -300");
  assert.strictEqual(summer, -240, "EDT should be -240");
});

// ── start of day ──────────────────────────────────────────────────────────
console.log("\nstart of day");
test("returns real midnight in the business timezone", () => {
  const start = startOfDayInTz(at("2026-10-05T09:30:00Z"), "Asia/Kathmandu");
  const wall = new Date(start.getTime() + getTimezoneOffsetMs(start, "Asia/Kathmandu"));
  assert.strictEqual(wall.toISOString().slice(0, 19), "2026-10-05T00:00:00");
});

test("late-evening UTC still maps to the correct local day", () => {
  // 2026-10-05T20:00Z is 2026-10-06 01:45 in Kathmandu -> local day is the 6th.
  const start = startOfDayInTz(at("2026-10-05T20:00:00Z"), "Asia/Kathmandu");
  assert.strictEqual(start.toISOString(), "2026-10-05T18:15:00.000Z");
});

test("a time before local midnight belongs to the previous day", () => {
  // 2026-10-05T18:00Z is 2026-10-05 23:45 in Kathmandu -> still the 5th.
  const start = startOfDayInTz(at("2026-10-05T18:00:00Z"), "Asia/Kathmandu");
  assert.strictEqual(start.toISOString(), "2026-10-04T18:15:00.000Z");
});

// ── range windows ─────────────────────────────────────────────────────────
console.log("\nrange windows");
test("'today' starts at local midnight, not a rolling 24h window", () => {
  const {start} = resolveWindow("today", at("2026-10-05T09:30:00Z"));
  assert.strictEqual(start.toISOString(), "2026-10-04T18:15:00.000Z");
});

test("'today' is shorter than 24h when measured mid-morning", () => {
  const {start, end} = resolveWindow("today", at("2026-10-05T09:30:00Z"));
  const hours = (end - start) / 3_600_000;
  assert.ok(hours < 24 && hours > 0, `expected < 24h, got ${hours}`);
});

test("'hour' uses minute buckets, 'today' uses hourly, others daily", () => {
  const now = at("2026-10-05T09:30:00Z");
  assert.strictEqual(resolveWindow("hour", now).config.bucket, "minute");
  assert.strictEqual(resolveWindow("today", now).config.bucket, "hour");
  assert.strictEqual(resolveWindow("week", now).config.bucket, "day");
  assert.strictEqual(resolveWindow("month", now).config.bucket, "day");
  assert.strictEqual(resolveWindow("year", now).config.bucket, "day");
});

test("'week' spans exactly seven days, aligned to local midnight", () => {
  const {start} = resolveWindow("week", at("2026-10-05T09:30:00Z"));
  const wall = new Date(start.getTime() + getTimezoneOffsetMs(start, BUSINESS_TZ));
  assert.strictEqual(wall.toISOString().slice(0, 19), "2026-09-28T00:00:00");
});

// ── labels ────────────────────────────────────────────────────────────────
console.log("\nbucket labels");
test("day labels render as short date", () => {
  assert.strictEqual(formatLabel("2026-10-05", "day"), "Oct 5");
});

test("hour labels use 12-hour clock", () => {
  assert.strictEqual(formatLabel("2026-10-05T14:00", "hour"), "2 PM");
  assert.strictEqual(formatLabel("2026-10-05T00:00", "hour"), "12 AM");
  assert.strictEqual(formatLabel("2026-10-05T12:00", "hour"), "12 PM");
});

test("minute labels keep the minute component", () => {
  assert.strictEqual(formatLabel("2026-10-05T14:35", "minute"), "2:35 PM");
});

// ── bucket stepping ───────────────────────────────────────────────────────
console.log("\nbucket stepping");
test("hour buckets advance one hour", () => {
  assert.strictEqual(nextBucketKey("2026-10-05T14:00", "hour"), "2026-10-05T15:00");
});

test("minute buckets advance five minutes", () => {
  assert.strictEqual(nextBucketKey("2026-10-05T14:35", "minute"), "2026-10-05T14:40");
});

test("day buckets roll over the month boundary", () => {
  assert.strictEqual(nextBucketKey("2026-10-31", "day"), "2026-11-01");
});

test("hour buckets roll over midnight into the next day", () => {
  assert.strictEqual(nextBucketKey("2026-10-05T23:00", "hour"), "2026-10-06T00:00");
});

test("day stepping handles a leap day", () => {
  assert.strictEqual(nextBucketKey("2028-02-28", "day"), "2028-02-29");
  assert.strictEqual(nextBucketKey("2028-02-29", "day"), "2028-03-01");
});

// ── zero fill ─────────────────────────────────────────────────────────────
console.log("\nzero fill");
test("fills gaps between buckets so the chart stays continuous", () => {
  const filled = zeroFill(
    [
      {bucket: "2026-10-05T09:00", pageViews: 5, uniqueVisitors: 4},
      {bucket: "2026-10-05T12:00", pageViews: 2, uniqueVisitors: 2}
    ],
    "hour"
  );
  assert.deepStrictEqual(
    filled.map(b => b.bucket),
    ["2026-10-05T09:00", "2026-10-05T10:00", "2026-10-05T11:00", "2026-10-05T12:00"]
  );
  assert.deepStrictEqual(
    filled.map(b => b.pageViews),
    [5, 0, 0, 2]
  );
});

test("every filled bucket carries a display label", () => {
  const filled = zeroFill([{bucket: "2026-10-05", pageViews: 1, uniqueVisitors: 1}], "day");
  assert.strictEqual(filled[0].label, "Oct 5");
});

test("no rows yields no buckets", () => {
  assert.deepStrictEqual(zeroFill([], "day"), []);
});

// ── five minute rollup ────────────────────────────────────────────────────
console.log("\nfive-minute rollup");
test("groups minutes into 5-minute blocks", () => {
  const rolled = rollUpToFiveMinutes([
    {bucket: "2026-10-05T14:31", pageViews: 1, uniqueVisitors: 1},
    {bucket: "2026-10-05T14:32", pageViews: 2, uniqueVisitors: 2},
    {bucket: "2026-10-05T14:34", pageViews: 3, uniqueVisitors: 2}
  ]);
  assert.strictEqual(rolled.length, 1);
  assert.strictEqual(rolled[0].bucket, "2026-10-05T14:30");
  assert.strictEqual(rolled[0].pageViews, 6);
});

test("separate blocks stay separate and ordered", () => {
  const rolled = rollUpToFiveMinutes([
    {bucket: "2026-10-05T14:31", pageViews: 1, uniqueVisitors: 1},
    {bucket: "2026-10-05T14:37", pageViews: 5, uniqueVisitors: 4}
  ]);
  assert.deepStrictEqual(rolled.map(b => b.bucket), ["2026-10-05T14:30", "2026-10-05T14:35"]);
  assert.strictEqual(rolled[0].label, "2:30 PM");
});

// ── source classification ─────────────────────────────────────────────────
console.log("\ntraffic sources");
const cases = [
  [undefined, "Direct"],
  ["", "Direct"],
  ["https://www.google.com/search?q=earrings", "Google"],
  ["https://l.facebook.com/l.php?u=123", "Facebook"],
  ["https://www.facebook.com/", "Facebook"],
  ["https://www.instagram.com/p/abc/", "Instagram"],
  ["https://wa.me/9779768620644", "WhatsApp"],
  ["https://www.youtube.com/watch?v=x", "YouTube"],
  ["https://t.me/channel", "Other"],
  ["https://abhushangallery.com/product/1", "Internal"],
  ["https://www.abhushangallery.com/", "Internal"],
  ["http://localhost:3010/", "Internal"],
  ["https://some-random-blog.io/post", "Other"]
];

for (const [referrer, expected] of cases) {
  test(`${String(referrer || "(none)").slice(0, 42)} -> ${expected}`, () => {
    assert.strictEqual(classifySource(referrer).source, expected);
  });
}

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);