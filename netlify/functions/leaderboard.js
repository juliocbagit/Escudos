import { getStore } from "@netlify/blobs";

const STORE_NAME = "escudos-do-brasil-recordes";
const SERIES_RANK = { D: 1, C: 2, B: 3, A: 4 };
const MAX_SCORE_ABS = 31;

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

function compareEntries(a, b) {
  if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
  const rankDiff = (SERIES_RANK[b.bestSeries] || 0) - (SERIES_RANK[a.bestSeries] || 0);
  if (rankDiff !== 0) return rankDiff;
  if ((a.bestRound || 0) !== (b.bestRound || 0)) return (a.bestRound || 0) - (b.bestRound || 0);
  return String(a.displayName).localeCompare(String(b.displayName), "pt-BR", { sensitivity: "base" });
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

  const valid = records.filter((entry) => entry && typeof entry.bestScore === "number" && entry.displayName);
  valid.sort(compareEntries);

  return {
    leaderboard: valid.slice(0, 10).map((entry) => ({
      displayName: entry.displayName,
      bestScore: entry.bestScore,
      bestSeries: entry.bestSeries,
      bestRound: entry.bestRound,
      bestAt: entry.bestAt,
      gamesPlayed: entry.gamesPlayed || 1,
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
  const bestSeries = String(body?.series || "").toUpperCase();
  const bestRound = Number(body?.round || 0);

  if (!displayName || !slug) {
    return json({ error: "Nome inválido." }, { status: 400 });
  }
  if (!Number.isInteger(score) || Math.abs(score) > MAX_SCORE_ABS) {
    return json({ error: "Pontuação inválida." }, { status: 400 });
  }
  if (!Object.hasOwn(SERIES_RANK, bestSeries)) {
    return json({ error: "Série inválida." }, { status: 400 });
  }
  if (!Number.isInteger(bestRound) || bestRound < 1 || bestRound > MAX_SCORE_ABS) {
    return json({ error: "Rodada inválida." }, { status: 400 });
  }

  const key = `players/${slug}.json`;
  const existing = await store.get(key, { type: "json", consistency: "strong" });
  const now = new Date().toISOString();

  const currentBestScore = existing?.bestScore ?? Number.NEGATIVE_INFINITY;
  const currentBestSeriesRank = SERIES_RANK[existing?.bestSeries] || 0;
  const incomingSeriesRank = SERIES_RANK[bestSeries];

  const isNewBest =
    !existing ||
    score > currentBestScore ||
    (score === currentBestScore && incomingSeriesRank > currentBestSeriesRank) ||
    (score === currentBestScore && incomingSeriesRank === currentBestSeriesRank && bestRound < (existing?.bestRound || Number.MAX_SAFE_INTEGER));

  const record = {
    slug,
    displayName,
    bestScore: isNewBest ? score : existing.bestScore,
    bestSeries: isNewBest ? bestSeries : existing.bestSeries,
    bestRound: isNewBest ? bestRound : existing.bestRound,
    bestAt: isNewBest ? now : existing.bestAt,
    gamesPlayed: (existing?.gamesPlayed || 0) + 1,
    lastScore: score,
    lastSeries: bestSeries,
    lastRound: bestRound,
    lastAt: now,
  };

  await store.setJSON(key, record);
  const payload = await getLeaderboard(store);
  return json({ ...payload, isNewBest }, { status: 200 });
};
