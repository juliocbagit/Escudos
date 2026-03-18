import { getStore } from "@netlify/blobs";

const STORE_NAME = "escudos-do-brasil-recordes";
const SERIES_RANK = { D: 1, C: 2, B: 3, A: 4 };
const MAX_SCORE_ABS = 200;
const MAX_ROUND = 200;

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function sanitizeName(value = "") {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 24);
}

function slugify(value = "") {
  return sanitizeName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSeries(value = "") {
  const series = String(value || "").toUpperCase();
  return Object.hasOwn(SERIES_RANK, series) ? series : "D";
}

function titleLabel(titles = 0) {
  if (titles <= 0) return "";
  if (titles === 1) return "Campeão";
  if (titles === 2) return "Bicampeão";
  if (titles === 3) return "Tricampeão";
  return `${titles}x campeão`;
}

function stageWeight(entry) {
  const titles = numeric(entry?.titles, 0);
  if (titles > 0) return 1000 + titles;
  return SERIES_RANK[normalizeSeries(entry?.bestSeries || entry?.lastSeries || "D")] || 0;
}

function displayStage(entry) {
  const titles = numeric(entry?.titles, 0);
  if (titles > 0) return titleLabel(titles);
  return `Série ${normalizeSeries(entry?.bestSeries || entry?.lastSeries || "D")}`;
}

function compareEntries(a, b) {
  const stageDiff = stageWeight(b) - stageWeight(a);
  if (stageDiff !== 0) return stageDiff;

  const pointsDiff = numeric(b.totalPoints, numeric(b.bestScore, numeric(b.lastScore, 0))) - numeric(a.totalPoints, numeric(a.bestScore, numeric(a.lastScore, 0)));
  if (pointsDiff !== 0) return pointsDiff;

  const scoreDiff = numeric(b.lastScore, 0) - numeric(a.lastScore, 0);
  if (scoreDiff !== 0) return scoreDiff;

  return String(a.displayName).localeCompare(String(b.displayName), "pt-BR", { sensitivity: "base" });
}

function normalizeExisting(entry = {}) {
  return {
    slug: entry.slug || "",
    displayName: sanitizeName(entry.displayName || ""),
    bestSeries: normalizeSeries(entry.bestSeries || entry.lastSeries || "D"),
    titles: numeric(entry.titles, 0),
    totalPoints: numeric(entry.totalPoints, numeric(entry.bestScore, numeric(entry.lastScore, 0))),
    gamesPlayed: numeric(entry.gamesPlayed, 0),
    bestAt: entry.bestAt || entry.lastAt || null,
    lastScore: numeric(entry.lastScore, numeric(entry.bestScore, 0)),
    lastSeries: normalizeSeries(entry.lastSeries || entry.bestSeries || "D"),
    lastRound: numeric(entry.lastRound, numeric(entry.bestRound, 1)),
    lastAt: entry.lastAt || entry.bestAt || null,
    lastEasyMode: Boolean(entry.lastEasyMode),
  };
}

async function getLeaderboard(store) {
  const { blobs } = await store.list({ prefix: "players/" });
  if (!blobs.length) {
    return { leaderboard: [], totalPlayers: 0 };
  }

  const records = await Promise.all(
    blobs.map(async ({ key }) => {
      try {
        return await store.get(key, { type: "json", consistency: "strong" });
      } catch {
        return null;
      }
    }),
  );

  const valid = records
    .filter((entry) => entry && sanitizeName(entry.displayName || ""))
    .map((entry) => normalizeExisting(entry));

  valid.sort(compareEntries);

  return {
    leaderboard: valid.slice(0, 10).map((entry) => ({
      displayName: entry.displayName,
      displayStage: displayStage(entry),
      bestSeries: entry.bestSeries,
      titles: entry.titles,
      totalPoints: entry.totalPoints,
      gamesPlayed: entry.gamesPlayed || 1,
      lastScore: entry.lastScore,
      lastSeries: entry.lastSeries,
      lastRound: entry.lastRound,
      lastAt: entry.lastAt,
      easyMode: entry.lastEasyMode,
    })),
    totalPlayers: valid.length,
  };
}

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  if (req.method === "GET") {
    const payload = await getLeaderboard(store);
    return json(payload, { status: 200 });
  }

  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, { status: 405, headers: { allow: "GET, POST" } });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corpo JSON inválido." }, { status: 400 });
  }

  const displayName = sanitizeName(body?.name || "");
  const slug = slugify(displayName);
  const score = Number(body?.score);
  const series = normalizeSeries(body?.series || "D");
  const round = Number(body?.round || 0);
  const isChampion = Boolean(body?.isChampion);
  const easyMode = Boolean(body?.easyMode);

  if (!displayName || !slug) {
    return json({ error: "Nome inválido." }, { status: 400 });
  }
  if (!Number.isInteger(score) || Math.abs(score) > MAX_SCORE_ABS) {
    return json({ error: "Pontuação inválida." }, { status: 400 });
  }
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUND) {
    return json({ error: "Rodada inválida." }, { status: 400 });
  }

  const key = `players/${slug}.json`;
  const existingRaw = await store.get(key, { type: "json", consistency: "strong" });
  const existing = normalizeExisting(existingRaw || {});
  const now = new Date().toISOString();

  const incomingSeriesRank = SERIES_RANK[series];
  const existingSeriesRank = SERIES_RANK[existing.bestSeries] || 0;
  const updatedTitles = existing.titles + (isChampion ? 1 : 0);

  const record = {
    slug,
    displayName,
    bestSeries: incomingSeriesRank > existingSeriesRank ? series : existing.bestSeries,
    titles: updatedTitles,
    totalPoints: existing.totalPoints + score,
    gamesPlayed: existing.gamesPlayed + 1,
    bestAt: existing.bestAt || now,
    lastScore: score,
    lastSeries: series,
    lastRound: round,
    lastAt: now,
    lastEasyMode: easyMode,
  };

  await store.setJSON(key, record);
  const payload = await getLeaderboard(store);
  return json({
    ...payload,
    updatedRecord: {
      displayName: record.displayName,
      displayStage: displayStage(record),
      totalPoints: record.totalPoints,
      titles: record.titles,
    },
  }, { status: 200 });
};
