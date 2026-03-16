import { getStore } from "@netlify/blobs";

const STORE_NAME = "escudos-do-brasil-recordes";
const SERIES_RANK = { D: 1, C: 2, B: 3, A: 4 };
const MAX_SCORE_ABS = 500;
const MAX_ROUND = 500;
const MAX_CHAMPIONSHIPS = 200;

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

function normalizeChampionships(value = 0, series = "A") {
  const n = Math.max(0, Math.trunc(numeric(value, 0)));
  if (normalizeSeries(series) !== "A") return 0;
  return Math.min(n, MAX_CHAMPIONSHIPS);
}

function stageWeight(series, championships = 0) {
  const normalizedSeries = normalizeSeries(series);
  const champs = normalizeChampionships(championships, normalizedSeries);
  if (champs > 0) return 100 + champs;
  return SERIES_RANK[normalizedSeries] || 0;
}

function stageLabel(series, championships = 0) {
  const normalizedSeries = normalizeSeries(series);
  const champs = normalizeChampionships(championships, normalizedSeries);
  if (normalizedSeries !== "A" || champs === 0) return `Série ${normalizedSeries}`;
  if (champs === 1) return "Campeão";
  if (champs === 2) return "Bicampeão";
  if (champs === 3) return "Tricampeão";
  if (champs === 4) return "Tetracampeão";
  if (champs === 5) return "Pentacampeão";
  return `${champs}x campeão`;
}

function normalizeExisting(entry = {}) {
  const bestSeries = normalizeSeries(entry.bestSeries || entry.lastSeries || "D");
  const bestChampionships = normalizeChampionships(
    entry.bestChampionships ?? entry.lastChampionships ?? entry.championships ?? entry.titles ?? 0,
    bestSeries,
  );
  const bestScore = numeric(entry.bestScore, numeric(entry.totalPoints, numeric(entry.lastScore, 0)));
  const bestRound = Math.max(1, Math.trunc(numeric(entry.bestRound, numeric(entry.lastRound, 1))));
  const gamesPlayed = Math.max(1, Math.trunc(numeric(entry.gamesPlayed, 1)));

  return {
    slug: entry.slug || "",
    displayName: sanitizeName(entry.displayName || ""),
    bestSeries,
    bestChampionships,
    bestScore,
    bestRound,
    bestAt: entry.bestAt || entry.lastAt || null,
    gamesPlayed,
    lastScore: numeric(entry.lastScore, bestScore),
    lastSeries: normalizeSeries(entry.lastSeries || bestSeries),
    lastChampionships: normalizeChampionships(entry.lastChampionships ?? bestChampionships, entry.lastSeries || bestSeries),
    lastRound: Math.max(1, Math.trunc(numeric(entry.lastRound, bestRound))),
    lastAt: entry.lastAt || entry.bestAt || null,
  };
}

function serializeForClient(entry) {
  return {
    displayName: entry.displayName,
    bestScore: entry.bestScore,
    totalPoints: entry.bestScore,
    bestSeries: entry.bestSeries,
    bestChampionships: entry.bestChampionships,
    bestRound: entry.bestRound,
    displayStage: stageLabel(entry.bestSeries, entry.bestChampionships),
    bestAt: entry.bestAt,
    gamesPlayed: entry.gamesPlayed || 1,
  };
}

function compareEntries(a, b) {
  const stageDiff = stageWeight(b.bestSeries, b.bestChampionships) - stageWeight(a.bestSeries, a.bestChampionships);
  if (stageDiff !== 0) return stageDiff;

  const scoreDiff = numeric(b.bestScore, 0) - numeric(a.bestScore, 0);
  if (scoreDiff !== 0) return scoreDiff;

  const roundDiff = numeric(a.bestRound, Number.MAX_SAFE_INTEGER) - numeric(b.bestRound, Number.MAX_SAFE_INTEGER);
  if (roundDiff !== 0) return roundDiff;

  return String(a.displayName || "").localeCompare(String(b.displayName || ""), "pt-BR", { sensitivity: "base" });
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
    leaderboard: valid.slice(0, 10).map(serializeForClient),
    totalPlayers: valid.length,
  };
}

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  if (req.method === "GET") {
    return json(await getLeaderboard(store), { status: 200 });
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
  const incomingScore = Number(body?.score);
  const incomingSeries = normalizeSeries(body?.series || "D");
  const incomingRound = Math.max(1, Math.trunc(numeric(body?.round, 1)));
  const incomingChampionships = normalizeChampionships(body?.championships ?? body?.titles ?? 0, incomingSeries);

  if (!displayName || !slug) {
    return json({ error: "Nome inválido." }, { status: 400 });
  }
  if (!Number.isInteger(incomingScore) || Math.abs(incomingScore) > MAX_SCORE_ABS) {
    return json({ error: "Pontuação inválida." }, { status: 400 });
  }
  if (!Number.isInteger(incomingRound) || incomingRound < 1 || incomingRound > MAX_ROUND) {
    return json({ error: "Rodada inválida." }, { status: 400 });
  }

  const key = `players/${slug}.json`;
  const existingRaw = await store.get(key, { type: "json", consistency: "strong" });
  const existing = existingRaw ? normalizeExisting(existingRaw) : null;
  const now = new Date().toISOString();

  const incomingRecord = {
    displayName,
    bestSeries: incomingSeries,
    bestChampionships: incomingChampionships,
    bestScore: incomingScore,
    bestRound: incomingRound,
  };

  const isNewBest = !existing || compareEntries(incomingRecord, existing) < 0;

  const record = {
    slug,
    displayName,
    bestSeries: isNewBest ? incomingSeries : existing.bestSeries,
    bestChampionships: isNewBest ? incomingChampionships : existing.bestChampionships,
    bestScore: isNewBest ? incomingScore : existing.bestScore,
    bestRound: isNewBest ? incomingRound : existing.bestRound,
    bestAt: isNewBest ? now : existing.bestAt,
    gamesPlayed: (existing?.gamesPlayed || 0) + 1,
    lastScore: incomingScore,
    lastSeries: incomingSeries,
    lastChampionships: incomingChampionships,
    lastRound: incomingRound,
    lastAt: now,
  };

  await store.setJSON(key, record);
  const payload = await getLeaderboard(store);
  return json({ ...payload, isNewBest }, { status: 200 });
};
