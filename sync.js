// ============================================================
// NOTION → TRADING JOURNAL  Sync Script
// Node.js  |  npm install @notionhq/client pg dotenv
// ============================================================
// Setup:
//   1. Go to https://www.notion.so/my-integrations → New integration
//   2. Copy the "Internal Integration Secret" → NOTION_TOKEN
//   3. Open your journal database in Notion → Share → Invite your integration
//   4. Copy the database ID from the URL → NOTION_DATABASE_ID
//      URL format: notion.so/{workspace}/{DATABASE_ID}?v=...
//   5. Fill in your Postgres connection string → DATABASE_URL
// ============================================================

import { Client } from "@notionhq/client";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── Notion property helpers ──────────────────────────────────
const getText = (prop) =>
  prop?.rich_text?.map((r) => r.plain_text).join("") ||
  prop?.title?.map((r) => r.plain_text).join("") ||
  "";

const getSelect = (prop) => prop?.select?.name || null;
const getMultiSelect = (prop) => prop?.multi_select?.map((s) => s.name) || [];
const getNumber = (prop) => prop?.number ?? null;
const getDate = (prop) => prop?.date?.start || null;
const getCheckbox = (prop) => prop?.checkbox ?? false;
const getUrl = (prop) => prop?.url || null;

// ── Map a Notion page → journal_day row ─────────────────────
function mapPageToDay(page) {
  const p = page.properties;
  return {
    notion_page_id: page.id,
    trade_date: getDate(p["Date"]),
    instrument: getText(p["Instrument"]) || "NQ",
    day_bias: getSelect(p["Day Bias"]),
    premarket_analysis: getText(p["Pre-market Analysis"]),
    premarket_chart_url: getUrl(p["Pre-market Chart"]),
    postmarket_summary: getText(p["Post-market Summary"]),
    key_lesson: getText(p["Key Lesson"]),
    emotional_state: getNumber(p["Emotional State"]),
    emotion_tags: getMultiSelect(p["Emotion Tags"]),
    notion_last_synced: new Date().toISOString(),
  };
}

// ── Map a Notion sub-page / callout → trade_setup row ───────
function mapBlockToSetup(block, dayId) {
  // Expects a Notion "Toggle" or "Callout" block with these child paragraphs:
  //   Setup Type: Continuation OB
  //   Entry: 24780
  //   SL: 24720
  //   TP: 24900
  //   Result: win
  //   PnL: 120
  //   R:R: 2.5
  //   Taken: yes
  //   Skipped Reason: PM session uncertainty
  const text = block.callout?.rich_text?.[0]?.plain_text || "";
  const lines = text.split("\n");
  const get = (key) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(key.toLowerCase() + ":"));
    return line ? line.split(":").slice(1).join(":").trim() : null;
  };
  return {
    day_id: dayId,
    notion_block_id: block.id,
    instrument: get("Instrument") || "NQ",
    setup_type: get("Setup Type"),
    htf_bias: get("HTF Bias"),
    entry_tf: get("Entry TF"),
    entry_price: parseFloat(get("Entry")) || null,
    stop_loss: parseFloat(get("SL")) || null,
    take_profit: parseFloat(get("TP")) || null,
    taken: get("Taken")?.toLowerCase() === "yes",
    reason_skipped: get("Skipped Reason"),
    trade_result: get("Result"),
    exit_price: parseFloat(get("Exit")) || null,
    pnl: parseFloat(get("PnL")) || null,
    rr_ratio: parseFloat(get("R:R")) || null,
  };
}

