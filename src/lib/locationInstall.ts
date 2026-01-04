// Utilities for seeding location records during install flows.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebaseAdmin";

type EnsureLocationInstallParams = {
  locationId: string;
  agencyId?: string | null;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function cleanTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
  } catch {
    return null;
  }
  return trimmed;
}

function extractTimeZone(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const settings =
    data.settings && typeof data.settings === "object" ? (data.settings as Record<string, unknown>) : null;
  const ghl = data.ghl && typeof data.ghl === "object" ? (data.ghl as Record<string, unknown>) : null;
  const candidates = [
    data.timeZone,
    data.timezone,
    data.time_zone,
    data.locationTimeZone,
    data.locationTimezone,
    settings?.timeZone,
    settings?.timezone,
    ghl?.timeZone,
    ghl?.timezone,
  ];
  for (const candidate of candidates) {
    const tz = cleanTimeZone(candidate);
    if (tz) return tz;
  }
  return null;
}

function getTimeZoneParts(date: Date, timeZone: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    map[part.type] = Number(part.value);
  }
  return {
    year: map.year ?? date.getUTCFullYear(),
    month: map.month ?? date.getUTCMonth() + 1,
    day: map.day ?? date.getUTCDate(),
    hour: map.hour ?? 0,
    minute: map.minute ?? 0,
    second: map.second ?? 0,
  };
}

function getTimeZoneOffset(date: Date, timeZone: string): number {
  const parts = getTimeZoneParts(date, timeZone);
  const utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (utcMillis - date.getTime()) / 60000;
}

function makeDateInTimeZone(parts: DateParts, timeZone: string): Date {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = getTimeZoneOffset(new Date(utcGuess), timeZone);
  let adjusted = utcGuess - offset * 60000;
  const offsetCheck = getTimeZoneOffset(new Date(adjusted), timeZone);
  if (offsetCheck !== offset) {
    adjusted = utcGuess - offsetCheck * 60000;
  }
  return new Date(adjusted);
}

function buildNextMonthRefreshDate(base: Date): Date {
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  const nextMonthIndex = month + 1;
  const targetYear = year + Math.floor(nextMonthIndex / 12);
  const targetMonth = nextMonthIndex % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const safeDay = Math.min(day, daysInTargetMonth);
  return new Date(targetYear, targetMonth, safeDay, 0, 1, 0, 0);
}

function buildNextMonthRefreshDateInZone(base: Date, timeZone: string): Date {
  const parts = getTimeZoneParts(base, timeZone);
  const targetMonth = parts.month === 12 ? 1 : parts.month + 1;
  const targetYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const safeDay = Math.min(parts.day, daysInTargetMonth);
  return makeDateInTimeZone(
    {
      year: targetYear,
      month: targetMonth,
      day: safeDay,
      hour: 0,
      minute: 1,
      second: 0,
    },
    timeZone,
  );
}

/**
 * Ensure the base location document exists with install metadata and skiptrace defaults.
 * Adds skipTracesAvailable = 150 when the field is missing without overwriting existing values.
 */
export async function ensureLocationInstallRecord({ locationId, agencyId }: EnsureLocationInstallParams) {
  const locId = (locationId || "").trim();
  if (!locId) return;

  const agency = (agencyId || "").trim();
  const firestore = db();
  const ref = firestore.collection("locations").doc(locId);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    const payload: Record<string, unknown> = {
      locationId: locId,
      provider: "leadconnector",
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (agency) payload.agencyId = agency;

    const hasInstalledAt = snap.exists ? Boolean(snap.get("installedAt")) : false;
    const isInstalled = snap.exists ? snap.get("isInstalled") === true : false;

    if (!hasInstalledAt) payload.installedAt = FieldValue.serverTimestamp();
    if (!isInstalled) payload.isInstalled = true;

    const skipTracesAvailable = snap.exists ? snap.get("skipTracesAvailable") : undefined;
    if (typeof skipTracesAvailable !== "number") {
      payload.skipTracesAvailable = 150;
    }

    const skipTraceRefresh = snap.exists ? snap.get("skipTraceRefresh") : undefined;
    if (typeof skipTraceRefresh === "undefined") {
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const timeZone = extractTimeZone(data);
      const refreshDate = timeZone
        ? buildNextMonthRefreshDateInZone(new Date(), timeZone)
        : buildNextMonthRefreshDate(new Date());
      payload.skipTraceRefresh = Timestamp.fromDate(refreshDate);
    }

    tx.set(ref, payload, { merge: true });
  });
}
