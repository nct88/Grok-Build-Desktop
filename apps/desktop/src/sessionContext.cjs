/**
 * Context-window occupancy for the session-info chip.
 * Cumulative billed tokens (usage.totalTokens) belong in "This session".
 */
"use strict";

function asFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function occupancyFromUpdateRow(row) {
  if (!row || typeof row !== "object") return null;
  const update = row.params?.update || row.update || {};
  if (update && update.sessionUpdate === "usage_update") {
    const used = asFiniteNumber(update.used);
    const size = asFiniteNumber(update.size);
    if (used != null) return { used, size };
  }
  const metaTotal = asFiniteNumber(row._meta?.totalTokens);
  if (metaTotal != null) return { used: metaTotal, size: null };
  return null;
}

function mergeOccupancy(prev, next) {
  if (!next) return prev || null;
  return {
    used: next.used != null ? next.used : prev?.used ?? null,
    size: next.size != null ? next.size : prev?.size ?? null,
  };
}

function contextWindowMetrics(occupancy, modelContextWindow) {
  const size = occupancy?.size ?? asFiniteNumber(modelContextWindow);
  const used = occupancy?.used ?? null;
  const percent =
    size && used != null
      ? Math.min(100, Math.max(0, Math.round((used / size) * 1000) / 10))
      : null;
  return {
    used,
    size: size || null,
    percent,
  };
}

module.exports = {
  asFiniteNumber,
  occupancyFromUpdateRow,
  mergeOccupancy,
  contextWindowMetrics,
};