// ── Upsert a journal day ─────────────────────────────────────
async function upsertDay(data) {
  const {
    notion_page_id, trade_date, instrument, day_bias,
    premarket_analysis, premarket_chart_url, postmarket_summary,
    key_lesson, emotional_state, emotion_tags, notion_last_synced,
  } = data;

  const { rows } = await db.query(
    `INSERT INTO journal_day
       (notion_page_id, trade_date, instrument, day_bias,
        premarket_analysis, premarket_chart_url, postmarket_summary,
        key_lesson, emotional_state, emotion_tags, notion_last_synced)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (notion_page_id) DO UPDATE SET
       trade_date          = EXCLUDED.trade_date,
       instrument          = EXCLUDED.instrument,
       day_bias            = EXCLUDED.day_bias,
       premarket_analysis  = EXCLUDED.premarket_analysis,
       premarket_chart_url = EXCLUDED.premarket_chart_url,
       postmarket_summary  = EXCLUDED.postmarket_summary,
       key_lesson          = EXCLUDED.key_lesson,
       emotional_state     = EXCLUDED.emotional_state,
       emotion_tags        = EXCLUDED.emotion_tags,
       notion_last_synced  = EXCLUDED.notion_last_synced,
       updated_at          = now()
     RETURNING id`,
    [notion_page_id, trade_date, instrument, day_bias,
     premarket_analysis, premarket_chart_url, postmarket_summary,
     key_lesson, emotional_state, emotion_tags, notion_last_synced]
  );
  return rows[0].id;
}

// ── Upsert a trade setup ─────────────────────────────────────
async function upsertSetup(data) {
  const {
    day_id, notion_block_id, instrument, setup_type, htf_bias,
    entry_tf, entry_price, stop_loss, take_profit, taken,
    reason_skipped, trade_result, exit_price, pnl, rr_ratio,
  } = data;

  await db.query(
    `INSERT INTO trade_setup
       (day_id, notion_block_id, instrument, setup_type, htf_bias,
        entry_tf, entry_price, stop_loss, take_profit, taken,
        reason_skipped, trade_result, exit_price, pnl, rr_ratio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (notion_block_id) DO UPDATE SET
       setup_type     = EXCLUDED.setup_type,
       htf_bias       = EXCLUDED.htf_bias,
       entry_price    = EXCLUDED.entry_price,
       stop_loss      = EXCLUDED.stop_loss,
       take_profit    = EXCLUDED.take_profit,
       taken          = EXCLUDED.taken,
       reason_skipped = EXCLUDED.reason_skipped,
       trade_result   = EXCLUDED.trade_result,
       pnl            = EXCLUDED.pnl,
       rr_ratio       = EXCLUDED.rr_ratio`,
    [day_id, notion_block_id, instrument, setup_type, htf_bias,
     entry_tf, entry_price, stop_loss, take_profit, taken,
     reason_skipped, trade_result, exit_price, pnl, rr_ratio]
  );
}

// ── Main sync ────────────────────────────────────────────────
async function syncFromNotion() {
  console.log("⟳  Starting Notion sync…");

  let cursor;
  let pagesSynced = 0;

  do {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      sorts: [{ property: "Date", direction: "descending" }],
      start_cursor: cursor,
    });

    for (const page of response.results) {
      try {
        const dayData = mapPageToDay(page);
        if (!dayData.trade_date) continue;

        const dayId = await upsertDay(dayData);

        // Fetch child blocks (callout blocks = trade setups)
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        for (const block of blocks.results) {
          if (block.type === "callout") {
            const setupData = mapBlockToSetup(block, dayId);
            if (setupData.setup_type) await upsertSetup(setupData);
          }
        }

        pagesSynced++;
        console.log(`  ✓  ${dayData.trade_date} — ${dayData.instrument}`);
      } catch (err) {
        console.error(`  ✗  Page ${page.id}: ${err.message}`);
      }
    }

    cursor = response.next_cursor;
  } while (cursor);

  console.log(`\n✅  Sync complete — ${pagesSynced} days synced`);
  await db.end();
}

syncFromNotion().catch(console.error);

// ── Run on a schedule (every 15 min) ─────────────────────────
// Add this to your server or use a cron job:
//   */15 * * * * node sync.js
//
// Or with node-cron inside your Express server:
//   import cron from 'node-cron';
//   cron.schedule('*/15 * * * *', syncFromNotion);
